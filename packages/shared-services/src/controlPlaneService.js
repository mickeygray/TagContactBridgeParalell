"use strict";

const { CONTROL_PLANE_DOMAIN_KEYS } = require("../../shared-contracts/src");

function buildControlPlaneDomains() {
  return [
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.AUTH,
      title: "Auth And Identity",
      status: "implemented-foundation",
      owns: [
        "login/logout/current-user endpoints",
        "role and capability enforcement",
        "admin vs widget-user workspace shaping",
      ],
      originalFiles: [
        "server.js",
        "routes/auth.js",
        "middleware/authMiddleware.js",
      ],
      notes:
        "This is already active in the parallel workspace and remains the top-level gate for every internal read/write surface.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.EVENTS,
      title: "Event Replay And Worker Control",
      status: "implemented-foundation",
      owns: [
        "event listing",
        "manual replay/refire",
        "failure visibility",
        "durable retry state",
      ],
      originalFiles: [
        "ringBridge/routes/apiRoutes.js",
        "ringBridge/server.js",
      ],
      notes:
        "This is already active in the parallel workspace and is the durable base for later hygiene and reconciliation jobs.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.METRICS,
      title: "Metrics Materialization And Query",
      status: "mapped-from-original",
      owns: [
        "daily summary views",
        "spend sync results",
        "callrail statistics",
        "dashboard query surfaces",
      ],
      originalFiles: [
        "ringBridge/services/dailyReportService.js",
        "ringBridge/services/spendSyncService.js",
        "ringBridge/services/callRailStatsService.js",
      ],
      notes:
        "These reads grew inside RingBridge, but the original files show they are durable reporting/query concerns that fit 5001 better than 6101.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.LOGICS_RECONCILIATION,
      title: "Logics Reconciliation",
      status: "mapped-from-original",
      owns: [
        "payment refresh loops",
        "status refresh loops",
        "invoice and billing fetches",
        "case contact/account lookups",
        "GetCasesByStatus catch-all scans",
      ],
      originalFiles: [
        "services/logicsService.js",
        "services/statusChecker.js",
        "ringBridge/services/hourlySyncService.js",
      ],
      notes:
        "The original code treats Logics as the source of truth for case/payment/status updates. 5001 should consume events, run GetCasesByStatus catch-all scans, and only upgrade changed cases into richer collections.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.SOURCING_ATTRIBUTION,
      title: "Sourcing And Attribution",
      status: "mapped-from-original",
      owns: [
        "CallRail-assisted sourcing",
        "source-name normalization",
        "case/profile attribution refresh",
        "call log audit support",
      ],
      originalFiles: [
        "services/logicsService.js",
        "services/callRailService.js",
        "ringBridge/services/callRailStatsService.js",
        "ringBridge/services/hourlySyncService.js",
      ],
      notes:
        "This is the domain that checks what wrote into the system and tries to resolve the real source/channel/case relationship after the fact.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.DATA_HYGIENE,
      title: "Data Hygiene And Cleanup",
      status: "mapped-from-original",
      owns: [
        "nightly cleanup",
        "DNC/client deactivation follow-up",
        "stale prospect purging",
        "snapshot rollups",
      ],
      originalFiles: [
        "ringBridge/services/nightlyCaseHealthService.js",
        "services/statusChecker.js",
      ],
      notes:
        "These are classic control-plane jobs: they reconcile records after primary activity ends and maintain the quality of the durable data set.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.LIST_CLEANING,
      title: "List Cleaning And Review",
      status: "mapped-from-original",
      owns: [
        "client list cleaner jobs",
        "prospect phone/email cleaning",
        "review/flag/remove decisions",
        "future durable cleaner job state",
      ],
      originalFiles: [
        "controllers/listCleanerController.js",
        "utils/clientListCleaner.js",
        "utils/prospectListCleaner.js",
        "routes/cleaner.js",
      ],
      notes:
        "The original implementation is in-memory job based. In the parallel stack, this should become event-backed so progress and results survive restarts.",
    },
    {
      key: CONTROL_PLANE_DOMAIN_KEYS.CONTACT_QUERY,
      title: "Contact History And Frontend Reads",
      status: "mapped-from-original",
      owns: [
        "text message lists",
        "contact history reads",
        "contact info append/query helpers",
        "frontend-facing durable DB reads",
      ],
      originalFiles: [
        "controllers/listController.js",
        "client/src/components/tools/smsinbox/SmsInbox.js",
        "client/src/components/tools/metrics/MetricsDashboard.js",
      ],
      notes:
        "The frontend dependency pattern points to 5001 as the durable query layer for admin/operator reads rather than direct RingBridge internals.",
    },
  ];
}

function listControlPlaneDomains() {
  return buildControlPlaneDomains();
}

function getControlPlaneDomain(domainKey) {
  return buildControlPlaneDomains().find((domain) => domain.key === domainKey) || null;
}

function buildControlPlaneSummary() {
  const domains = buildControlPlaneDomains();

  return {
    status: "groundwork",
    implementedFoundation: domains.filter((domain) =>
      domain.status === "implemented-foundation").length,
    mappedFromOriginal: domains.filter((domain) =>
      domain.status === "mapped-from-original").length,
    totalDomains: domains.length,
    domains,
  };
}

module.exports = {
  listControlPlaneDomains,
  getControlPlaneDomain,
  buildControlPlaneSummary,
};
