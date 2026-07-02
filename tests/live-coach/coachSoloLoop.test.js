"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCoachSoloLoop, buildLiveDispatches } = require("../../packages/shared-services/src/coachSoloLoop");
const {
  buildActiveLiveCoachBatch,
  buildActiveLiveCoachChangeSet,
} = require("../../packages/shared-services/src/liveCoachBatchProjectionService");

function nowIso() {
  return new Date().toISOString();
}

function activeSession(id, agentEmail, uii, transcript) {
  const now = nowIso();
  return {
    id,
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail, domain: "WYNN", uii },
    memory: { transcripts: transcript.map((text) => ({ role: "prospect", text })) },
  };
}

// Wire the solo loop to the REAL projection over a mutable session store (the same fidelity
// the floor-loop test uses) + injectable fakes for the model + the two writebacks.
function makeSolo(sessions, runSolo, extra = {}) {
  const emitted = [];
  const steeringApplied = [];
  const deps = {
    buildChanges: (input) => buildActiveLiveCoachChangeSet(sessions, input),
    buildBatch: (input) => buildActiveLiveCoachBatch(sessions, input),
    applySteering: (updates) => steeringApplied.push(...updates),
    emitGuidance: (dispatch) => emitted.push(dispatch),
    runSolo,
    reference: "RULES: cost-of-waiting frame for price objections.",
    batchOptions: { maxSessions: 12 },
    ...extra,
  };
  return { emitted, steeringApplied, deps };
}

function deepResponse(rows) {
  return { ok: true, json: { guidance: rows } };
}

test("GATE: empty floor -> no fire and the model is never called", async () => {
  let calls = 0;
  const { deps } = makeSolo([], async () => {
    calls += 1;
    return deepResponse([]);
  });
  const loop = createCoachSoloLoop(deps);
  const out = await loop.tick();
  assert.equal(out.fired, false);
  assert.equal(out.reason, "no-active-conversations");
  assert.equal(calls, 0, "no model call when no one is on the phone");
});

test("FIRE: one Sonnet call on the big DEEP prompt -> cockpit steering + live rec say", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["this is way too expensive"])];
  let seenReq = null;
  const { emitted, steeringApplied, deps } = makeSolo(sessions, async (req) => {
    seenReq = req;
    return deepResponse([
      {
        sessionId: "coach-A",
        uii: "uii-A",
        agentEmail: "sean@tag.com",
        currentSection: "2",
        summary: "price hesitation surfaced",
        beats: [{ beatId: "b1", point: "anchor the full fee", status: "pending" }],
        remember: [{ text: "price-sensitive", kind: "watch" }],
        says: [
          { type: "objection", tag: "price", rec: true, text: "What has waiting on this cost you each month?" },
          { type: "tactic", tag: "anchor", text: "Most clients open the case in full." },
        ],
        priorFlags: [],
      },
    ]);
  });
  const loop = createCoachSoloLoop(deps);
  const out = await loop.tick();

  assert.equal(out.fired, true);
  // The big prompt rode in at the DEEP tier with the reference.
  assert.equal(seenReq.tier, "deep");
  assert.ok(seenReq.system.includes("cost-of-waiting"), "reference rode into the system prompt");
  assert.ok(seenReq.system.includes("SCRIPT BEATS BY SECTION"), "deep beat catalog rode in (the big prompt)");

  // 1) cockpit steering applied
  assert.equal(steeringApplied.length, 1);
  assert.equal(steeringApplied[0].sessionId, "coach-A");
  assert.equal(steeringApplied[0].currentSection, "2");
  assert.ok(steeringApplied[0].says.some((s) => s.rec), "a recommended say survived into steering");

  // 2) live rec say emitted as a reactor-shaped dispatch
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].target.sessionId, "coach-A");
  assert.equal(emitted[0].payload.try, "What has waiting on this cost you each month?");
  assert.equal(out.emitted, 1);
});

test("GROWTH GATE: nothing grew since the last tick -> no second model call", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  let calls = 0;
  const { deps } = makeSolo(sessions, async () => {
    calls += 1;
    return deepResponse([
      { sessionId: "coach-A", uii: "uii-A", currentSection: "2", says: [{ type: "line", rec: true, text: "anchor" }] },
    ]);
  });
  const loop = createCoachSoloLoop(deps);

  const first = await loop.tick();
  assert.equal(first.fired, true);
  assert.equal(calls, 1);

  // No transcript growth between ticks -> the change-set reports no changes -> skip the model.
  const second = await loop.tick();
  assert.equal(second.fired, false);
  assert.equal(second.reason, "no-changes");
  assert.equal(calls, 1, "model not called again when nothing grew");
});

test("GROWTH GATE: a new transcript turn re-fires the model", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  let calls = 0;
  const { deps } = makeSolo(sessions, async () => {
    calls += 1;
    return deepResponse([
      { sessionId: "coach-A", uii: "uii-A", currentSection: "2", says: [{ type: "line", rec: true, text: `say ${calls}` }] },
    ]);
  });
  const loop = createCoachSoloLoop(deps);

  await loop.tick();
  assert.equal(calls, 1);
  // grow the transcript
  sessions[0].memory.transcripts.push({ role: "prospect", text: "ok what would it cost" });
  sessions[0].updatedAt = nowIso();
  const out = await loop.tick();
  assert.equal(out.fired, true);
  assert.equal(calls, 2, "growth re-armed the model");
});

test("MODEL FAILURE: a transport error does not fire and stays retryable", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  const { emitted, steeringApplied, deps } = makeSolo(sessions, async () => ({ ok: false, error: "solo 429", text: "" }));
  const loop = createCoachSoloLoop(deps);
  const out = await loop.tick();
  assert.equal(out.fired, false);
  assert.equal(out.reason, "model-failed");
  assert.equal(emitted.length, 0);
  assert.equal(steeringApplied.length, 0);
});

test("DEDUP: the same recommended line never re-bubbles", () => {
  const parsed = {
    guidance: [{ sessionId: "coach-A", uii: "uii-A", says: [{ type: "line", rec: true, text: "hold the fee" }] }],
  };
  const seen = new Map();
  const first = buildLiveDispatches(parsed, seen);
  assert.equal(first.length, 1);
  assert.equal(first[0].dispatch.payload.try, "hold the fee");
  seen.set("coach-A", "hold the fee"); // loop records what it emitted
  const second = buildLiveDispatches(parsed, seen);
  assert.equal(second.length, 0, "unchanged rec say is suppressed");
});

test("COCKPIT-ONLY: with no emitGuidance the loop still steers (no throw)", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  const { steeringApplied, deps } = makeSolo(
    sessions,
    async () => deepResponse([{ sessionId: "coach-A", currentSection: "2", says: [{ type: "line", rec: true, text: "x" }] }]),
    { emitGuidance: null },
  );
  const loop = createCoachSoloLoop(deps);
  const out = await loop.tick();
  assert.equal(out.fired, true);
  assert.equal(out.emitted, 0);
  assert.equal(steeringApplied.length, 1);
});

test("EMPTY GUIDANCE: ok:true but no usable rows -> no fire, cursor NOT advanced (growth retries)", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  let good = false;
  let calls = 0;
  const { deps } = makeSolo(sessions, async () => {
    calls += 1;
    if (!good) return { ok: true, text: "" }; // refusal / max_tokens-truncated -> parses to guidance:[]
    return deepResponse([
      { sessionId: "coach-A", uii: "uii-A", currentSection: "2", says: [{ type: "line", rec: true, text: "anchor the fee" }] },
    ]);
  });
  const loop = createCoachSoloLoop(deps);

  const first = await loop.tick();
  assert.equal(first.fired, false);
  assert.equal(first.reason, "empty-guidance");

  // No new transcript turn added: only because the empty response did NOT consume the growth
  // (cursor not advanced) can the same pending growth re-fire once the model returns rows.
  good = true;
  const second = await loop.tick();
  assert.equal(second.fired, true, "the un-dropped growth retried and fired");
  assert.equal(calls, 2);
});

test("DEDUP DELIVERY: a silent no-op emit is NOT recorded -> the line retries next tick", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", ["too expensive"])];
  let emitCalls = 0;
  const { deps } = makeSolo(
    sessions,
    async () =>
      deepResponse([
        { sessionId: "coach-A", uii: "uii-A", currentSection: "2", says: [{ type: "line", rec: true, text: "same line" }] },
      ]),
    {
      emitGuidance: () => {
        emitCalls += 1;
        return false; // the bus dropped it (session flipped out of batch mode / went terminal)
      },
    },
  );
  const loop = createCoachSoloLoop(deps);

  const first = await loop.tick();
  assert.equal(first.fired, true);
  assert.equal(first.emitted, 0, "an undelivered say is not counted as emitted");
  assert.equal(emitCalls, 1);

  // grow + re-fire: the identical line is re-attempted (NOT suppressed) because it never delivered.
  sessions[0].memory.transcripts.push({ role: "prospect", text: "ok how much" });
  sessions[0].updatedAt = nowIso();
  const second = await loop.tick();
  assert.equal(second.fired, true);
  assert.equal(emitCalls, 2, "the undelivered line retried, not deduped");
});
