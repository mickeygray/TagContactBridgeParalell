"use strict";

// TWO-STATION RUNTIME PINS (2026-07-08). These pin the CADENCE CONTRACT — the part
// the evals could not test because it didn't exist: B grounds immediately on the
// first substantive turn (the warm-up fix), A fires on the Nth substance-floored
// turn with B's menu, HOLD dispatches nothing, failures cool down instead of
// hot-retrying (the A2 lesson), provisionals never count (A3), and dedupe records
// only on confirmed delivery (A10).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { createCoachTwoStationLoop } = require("../../packages/shared-services/src/coachTwoStationLoop");

const B_OK = JSON.stringify({
  guidance: [{
    currentSection: "2",
    beats: [{ beatId: "fee_line", status: "pending" }],
    remember: [{ text: "already burned by a firm once", kind: "watch" }],
    says: [
      { type: "objection", tag: "price shock", rec: true, text: "Hold the fee — anchor it against what the IRS adds monthly." },
      { type: "line", tag: "next step", rec: false, text: "Walk the investigation step first." },
    ],
    reasoning: "price objection is live",
    priorFlags: [],
  }],
  summary: "Prospect owes ~40k, spooked on price, still engaged.",
});

function makeRow(id, role, text, provisional = false) {
  return { id, role, text, provisional };
}

function conversation(sessionId, rows, uii = "uii-1") {
  return { sessionId, call: { uii }, arrays: { transcript: rows } };
}

function makeHarness({ bText = B_OK, aText, emitReturns } = {}) {
  const calls = { b: [], a: [], steered: [], emitted: [] };
  let batchRows = [];
  let clock = 1_000_000;
  const loop = createCoachTwoStationLoop({
    buildBatch: () => ({ conversations: batchRows }),
    applySteering: (updates) => { calls.steered.push(...updates); },
    emitGuidance: (dispatch) => {
      calls.emitted.push(dispatch);
      return emitReturns === undefined ? undefined : emitReturns; // real emit never returns true
    },
    runStrategist: async (req) => {
      calls.b.push(req);
      return typeof bText === "function" ? bText() : { ok: true, text: bText, usage: { input_tokens: 100, output_tokens: 50 } };
    },
    runCoach: async (req) => {
      calls.a.push(req);
      const text = typeof aText === "function" ? aText() : (aText ?? JSON.stringify({
        say: "Totally fair — most clients felt that until they saw what waiting costs.",
        guidance: "hold the fee, anchor to IRS accrual",
        summary: "price objection handled once",
      }));
      return { ok: true, text, usage: { input_tokens: 40, output_tokens: 20 } };
    },
    reference: "REFERENCE with fee $3,500 inline",
    logger: { info: () => {}, warn: () => {} },
    now: () => clock,
  });
  return {
    loop, calls,
    setBatch: (rows) => { batchRows = rows; },
    advance: (ms) => { clock += ms; },
  };
}

const T1 = makeRow("r1", "prospect", "I got your letter about my tax debt yesterday");
const T2 = makeRow("r2", "agent", "Thanks for calling in — how much are we dealing with?");
const T3 = makeRow("r3", "prospect", "Around forty thousand and I cannot pay that");

test("first substantive turn grounds B IMMEDIATELY (the 3-minute warm-up fix) and steers the shipped cockpit shape", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1])]);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 1, "B must fire on first sight");
  assert.match(h.calls.b[0].prompt, /prospect: I got your letter/);
  assert.equal(h.calls.steered.length, 1);
  const update = h.calls.steered[0];
  assert.equal(update.sessionId, "s1");
  assert.equal(update.uii, "uii-1");
  assert.equal(update.currentSection, "2");
  assert.equal(update.says.filter((s) => s.rec).length, 1);
  assert.match(update.callStrategy, /section 2 — Hold the fee/);
  assert.equal(h.loop.getCounters().bRegrounds, 1);
});

test("A fires on the Nth substantive turn, with B's menu and the turn window; dispatch = the shipped dialog shape", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1, T2, T3])]); // 3 substantive commits in one tick
  await h.loop.tick();
  assert.equal(h.calls.b.length, 1, "B grounds first in the same tick");
  assert.equal(h.calls.a.length, 1, "A fires with the fresh menu");
  assert.match(h.calls.a[0].prompt, /price shock/, "A sees B's play menu");
  assert.match(h.calls.a[0].prompt, /forty thousand/, "A sees the turn window");
  assert.equal(h.calls.emitted.length, 1);
  const d = h.calls.emitted[0];
  assert.equal(d.target.sessionId, "s1");
  assert.equal(d.payload.mode, "guidance");
  assert.match(d.payload.try, /Totally fair/);
  assert.match(d.payload.steer, /section 2/);
  assert.equal(h.loop.getCounters().aFires, 1);
});

test("HOLD: A returning say:'' dispatches NOTHING and is counted as a hold", async () => {
  const h = makeHarness({ aText: JSON.stringify({ say: "", guidance: "stay quiet", summary: "s" }) });
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  await h.loop.tick();
  assert.equal(h.calls.a.length, 1);
  assert.equal(h.calls.emitted.length, 0, "a HOLD must not dispatch");
  const c = h.loop.getCounters();
  assert.equal(c.aHolds, 1);
  assert.equal(c.aFires, 0);
});

test("provisional rows NEVER count toward the fire trigger (audit A3)", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [
    T1,
    makeRow("p1", "prospect", "and I also have unfiled returns from twenty", true),
    makeRow("p2", "prospect", "and I also have unfiled returns from twenty nineteen and", true),
  ])]);
  await h.loop.tick();
  const c = h.loop.getCounters();
  assert.equal(c.turnsCommitted, 1, "only the committed row counts");
  assert.equal(h.calls.a.length, 0, "no fire off partials");
});

test("B failure -> cooldown, NO hot retry next tick, retries after the cooldown (the A2 lesson)", async () => {
  let bMode = "fail";
  const h = makeHarness({
    bText: () => (bMode === "fail" ? { ok: false, error: "truncated:max_tokens" } : { ok: true, text: B_OK, usage: {} }),
  });
  h.setBatch([conversation("s1", [T1])]);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 1);
  assert.equal(h.loop.getCounters().bFailures, 1);
  await h.loop.tick(); // immediately again — must be inside cooldown
  assert.equal(h.calls.b.length, 1, "no hot retry");
  bMode = "ok";
  h.advance(61_000);
  h.setBatch([conversation("s1", [T1, makeRow("r4", "prospect", "are you still there about this")])]);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 2, "retries after cooldown");
  assert.equal(h.loop.getCounters().bRegrounds, 1);
});

test("unparseable B output = failure with cooldown, never a crash", async () => {
  const h = makeHarness({ bText: () => ({ ok: true, text: "SORRY I CANNOT", usage: {} }) });
  h.setBatch([conversation("s1", [T1])]);
  const result = await h.loop.tick();
  assert.equal(result.failed, undefined);
  assert.equal(h.loop.getCounters().bFailures, 1);
});

test("B regrounds ONLY after the interval AND with new substance — silence costs nothing", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1, T2])]);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 1);
  // a new substantive row 30s later -> interval unmet -> no reground yet
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  h.advance(30_000);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 1, "interval not yet met after last B");
  // 6 more minutes with NO further rows: the banked substance + met interval -> reground
  h.advance(6 * 60_000);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 2, "banked substance regrounds once the interval is met");
  // and pure silence after that reground never regrounds again
  h.advance(6 * 60_000);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 2, "no reground on silence");
});

test("dedupe records only on confirmed delivery: emit=false keeps the say retryable (audit A10)", async () => {
  const h = makeHarness({ emitReturns: false });
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  await h.loop.tick();
  assert.equal(h.calls.emitted.length, 1);
  assert.equal(h.loop.getCounters().aFires, 0, "undelivered = not a fire");
  // three MORE substantive turns -> A fires again with the same say — not deduped away
  h.setBatch([conversation("s1", [T1, T2, T3,
    makeRow("r4", "prospect", "I just do not have that kind of money right now"),
    makeRow("r5", "agent", "Understood — let me show you how clients handle it"),
    makeRow("r6", "prospect", "Okay explain it to me then please"),
  ])]);
  await h.loop.tick();
  assert.equal(h.calls.emitted.length, 2, "same say may retry because delivery never confirmed");
});

test("a session that leaves the batch is pruned; a duplicate say on a live session IS deduped", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  await h.loop.tick();
  assert.equal(h.loop.getCounters().aFires, 1);
  // three more turns, A returns the SAME say -> dupe, no second dialog
  h.setBatch([conversation("s1", [T1, T2, T3,
    makeRow("r4", "prospect", "I hear you but the price is still steep"),
    makeRow("r5", "agent", "Let me put it against the penalty math"),
    makeRow("r6", "prospect", "Go ahead show me those numbers now"),
  ])]);
  await h.loop.tick();
  assert.equal(h.loop.getCounters().aDupes, 1);
  assert.equal(h.calls.emitted.length, 1);
  // session disappears -> state pruned
  h.setBatch([]);
  await h.loop.tick();
  assert.equal(h.loop.getSessionCount(), 0);
});

test("REVIEW FIX: a failed REGROUND (after a successful ground) retries on the COOLDOWN, not a fresh interval + new turn", async () => {
  let failNext = false;
  const h = makeHarness({
    bText: () => (failNext ? { ok: false, error: "transient 500" } : { ok: true, text: B_OK, usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  h.setBatch([conversation("s1", [T1, T2])]);
  await h.loop.tick(); // ground OK
  assert.equal(h.calls.b.length, 1);
  // bank new substance, pass the interval, then FAIL the reground
  failNext = true;
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  h.advance(6 * 60_000);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 2);
  assert.equal(h.loop.getCounters().bFailures, 1);
  // NO new turns arrive. After the 60s cooldown the banked trigger must still be alive.
  failNext = false;
  h.advance(61_000);
  await h.loop.tick();
  assert.equal(h.calls.b.length, 3, "reground retried on cooldown without demanding a new turn");
  assert.equal(h.loop.getCounters().bRegrounds, 2);
});

test("REVIEW FIX: an A fire landing during a cooldown is DEFERRED, not destroyed", async () => {
  let aFails = true;
  const h = makeHarness({
    aText: () => {
      if (aFails) throw new Error("no"); // unreachable; harness uses ok path — override below
      return JSON.stringify({ say: "line", guidance: "g", summary: "s" });
    },
  });
  // stub runCoach directly for failure control
  let mode = "fail";
  const calls = h.calls;
  const loop2 = require("../../packages/shared-services/src/coachTwoStationLoop");
  let clock = 2_000_000;
  let rows = [];
  const l = loop2.createCoachTwoStationLoop({
    buildBatch: () => ({ conversations: [{ sessionId: "s1", call: { uii: "u" }, arrays: { transcript: rows } }] }),
    applySteering: () => {},
    emitGuidance: () => undefined,
    runStrategist: async () => ({ ok: true, text: B_OK, usage: {} }),
    runCoach: async () => (mode === "fail"
      ? { ok: false, error: "500" }
      : { ok: true, text: JSON.stringify({ say: "back online line", guidance: "g", summary: "s" }), usage: {} }),
    reference: "R",
    logger: { info: () => {}, warn: () => {} },
    now: () => clock,
  });
  rows = [T1, T2, T3];
  await l.tick(); // A fires -> FAILS -> 60s cooldown
  assert.equal(l.getCounters().aFailures, 1);
  // three more substantive turns DURING the cooldown -> fire pends, is not destroyed
  rows = [...rows,
    makeRow("x1", "prospect", "So what happens to my paycheck now"),
    makeRow("x2", "agent", "Let me walk you through the protection step"),
    makeRow("x3", "prospect", "Alright go ahead I am listening"),
  ];
  clock += 10_000; // still inside cooldown
  await l.tick();
  assert.equal(l.getCounters().aFires, 0, "cooldown holds");
  mode = "ok";
  clock += 55_000; // cooldown over; NO new turns
  await l.tick();
  assert.equal(l.getCounters().aFires, 1, "the deferred fire ran after cooldown without new turns");
});

test("REVIEW FIX: unparseable A output is a FAILURE with cooldown, never a HOLD", async () => {
  const h = makeHarness({ aText: "I think you should hold the fee firm here." /* prose, not JSON */ });
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  await h.loop.tick();
  const c = h.loop.getCounters();
  assert.equal(c.aHolds, 0, "prose must not read as deliberate silence");
  assert.equal(c.aFailures, 1);
});

test("REVIEW FIX: billed tokens from FAILED calls land in the meter", async () => {
  const h = makeHarness({
    bText: () => ({ ok: false, error: "b truncated:max_tokens", usage: { input_tokens: 500, output_tokens: 2500 } }),
  });
  h.setBatch([conversation("s1", [T1])]);
  await h.loop.tick();
  const u = h.loop.getCounters().usage.strategist;
  assert.equal(u.calls, 1);
  assert.equal(u.outputTokens, 2500, "a truncation bills full output and must be metered");
});

test("REVIEW FIX: stop() quiesces — no station calls for sessions after stop, even mid-tick state", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  h.loop.start();
  h.loop.stop();
  await h.loop.tick(); // manual tick after stop: the per-session loop must bail
  assert.equal(h.calls.b.length, 0);
  assert.equal(h.calls.a.length, 0);
});

test("usage accounting: strategist + coach tokens land in the counters (the cost meter)", async () => {
  const h = makeHarness();
  h.setBatch([conversation("s1", [T1, T2, T3])]);
  await h.loop.tick();
  const u = h.loop.getCounters().usage;
  assert.equal(u.strategist.calls, 1);
  assert.equal(u.strategist.inputTokens, 100);
  assert.equal(u.coach.calls, 1);
  assert.equal(u.coach.outputTokens, 20);
});
