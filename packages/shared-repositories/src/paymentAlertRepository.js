"use strict";

const { PaymentAlert } = require("../../shared-models/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function buildAlertStatusQuery(status) {
  if (status === "pending") return { textSentAt: null };
  if (status === "sent") return { textSentAt: { $ne: null }, textResult: { $not: /^suppressed/i } };
  if (status === "suppressed") return { textResult: { $regex: /^suppressed/i } };
  return {};
}

async function listPaymentAlerts(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildAlertStatusQuery(filters.status),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.paymentDate) query.paymentDate = String(filters.paymentDate);

  const limit = Math.min(Number(filters.limit) || 100, 500);
  return PaymentAlert.find(query)
    .sort({ createdAt: -1, paymentDate: -1 })
    .limit(limit)
    .lean();
}

async function countPaymentAlerts(domain, filters = {}) {
  const query = {
    domain: normalizeDomain(domain),
    ...buildAlertStatusQuery(filters.status),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.paymentDate) query.paymentDate = String(filters.paymentDate);

  return PaymentAlert.countDocuments(query);
}

module.exports = {
  countPaymentAlerts,
  listPaymentAlerts,
};
