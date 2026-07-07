"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCxAccountActiveCallWatchPlan,
  groupBulkSessionsByAccount,
  projectBulkSessionFromAccountSnapshot,
  runCxAccountActiveCallWatchOnce,
} = require("../../packages/shared-services/src/cxAccountActiveCallWatcherService");

function session(id, accountId, buffer = [], current = null) {
  return {
    sessionId: id,
    status: "running",
    phase: current ? "active" : "ready",
    agentEmail: `${id}@example.test`,
    agentExtensionId: id,
    domain: "TAG",
    ringcx: { accountId },
    current,
    acceptedBuffer: buffer,
    completed: [],
    stats: {},
    trace: {},
  };
}

function candidate(queueItemId, externId) {
  return {
    queueItemId,
    caseId: Number(queueItemId.replace(/\D/g, "")) || 1,
    domain: "TAG",
    name: `Lead ${queueItemId}`,
    externId,
    ringcx: { externId },
  };
}

test("groupBulkSessionsByAccount groups sessions by RingCX account and reports missing account ids", () => {
  const grouped = groupBulkSessionsByAccount([
    session("s1", "acct-a"),
    session("s2", "acct-a"),
    session("s3", "acct-b"),
    { sessionId: "missing", status: "running" },
  ]);

  assert.equal(grouped.byAccount.get("acct-a").length, 2);
  assert.equal(grouped.byAccount.get("acct-b").length, 1);
  assert.deepEqual(grouped.skipped, [{ sessionId: "missing", reason: "missing-account-id" }]);
});

test("projectBulkSessionFromAccountSnapshot promotes the matched candidate without terminal writes", () => {
  const s = session("s1", "acct-a", [candidate("q1", "cxbl-q1")]);
  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [{ externalId: "cxbl-q1", uii: "u1", callState: "ACTIVE", ani: "5551112222" }],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.changed, true);
  assert.equal(projected.transitionKind, "switch");
  assert.equal(projected.after.current.queueItemId, "q1");
  assert.equal(projected.after.current.uii, "u1");
  assert.equal(projected.after.acceptedBuffer.length, 0);
  assert.equal(projected.after.completed.length, 0);
  assert.equal(projected.after.trace.accountActiveCallWatcher.activeCallCount, 1);
  assert.equal(projected.after.trace.prevActiveCalls[0].externId, "cxbl-q1");
  assert.equal(projected.after.trace.prevActiveCalls[0].ani, "5551112222");
});

test("WO-2 injected external candidates are ignored by the account watcher", async () => {
  const writes = [];
  const servingAttempts = [];
  let resolverCalls = 0;
  const s1 = session("s1", "acct-a", []);
  const externalOnly = candidate("q-ext", "cxbl-external-only");
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { writes.push({ sessionId, patch }); return patch; },
  };
  const client = { async listActiveCalls() { return [{ externalId: "cxbl-external-only", uii: "u-ext" }]; } };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    resolveExternalCandidates: async () => {
      resolverCalls += 1;
      return [{ ...externalOnly, adoption: { source: "ringcx-active-external-id" } }];
    },
    queueStateAdapter: {
      async markCandidateServing(input) {
        servingAttempts.push(input);
        return { ok: true };
      },
      async markAdoptedCandidateServing() {
        throw new Error("WO-2 disabled adoption path should not be called");
      },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(resolverCalls, 0);
  assert.equal(servingAttempts.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(result.summary.changedCount, 0);
  assert.equal(result.applied.writeCount, 0);
});

test("WO-3 watcher never phone-attaches an active call", async () => {
  const writes = [];
  const servingAttempts = [];
  const phoneOnly = { ...candidate("q9", "cxbl-q9"), phone: "5551112222" };
  const s1 = session("s1", "acct-a", [phoneOnly]);
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { writes.push({ sessionId, patch }); return patch; },
  };
  // Active call shares the candidate's phone digits but matches no externId/queueItemId/uii.
  const client = {
    async listActiveCalls() {
      return [{ externalId: "parallel:TAG:999:legacy", uii: "u-phone", ani: "5551112222", callState: "ACTIVE" }];
    },
  };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    queueStateAdapter: {
      async markCandidateServing(input) {
        servingAttempts.push(input);
        return { ok: true };
      },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(servingAttempts.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(result.summary.changedCount, 0);
  assert.equal(result.applied.writeCount, 0);
});


test("TRUNK: a connected current dropped by RingCX wraps — no outcome, current held", () => {
  const current = { ...candidate("q1", "cxbl-q1"), uii: "u1", connectedAt: "2026-06-23T11:59:00.000Z" };
  const s = {
    ...session("s1", "acct-a", [candidate("q2", "cxbl-q2")], current),
    prevActiveExternIds: ["cxbl-q1"],
    trace: {
      prevActiveCalls: [{ externId: "cxbl-q1", externalId: "cxbl-q1", uii: "u1" }],
    },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.changed, true);
  assert.equal(projected.terminalObservations.length, 0, "call end is NOT an outcome for a touched call");
  assert.equal(projected.after.current.queueItemId, "q1", "current is HELD, not cleared");
  assert.equal(projected.after.current.uii, "u1");
  assert.equal(projected.after.current.wrap.reason, "ringcx-current-released");
  assert.equal(projected.after.completed.length, 0);
});

test("TRUNK: a wrapped current holds steady on the next tick (no duplicate processing)", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    wrap: { at: "2026-06-23T11:59:30.000Z", reason: "ringcx-current-released" },
  };
  const s = {
    ...session("s1", "acct-a", [], current),
    prevActiveExternIds: [],
    trace: { prevActiveCalls: [] },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.changed, false, "inside the entry window nothing changes");
  assert.equal(projected.terminalObservations.length, 0);
  assert.equal(projected.after.current.queueItemId, "q1");
  assert.equal(projected.after.current.wrap.at, "2026-06-23T11:59:30.000Z");
});

test("TRUNK: wrap timeout is the walk-away guard — expiry records ANSWERED (the machine knows)", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    connectedAt: "2026-06-23T11:55:00.000Z",
    wrap: { at: "2026-06-23T11:56:00.000Z", reason: "ringcx-current-released" },
  };
  const s = {
    ...session("s1", "acct-a", [], current),
    prevActiveExternIds: [],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:00:00.000Z"), wrapTimeoutMs: 180000 }, // 240s > explicit 180s
  );

  assert.equal(projected.changed, true);
  assert.equal(projected.terminalObservations.length, 1);
  assert.equal(projected.terminalObservations[0].source, "wrap-timeout");
  assert.equal(projected.terminalObservations[0].outcome, "answered", "walked-away answered call records answered");
  assert.equal(projected.after.current, null);
  assert.equal(projected.after.completed[0].queueItemId, "q1");
});

test("TRUNK→JANITOR: wrap holds at human timescales; an ABANDONED wrap self-resolves at the 30-min janitor default", () => {
  // SUPERSEDES the hold-forever pin (Mickey's auto-opt-out ruling, 2026-07-06: "if someone
  // gets lazy or something gets stuck there's a mechanism to clean things up"). The agent's
  // click is still the record any time BEFORE the janitor line; only a walked-away wrap
  // gets machine-resolved, loudly, via the answered guard (source wrap-timeout).
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    wrap: { at: "2026-06-23T11:56:00.000Z", reason: "ringcx-current-released" },
  };
  const s = {
    ...session("s1", "acct-a", [], current),
    prevActiveExternIds: [],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };

  // 14 minutes into the wrap: HELD — buttons live, no writes, the human owns the moment.
  const held = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:10:00.000Z") },
  );
  assert.equal(held.changed, false);
  assert.equal(held.terminalObservations.length, 0);
  assert.equal(held.after.current.queueItemId, "q1");
  assert.equal(held.after.current.wrap.at, "2026-06-23T11:56:00.000Z");

  // 34 minutes in: the janitor resolves the abandoned wrap — never-connected fixture
  // (no connectedAt) classifies did_not_connect through the guard, source wrap-timeout.
  const swept = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:30:00.000Z") },
  );
  assert.equal(swept.changed, true);
  assert.equal(swept.after.current, null);
  assert.equal(swept.after.completed.length, 1);
  assert.equal(swept.terminalObservations.length, 1);
  assert.equal(swept.terminalObservations[0].source, "wrap-timeout");
  assert.equal(swept.terminalObservations[0].outcome, "did_not_connect");
});

test("TRUNK: a reappearing call clears the wrap flag (resume)", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    wrap: { at: "2026-06-23T11:59:30.000Z", reason: "ringcx-current-released" },
  };
  const s = {
    ...session("s1", "acct-a", [], current),
    prevActiveExternIds: [],
    trace: { prevActiveCalls: [] },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [{ externalId: "cxbl-q1", uii: "u1", callState: "ACTIVE" }],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.after.current.wrap, null, "resumed call is live again");
  assert.equal(projected.terminalObservations.length, 0);
});

test("TRUNK: a never-connected current (no uii) still releases immediately — the machine's own outcome", () => {
  const current = { ...candidate("q1", "cxbl-q1") }; // no uii: no human ever touched it
  const s = {
    ...session("s1", "acct-a", [candidate("q2", "cxbl-q2")], current),
    prevActiveExternIds: ["cxbl-q1"],
    trace: {
      prevActiveCalls: [{ externId: "cxbl-q1", externalId: "cxbl-q1", uii: "u1" }],
    },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.changed, true);
  assert.equal(projected.after.current, null, "untouched calls auto-release as before");
  assert.equal(projected.after.completed.length, 1);
  assert.equal(projected.after.completed[0].queueItemId, "q1");
});

test("projectBulkSessionFromAccountSnapshot respects a review hold before promoting the next active call", () => {
  const held = {
    ...session("s1", "acct-a", [candidate("q2", "cxbl-q2")], null),
    lastOutcome: { ...candidate("q1", "cxbl-q1"), uii: "u1", outcome: "did_not_connect" },
    reviewHoldUntil: "2026-06-23T12:00:03.000Z",
  };

  const duringHold = projectBulkSessionFromAccountSnapshot(
    held,
    [{ externalId: "cxbl-q2", uii: "u2", callState: "ACTIVE" }],
    { now: new Date("2026-06-23T12:00:01.000Z") },
  );

  assert.equal(duringHold.changed, true);
  assert.equal(duringHold.matchStatus, "held-review");
  assert.equal(duringHold.after.current, null);
  assert.equal(duringHold.after.acceptedBuffer.length, 1);
  assert.equal(duringHold.after.acceptedBuffer[0].queueItemId, "q2");
  assert.equal(duringHold.after.trace.prevActiveCalls[0].externId, "cxbl-q2");

  const afterHold = projectBulkSessionFromAccountSnapshot(
    duringHold.after,
    [{ externalId: "cxbl-q2", uii: "u2", callState: "ACTIVE" }],
    { now: new Date("2026-06-23T12:00:04.000Z") },
  );

  assert.equal(afterHold.matchStatus, "matched");
  assert.equal(afterHold.after.current.queueItemId, "q2");
  assert.equal(afterHold.after.current.uii, "u2");
  assert.equal(afterHold.after.reviewHoldUntil, null);
});

test("buildCxAccountActiveCallWatchPlan calls RingCX once per account and fans out to sessions", async () => {
  const calls = [];
  const client = {
    async listActiveCalls(options) {
      calls.push(options);
      if (options.productId === "acct-a") {
        return [{ externalId: "cxbl-q1", uii: "u1" }];
      }
      return [{ externalId: "cxbl-q3", uii: "u3" }];
    },
  };

  const plan = await buildCxAccountActiveCallWatchPlan({
    client,
    sessions: [
      session("s1", "acct-a", [candidate("q1", "cxbl-q1")]),
      session("s2", "acct-a", [candidate("q2", "cxbl-q2")]),
      session("s3", "acct-b", [candidate("q3", "cxbl-q3")]),
    ],
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.productId).sort(), ["acct-a", "acct-b"]);
  assert.equal(plan.summary.accountCount, 2);
  assert.equal(plan.summary.sessionCount, 3);
  assert.equal(plan.projections.length, 3);
  assert.equal(plan.projections.find((p) => p.sessionId === "s1").currentUii, "u1");
  assert.equal(plan.projections.find((p) => p.sessionId === "s2").matchStatus, "empty");
  assert.equal(plan.projections.find((p) => p.sessionId === "s3").currentUii, "u3");
});

test("account watcher updates multiple agents from one account snapshot without cross-agent churn", async () => {
  const calls = [];
  const client = {
    async listActiveCalls(options) {
      calls.push(options);
      return [
        { externalId: "cxbl-sean-q1", uii: "u-sean" },
        { externalId: "cxbl-brad-q1", uii: "u-brad" },
        { externalId: "cxbl-unrelated-q1", uii: "u-unrelated" },
      ];
    },
  };

  const plan = await buildCxAccountActiveCallWatchPlan({
    client,
    sessions: [
      session("sean", "acct-a", [candidate("q1", "cxbl-sean-q1")]),
      session("brad", "acct-a", [candidate("q2", "cxbl-brad-q1")]),
    ],
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(plan.summary.changedCount, 2);
  assert.equal(plan.projections.find((p) => p.sessionId === "sean").currentUii, "u-sean");
  assert.equal(plan.projections.find((p) => p.sessionId === "brad").currentUii, "u-brad");
  assert.equal(plan.projections.find((p) => p.sessionId === "sean").relevantActiveCallCount, 1);
  assert.equal(plan.projections.find((p) => p.sessionId === "brad").relevantActiveCallCount, 1);
});

test("account watcher isolates an account read failure and keeps other accounts useful", async () => {
  const client = {
    async listActiveCalls(options) {
      if (options.productId === "acct-a") throw new Error("429 account throttle");
      return [{ externalId: "cxbl-q2", uii: "u2" }];
    },
  };

  const plan = await buildCxAccountActiveCallWatchPlan({
    client,
    sessions: [
      session("s1", "acct-a", [candidate("q1", "cxbl-q1")]),
      session("s2", "acct-b", [candidate("q2", "cxbl-q2")]),
    ],
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(plan.summary.accountCount, 2);
  assert.equal(plan.summary.errorCount, 1);
  assert.equal(plan.projections.find((p) => p.sessionId === "s1").changed, false);
  assert.match(plan.projections.find((p) => p.sessionId === "s1").error, /429/);
  assert.equal(plan.projections.find((p) => p.sessionId === "s2").currentUii, "u2");
});

test("runCxAccountActiveCallWatchOnce writes only changed sessions", async () => {
  const writes = [];
  const s1 = session("s1", "acct-a", [candidate("q1", "cxbl-q1")]);
  const s2 = session("s2", "acct-a", [candidate("q2", "cxbl-q2")]);
  const sessionRepository = {
    async listActiveBulkLoadSessions() {
      return [s1, s2];
    },
    async updateBulkLoadSession(sessionId, patch) {
      writes.push({ sessionId, patch });
      return patch;
    },
  };
  const client = {
    async listActiveCalls() {
      return [{ externalId: "cxbl-q1", uii: "u1" }];
    },
  };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(result.applied.writeCount, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "s1");
  assert.equal(writes[0].patch.current.queueItemId, "q1");
  assert.equal(writes[0].patch.current.uii, "u1");
});

test("runCxAccountActiveCallWatchOnce skips only busy sessions and still updates others", async () => {
  const writes = [];
  const sean = session("sean", "acct-a", [candidate("q1", "cxbl-sean-q1")]);
  const brad = session("brad", "acct-a", [candidate("q2", "cxbl-brad-q1")]);
  const sessionRepository = {
    async listActiveBulkLoadSessions() {
      return [sean, brad];
    },
    async updateBulkLoadSession(sessionId, patch) {
      writes.push({ sessionId, patch });
      return patch;
    },
  };
  const client = {
    async listActiveCalls() {
      return [
        { externalId: "cxbl-sean-q1", uii: "u-sean" },
        { externalId: "cxbl-brad-q1", uii: "u-brad" },
      ];
    },
  };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    skipSessionIds: ["sean"],
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(result.applied.writeCount, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sessionId, "brad");
  assert.equal(writes[0].patch.current.queueItemId, "q2");
  assert.equal(writes[0].patch.current.uii, "u-brad");
  assert.equal(result.applied.skippedCount, 1);
  assert.equal(result.applied.skipped[0].sessionId, "sean");
  assert.equal(result.applied.skipped[0].reason, "session-busy");
});

test("runCxAccountActiveCallWatchOnce requires the serving ownership stamp before current promotion", async () => {
  const writes = [];
  const servingAttempts = [];
  const s1 = session("s1", "acct-a", [candidate("q1", "cxbl-q1")]);
  const sessionRepository = {
    async listActiveBulkLoadSessions() {
      return [s1];
    },
    async updateBulkLoadSession(sessionId, patch) {
      writes.push({ sessionId, patch });
      return patch;
    },
  };
  const client = {
    async listActiveCalls() {
      return [{ externalId: "cxbl-q1", uii: "u1" }];
    },
  };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    queueStateAdapter: {
      async markCandidateServing(input) {
        servingAttempts.push(input);
        return null;
      },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(servingAttempts.length, 1);
  assert.equal(servingAttempts[0].candidate.queueItemId, "q1");
  assert.equal(writes.length, 0);
  assert.equal(result.applied.writeCount, 0);
  assert.equal(result.applied.skippedCount, 1);
  assert.equal(result.applied.skipped[0].reason, "serving-ownership-stamp-miss");
});

test("runCxAccountActiveCallWatchOnce writes terminal observations for released UIIs (wrap expired)", async () => {
  const writes = [];
  const terminalWrites = [];
  // TRUNK: a connected current only terminals after its wrap window expires —
  // seed an already-expired wrap so the persistence pipeline runs this tick.
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    wrap: { at: "2026-06-23T11:56:00.000Z", reason: "ringcx-current-released" },
  };
  const s1 = {
    ...session("s1", "acct-a", [], current),
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() {
      return [s1];
    },
    async updateBulkLoadSession(sessionId, patch) {
      writes.push({ sessionId, patch });
      return patch;
    },
  };
  const client = {
    async listActiveCalls() {
      return [];
    },
  };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    wrapTimeoutMs: 180000,
    outcomeAdapter: {
      async persistTerminalOutcome(input) {
        terminalWrites.push(input);
        return { written: true };
      },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].source, "wrap-timeout");
  assert.equal(terminalWrites[0].candidate.queueItemId, "q1");
  assert.equal(terminalWrites[0].candidate.uii, "u1");
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch.current, null);
  assert.equal(result.applied.terminalWriteCount, 1);
});

test("a different active call while current exists terminalizes prior current before promotion", async () => {
  const writes = [];
  const terminalWrites = [];
  const current = { ...candidate("q1", "cxbl-q1"), uii: "u1" };
  const s1 = session("s1", "acct-a", [candidate("q2", "cxbl-q2")], current);
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { writes.push({ sessionId, patch }); return patch; },
  };
  const client = { async listActiveCalls() { return [{ externalId: "cxbl-q2", uii: "u2" }]; } };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    queueStateAdapter: { async markCandidateServing() { return null; } }, // CAS miss for B
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(result.applied.skippedCount, 1, "incoming promotion still requires the serving CAS");
  assert.equal(result.applied.skipped[0].reason, "serving-ownership-stamp-miss");
  assert.equal(writes.length, 0, "the incoming lead is not promoted when its serving stamp misses");
  assert.equal(terminalWrites.length, 1, "the departed current is still terminalized");
  assert.equal(terminalWrites[0].source, "active-call-switch");
  assert.equal(terminalWrites[0].candidate.queueItemId, "q1");
  assert.equal(terminalWrites[0].candidate.uii, "u1");
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
});

test("#10 a stale projection is rejected BEFORE the serving CAS fires (no orphan serving stamp)", async () => {
  // loadLatestState reports a newer __v than the projection was built from -> the promotion is
  // stale; the serving stamp (a Mongo side-effect) must NOT fire and no session write happens.
  const writes = [];
  const servingAttempts = [];
  const s1 = { ...session("s1", "acct-a", [candidate("q1", "cxbl-q1")]), __v: 1 };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { writes.push({ sessionId, patch }); return patch; },
  };
  const client = { async listActiveCalls() { return [{ externalId: "cxbl-q1", uii: "u1" }]; } };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    loadLatestState: async () => ({ ...s1, __v: 2 }), // concurrent mutation bumped the version
    queueStateAdapter: { async markCandidateServing(input) { servingAttempts.push(input); return { ok: true }; } },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(servingAttempts.length, 0, "serving stamp must not fire on a stale projection");
  assert.equal(writes.length, 0, "no session write on a stale projection");
  assert.equal(result.applied.skipped[0].reason, "stale-projection-apply");
});

test("#10 happy path: latest __v matches -> the serving CAS fires once and the session writes", async () => {
  const writes = [];
  const servingAttempts = [];
  const s1 = { ...session("s1", "acct-a", [candidate("q1", "cxbl-q1")]), __v: 5 };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { writes.push({ sessionId, patch }); return patch; },
  };
  const client = { async listActiveCalls() { return [{ externalId: "cxbl-q1", uii: "u1" }]; } };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    loadLatestState: async () => ({ ...s1, __v: 5 }), // unchanged
    queueStateAdapter: { async markCandidateServing(input) { servingAttempts.push(input); return { ok: true }; } },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(servingAttempts.length, 1);
  assert.equal(writes.length, 1);
  assert.equal(result.applied.writeCount, 1);
});

test("#6 a version-miss on a released current re-reads + re-projects terminal evidence", async () => {
  // A is current and RingCX omits it. The first session write version-misses (a concurrent
  // writer bumped __v); the retry re-reads the latest row, re-projects against the same empty active
  // snapshot, and still writes the release without dropping terminal evidence.
  const writes = [];
  const terminalWrites = [];
  // TRUNK: the #6 machinery is exercised via an expired wrap (the terminal path
  // for a connected current) — the version-miss retry semantics are unchanged.
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    wrap: { at: "2026-06-23T11:56:00.000Z", reason: "ringcx-current-released" },
  };
  const s1 = {
    ...session("s1", "acct-a", [], current),
    __v: 1,
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  let updateCalls = 0;
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) {
      updateCalls += 1;
      if (updateCalls === 1) return null; // version-miss on the first attempt
      writes.push({ sessionId, patch });
      return patch;
    },
  };
  const client = { async listActiveCalls() { return []; } };

  const result = await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    loadLatestState: async () => ({ ...s1, __v: 2 }), // bumped row still carries the release anchors
    wrapTimeoutMs: 180000,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(updateCalls, 2, "first write misses, retry re-attempts");
  assert.equal(writes.length, 1, "the retry persists the release observation");
  assert.equal(writes[0].patch.current, null);
  assert.equal(writes[0].patch.completed[0].queueItemId, "q1");
  assert.equal(terminalWrites.length, 1, "a RingCX-proven released current is counted");
  assert.equal(terminalWrites[0].candidate.queueItemId, "q1");
  assert.equal(terminalWrites[0].candidate.uii, "u1");
  assert.equal(result.applied.terminalWriteCount, 1);
});

test("CONGESTION label: a never-connected release matched in RingCX's congestion set carries systemDisposition", async () => {
  const terminalWrites = [];
  const current = { ...candidate("q1", "cxbl-q1") }; // no uii on current: never connected
  const s1 = {
    ...session("s1", "acct-a", [], current),
    ringcx: { accountId: "acct-a", campaignId: 2306 },
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { return patch; },
  };
  const searchCalls = [];
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads(payload) {
      searchCalls.push(payload);
      assert.equal(payload.campaignId, 2306);
      // Row carries no readable disposition field -> the family probe can't say
      // WHICH, so the CONGESTION-only fallback answers the loop-breaker case.
      return { leads: [{ externId: "cxbl-q1", leadState: "READY" }] };
    },
  };

  await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  // Direct-extern search is the primary read since 2026-07-07 (the ANSWER discovery);
  // the family + CONGESTION probes are the did_not_connect fallback chain.
  assert.equal(searchCalls.length, 3, "direct extern first, then family probe, then CONGESTION fallback");
  assert.deepEqual(searchCalls[0].externIds, ["cxbl-q1"], "the primary read is extern-scoped");
  assert.ok(searchCalls[1].systemDispositions.includes("BUSY"), "fallback filters the whole never-connected family");
  assert.deepEqual(searchCalls[2].systemDispositions, ["CONGESTION"]);
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].outcome, "did_not_connect", "outcome ENUM is untouched");
  assert.equal(terminalWrites[0].systemDisposition, "CONGESTION", "the label rides along");
});

test("SYSTEM DISPOSITION label is general: RingCX's own per-lead value is stamped verbatim (BUSY)", async () => {
  const terminalWrites = [];
  const searchCalls = [];
  const current = { ...candidate("q1", "cxbl-q1") };
  const s1 = {
    ...session("s1", "acct-a", [], current),
    ringcx: { accountId: "acct-a", campaignId: 2306 },
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { return patch; },
  };
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads(payload) {
      searchCalls.push(payload);
      // Row DOES carry the per-lead system disposition -> read it directly, one call.
      return { leads: [{ externId: "cxbl-q1", systemDisposition: "BUSY" }] };
    },
  };

  await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(searchCalls.length, 1, "one probe suffices when the row says which");
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
  assert.equal(terminalWrites[0].systemDisposition, "BUSY", "THEIR value, verbatim — not ours");
});

test("CONGESTION label: a failing leadSearch keeps the plain record (fail-soft)", async () => {
  const terminalWrites = [];
  const current = { ...candidate("q1", "cxbl-q1") };
  const s1 = {
    ...session("s1", "acct-a", [], current),
    ringcx: { accountId: "acct-a", campaignId: 2306 },
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { return patch; },
  };
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads() { throw new Error("ringcx down"); },
  };

  await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
  assert.equal(terminalWrites[0].systemDisposition, undefined, "no label on failure — never blocks the record");
});

test("REAL-PICKUP guard: a short screener/VM-kick connect (<10s) superseded records did_not_connect", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    connectedAt: "2026-06-23T12:00:00.000Z", // SIP-answered (Google screener / VM kick)
  };
  const s = {
    ...session("s1", "acct-a", [candidate("q2", "cxbl-q2")], current),
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [{ externalId: "cxbl-q2", uii: "u2", callState: "ACTIVE" }],
    { now: new Date("2026-06-23T12:00:03.000Z") }, // connected only 3s — not a human pickup
  );

  assert.equal(projected.terminalObservations.length, 1);
  assert.equal(projected.terminalObservations[0].outcome, "did_not_connect", "3s SIP-connect is not answered");
  assert.equal(projected.after.current.queueItemId, "q2");
});

test("REAL-PICKUP guard: a real conversation (>=10s) superseded records answered", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    uii: "u1",
    connectedAt: "2026-06-23T12:00:00.000Z",
  };
  const s = {
    ...session("s1", "acct-a", [candidate("q2", "cxbl-q2")], current),
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };

  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [{ externalId: "cxbl-q2", uii: "u2", callState: "ACTIVE" }],
    { now: new Date("2026-06-23T12:00:30.000Z") }, // 30s of conversation
  );

  assert.equal(projected.terminalObservations.length, 1);
  assert.equal(projected.terminalObservations[0].outcome, "answered", "a real pickup records answered");
  assert.equal(projected.after.lastOutcome.outcome, "answered", "and lands on the answered worklist");
});

test("ANSWER discovery (2026-07-07): lastPassDispo=ANSWER is read via the direct extern search and rides the write", async () => {
  const terminalWrites = [];
  const searchCalls = [];
  const current = { ...candidate("q1", "cxbl-q1") }; // never latched → guard says did_not_connect
  const s1 = {
    ...session("s1", "acct-a", [], current),
    ringcx: { accountId: "acct-a", campaignId: 2306 },
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { return patch; },
  };
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads(payload) {
      searchCalls.push(payload);
      // The exact shape Mickey's probe captured: composite lastPassDisposition.
      return { leads: [{ externId: "cxbl-q1", lastPassDispo: "ANSWER", lastPassDisposition: "ANSWER : Auto Dispo" }] };
    },
  };
  await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-07-07T12:00:00.000Z"),
  });
  assert.equal(searchCalls.length, 1, "the direct extern read suffices");
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].systemDisposition, "ANSWER", "the proven token rides the write");
  assert.equal(terminalWrites[0].outcome, "did_not_connect", "flag OFF: the guard's verdict still stands");
});

test("ANSWER + classifier flag ON: the guard's did_not_connect upgrades to answered (the wrap card's case)", async () => {
  const terminalWrites = [];
  const current = { ...candidate("q1", "cxbl-q1") };
  const s1 = {
    ...session("s1", "acct-a", [], current),
    ringcx: { accountId: "acct-a", campaignId: 2306 },
    prevActiveExternIds: ["cxbl-q1"],
    trace: { prevActiveCalls: [{ externId: "cxbl-q1", uii: "u1" }] },
  };
  const sessionRepository = {
    async listActiveBulkLoadSessions() { return [s1]; },
    async updateBulkLoadSession(sessionId, patch) { return patch; },
  };
  const client = {
    async listActiveCalls() { return []; },
    async searchLeads() {
      return { leads: [{ externId: "cxbl-q1", lastPassDispo: "ANSWER" }] };
    },
  };
  await runCxAccountActiveCallWatchOnce({
    sessionRepository,
    client,
    sysDispoClassifierEnabled: true,
    outcomeAdapter: {
      async persistTerminalOutcome(input) { terminalWrites.push(input); return { written: true }; },
    },
    now: new Date("2026-07-07T12:10:00.000Z"),
  });
  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].outcome, "answered", "RingCX's ANSWER verdict overrides the guard");
  assert.equal(terminalWrites[0].systemDisposition, "ANSWER");
});
