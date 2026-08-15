"use strict";

const { workflowRecordRepository } = require("../../shared-repositories/src");
const { workflowRecordSoftGate } = require("./workflowRecordPersistencePolicy");

function normalizeDomain(domain) {
  return domain ? String(domain).trim().toUpperCase() : null;
}

async function recordWorkflowStage(input = {}) {
  const record = {
    domain: normalizeDomain(input.domain),
    family: input.family,
    subtype: input.subtype || null,
    stage: input.stage,
    aggregateType: input.aggregateType,
    aggregateId: String(input.aggregateId),
    caseId: input.caseId != null ? Number(input.caseId) : null,
    sourceService: input.sourceService || null,
    workerName: input.workerName || null,
    status: input.status || "ok",
    title: input.title || null,
    summary: input.summary || null,
    payload: input.payload || null,
    result: input.result || null,
    dedupeKey: input.dedupeKey || null,
    happenedAt: input.happenedAt ? new Date(input.happenedAt) : new Date(),
  };
  const decision = workflowRecordSoftGate.evaluate(record);
  if (!decision.persist) return decision.record;
  return workflowRecordRepository.createWorkflowRecord(record);
}

async function listWorkflowStages(filters = {}) {
  return workflowRecordRepository.listWorkflowRecords(filters);
}

module.exports = {
  listWorkflowStages,
  recordWorkflowStage,
};
