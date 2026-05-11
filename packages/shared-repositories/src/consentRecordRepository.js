"use strict";

const { ConsentRecord } = require("../../shared-models/src");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDateRange(from, to) {
  const query = {};

  if (from) {
    const next = new Date(from);
    if (!Number.isNaN(next.getTime())) {
      query.$gte = next;
    }
  }

  if (to) {
    const next = new Date(to);
    if (!Number.isNaN(next.getTime())) {
      query.$lte = next;
    }
  }

  return Object.keys(query).length > 0 ? query : null;
}

function buildConsentQuery(filters = {}) {
  const query = {};

  if (filters.domain || filters.company) {
    query.domain = normalizeDomain(filters.domain || filters.company);
  }

  if (filters.caseId != null && filters.caseId !== "") {
    const caseId = Number(filters.caseId);
    if (Number.isFinite(caseId)) {
      query.caseId = caseId;
    }
  }

  if (filters.source) {
    query.source = new RegExp(escapeRegex(filters.source), "i");
  }

  if (filters.email) {
    query.email = new RegExp(escapeRegex(filters.email), "i");
  }

  if (filters.phone) {
    const digits = String(filters.phone || "").replace(/\D/g, "");
    if (digits) {
      query.phone = new RegExp(escapeRegex(digits), "i");
    }
  }

  const receivedAt = buildDateRange(filters.from, filters.to);
  if (receivedAt) {
    query.receivedAt = receivedAt;
  }

  return query;
}

async function createConsentRecord(record = {}) {
  const next = new ConsentRecord({
    ...record,
    domain: normalizeDomain(record.domain || record.company),
    company: normalizeDomain(record.company || record.domain),
  });
  return next.save();
}

async function findConsentRecordById(id) {
  return ConsentRecord.findById(id).lean();
}

async function listConsentRecords(filters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 250);
  return ConsentRecord.find(buildConsentQuery(filters))
    .sort({ receivedAt: -1, createdAt: -1 })
    .limit(limit)
    .lean();
}

async function countConsentRecords(filters = {}) {
  return ConsentRecord.countDocuments(buildConsentQuery(filters));
}

async function getConsentStats(filters = {}) {
  const query = buildConsentQuery(filters);
  const [total, withTrustedForm, withJornaya] = await Promise.all([
    ConsentRecord.countDocuments(query),
    ConsentRecord.countDocuments({
      ...query,
      trustedFormCertUrl: { $nin: [null, ""] },
    }),
    ConsentRecord.countDocuments({
      ...query,
      jornayaLeadId: { $nin: [null, ""] },
    }),
  ]);

  return {
    total,
    withTrustedForm,
    withJornaya,
  };
}

module.exports = {
  countConsentRecords,
  createConsentRecord,
  findConsentRecordById,
  getConsentStats,
  listConsentRecords,
};
