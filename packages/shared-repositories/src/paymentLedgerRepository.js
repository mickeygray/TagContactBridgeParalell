"use strict";

const { PaymentLedger } = require("../../shared-models/src");

async function upsertPaymentLedger(casePaymentId, update = {}) {
  return PaymentLedger.findOneAndUpdate(
    { casePaymentId: Number(casePaymentId) },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function listPaymentsForCase(domain, caseId) {
  return PaymentLedger.find({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  })
    .sort({ paymentDate: 1, casePaymentId: 1 })
    .lean();
}

async function listPayments(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.transactionStatus) query.transactionStatus = filters.transactionStatus;
  if (filters.sourceCanonicalId) query.sourceCanonicalId = filters.sourceCanonicalId;

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return PaymentLedger.find(query)
    .sort({ paymentDate: -1, casePaymentId: -1 })
    .limit(limit)
    .lean();
}

async function countPayments(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.transactionStatus) query.transactionStatus = filters.transactionStatus;
  if (filters.sourceCanonicalId) query.sourceCanonicalId = filters.sourceCanonicalId;

  return PaymentLedger.countDocuments(query);
}

module.exports = {
  countPayments,
  listPayments,
  listPaymentsForCase,
  upsertPaymentLedger,
};
