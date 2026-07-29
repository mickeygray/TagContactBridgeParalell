"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createDailyDialCallLogProjection,
} = require("../../packages/shared-services/src/dailyDialCallLogProjectionService");
const { CallLog } = require("../../packages/shared-models/src");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeDailyDial(rows) {
  return {
    find(filter) {
      const selected = rows.filter((row) => row.dateKey === filter.dateKey);
      return {
        sort() { return this; },
        async lean() { return clone(selected); },
      };
    },
  };
}

test("CallLog accepts the provider-neutral PhoneBurner projection contract", () => {
  const row = new CallLog({
    domain: "TAG",
    telephonySessionId: "phoneburner:call-1",
    provider: "phoneburner",
    providerCallId: "call-1",
    providerAttemptKey: "attempt-1",
    platform: "phoneburner",
    strategy: "lead-delivery",
    direction: "outbound",
    outcome: "review",
  });

  assert.equal(row.validateSync(), undefined);
});

test("closed DailyDial attempts replay into one exact PhoneBurner CallLog row", async () => {
  const rows = [{
    _id: "daily-1",
    domain: "tag",
    caseId: "42",
    dateKey: "2026-07-16",
    originPool: "new_today",
    leadSnapshot: { normalizedPhone: "5555550100" },
    attempts: [{
      attemptKey: "attempt-1",
      provider: "phoneburner",
      providerCallId: "call-1",
      agentId: "chris_bolt",
      outcome: "dnc",
      connected: true,
      callStartedAt: new Date("2026-07-16T18:00:00.000Z"),
      callEndedAt: new Date("2026-07-16T18:02:00.000Z"),
      durationSeconds: 120,
      recordingUrl: "https://recordings.example.invalid/call/1.mp3?token=test",
      originPool: "new_today",
      dailyAttemptCount: 1,
      totalAttemptCount: 3,
    }],
  }];
  const callLogs = new Map();
  const upsertCallLog = async (input) => {
    const key = `${input.domain}:${input.telephonySessionId}`;
    callLogs.set(key, { ...(callLogs.get(key) || {}), ...clone(input) });
    return clone(callLogs.get(key));
  };
  const reconcile = createDailyDialCallLogProjection({
    DailyDial: fakeDailyDial(rows),
    upsertCallLog,
    resolveAgent: async (agentId) => ({
      extensionId: agentId === "chris_bolt" ? "extension-1" : null,
      name: "Chris Bolt",
    }),
    now: () => new Date("2026-07-17T01:00:00.000Z"),
  });

  const first = await reconcile({ dateKey: "2026-07-16" });
  const replay = await reconcile({ dateKey: "2026-07-16" });

  assert.equal(first.status, "completed");
  assert.equal(first.attempts, 1);
  assert.equal(first.reconciled, 1);
  assert.equal(first.rejected, 0);
  assert.equal(replay.reconciled, 1);
  assert.equal(callLogs.size, 1);
  const [callLog] = callLogs.values();
  assert.equal(callLog.telephonySessionId, "phoneburner:call-1");
  assert.equal(callLog.providerAttemptKey, "attempt-1");
  assert.equal(callLog.platform, "phoneburner");
  assert.equal(callLog.direction, "outbound");
  assert.equal(callLog.extensionId, "extension-1");
  assert.equal(callLog.caseId, 42);
  assert.equal(callLog.outcome, "dnc");
  assert.equal(callLog.connected, true);
  assert.equal(callLog.durationSec, 120);
  assert.equal(callLog.status, "resolved");
  assert.equal(callLog["recordingArchive.provider"], "phoneburner");
  assert.equal(callLog["recordingArchive.sourceUri"], "https://recordings.example.invalid/call/1.mp3?token=test");
});

test("projection reports invalid identities instead of inventing metric rows", async () => {
  const rows = [{
    _id: "daily-bad",
    domain: "tag",
    caseId: "not-a-case",
    dateKey: "2026-07-16",
    attempts: [{
      attemptKey: "attempt-bad",
      providerCallId: "call-bad",
      callEndedAt: new Date("2026-07-16T18:02:00.000Z"),
    }],
  }];
  let writes = 0;
  const reconcile = createDailyDialCallLogProjection({
    DailyDial: fakeDailyDial(rows),
    upsertCallLog: async () => { writes += 1; },
  });

  const result = await reconcile({ dateKey: "2026-07-16" });

  assert.equal(result.status, "partial");
  assert.equal(result.attempts, 1);
  assert.equal(result.reconciled, 0);
  assert.equal(result.rejected, 1);
  assert.equal(result.rejectsByReason["invalid-case-id"], 1);
  assert.equal(writes, 0);
});
