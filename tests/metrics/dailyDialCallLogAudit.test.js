"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  classifyDailyDialRows,
  finalizeAudit,
  pacificMidnightUtc,
} = require("../../packages/shared-services/src/dailyDialCallLogAuditService");
const {
  parseArgs,
} = require("../../scripts/audit-phoneburner-daily-dial-calllog");

function attempt({
  callId,
  attemptKey,
  endedAt,
  outcome = "review",
  durationSeconds = 30,
} = {}) {
  return {
    provider: "phoneburner",
    providerCallId: callId,
    attemptKey,
    agentId: "agent_one",
    outcome,
    connected: false,
    callStartedAt: new Date(new Date(endedAt).getTime() - durationSeconds * 1000),
    callEndedAt: new Date(endedAt),
    durationSeconds,
    originPool: "overnight",
  };
}

function projectedCall({
  id,
  domain = "TAG",
  callId,
  attemptKey,
  endedAt,
  outcome = "review",
  durationSeconds = 30,
} = {}) {
  return {
    _id: id,
    domain,
    telephonySessionId: `phoneburner:${callId}`,
    callSessionId: callId,
    provider: "phoneburner",
    providerCallId: callId,
    providerAttemptKey: attemptKey,
    providerAgentId: "agent_one",
    platform: "phoneburner",
    direction: "outbound",
    strategy: "lead-delivery",
    confidence: "high",
    status: "resolved",
    caseId: 101,
    caseDomain: "TAG",
    callStartTime: new Date(new Date(endedAt).getTime() - durationSeconds * 1000),
    callEndTime: new Date(endedAt),
    durationSec: durationSeconds,
    outcome,
    connected: false,
    originPool: "overnight",
  };
}

test("July equality audit reports exact projections without exposing identities", () => {
  const dailyDials = [{
    _id: "daily-1",
    domain: "tag",
    caseId: "101",
    dateKey: "2026-07-22",
    callEndedAt: new Date("2026-07-22T18:01:00.000Z"),
    originPool: "overnight",
    attempts: [
      attempt({
        callId: "call-1",
        attemptKey: "attempt-1",
        endedAt: "2026-07-22T18:01:00.000Z",
      }),
      attempt({
        callId: "call-2",
        attemptKey: "attempt-2",
        endedAt: "2026-07-22T18:02:00.000Z",
      }),
    ],
  }];
  const classified = classifyDailyDialRows({
    dailyDials,
    from: "2026-07-22",
    to: "2026-07-22",
  });
  const result = finalizeAudit({
    ...classified,
    callLogs: [
      projectedCall({
        id: "log-1",
        callId: "call-1",
        attemptKey: "attempt-1",
        endedAt: "2026-07-22T18:01:00.000Z",
      }),
      projectedCall({
        id: "log-2",
        callId: "call-2",
        attemptKey: "attempt-2",
        endedAt: "2026-07-22T18:02:00.000Z",
      }),
    ],
    from: "2026-07-22",
    to: "2026-07-22",
  });

  assert.equal(result.equalityOk, true);
  assert.equal(result.totals.attempts, 2);
  assert.equal(result.totals.validIdentities, 2);
  assert.equal(result.totals.projectedCallLogs, 2);
  assert.equal(result.totals.missing, 0);
  assert.equal(result.totals.explicitRejects, 0);
  assert.doesNotMatch(JSON.stringify(result), /call-1|attempt-1|daily-1/);
});

test("audit fails closed for rejects, source duplicates, missing and mismatched rows", () => {
  const dailyDials = [
    {
      _id: "daily-valid",
      domain: "tag",
      caseId: "101",
      dateKey: "2026-07-23",
      callEndedAt: new Date("2026-07-23T18:04:00.000Z"),
      originPool: "overnight",
      attempts: [
        attempt({
          callId: "valid-call",
          attemptKey: "valid-attempt",
          endedAt: "2026-07-23T18:01:00.000Z",
        }),
        attempt({
          callId: "missing-call",
          attemptKey: "missing-attempt",
          endedAt: "2026-07-23T18:02:00.000Z",
        }),
        attempt({
          callId: "valid-call",
          attemptKey: "duplicate-attempt",
          endedAt: "2026-07-23T18:03:00.000Z",
        }),
      ],
    },
    {
      _id: "daily-invalid",
      domain: "tag",
      caseId: "not-numeric",
      dateKey: "2026-07-23",
      callEndedAt: new Date("2026-07-23T18:05:00.000Z"),
      attempts: [
        attempt({
          callId: "invalid-case-call",
          attemptKey: "invalid-case-attempt",
          endedAt: "2026-07-23T18:05:00.000Z",
        }),
      ],
    },
  ];
  const classified = classifyDailyDialRows({
    dailyDials,
    from: "2026-07-23",
    to: "2026-07-23",
  });
  const mismatched = projectedCall({
    id: "log-valid",
    callId: "valid-call",
    attemptKey: "wrong-attempt",
    endedAt: "2026-07-23T18:01:00.000Z",
  });
  const unexpected = projectedCall({
    id: "log-extra",
    callId: "extra-call",
    attemptKey: "extra-attempt",
    endedAt: "2026-07-23T18:06:00.000Z",
  });
  const result = finalizeAudit({
    ...classified,
    callLogs: [mismatched, unexpected],
    from: "2026-07-23",
    to: "2026-07-23",
  });

  assert.equal(result.equalityOk, false);
  assert.equal(result.totals.attempts, 4);
  assert.equal(result.totals.validIdentities, 2);
  assert.equal(result.totals.explicitRejects, 2);
  assert.equal(result.totals.sourceDuplicates, 1);
  assert.equal(result.totals.rejectsByReason["duplicate-provider-call"], 1);
  assert.equal(result.totals.rejectsByReason["invalid-case-id"], 1);
  assert.equal(result.totals.missing, 1);
  assert.equal(result.totals.mismatched, 1);
  assert.equal(result.totals.mismatchesByReason["attempt-key"], 1);
  assert.equal(result.totals.unexpectedProjectedCallLogs, 1);
});

test("Pacific month boundaries are DST-safe and CLI supports explicit closed ranges", () => {
  const springStart = pacificMidnightUtc("2026-03-08");
  const springEnd = pacificMidnightUtc("2026-03-09");
  assert.equal((springEnd.getTime() - springStart.getTime()) / 3_600_000, 23);

  assert.deepEqual(
    parseArgs(["--from=2026-07-01", "--to=2026-07-23", "--pretty"]),
    { from: "2026-07-01", to: "2026-07-23", pretty: true },
  );
  assert.deepEqual(
    parseArgs(["--month=2026-07"]),
    { from: "2026-07-01", to: "2026-07-31", pretty: false },
  );
});
test("audit requires explicit provider, outcome and origin pool on projected CallLog", () => {
  const dailyDials = [{
    domain: "tag",
    caseId: "101",
    dateKey: "2026-07-23",
    callEndedAt: new Date("2026-07-23T18:01:00.000Z"),
    originPool: "overnight",
    attempts: [attempt({
      callId: "strict-call",
      attemptKey: "strict-attempt",
      endedAt: "2026-07-23T18:01:00.000Z",
    })],
  }];
  const classified = classifyDailyDialRows({
    dailyDials,
    from: "2026-07-23",
    to: "2026-07-23",
  });
  const target = projectedCall({
    id: "strict-log",
    callId: "strict-call",
    attemptKey: "strict-attempt",
    endedAt: "2026-07-23T18:01:00.000Z",
  });
  target.provider = null;
  target.outcome = null;
  target.originPool = null;
  const result = finalizeAudit({
    ...classified,
    callLogs: [target],
    from: "2026-07-23",
    to: "2026-07-23",
  });
  assert.equal(result.equalityOk, false);
  assert.equal(result.totals.mismatched, 1);
  assert.equal(result.totals.mismatchesByReason.provider, 1);
  assert.equal(result.totals.mismatchesByReason.outcome, 1);
  assert.equal(result.totals.mismatchesByReason["origin-pool"], 1);
});