"use strict";

// CR-5 §14 — the DNC sweep.
//
// This is the gate that decides whether a recovery call may EVER be placed:
// admission holds on `dnc-unproven` until a real RealValidation result exists
// for that exact phone. So a wrong answer here is not a wrong number in a
// report — it is a call to somebody who asked not to be called.
//
// Every test below is therefore about the same question: can anything that is
// not an explicit clean read come out the other side as clean?

const test = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/callRecoveryDncSweepService");

const NOW = new Date("2026-08-03T18:00:00Z");
const FIRST = new Date("2026-07-30T18:00:00Z");

test("only an explicit clean read is clean", () => {
  assert.equal(svc.classifyRecoveryDnc({ onNationalDNC: false, onStateDNC: false, isLitigator: false }).result, "clean");
});

test("ANY hit signal terminates", () => {
  for (const [payload, reason] of [
    [{ isLitigator: true }, "known-litigator"],
    [{ onNationalDNC: true }, "national-dnc"],
    [{ onStateDNC: true }, "state-dnc"],
    // A hit wins even when the other flags read clean.
    [{ isLitigator: true, onNationalDNC: false, onStateDNC: false }, "known-litigator"],
  ]) {
    const v = svc.classifyRecoveryDnc(payload);
    assert.equal(v.result, "hit", JSON.stringify(payload));
    assert.equal(v.reason, reason);
  }
});

test("a missing, empty or partial answer is FAILED — never clean", () => {
  // The one thing this function must never do is turn "I could not tell" into
  // permission. Absence of a hit is not evidence of a clean read.
  for (const payload of [
    null,
    undefined,
    {},
    "ok",
    0,
    { someOtherField: true },
    { onNationalDNC: false },
    { onNationalDNC: false, onStateDNC: false },
    { onNationalDNC: false, isLitigator: false },
    { onStateDNC: false, isLitigator: false },
    { status: "skipped", skipped: true, onNationalDNC: false, onStateDNC: false, isLitigator: false },
    { status: "invalid", onNationalDNC: false, onStateDNC: false, isLitigator: false },
    { status: "ok", error: "provider-error", onNationalDNC: false, onStateDNC: false, isLitigator: false },
    { mode: "dnc-lookup", status: "ok", dncFieldsComplete: false, onNationalDNC: false, onStateDNC: false, isLitigator: false },
  ]) {
    assert.equal(svc.classifyRecoveryDnc(payload).result, "failed", JSON.stringify(payload));
  }
});

test("there is NO grace window — unlike the cadence recheck", () => {
  // dncRecheckService grants fresh leads a 30-day TrustedForm grace, because a
  // lead that just filled in a form has consent that outranks a stale list
  // entry. A recovery episode is the opposite: an old mail prospect with no
  // recent consent artefact, dialled months later. A hit terminates, full stop.
  const src = require("fs").readFileSync(
    require.resolve("../../packages/shared-services/src/callRecoveryDncSweepService"), "utf8");
  assert.ok(!/GRACE_WINDOW|isPastGrace|pastGrace/.test(src),
    "a grace window must not reappear in the recovery sweep");
});

test("checkpoints run 30/60/90 from the FIRST call, then stop", () => {
  const day = (n) => new Date(FIRST.getTime() + n * 86400000);
  assert.deepEqual(svc.nextCheckpointAt(FIRST, day(1)), day(30));
  assert.deepEqual(svc.nextCheckpointAt(FIRST, day(31)), day(60));
  assert.deepEqual(svc.nextCheckpointAt(FIRST, day(61)), day(90));
  // Past day 90 there is no next check — expiry takes it. A recheck booked
  // beyond day 120 would imply the program outlives its own clock.
  assert.equal(svc.nextCheckpointAt(FIRST, day(91)), null);
  assert.equal(svc.nextCheckpointAt(null, NOW), null);
});

// ── the sweep itself ──────────────────────────────────────────────────────

function repo({ due = [], fresh = [] } = {}) {
  const recorded = [];
  const transitions = [];
  return {
    recorded,
    transitions,
    async listDncCheckpointsDue() { return due; },
    async listEpisodesForConsideration() { return fresh; },
    async recordDncResult(id, patch) { recorded.push({ id, ...patch }); return { ok: true }; },
    async transitionState(id, patch) { transitions.push({ id, ...patch }); return { ok: true }; },
  };
}

const EPISODE = (over = {}) => ({
  episodeId: "ep:1", state: "eligible", normalizedPhone: "7249674387",
  firstQualifyingCallAt: FIRST, dnc: { result: "unknown" }, ...over,
});

test("a hit terminates the episode and books no recheck", async () => {
  const r = repo({ fresh: [EPISODE()] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true,
    client: { lookupDnc: async () => ({ onNationalDNC: true }) },
  });
  assert.equal(out.hit, 1);
  assert.equal(out.terminated, 1);
  assert.equal(r.recorded[0].result, "hit");
  assert.equal(r.recorded[0].nextCheckAt, null, "a dead episode must not stay in the sweep");
  assert.equal(r.transitions[0].to, "terminal");
});

test("a clean result books the next checkpoint and terminates nothing", async () => {
  const r = repo({ fresh: [EPISODE()] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true,
    client: { lookupDnc: async () => ({ onNationalDNC: false, onStateDNC: false, isLitigator: false }) },
  });
  assert.equal(out.clean, 1);
  assert.equal(out.terminated, 0);
  assert.equal(r.recorded[0].result, "clean");
  assert.ok(r.recorded[0].nextCheckAt instanceof Date);
});

test("a provider failure records FAILED and terminates nothing", async () => {
  const r = repo({ fresh: [EPISODE()] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true,
    client: { lookupDnc: async () => { throw new Error("RealValidation 503"); } },
  });
  assert.equal(out.failed, 1);
  assert.equal(out.errors, 1);
  assert.equal(r.recorded[0].result, "failed");
  assert.equal(out.terminated, 0, "an outage must not terminate anybody");
  assert.notEqual(r.recorded[0].result, "clean");
});

test("dry mode looks everything up and records nothing", async () => {
  // So the hit rate can be measured before a single episode is terminated.
  const r = repo({ fresh: [EPISODE(), EPISODE({ episodeId: "ep:2" })] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: false,
    client: { lookupDnc: async () => ({ onNationalDNC: true }) },
  });
  assert.equal(out.checked, 2);
  assert.equal(out.hit, 2);
  assert.equal(r.recorded.length, 0);
  assert.equal(r.transitions.length, 0);
});

test("an episode is never swept twice in one pass", async () => {
  const dup = EPISODE();
  const r = repo({ due: [dup], fresh: [dup] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true,
    client: { lookupDnc: async () => ({ onNationalDNC: false, onStateDNC: false, isLitigator: false }) },
  });
  assert.equal(out.considered, 1, "the two populations must be deduped");
  assert.equal(r.recorded.length, 1);
});

test("an already-checked episode is not re-swept as if fresh", async () => {
  const r = repo({ fresh: [EPISODE({ dnc: { result: "clean", checkedAt: NOW } })] });
  const out = await svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true,
    client: { lookupDnc: async () => ({ onNationalDNC: false }) },
  });
  assert.equal(out.considered, 0, "only unknown-result episodes count as fresh work");
});

// ── the three cadences, kept discrete ─────────────────────────────────────
//
// Mickey 2026-07-31: "it needs its own discrete load-in check but then after
// that should just get monthly hygiene. also needs to check logics dnc once a
// day."

test("load-in mode checks ONLY never-checked episodes", () => {
  // The discrete gate. It must be runnable and measurable on its own, before
  // any recheck machinery is armed.
  const r = repo({
    due: [EPISODE({ episodeId: "ep:due", dnc: { result: "clean" } })],
    fresh: [EPISODE({ episodeId: "ep:new" })],
  });
  return svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true, mode: "load-in",
    client: { lookupDnc: async () => ({ onNationalDNC: false, onStateDNC: false, isLitigator: false }) },
  }).then((out) => {
    assert.equal(out.considered, 1);
    assert.equal(r.recorded[0].id, "ep:new", "a due recheck is not a load-in check");
  });
});

test("monthly mode checks ONLY episodes at a checkpoint", () => {
  const r = repo({
    due: [EPISODE({ episodeId: "ep:due", dnc: { result: "clean" } })],
    fresh: [EPISODE({ episodeId: "ep:new" })],
  });
  return svc.runCallRecoveryDncSweep({
    repository: r, now: NOW, apply: true, mode: "monthly",
    client: { lookupDnc: async () => ({ onNationalDNC: false, onStateDNC: false, isLitigator: false }) },
  }).then((out) => {
    assert.equal(out.considered, 1);
    assert.equal(r.recorded[0].id, "ep:due", "a never-checked episode is not a monthly recheck");
  });
});

test("an unknown sweep mode is refused, not silently treated as 'all'", () => {
  assert.rejects(() => svc.runCallRecoveryDncSweep({ repository: repo(), mode: "everything" }),
    /unknown sweep mode/);
});

// ── the daily Logics DNC check ────────────────────────────────────────────

test("the daily Logics check covers ONLY episodes not yet in the pool", async () => {
  // Anything with a work item is already covered by refreshQueuedLeadStatuses,
  // which walks leaddeliveryitems nightly at maxAgeHours=20. Re-checking those
  // here would be duplicated work against the same mirror.
  const r = repo();
  r.listEpisodesForConsideration = async () => [
    EPISODE({ episodeId: "ep:pending" }),
    EPISODE({ episodeId: "ep:in-pool", linkedLeadDeliveryItemId: "item-1" }),
  ];
  const asked = [];
  const out = await svc.runCallRecoveryLogicsDncCheck({
    repository: r, now: NOW, apply: true,
    readCaseDnc: async ({ caseId }) => { asked.push(caseId); return false; },
  });
  assert.equal(out.considered, 1);
  assert.equal(asked.length, 1, "an item already in the pool must not be re-checked here");
});

test("only an explicit DNC=true terminates — an outage destroys no inventory", async () => {
  const r = repo();
  r.listEpisodesForConsideration = async () => [EPISODE()];
  for (const answer of [null, undefined, false, "yes", 1]) {
    r.transitions.length = 0;
    const out = await svc.runCallRecoveryLogicsDncCheck({
      repository: r, now: NOW, apply: true, readCaseDnc: async () => answer,
    });
    assert.equal(out.terminated, 0, `${JSON.stringify(answer)} must not terminate`);
  }
  r.transitions.length = 0;
  const hit = await svc.runCallRecoveryLogicsDncCheck({
    repository: r, now: NOW, apply: true, readCaseDnc: async () => true,
  });
  assert.equal(hit.terminated, 1);
  assert.equal(r.transitions[0].reason, "logics-dnc");
});

test("a failed Logics read is counted, not fatal, and does not terminate", async () => {
  const r = repo();
  r.listEpisodesForConsideration = async () => [EPISODE(), EPISODE({ episodeId: "ep:2" })];
  let call = 0;
  const out = await svc.runCallRecoveryLogicsDncCheck({
    repository: r, now: NOW, apply: true,
    readCaseDnc: async () => { call += 1; if (call === 1) throw new Error("Logics 503"); return true; },
  });
  assert.equal(out.errors, 1);
  assert.equal(out.terminated, 1, "the healthy one still resolves");
});
