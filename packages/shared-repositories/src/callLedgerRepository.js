"use strict";

const { CallLedger } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildDateRangeQuery(filters = {}) {
  if (filters.date) {
    return { date: String(filters.date).trim() };
  }
  const range = {};
  if (filters.from) range.$gte = String(filters.from).trim();
  if (filters.to) range.$lte = String(filters.to).trim();
  return Object.keys(range).length > 0 ? { date: range } : {};
}

async function upsertCallLedger({ domain, telephonySessionId, ...rest }) {
  if (!telephonySessionId) {
    throw new Error("telephonySessionId is required");
  }
  const normalizedDomain = normalizeDomain(domain);
  return CallLedger.findOneAndUpdate(
    {
      domain: normalizedDomain,
      telephonySessionId: String(telephonySessionId),
    },
    {
      $set: {
        ...rest,
        syncedAt: rest.syncedAt || new Date(),
      },
      $setOnInsert: {
        domain: normalizedDomain,
        telephonySessionId: String(telephonySessionId),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findCallLedger(domain, telephonySessionId) {
  return CallLedger.findOne({
    domain: normalizeDomain(domain),
    telephonySessionId: String(telephonySessionId),
  }).lean();
}

async function listCallLedgerByCaseId(domain, caseId, { limit = 100 } = {}) {
  return CallLedger.find({
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
  })
    .sort({ callStartTime: -1, createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 500))
    .lean();
}

async function summarizeCallLedgerBySource(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildDateRangeQuery(filters),
  };

  return CallLedger.aggregate([
    { $match: query },
    {
      $group: {
        _id: {
          source: { $ifNull: ["$sourceName", "Unknown"] },
          channel: "$sourceChannel",
          // Third dimension so LD calls split into ld-custom vs
          // ld-general in the vendor families rollup. Older rows are
          // null and fall back to the legacy ld-posting family.
          routeCampaignKey: { $ifNull: ["$routeCampaignKey", null] },
        },
        calls: { $sum: 1 },
        callsOver5: {
          $sum: {
            $cond: [{ $gte: ["$durationSec", 300] }, 1, 0],
          },
        },
        callsOver2: {
          $sum: {
            $cond: [{ $gte: ["$durationSec", 120] }, 1, 0],
          },
        },
        uniqueCallersSet: {
          $addToSet: {
            $ifNull: ["$normalizedPhone", "$phone"],
          },
        },
        scoredCalls: {
          $sum: {
            $cond: [{ $ne: ["$scoreOverall", null] }, 1, 0],
          },
        },
        averageScore: { $avg: "$scoreOverall" },
        hot: {
          $sum: {
            $cond: [{ $eq: ["$scoreVerdict", "hot"] }, 1, 0],
          },
        },
        warm: {
          $sum: {
            $cond: [{ $eq: ["$scoreVerdict", "warm"] }, 1, 0],
          },
        },
        cold: {
          $sum: {
            $cond: [{ $eq: ["$scoreVerdict", "cold"] }, 1, 0],
          },
        },
        dead: {
          $sum: {
            $cond: [{ $eq: ["$scoreVerdict", "dead"] }, 1, 0],
          },
        },
        fake: {
          $sum: {
            $cond: [{ $eq: ["$scoreVerdict", "fake"] }, 1, 0],
          },
        },
      },
    },
    { $sort: { calls: -1, "_id.source": 1 } },
  ]);
}

module.exports = {
  findCallLedger,
  listCallLedgerByCaseId,
  summarizeCallLedgerBySource,
  upsertCallLedger,
};
