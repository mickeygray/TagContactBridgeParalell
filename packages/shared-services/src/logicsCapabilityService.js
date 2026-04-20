"use strict";

const { buildDomainStatusScanPlan } = require("./logicsScanService");

const ROUTE_HEALTH = Object.freeze({
  TAG: {
    checkedAt: "2026-04-17",
    routes: {
      caseInfo: { path: "Case/CaseInfo", status: "working" },
      caseStatusInfo: { path: "Case/CaseStatusInfo", status: "working" },
      findCaseByPhone: { path: "Find/FindCaseByPhone", status: "working" },
      caseActivity: { path: "CaseActivity/Activity", status: "working" },
      caseBillingSummary: {
        path: "Billing/CaseBillingSummary",
        status: "working",
      },
      getCasesByStatus: {
        path: "Case/GetCasesByStatus",
        status: "missing",
        detail: "Tenant returned route-level 404 during live smoke.",
      },
      casePayment: {
        path: "Billing/CasePayment",
        status: "missing",
        detail: "Tenant returned Resource not found during live smoke.",
      },
      caseInvoice: {
        path: "Billing/CaseInvoice",
        status: "missing",
        detail: "Tenant returned Resource not found during live smoke.",
      },
    },
  },
  WYNN: {
    checkedAt: "2026-04-17",
    routes: {
      caseInfo: { path: "Case/CaseInfo", status: "working" },
      caseStatusInfo: { path: "Case/CaseStatusInfo", status: "working" },
      findCaseByPhone: { path: "Find/FindCaseByPhone", status: "working" },
      caseActivity: { path: "CaseActivity/Activity", status: "working" },
      caseBillingSummary: {
        path: "Billing/CaseBillingSummary",
        status: "working",
      },
      getCasesByStatus: {
        path: "Case/GetCasesByStatus",
        status: "missing",
        detail: "Tenant returned route-level 404 during live smoke.",
      },
      casePayment: {
        path: "Billing/CasePayment",
        status: "missing",
        detail: "Tenant returned Resource not found during live smoke.",
      },
      caseInvoice: {
        path: "Billing/CaseInvoice",
        status: "missing",
        detail: "Tenant returned Resource not found during live smoke.",
      },
    },
  },
});

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function getRouteHealth(domain) {
  return ROUTE_HEALTH[normalizeDomain(domain)] || null;
}

function getWorkingRoutes(routeHealth) {
  return Object.entries(routeHealth.routes)
    .filter(([, config]) => config.status === "working")
    .map(([key, config]) => ({ key, ...config }));
}

function getMissingRoutes(routeHealth) {
  return Object.entries(routeHealth.routes)
    .filter(([, config]) => config.status !== "working")
    .map(([key, config]) => ({ key, ...config }));
}

function buildRecommendedWorkflow(domain) {
  const routeHealth = getRouteHealth(domain);
  if (!routeHealth) {
    return null;
  }

  const plan = buildDomainStatusScanPlan(domain);
  const hasStatusSweep = routeHealth.routes.getCasesByStatus.status === "working";
  const hasPayments = routeHealth.routes.casePayment.status === "working";
  const hasInvoices = routeHealth.routes.caseInvoice.status === "working";
  const hasBillingSummary =
    routeHealth.routes.caseBillingSummary.status === "working";

  const strategy = hasStatusSweep
    ? "status-sweep"
    : "caseinfo-reconciliation";

  const phases = hasStatusSweep
    ? [
        "status-bucket scan via GetCasesByStatus",
        "local MasterProspectIndex diff",
        "CaseInfo verification on moved cases",
      ]
    : [
        "maintain MasterProspectIndex from lead-contact, mailer uploads, calls, and manual CSVs",
        "run daily CaseInfo refresh on tracked prospects and touched cases",
        "promote or deactivate cases from CaseInfo status drift",
      ];

  const financialPhase = hasPayments
    ? "materialize PaymentLedger from CasePayment and use BillingSummary as aggregate cross-check"
    : hasBillingSummary
      ? "use BillingSummary for aggregate finance signals and treat payment-ledger materialization as deferred/manual until a working payment route is confirmed"
      : "financial sync unavailable";

  return {
    domain: normalizeDomain(domain),
    checkedAt: routeHealth.checkedAt,
    statusScanStrategy: strategy,
    plan,
    workingRoutes: getWorkingRoutes(routeHealth),
    missingRoutes: getMissingRoutes(routeHealth),
    phases: [
      ...phases,
      financialPhase,
      hasInvoices
        ? "use CaseInvoice for cleaner/list filtering and invoice recency rules"
        : "invoice-dependent cleaner rules must be deferred or replaced with activity/billing-summary heuristics",
    ],
    conclusions: {
      canRunProspectSweep: hasStatusSweep,
      canMaterializePayments: hasPayments,
      canUseInvoiceRules: hasInvoices,
      canUseBillingSummary: hasBillingSummary,
    },
  };
}

function buildCapabilitySummary() {
  return Object.keys(ROUTE_HEALTH).map((domain) =>
    buildRecommendedWorkflow(domain),
  );
}

module.exports = {
  buildCapabilitySummary,
  buildRecommendedWorkflow,
  getRouteHealth,
};
