"use strict";

const {
  caseProfileRepository,
  deepCutRunRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentLedgerRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");

async function buildControlPlaneReadOverview(domain) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const [
    totalProspects,
    totalCaseProfiles,
    totalPayments,
    totalReviewItems,
    prospects,
    caseProfiles,
    payments,
    reviewItems,
    latestDeepCutRun,
    latestDailyMetrics,
    lifetimeMetrics,
  ] =
    await Promise.all([
      masterProspectRepository.countMasterProspects(normalizedDomain),
      caseProfileRepository.countCaseProfilesByDomain(normalizedDomain),
      paymentLedgerRepository.countPayments(normalizedDomain),
      reviewQueueRepository.countReviewQueueItems(normalizedDomain),
      masterProspectRepository.listMasterProspects(normalizedDomain, { limit: 5 }),
      caseProfileRepository.listCaseProfiles(normalizedDomain, { limit: 5 }),
      paymentLedgerRepository.listPayments(normalizedDomain, { limit: 5 }),
      reviewQueueRepository.listReviewQueueItems(normalizedDomain, { limit: 5 }),
      deepCutRunRepository.getLatestDeepCutRun(normalizedDomain),
      metricsSnapshotRepository.getLatestDailyMetrics(normalizedDomain),
      metricsSnapshotRepository.findMetricsSnapshot(normalizedDomain, "lifetime", "all-time"),
    ]);

  return {
    domain: normalizedDomain,
    counts: {
      prospects: totalProspects,
      caseProfiles: totalCaseProfiles,
      payments: totalPayments,
      reviewItems: totalReviewItems,
    },
    latestDeepCutRun,
    metrics: {
      daily: latestDailyMetrics,
      lifetime: lifetimeMetrics,
    },
    recent: {
      prospects,
      caseProfiles,
      payments,
      reviewItems,
    },
  };
}

async function listPresentationProspects(domain, filters = {}) {
  return masterProspectRepository.listMasterProspects(domain, filters);
}

async function listPresentationCaseProfiles(domain, filters = {}) {
  return caseProfileRepository.listCaseProfiles(domain, filters);
}

async function listPresentationPayments(domain, filters = {}) {
  return paymentLedgerRepository.listPayments(domain, filters);
}

module.exports = {
  buildControlPlaneReadOverview,
  listPresentationCaseProfiles,
  listPresentationPayments,
  listPresentationProspects,
};
