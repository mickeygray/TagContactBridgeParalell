"use strict";

const { createHash } = require("node:crypto");
const { CallRecoveryDailyCohort, CallRecoveryLead } = require("../../shared-models/src");

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function normalizeReasonCounts(value = {}) {
  const output = {};
  for (const [rawKey, rawCount] of Object.entries(value || {})) {
    const key = String(rawKey || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60);
    const count = Number(rawCount);
    if (!key || !Number.isSafeInteger(count) || count < 0) continue;
    output[key] = count;
  }
  return output;
}

function normalizePolicyIds(policyIds = {}) {
  const normalized = {
    cadencePolicyId: String(policyIds.cadence || "").trim(),
    dncPolicyId: String(policyIds.dnc || "").trim(),
    logicsPolicyId: String(policyIds.logics || "").trim(),
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!value || value.length > 120) throw new TypeError(`${field} is required`);
  }
  return normalized;
}

async function captureCompletedDay({
  dateKey,
  discoveryResult = {},
  policyIds,
  capturedAt = new Date(),
} = {}) {
  const key = String(dateKey || "").trim();
  if (!DATE_KEY.test(key)) throw new TypeError("dateKey must be YYYY-MM-DD");
  const policies = normalizePolicyIds(policyIds);
  const rows = await CallRecoveryLead.find({
    programKey: CallRecoveryLead.PROGRAM_KEY,
    qualifyingDateKeys: key,
  }).select({ _id: 1 }).sort({ _id: 1 }).lean();
  const candidateEpisodeIds = rows.map((row) => row._id);
  const rejectedByReason = normalizeReasonCounts(discoveryResult.rejectedByReason);
  const status = discoveryResult.readFailed || Number(discoveryResult.errors || 0) > 0
    ? "incomplete"
    : "complete";
  const stable = {
    status,
    candidateEpisodeIds: candidateEpisodeIds.map(String),
    factsRead: Number(discoveryResult.factsRead || 0),
    qualifiedCalls: Number(discoveryResult.qualified || 0),
    errorCount: Number(discoveryResult.errors || 0),
    rejectedByReason,
    ...policies,
  };
  const sourceDigest = createHash("sha256").update(JSON.stringify(stable)).digest("hex");
  const existing = await CallRecoveryDailyCohort.findOne({ dateKey: key }).lean();
  if (existing?.sourceDigest === sourceDigest) {
    return { cohort: existing, inserted: false, updated: false, unchanged: true };
  }
  const cohort = await CallRecoveryDailyCohort.findOneAndUpdate({ dateKey: key }, {
    $set: {
      programKey: CallRecoveryLead.PROGRAM_KEY,
      captureVersion: 1,
      ...policies,
      status,
      candidateEpisodeIds,
      candidateCount: candidateEpisodeIds.length,
      factsRead: stable.factsRead,
      qualifiedCalls: stable.qualifiedCalls,
      errorCount: stable.errorCount,
      rejectedByReason,
      sourceDigest,
      capturedAt,
      revision: Number(existing?.revision || 0) + 1,
    },
  }, { new: true, upsert: true }).lean();
  return { cohort, inserted: !existing, updated: Boolean(existing), unchanged: false };
}

async function readDay(dateKey) {
  const key = String(dateKey || "").trim();
  if (!DATE_KEY.test(key)) throw new TypeError("dateKey must be YYYY-MM-DD");
  return CallRecoveryDailyCohort.findOne({ dateKey: key }).lean();
}

module.exports = { captureCompletedDay, normalizePolicyIds, normalizeReasonCounts, readDay };
