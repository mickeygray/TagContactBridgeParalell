"use strict";

const { WorkflowRecord } = require("../../shared-models/src");

async function createWorkflowRecord(payload) {
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
  createWorkflowRecord,
  listWorkflowRecords,
};
