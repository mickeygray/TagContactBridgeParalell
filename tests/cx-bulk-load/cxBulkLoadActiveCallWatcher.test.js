"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  matchActiveCallToCandidates,
  deriveCurrentTransition,
  deriveReleasedCandidates,
  deriveCurrentRelease,
  loadActiveCallsSnapshot,
  normalizeActiveCall,
} = require("../../packages/shared-services/src/cxBulkLoadActiveCallWatcher");

function candidate(queueItemId, externId) {
  return { queueItemId, externId, ringcx: { externId } };
}

// ── release diff (M11 gate 1) ─────────────────────────────────────────────
test("deriveReleasedCandidates flags a buffer lead active last poll but gone this poll", () => {
  const pool = [candidate("q1", "cxbl-tag-q1"), candidate("q2", "cxbl-tag-q2")];
  const { released, nextActiveExternIds, nextActiveCalls } = deriveReleasedCandidates({
    prevActiveCalls: [{ externalId: "cxbl-tag-q1", uii: "u1" }], // q1 was active last poll
    activeCalls: [{ externalId: "cxbl-tag-q2", uii: "u2" }], // now q2 is active, q1 dialed+released between polls
    pool,
  });
  assert.equal(released.length, 1);
  assert.equal(released[0].queueItemId, "q1");
  assert.equal(released[0].uii, "u1");
  assert.deepEqual(nextActiveExternIds, ["cxbl-tag-q2"]);
  assert.deepEqual(nextActiveCalls, [{ externId: "cxbl-tag-q2", uii: "u2", callState: null, dnis: null, ani: null, agentId: null }]);
});

test("deriveReleasedCandidates does not count a prior active shell without UII", () => {
  const pool = [candidate("q1", "cxbl-tag-q1")];
  const { released } = deriveReleasedCandidates({
    prevActiveCalls: [{ externalId: "cxbl-tag-q1" }],
    activeCalls: [],
    pool,
  });
  assert.equal(released.length, 0);
});

test("deriveReleasedCandidates returns nothing when the active set is unchanged", () => {
  const { released } = deriveReleasedCandidates({
    prevActiveExternIds: ["cxbl-tag-q1"],
    activeCalls: [{ externalId: "cxbl-tag-q1" }],
    pool: [candidate("q1", "cxbl-tag-q1")],
  });
  assert.equal(released.length, 0);
});

test("deriveReleasedCandidates ignores a released externId that is not in the pool", () => {
  const { released } = deriveReleasedCandidates({
    prevActiveExternIds: ["cxbl-tag-gone"],
    activeCalls: [],
    pool: [candidate("q1", "cxbl-tag-q1")],
  });
  assert.equal(released.length, 0);
});

test("deriveCurrentRelease flags current active last poll but gone this poll", () => {
  const released = deriveCurrentRelease({
    current: candidate("q1", "cxbl-tag-q1"),
    prevActiveCalls: [{ externalId: "cxbl-tag-q1", uii: "u1" }],
    activeCalls: [],
  });
  assert.equal(released.queueItemId, "q1");
  assert.equal(released.uii, "u1");
});

test("deriveCurrentRelease does not release a current that is still active", () => {
  const released = deriveCurrentRelease({
    current: candidate("q1", "cxbl-tag-q1"),
    prevActiveCalls: [{ externalId: "cxbl-tag-q1", uii: "u1" }],
    activeCalls: [{ externalId: "cxbl-tag-q1", uii: "u1" }],
  });
  assert.equal(released, null);
});

// ── matcher ─────────────────────────────────────────────────────────────
test("no live calls -> empty", () => {
  const r = matchActiveCallToCandidates([], [candidate("q1", "x1")]);
  assert.equal(r.status, "empty");
});

test("matches a live call to its candidate by externId", () => {
  const calls = [{ externalId: "x1", uii: "u1", callState: "connected" }];
  const r = matchActiveCallToCandidates(calls, [candidate("q1", "x1"), candidate("q2", "x2")]);
  assert.equal(r.status, "matched");
  assert.equal(r.candidate.queueItemId, "q1");
  assert.deepEqual(r.matchReasons, ["externId"]);
  assert.equal(r.activeCall.uii, "u1");
});

test("a live call with no identity match is ambiguous, NEVER promoted on phone alone", () => {
  // call carries a phone that equals a candidate's, but no externId match
  const calls = [{ externalId: "unknown", dnis: "5551234567", uii: "u9" }];
  const cands = [{ queueItemId: "q1", externId: "x1", phoneLast4: "4567" }];
  const r = matchActiveCallToCandidates(calls, cands);
  assert.equal(r.status, "ambiguous");
});

test("two different candidates matched at once is ambiguous (no guess)", () => {
  const calls = [
    { externalId: "x1", uii: "u1" },
    { externalId: "x2", uii: "u2" },
  ];
  const r = matchActiveCallToCandidates(calls, [candidate("q1", "x1"), candidate("q2", "x2")]);
  assert.equal(r.status, "ambiguous");
});

// ── transition ──────────────────────────────────────────────────────────
test("no match -> kind none (current untouched)", () => {
  const t = deriveCurrentTransition({ queueItemId: "q1" }, { status: "empty" });
  assert.equal(t.kind, "none");
});

test("match with no current -> switch, no completePrevious", () => {
  const match = { status: "matched", candidate: candidate("q1", "x1"), activeCall: { uii: "u1" }, matchReasons: ["externId"] };
  const t = deriveCurrentTransition(null, match);
  assert.equal(t.kind, "switch");
  assert.equal(t.completePrevious, false);
  assert.equal(t.candidate.queueItemId, "q1");
  assert.equal(t.uii, "u1");
});

test("match equal to current -> same (refresh only)", () => {
  const match = { status: "matched", candidate: candidate("q1", "x1"), activeCall: { uii: "u1b" }, matchReasons: ["externId"] };
  const t = deriveCurrentTransition({ queueItemId: "q1" }, match);
  assert.equal(t.kind, "same");
  assert.equal(t.uii, "u1b");
});

test("match different from current -> switch completes prior as did_not_connect (M11 gate 9)", () => {
  const match = { status: "matched", candidate: candidate("q2", "x2"), activeCall: { uii: "u2" }, matchReasons: ["externId"] };
  const t = deriveCurrentTransition({ queueItemId: "q1" }, match);
  assert.equal(t.kind, "switch");
  assert.equal(t.completePrevious, true);
  // The departing lead's cadence outcome is did_not_connect; the synthetic label survives
  // only as a separate debug reason, never as the outcome.
  assert.equal(t.previousOutcome, "did_not_connect");
  assert.equal(t.previousReason, "cx-auto-advanced");
  assert.equal(t.candidate.queueItemId, "q2");
});

// ── thin I/O ────────────────────────────────────────────────────────────
test("loadActiveCallsSnapshot normalizes the client response shape", async () => {
  const fakeClient = {
    listActiveCalls: async () => ({ activeCalls: [{ externalId: "x1", uii: "u1", dnis: "5551112222" }] }),
  };
  const snapshot = await loadActiveCallsSnapshot(fakeClient, { accountId: "acct1" });
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].externId, "x1");
  assert.equal(snapshot[0].uii, "u1");
});

test("loadActiveCallsSnapshot tolerates a bare-array response", async () => {
  const fakeClient = { listActiveCalls: async () => [{ externalId: "x9" }] };
  const snapshot = await loadActiveCallsSnapshot(fakeClient, {});
  assert.equal(snapshot[0].externId, "x9");
});

test("normalizeActiveCall maps externalId/uii/dnis aliases", () => {
  const n = normalizeActiveCall({ outboundExternid: "xZ", uii: "uZ", dnisE164: "+15550000" });
  assert.equal(n.externId, "xZ");
  assert.equal(n.uii, "uZ");
  assert.equal(n.dnis, "+15550000");
});
