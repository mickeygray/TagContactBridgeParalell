"use strict";

const { WorkflowRecord } = require("../../shared-models/src");

// WorkflowRecord's unique dedupe index is partial so legacy rows without a
// string key can coexist. Mongo will not use that index unless every lookup
// includes its partial predicate. A plain `{ dedupeKey }` query scans the
// million-row workflow journal to find one receipt.
function buildWorkflowDedupeFilter(value) {
  const dedupeKey = String(value || "").trim();
  if (!dedupeKey) throw new TypeError("dedupeKey is required");
  return {
    $and: [
      { dedupeKey },
      { dedupeKey: { $type: "string" } },
    ],
  };
}

async function createWorkflowRecord(payload) {
  const dedupeKey = payload?.dedupeKey ? String(payload.dedupeKey) : "";
  if (dedupeKey) {
    const filter = buildWorkflowDedupeFilter(dedupeKey);
    try {
      return await WorkflowRecord.findOneAndUpdate(
        filter,
        { $setOnInsert: { ...payload, dedupeKey } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await WorkflowRecord.findOne(filter);
        if (existing) return existing;
      }
      throw error;
    }
  }
  return WorkflowRecord.create(payload);
}

async function listWorkflowRecords(filters = {}) {
  const query = {};
  if (filters.domain) query.domain = String(filters.domain).toUpperCase();
  if (filters.family) query.family = filters.family;
  if (filters.subtype) query.subtype = filters.subtype;
  if (filters.stage) query.stage = filters.stage;
  if (filters.aggregateType) query.aggregateType = filters.aggregateType;
  if (filters.aggregateId) query.aggregateId = String(filters.aggregateId);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);

  const limit = Math.min(Number(filters.limit) || 100, 500);
  return WorkflowRecord.find(query).sort({ happenedAt: -1, createdAt: -1 }).limit(limit).lean();
}

module.exports = {
  buildWorkflowDedupeFilter,
  createWorkflowRecord,
  listWorkflowRecords,
};
