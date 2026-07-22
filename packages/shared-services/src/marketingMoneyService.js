"use strict";

// Sole normal-runtime write boundary for marketing money facts. Fetchers
// discover facts; this service decides their authority and persists them.
// MetricsSnapshot and CaseProfile are projections, never financial ledgers.
const {
  paymentLedgerRepository,
  spendEntryRepository,
} = require("../../shared-repositories/src");

async function reconcileSpendSheet({ rows = [], sheetId, domain, channel, runId } = {}) {
  return spendEntryRepository.reconcileSpendEntries(rows, {
    sheetId,
    domain,
    channel,
    runId,
  });
}

async function recordComputedSpend(entry = {}) {
  return spendEntryRepository.upsertSpendEntry({
    ...entry,
    factOwner: "marketing-money",
  });
}

async function reconcilePayment(casePaymentId, payment = {}) {
  return paymentLedgerRepository.reconcilePaymentLedger(casePaymentId, payment);
}

async function observePayment(casePaymentId, payment = {}) {
  return paymentLedgerRepository.observePaymentLedger(casePaymentId, payment);
}

module.exports = {
  observePayment,
  reconcilePayment,
  reconcileSpendSheet,
  recordComputedSpend,
};
