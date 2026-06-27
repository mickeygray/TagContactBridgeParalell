"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCoachFloorLoop } = require("../../packages/shared-services/src/coachFloorLoop");
const {
  buildActiveLiveCoachBatch,
  buildActiveLiveCoachChangeSet,
} = require("../../packages/shared-services/src/liveCoachBatchProjectionService");
const {
  buildLiveCoachGuidanceDispatchPlan,
} = require("../../packages/shared-services/src/liveCoachBatchGuidanceDispatchService");

function nowIso() {
  return new Date().toISOString();
}

// Mutable session store the fixture loop reads through the real projection.
function makeFloor(sessions) {
  const emitted = [];
  const steeringApplied = [];
  const deps = {
    buildChanges: (input) => buildActiveLiveCoachChangeSet(sessions, input),
    buildBatch: (input) => buildActiveLiveCoachBatch(sessions, input),
    buildDispatchPlan: (activeBatch, parsed) => buildLiveCoachGuidanceDispatchPlan(activeBatch, parsed),
    emitGuidance: (dispatch) => emitted.push(dispatch),
    applySteering: (updates) => steeringApplied.push(...updates),
    reference: "RULES: cost-of-waiting frame for price objections.",
    batchOptions: { maxSessions: 12 },
  };
  return { emitted, steeringApplied, deps };
}

function activeSession(id, agentEmail, uii, prospectLine) {
  const now = nowIso();
  return {
    id,
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail, domain: "WYNN", uii },
    memory: { transcripts: [{ role: "prospect", text: prospectLine }] },
  };
}

test("GATE: empty floor -> reactor does not fire and the runner is never called", async () => {
  let runnerCalls = 0;
  const { deps } = makeFloor([]);
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => {
      runnerCalls += 1;
      return { guidance: [] };
    },
  });
  const out = await loop.tickReactor();
  assert.equal(out.fired, false);
  assert.equal(out.reason, "no-active-conversations");
  assert.equal(runnerCalls, 0, "no model call when no one is on the phone");
});

test("REACTOR: changes -> runner -> real dispatch plan -> emit to the right agent", async () => {
  const sessions = [
    activeSession("coach-A", "sean@tag.com", "uii-A", "this is way too expensive"),
    activeSession("coach-B", "dana@tag.com", "uii-B", "what forms do i need"),
  ];
  const { emitted, deps } = makeFloor(sessions);

  // Fake Haiku: echoes routing keys per changed conversation.
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async (req) => {
      assert.ok(req.system.includes("cost-of-waiting"), "reference rode into the request");
      return {
        guidance: [
          { sessionId: "coach-A", uii: "uii-A", agentEmail: "sean@tag.com", mode: "reaction", read: "price objection", steer: "cost of waiting", try: "what has waiting cost you?", confidence: "high" },
          { sessionId: "coach-B", uii: "uii-B", agentEmail: "dana@tag.com", mode: "reaction", read: "forms question", steer: "answer plainly", try: "you'll need a 2848", confidence: "medium" },
        ],
      };
    },
  });

  const out = await loop.tickReactor();
  assert.equal(out.fired, true);
  assert.equal(out.dispatchCount, 2);
  assert.equal(out.emitted, 2);

  const targets = emitted.map((d) => d.target.sessionId).sort();
  assert.deepEqual(targets, ["coach-A", "coach-B"]);
  const sean = emitted.find((d) => d.target.sessionId === "coach-A");
  assert.equal(sean.target.agentEmail, "sean@tag.com");
  assert.equal(sean.payload.try, "what has waiting cost you?");
});

test("REACTOR: a mis-routed guidance row is rejected by the real dispatch plan, not emitted", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", "too expensive")];
  const { emitted, deps } = makeFloor(sessions);
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => ({
      guidance: [
        { sessionId: "coach-A", uii: "uii-A", mode: "reaction", try: "good one" },
        { sessionId: "coach-A", uii: "WRONG", mode: "reaction", try: "bad uii" },
        { sessionId: "coach-GHOST", mode: "reaction", try: "no session" },
      ],
    }),
  });
  const out = await loop.tickReactor();
  assert.equal(out.dispatchCount, 1, "only the valid row dispatches");
  assert.equal(out.rejectedCount, 2);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.try, "good one");
});

test("DEEP: fires on a live floor and applies cockpit STATE (no dialog dispatch)", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", "i owe a lot and havent filed")];
  const { emitted, steeringApplied, deps } = makeFloor(sessions);
  const loop = createCoachFloorLoop({
    ...deps,
    runDeep: async (req) => {
      assert.equal(req.tier, "deep");
      return {
        guidance: [
          {
            sessionId: "coach-A",
            uii: "uii-A",
            currentSection: "2",
            beats: [
              { point: "Ask unfiled years", status: "hit" },
              { point: "Ask amount owed", status: "pending" },
            ],
            remember: [{ text: "Balance still unknown — quantify before pitching", kind: "watch" }],
            says: [{ type: "tactic", tag: "quantify", rec: true, text: "Roughly how much are we talking — federal, state, or both?" }],
            priorFlags: [],
          },
        ],
      };
    },
  });

  const out = await loop.tickDeep();
  assert.equal(out.fired, true);
  assert.equal(out.stateUpdates, 1, "the deep pull applies one state update");
  // The deep pull is STATE, not a live dialog dispatch.
  assert.equal(emitted.length, 0, "deep pull does not emit a dialog");
  assert.equal(steeringApplied.length, 1);
  assert.equal(steeringApplied[0].sessionId, "coach-A");
  assert.equal(steeringApplied[0].currentSection, "2");
  assert.equal(steeringApplied[0].beats.length, 2);
  assert.equal(steeringApplied[0].says[0].type, "tactic");
});

test("IN-FLIGHT GUARD: a second tick while one is running is skipped", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", "too expensive")];
  const { deps } = makeFloor(sessions);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let calls = 0;
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => {
      calls += 1;
      await gate; // hold the first pass open
      return { guidance: [{ sessionId: "coach-A", uii: "uii-A", mode: "quiet" }] };
    },
  });

  const first = loop.tickReactor(); // starts, holds
  const second = await loop.tickReactor(); // should bounce off the in-flight guard
  assert.equal(second.skipped, "in-flight");
  assert.equal(calls, 1, "the runner was only entered once");
  release();
  await first;
});

test("CURSOR: advances on a fired pass; a model error does NOT advance it (retry next tick)", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", "too expensive")];
  const { deps } = makeFloor(sessions);

  let mode = "throw";
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => {
      if (mode === "throw") throw new Error("model 500");
      return { guidance: [{ sessionId: "coach-A", uii: "uii-A", mode: "quiet" }] };
    },
  });

  const errOut = await loop.tickReactor();
  assert.equal(errOut.fired, false);
  assert.equal(errOut.error, "model 500");
  assert.equal(loop.getCursor(), null, "cursor not advanced after a model error");

  mode = "ok";
  const okOut = await loop.tickReactor();
  assert.equal(okOut.fired, true);
  assert.ok(loop.getCursor(), "cursor advanced after a successful pass");
});

test("CURSOR: ok:false transport results do NOT advance changed transcripts", async () => {
  const sessions = [activeSession("coach-A", "sean@tag.com", "uii-A", "too expensive")];
  const { deps } = makeFloor(sessions);

  let mode = "http-error";
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => {
      if (mode === "http-error") return { ok: false, error: "reactor 429", text: "" };
      return { guidance: [{ sessionId: "coach-A", uii: "uii-A", mode: "quiet" }] };
    },
  });

  const failed = await loop.tickReactor();
  assert.equal(failed.fired, false);
  assert.equal(failed.reason, "model-failed");
  assert.equal(failed.error, "reactor 429");
  assert.equal(loop.getCursor(), null, "cursor not advanced after ok:false transport result");

  mode = "ok";
  const retried = await loop.tickReactor();
  assert.equal(retried.fired, true);
  assert.ok(loop.getCursor(), "the same change is retried and then accepted");
});

test("start/stop drive the injected scheduler and respect which runners exist", () => {
  const { deps } = makeFloor([]);
  const started = [];
  const stopped = [];
  let handleSeq = 0;
  const loop = createCoachFloorLoop({
    ...deps,
    runReactor: async () => ({ guidance: [] }),
    // runDeep omitted => deep cadence should NOT be scheduled
    startInterval: (fn, ms) => {
      const handle = ++handleSeq;
      started.push({ handle, ms });
      return handle;
    },
    stopInterval: (handle) => stopped.push(handle),
    reactorIntervalMs: 4000,
  });
  loop.start();
  assert.equal(started.length, 1, "only the reactor cadence is scheduled (no deep runner)");
  assert.equal(started[0].ms, 4000);
  assert.equal(loop.isRunning(), true);
  loop.stop();
  assert.deepEqual(stopped, [started[0].handle]);
  assert.equal(loop.isRunning(), false);
});
