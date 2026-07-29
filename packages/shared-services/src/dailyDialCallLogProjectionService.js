"use strict";

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeProvider(value) {
  return String(value || "phoneburner").trim().toLowerCase() || "phoneburner";
}

function validDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function numericCaseId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function incrementReason(target, reason) {
  target[reason] = Number(target[reason] || 0) + 1;
}

/**
 * Project one closed DailyDial date into the provider-neutral CallLog.
 *
 * DailyDial remains the exact daytime write ledger. CallLog is the only
 * downstream analytical source. A deterministic provider session identity
 * makes this safe to replay after a crash or partial close.
 */
function createDailyDialCallLogProjection({
  DailyDial,
  upsertCallLog,
  resolveAgent = async () => null,
  now = () => new Date(),
} = {}) {
  if (!DailyDial || typeof DailyDial.find !== "function") {
    throw new TypeError("DailyDial model is required");
  }
  if (typeof upsertCallLog !== "function") throw new TypeError("upsertCallLog is required");
  if (typeof resolveAgent !== "function") throw new TypeError("resolveAgent is required");

  return async function reconcileDailyDialsToCallLog({ dateKey } = {}) {
    const selectedDateKey = String(dateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDateKey)) {
      throw new TypeError("dateKey is required");
    }

    const rows = await DailyDial.find({ dateKey: selectedDateKey })
      .sort({ callEndedAt: 1, _id: 1 })
      .lean();
    const result = {
      status: "completed",
      dateKey: selectedDateKey,
      rows: rows.length,
      attempts: 0,
      reconciled: 0,
      rejected: 0,
      agentUnmapped: 0,
      rejectsByReason: {},
    };
    const seenProviderCalls = new Set();
    const agentCache = new Map();

    for (const row of rows) {
      const domain = normalizeDomain(row.domain);
      const caseId = numericCaseId(row.caseId);
      const attempts = Array.isArray(row.attempts) ? [...row.attempts] : [];
      attempts.sort((left, right) => (
        (validDate(left.callEndedAt)?.getTime() || 0) - (validDate(right.callEndedAt)?.getTime() || 0)
      ));

      for (const attempt of attempts) {
        result.attempts += 1;
        const provider = normalizeProvider(attempt.provider);
        const providerCallId = String(attempt.providerCallId || "").trim();
        const providerAttemptKey = String(attempt.attemptKey || "").trim();
        const callEndTime = validDate(attempt.callEndedAt);
        const callStartTime = validDate(attempt.callStartedAt) || callEndTime;
        let rejectReason = null;
        if (!domain) rejectReason = "invalid-domain";
        else if (!caseId) rejectReason = "invalid-case-id";
        else if (!providerCallId || !providerAttemptKey) rejectReason = "missing-provider-identity";
        else if (!callEndTime) rejectReason = "invalid-call-end";

        const providerIdentity = `${domain}:${provider}:${providerCallId}`;
        if (!rejectReason && seenProviderCalls.has(providerIdentity)) {
          rejectReason = "duplicate-provider-call";
        }
        if (rejectReason) {
          result.rejected += 1;
          incrementReason(result.rejectsByReason, rejectReason);
          continue;
        }
        seenProviderCalls.add(providerIdentity);

        const providerAgentId = String(attempt.agentId || "").trim().toLowerCase() || null;
        let agent = null;
        if (providerAgentId) {
          if (!agentCache.has(providerAgentId)) {
            agentCache.set(providerAgentId, await resolveAgent(providerAgentId));
          }
          agent = agentCache.get(providerAgentId);
          if (!agent?.extensionId) result.agentUnmapped += 1;
        } else {
          result.agentUnmapped += 1;
        }

        const outcome = String(attempt.outcome || "review").trim().toLowerCase() || "review";
        const resolvedAt = now();
        await upsertCallLog({
          domain,
          telephonySessionId: `${provider}:${providerCallId}`,
          callSessionId: providerCallId,
          callStartTime,
          callEndTime,
          durationSec: attempt.durationSeconds == null ? null : Number(attempt.durationSeconds),
          direction: "outbound",
          provider,
          providerCallId,
          providerAttemptKey,
          providerAgentId,
          outcome,
          connected: attempt.connected === true ? true : attempt.connected === false ? false : null,
          originPool: String(attempt.originPool || row.originPool || "unknown").trim() || "unknown",
          phone: row.leadSnapshot?.normalizedPhone || null,
          normalizedPhone: row.leadSnapshot?.normalizedPhone || null,
          extensionId: agent?.extensionId ? String(agent.extensionId) : null,
          agentName: agent?.name || agent?.displayName || null,
          platform: provider === "phoneburner" ? "phoneburner" : null,
          caseId,
          caseDomain: domain,
          strategy: "lead-delivery",
          confidence: "high",
          status: "resolved",
          resolvedAt,
          resolverActor: "reconcile",
          ...(attempt.recordingUrl ? { "recordingArchive.provider": provider, "recordingArchive.sourceUri": attempt.recordingUrl } : {}),
          setOnInsert: {
            transcription: { status: "skipped", source: `${provider}-daily-dial` },
          },
        });
        result.reconciled += 1;
      }
    }

    if (result.rejected > 0) result.status = "partial";
    return result;
  };
}

module.exports = {
  createDailyDialCallLogProjection,
};
