"use strict";

const { LOGICS_SCAN_PHASES } = require("../../shared-contracts/src");

const STATUS_SCAN_SETS = {
  TAG: {
    prospectStatusIds: [1, 2, 52, 53, 54, 56, 49, 165, 179, 6, 5, 176, 197],
    conversionStatusIds: [210, 211, 206, 207, 208, 209, 212, 176, 150, 170],
    inactiveStatusIds: [173, 39, 22, 24, 25, 26, 214, 215, 185, 18, 60, 202],
    phoneBackfillStatusIds: [1, 2, 52, 53, 54, 56, 49, 165, 179, 6, 5, 176],
  },
  WYNN: {
    prospectStatusIds: [
      1, 2, 3, 8, 49, 5, 6, 160, 161, 162, 163, 165, 176, 177, 178, 179, 180,
      222, 223,
    ],
    conversionStatusIds: [
      10, 11, 13, 151, 152, 153, 154, 155, 156, 157, 158, 159, 181, 182, 183,
      184, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 201, 202,
      203, 204, 205, 207, 208, 210, 211, 212, 213, 215, 216, 217, 218, 219,
      220, 221,
    ],
    inactiveStatusIds: [
      12, 18, 22, 24, 25, 26, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 46, 47,
      57, 60, 171, 172, 173, 186, 187, 206, 209, 214,
    ],
    phoneBackfillStatusIds: [1, 2, 3, 8, 49, 5, 6, 160, 161, 162, 163, 165, 176, 177, 178, 179],
  },
};

function uniq(values) {
  return [...new Set(values)];
}

function buildDomainStatusScanPlan(domain) {
  const key = String(domain || "").toUpperCase();
  const config = STATUS_SCAN_SETS[key];
  if (!config) return null;

  const allStatusIds = uniq([
    ...config.prospectStatusIds,
    ...config.conversionStatusIds,
    ...config.inactiveStatusIds,
  ]).sort((left, right) => left - right);

  return {
    domain: key,
    phases: [
      LOGICS_SCAN_PHASES.STATUS_SCAN,
      LOGICS_SCAN_PHASES.CASE_VERIFY,
      LOGICS_SCAN_PHASES.CONVERSION_UPGRADE,
      LOGICS_SCAN_PHASES.INACTIVE_RESOLUTION,
      LOGICS_SCAN_PHASES.PHONE_BACKFILL,
    ],
    prospectStatusIds: uniq(config.prospectStatusIds).sort((left, right) => left - right),
    conversionStatusIds: uniq(config.conversionStatusIds).sort((left, right) => left - right),
    inactiveStatusIds: uniq(config.inactiveStatusIds).sort((left, right) => left - right),
    phoneBackfillStatusIds: uniq(config.phoneBackfillStatusIds).sort((left, right) => left - right),
    allStatusIds,
    notes: [
      "Status scan should call GetCasesByStatus for each configured status bucket.",
      "Local diffing should happen against MasterProspectIndex by domain + caseId + statusId.",
      "Cases leaving prospect buckets should be verified by CaseInfo before any promotion or cleanup.",
      "Only changed or promoted cases should trigger billing/payment upgrade calls.",
    ],
  };
}

function buildDailyStatusScanWorkflow() {
  return {
    phases: [
      {
        phase: LOGICS_SCAN_PHASES.STATUS_SCAN,
        description:
          "Loop configured status ids, fetch Logics case id arrays, and update the shallow MasterProspectIndex.",
      },
      {
        phase: LOGICS_SCAN_PHASES.CASE_VERIFY,
        description:
          "For cases that disappeared from a prospect bucket, call CaseInfo to confirm the current status/source before acting.",
      },
      {
        phase: LOGICS_SCAN_PHASES.CONVERSION_UPGRADE,
        description:
          "If the verified case is now client/tier/post-date, fetch payments, invoices, and billing summary, then materialize CaseProfile and PaymentLedger.",
      },
      {
        phase: LOGICS_SCAN_PHASES.INACTIVE_RESOLUTION,
        description:
          "If the verified case is dead/bad/inactive/DNC, deactivate cadence, mark prospect state, and avoid unnecessary client materialization.",
      },
      {
        phase: LOGICS_SCAN_PHASES.PHONE_BACKFILL,
        description:
          "Run phone and source enrichment on shallow prospects missing identity fields, using CaseInfo and real-time activity matches as evidence.",
      },
    ],
    apiRequirements: [
      "Case/GetCasesByStatus",
      "Case/CaseInfo",
      "Billing/CasePayment",
      "Billing/CaseInvoice",
      "Billing/CaseBillingsummary",
      "Find/FindCaseByPhone",
    ],
  };
}

function buildLogicsScanSummary() {
  return {
    workflow: buildDailyStatusScanWorkflow(),
    domains: Object.keys(STATUS_SCAN_SETS).map((domain) =>
      buildDomainStatusScanPlan(domain)),
  };
}

module.exports = {
  STATUS_SCAN_SETS,
  buildDailyStatusScanWorkflow,
  buildDomainStatusScanPlan,
  buildLogicsScanSummary,
};
