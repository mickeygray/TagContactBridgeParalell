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

test("projectBulkSessionFromAccountSnapshot attaches UII to a manually-started current by scoped phone proof", () => {
  const current = {
    ...candidate("q1", "cxbl-q1"),
    phone: "3106665997",
    manualStartPending: true,
    matchReasons: ["manual-start-request"],
  };
  const s = session("s1", "acct-a", [], current);
  const projected = projectBulkSessionFromAccountSnapshot(
    s,
    [{ uii: "u-manual", callState: "ACTIVE", dnis: "+13106665997" }],
    { now: new Date("2026-06-23T12:00:00.000Z") },
  );

  assert.equal(projected.changed, true);
  assert.equal(projected.transitionKind, "same");
  assert.equal(projected.after.current.queueItemId, "q1");
  assert.equal(projected.after.current.uii, "u-manual");
  assert.deepEqual(projected.after.current.matchReasons, ["externId"]);
  assert.equal(projected.after.acceptedBuffer.length, 0);
  assert.equal(projected.terminalObservations.length, 0);
  assert.equal(projected.after.trace.accountActiveCallWatcher.relevantActiveCallCount, 1);
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

test("runCxAccountActiveCallWatchOnce writes terminal observations for released UIIs", async () => {
  const writes = [];
  const terminalWrites = [];
  const current = { ...candidate("q1", "cxbl-q1"), uii: "u1" };
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
    outcomeAdapter: {
      async persistTerminalOutcome(input) {
        terminalWrites.push(input);
        return { written: true };
      },
    },
    now: new Date("2026-06-23T12:00:00.000Z"),
  });

  assert.equal(terminalWrites.length, 1);
  assert.equal(terminalWrites[0].source, "active-call-release");
  assert.equal(terminalWrites[0].candidate.queueItemId, "q1");
  assert.equal(terminalWrites[0].candidate.uii, "u1");
  assert.equal(terminalWrites[0].outcome, "did_not_connect");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch.current, null);
  assert.equal(result.applied.terminalWriteCount, 1);
});
