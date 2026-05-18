"use strict";

const { DncAudit } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function createDncAudit(input = {}) {
  return DncAudit.create({
    domain: normalizeDomain(input.domain),
    phone: normalizePhone(input.phone) || null,
    caseId: input.caseId != null ? Number(input.caseId) : null,
    workflowId: input.workflowId ? String(input.workflowId) : null,
    source: input.source || "sms-opus-triage",
    inboundText: input.inboundText || null,
    threadHistory: Array.isArray(input.threadHistory) ? input.threadHistory : [],
    classification: input.classification || null,
    rawPayload: input.rawPayload || null,
    logicsResult: input.logicsResult || null,
    happenedAt: input.happenedAt || new Date(),
  });
}

async function updateDncAudit(id, update = {}) {
  if (!id) return null;
  return DncAudit.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  ).lean();
}

async function listDncAudits(domain, filters = {}) {
  const query = {};
  if (domain) query.domain = normalizeDomain(domain);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.phone) query.phone = normalizePhone(filters.phone);
  if (filters.since) query.happenedAt = { $gte: new Date(filters.since) };
  const limit = Math.min(Number(filters.limit) || 100, 500);
  return DncAudit.find(query).sort({ happenedAt: -1 }).limit(limit).lean();
}

module.exports = {
  createDncAudit,
  listDncAudits,
  updateDncAudit,
};
