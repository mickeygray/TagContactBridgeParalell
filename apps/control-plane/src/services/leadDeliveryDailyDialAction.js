"use strict";

const {
  recordDailyDialOffload,
} = require("../../../../packages/shared-services/src/dailyDialLedgerService");

function createRecordLeadDeliveryDailyDial({ DailyDial } = {}) {
  if (!DailyDial) throw new TypeError("DailyDial model is required");
  return async function recordLeadDeliveryDailyDial(action = {}) {
    const result = await recordDailyDialOffload({
      model: DailyDial,
      cadence: {
        domain: action.domain,
        caseId: action.caseId,
        receivedAt: action.leadReceivedAt,
        normalizedPhone: action.normalizedPhone,
        firstName: action.firstName,
        lastName: action.lastName,
      },
      originPool: action.originPool,
      providerAttemptKey: action.providerAttemptKey,
      providerCallId: action.providerCallId,
      provider: action.provider,
      agentId: action.agentId,
      normalizedOutcome: action.normalizedOutcome,
      connected: action.connected,
      dailyAttemptDateKey: action.dailyAttemptDateKey,
      dailyAttemptCount: action.dailyAttemptCount,
      totalAttemptCount: action.totalAttemptCount,
      nextContactAt: action.nextContactAt,
      callStartedAt: action.callStartedAt,
      callEndedAt: action.completedAt,
      durationSeconds: action.durationSeconds,
    });
    return { ok: true, counted: result.counted, status: result.status };
  };
}

function createPersistDailyDialsToCadence({ DailyDial, recordCadence } = {}) {
  if (!DailyDial || typeof DailyDial.find !== "function" || typeof DailyDial.updateOne !== "function") {
    throw new TypeError("DailyDial model is required");
  }
  if (typeof recordCadence !== "function") throw new TypeError("recordCadence is required");

  return async function persistDailyDialsToCadence({ dateKey = null, beforeDateKey = null } = {}) {
    const filter = { cadencePersistedAt: null };
    if (dateKey) filter.dateKey = String(dateKey);
    if (beforeDateKey) filter.dateKey = { $lt: String(beforeDateKey) };
    const rows = await DailyDial.find(filter).sort({ dateKey: 1, callEndedAt: 1, _id: 1 }).lean();
    let persisted = 0;
    let attempts = 0;
    let skipped = 0;
    let skippedRows = 0;
    for (const row of rows) {
      let rowSkipped = false;
      const ordered = [...(Array.isArray(row.attempts) ? row.attempts : [])]
        .sort((left, right) => new Date(left.callEndedAt) - new Date(right.callEndedAt));
      for (const attempt of ordered) {
        const result = await recordCadence({
          domain: row.domain,
          caseId: row.caseId,
          providerCallId: attempt.providerCallId,
          providerAttemptKey: attempt.attemptKey,
          completedAt: attempt.callEndedAt,
          dailyAttemptDateKey: row.dateKey,
          dailyAttemptCount: attempt.dailyAttemptCount,
          totalAttemptCount: attempt.totalAttemptCount,
          historicalAttempt: true,
        });
        if (result?.skipped === true) {
          skipped += 1;
          rowSkipped = true;
        } else {
          attempts += 1;
        }
      }
      const result = await DailyDial.updateOne(
        { _id: row._id, cadencePersistedAt: null },
        { $set: { cadencePersistedAt: new Date() } },
      );
      if (Number(result.matchedCount || 0) > 0) {
        persisted += 1;
        if (rowSkipped) skippedRows += 1;
      }
    }
    return { status: "completed", rows: rows.length, persisted, attempts, skipped, skippedRows };
  };
}

module.exports = {
  createPersistDailyDialsToCadence,
  createRecordLeadDeliveryDailyDial,
};
