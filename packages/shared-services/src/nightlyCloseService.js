"use strict";

const {
  CaseProfile,
  CallLog,
  HourlyJobEvent,
  PaymentLedger,
} = require("../../shared-models/src");
const {
  caseProfileRepository,
  deepCutRunRepository,
  leadCadenceRepository,
  masterProspectRepository,
  paymentAlertRepository,
  paymentLedgerRepository,
  postDateHoldRepository,
  reviewQueueRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
} = require("../../shared-repositories/src");
const {
  legacyReadDb,
} = require("../../shared-repositories/src/legacyReadDb");
const mongoose = require("mongoose");
const {
  summarizeCallStats,
  summarizeCallsByChannel,
} = require("../../shared-repositories/src/dailyCallStatRepository");
const { getCompanyConfig } = require("../../shared-config/src/companyConfig");
const { reconcilePaymentsForDomain } = require("./paymentReconcileService");
const { sendMail } = require("./mailerService");
const {
  buildFinancialCsv,
  buildLeadReconciliationCsv,
  buildVendorCsv,
  buildCallLogCsv,
  buildRedlineCsv,
} = require("./nightlyCsvBuilders");
const { buildVendorDailySummary } = require("./vendorDailySummaryService");
const {
  buildDetailBackedVendorSummary,
  buildVendorCallRows,
  buildVendorLeadRows,
  buildVendorOutcomeRows,
} = require("./vendorNightlyEmailService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");
const {
  listLegacyTodaysCalls,
  listLegacyTodaysPaymentAlerts,
  summarizeLegacySpendByChannel,
  summarizeLegacyDealsBySource,
  summarizeLegacyTransitionsBySource,
  buildLegacyManagementSnapshot,
  buildLegacyMonthToDateSnapshot,
} = require("./legacyNightlyDataService");
const { refreshAttributionForCases } = require("./attributionLoopService");
const {
  buildDealsByCase: sharedBuildDealsByCase,
  buildPaymentsByCase: sharedBuildPaymentsByCase,
  rollupDealsBySource: sharedRollupDealsBySource,
  rollupPaymentTotals: sharedRollupPaymentTotals,
} = require("./metricsDedupService");
const { runHourlySweep } = require("./hourlySweeperService");
const {
  recoverCxCallLogsForDate,
} = require("./cxCallActivityBackfillService");
const { refreshTouchedCase } = require("./hourlyCallLogHygieneService");
const { getInternalFromEmail } = require("../../shared-config/src");

const UNRESOLVED_HOURLY_STATUSES = ["pending", "processing", "failed", "dead-letter"];
const REQUIRED_NIGHTLY_DOMAINS = ["WYNN", "TAG"];
const LD_VENDOR_FAMILY_KEYS = new Set(["ld-custom", "ld-custom-2", "ld-general"]);
const LD_CAMPAIGN_LABELS = {
  "ld-custom": "LD CUSTOM",
  "ld-custom-2": "LD CUSTOM 2",
  "ld-general": "LD GENERAL",
  "ld-posting": "LD Posting",
  "ld": "LD (unsplit)",
};

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function internalFromHeader(name = "Parallel Nightly") {
  return `${name} <${getInternalFromEmail()}>`;
}

function formatDateKey(date = new Date(), timeZone = "America/Los_Angeles") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function vendorFamilyKey(row = {}) {
  return String(row.family || row.familyKey || row.sourceFamilyKey || "")
    .trim()
    .toLowerCase();
}

function isLdVendorFamily(row = {}) {
  return LD_VENDOR_FAMILY_KEYS.has(vendorFamilyKey(row));
}

function isLdSourceLabel(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "ld" ||
    text.includes("ld custom") ||
    text.includes("ld general") ||
    text.includes("lead data");
}

function isLdTransitionRow(row = {}) {
  return isLdSourceLabel(row.source || row.sourceName || row.label);
}

// Rates come from ldSpendService (env-overridable) so the email's estimate
// and the spend LEDGER price identically — the hardcoded $2 general rate
// here overstated the email's LD cost for months (real rate: $1.50).
function ldFamilyEstimatedCost(row = {}) {
  const leads = toNumber(row.leads);
  const key = vendorFamilyKey(row);
  const rates = require("./ldSpendService").getLdRates();
  return leads * toNumber(rates[key]);
}

function decorateLdVendorFamily(row = {}) {
  return {
    ...row,
    estimatedCost: ldFamilyEstimatedCost(row),
  };
}

function sumVendorRows(rows = [], field) {
  return rows.reduce((sum, row) => sum + toNumber(row?.[field]), 0);
}

function buildLdCostSummary(rows = []) {
  const custom = rows.find((row) => vendorFamilyKey(row) === "ld-custom") || {};
  const custom2 = rows.find((row) => vendorFamilyKey(row) === "ld-custom-2") || {};
  const general = rows.find((row) => vendorFamilyKey(row) === "ld-general") || {};
  const customCount = toNumber(custom.leads);
  const custom2Count = toNumber(custom2.leads);
  const generalCount = toNumber(general.leads);
  const rates = require("./ldSpendService").getLdRates();
  const customRate = toNumber(rates["ld-custom"]);
  const custom2Rate = toNumber(rates["ld-custom-2"]);
  const generalRate = toNumber(rates["ld-general"]);
  const customCost = customCount * customRate;
  const custom2Cost = custom2Count * custom2Rate;
  const generalCost = generalCount * generalRate;
  return {
    customCount,
    custom2Count,
    generalCount,
    customRate,
    custom2Rate,
    generalRate,
    customCost,
    custom2Cost,
    generalCost,
    total: customCost + custom2Cost + generalCost,
  };
}

function campaignEstimatedCost(row = {}) {
  const count = toNumber(row.count);
  const rates = require("./ldSpendService").getLdRates();
  return count * toNumber(rates[String(row.key || "").toLowerCase()]);
}

function normalizeNightlyDomains(domains) {
  const requested = (Array.isArray(domains) ? domains : [])
    .map(normalizeDomain)
    .filter(Boolean);
  return [...new Set([...requested, ...REQUIRED_NIGHTLY_DOMAINS])];
}

function rollupVendorOutcomeRows(outcomeRows = []) {
  const bySource = new Map();
  for (const row of Array.isArray(outcomeRows) ? outcomeRows : []) {
    const source = row.sourceName || row.source || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, {
        source,
        contacted: 0,
        deal: 0,
        postdate: 0,
        dnc: 0,
        redline: 0,
      });
    }
    const target = bySource.get(source);
    target.contacted += 1;
    if (row.becameDeal === "yes" || row.becameDeal === true) target.deal += 1;
    if (row.becamePostdate === "yes" || row.becamePostdate === true) target.postdate += 1;
    if (row.becameDnc === "yes" || row.becameDnc === true) target.dnc += 1;
  }
  return [...bySource.values()].sort((a, b) =>
    toNumber(b.deal) - toNumber(a.deal) ||
    toNumber(b.postdate) - toNumber(a.postdate) ||
    toNumber(b.dnc) - toNumber(a.dnc) ||
    String(a.source).localeCompare(String(b.source)),
  );
}

function summarizePaymentSweepForOps(results = [], selectedDomains = []) {
  const allowed = new Set(
    (Array.isArray(selectedDomains) ? selectedDomains : [])
      .map(normalizeDomain)
      .filter(Boolean),
  );
  return (Array.isArray(results) ? results : []).reduce(
    (summary, entry) => {
      if (!entry) return summary;
      const domain = normalizeDomain(entry.domain);
      if (allowed.size > 0 && domain && !allowed.has(domain)) return summary;
      if (entry.error) {
        summary.errors += 1;
        summary.errorDetails.push({ domain, error: entry.error });
        return summary;
      }
      summary.domains += 1;
      summary.casesScanned += toNumber(entry.casesScanned);
      summary.casesWithPayments += toNumber(entry.casesWithPayments);
      summary.newLedgerRows += toNumber(entry.newLedgerRows);
      summary.flaggedFailures += toNumber(entry.flaggedFailures);
      summary.reversals += toNumber(entry.reversals);
      summary.errors += toNumber(entry.errors);
      if (Array.isArray(entry.errorDetails)) {
        for (const detail of entry.errorDetails.slice(0, 20)) {
          summary.errorDetails.push({ domain, ...detail });
        }
      }
      return summary;
    },
    {
      domains: 0,
      casesScanned: 0,
      casesWithPayments: 0,
      newLedgerRows: 0,
      flaggedFailures: 0,
      reversals: 0,
      errors: 0,
      errorDetails: [],
    },
  );
}

async function runNightlyLeadCadenceCaseRefresh(domains, dateKey, options = {}) {
  const selectedDomains = normalizeNightlyDomains(domains);
  const limitPerDomain = Math.min(
    Math.max(Number(options.leadCadenceCaseRefreshLimitPerDomain) || 20000, 1),
    20000,
  );
  const summary = {
    domains: [],
    totals: {
      domains: selectedDomains.length,
      leadRows: 0,
      casesScanned: 0,
      statusRefreshed: 0,
      statusChanges: 0,
      paymentsUpdated: 0,
      newLedgerRows: 0,
      flaggedFailures: 0,
      errors: 0,
    },
  };

  for (const domain of selectedDomains) {
    const domainSummary = {
      domain,
      leadRows: 0,
      casesScanned: 0,
      statusRefreshed: 0,
      statusChanges: 0,
      paymentsUpdated: 0,
      newLedgerRows: 0,
      flaggedFailures: 0,
      errors: 0,
      errorDetails: [],
    };
    try {
      const leads = await leadCadenceRepository.listLeadCadence(domain, {
        createdAtAfter: dateKey,
        createdAtBefore: dateKey,
        limit: limitPerDomain,
      });
      const caseIds = [...new Set(
        leads
          .map((lead) => Number(lead.caseId))
          .filter(Number.isFinite),
      )];
      domainSummary.leadRows = leads.length;
      summary.totals.leadRows += leads.length;

      for (const caseId of caseIds) {
        try {
          const result = await refreshTouchedCase({
            domain,
            caseId,
            createProfileFromCaseInfo: true,
            logger: options.logger || null,
          });
          domainSummary.casesScanned += 1;
          if (result?.statusRefreshed) domainSummary.statusRefreshed += 1;
          if (result?.statusChanged) domainSummary.statusChanges += 1;
          if (result?.paymentsUpdated) domainSummary.paymentsUpdated += 1;
          domainSummary.newLedgerRows += toNumber(result?.paymentResult?.newLedgerRows);
          domainSummary.flaggedFailures += toNumber(result?.paymentResult?.flaggedFailures);
        } catch (error) {
          domainSummary.errors += 1;
          if (domainSummary.errorDetails.length < 20) {
            domainSummary.errorDetails.push({ caseId, error: error.message });
          }
          options.logger?.warn?.("nightly.lead_cadence_case_refresh_failed", {
            domain,
            caseId,
            error: error.message,
          });
        }
      }
    } catch (error) {
      domainSummary.errors += 1;
      domainSummary.errorDetails.push({ error: error.message });
    }

    summary.totals.casesScanned += domainSummary.casesScanned;
    summary.totals.statusRefreshed += domainSummary.statusRefreshed;
    summary.totals.statusChanges += domainSummary.statusChanges;
    summary.totals.paymentsUpdated += domainSummary.paymentsUpdated;
    summary.totals.newLedgerRows += domainSummary.newLedgerRows;
    summary.totals.flaggedFailures += domainSummary.flaggedFailures;
    summary.totals.errors += domainSummary.errors;
    summary.domains.push(domainSummary);
  }

  return summary;
}

async function runNightlyFinalClosePass(domains, options = {}) {
  const selectedDomains = normalizeNightlyDomains(domains);
  const dateKey = options.dateKey || options.date || formatDateKey(new Date(), options.timezone || "America/Los_Angeles");
  let spendSync = null;

  if (options.spendSyncRuntime?.syncAll) {
    try {
      spendSync = await options.spendSyncRuntime.syncAll({
        scheduled: Boolean(options.scheduled),
      });
    } catch (error) {
      spendSync = { ok: false, error: error.message };
    }
  } else {
    spendSync = { ok: false, skipped: true, reason: "no-spend-sync-runtime-passed" };
  }

  // LD spend materializer: lead-cadence counts × per-family rates become
  // REAL spend entries (idempotent per date+family; manual nudges win via
  // collision-skip). Runs right after spend sync so the vendor report and
  // snapshots built later in this close read true LD cost, not zero.
  let ldSpendMaterializer = { skipped: true, reason: "disabled" };
  const ldSpendEnabled =
    options.ldSpendMaterializerEnabled !== undefined
      ? Boolean(options.ldSpendMaterializerEnabled)
      : String(process.env.LD_SPEND_MATERIALIZER_ENABLED ?? "true") !== "false";
  if (ldSpendEnabled) {
    try {
      const { materializeLdSpendForDate } = require("./ldSpendService");
      const ldDomains = String(process.env.LD_SPEND_DOMAINS || "WYNN")
        .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
        .filter((d) => selectedDomains.includes(d));
      ldSpendMaterializer = { domains: {} };
      for (const ldDomain of ldDomains) {
        ldSpendMaterializer.domains[ldDomain] = await materializeLdSpendForDate({
          domain: ldDomain,
          dateKey,
          logger: options.logger || null,
        });
      }
    } catch (error) {
      ldSpendMaterializer = { ok: false, error: error.message };
      options.logger?.warn?.("nightly-close.ld_spend_materializer_failed", { error: error.message });
    }
  }

  const hourlySweep = await runHourlySweep({
    workerName: "nightly-close-final",
    lane: "nightly",
    scheduledPhase: true,
    domains: selectedDomains,
    batchCap: Math.min(Math.max(Number(options.retryBatchCap) || 100, 1), 500),
    maxCasesPerDomain: Math.min(Math.max(Number(options.maxCasesPerDomain || options.maxCases) || 10000, 1), 10000),
    metricsRefreshEnabled: options.metricsRefreshEnabled !== false,
    metricsRefreshPreferLegacyContactActivities:
      options.metricsRefreshPreferLegacyContactActivities === true,
    leadCadenceEnforcementEnabled:
      options.leadCadenceEnforcementEnabled !== undefined
        ? Boolean(options.leadCadenceEnforcementEnabled)
        : false,
    leadCadenceEnforcementLimitPerDomain:
      options.leadCadenceEnforcementLimitPerDomain || 1000,
    leadCadenceEnforcementMinStaleMs:
      options.leadCadenceEnforcementMinStaleMs || 0,
    leadCadenceEnforcementDryRun:
      Boolean(options.leadCadenceEnforcementDryRun),
    callLogHygieneEnabled: options.callLogHygieneEnabled !== false,
    callLogHygieneSinceMs:
      Math.max(Number(options.callLogHygieneSinceMs) || 48 * 60 * 60 * 1000, 60 * 60 * 1000),
    callLogHygieneLimitPerDomain:
      Math.min(Math.max(Number(options.callLogHygieneLimitPerDomain) || 10000, 1), 20000),
    callLogHygieneMirrorLegacyContactActivities:
      options.callLogHygieneMirrorLegacyContactActivities === true,
    callLogHygieneNativeSweepEnabled:
      options.callLogHygieneNativeSweepEnabled !== false,
    callLogHygieneNativeSweepLimit:
      Math.min(Math.max(Number(options.callLogHygieneNativeSweepLimit) || 5000, 1), 20000),
    callLogHygieneNativeSweepMaxPages:
      Math.min(Math.max(Number(options.callLogHygieneNativeSweepMaxPages) || 50, 1), 200),
    callLogHygieneNativeSweepDefaultDomain:
      options.callLogHygieneNativeSweepDefaultDomain,
    callLogHygieneMinDurationSec:
      Math.max(Number(options.callLogHygieneMinDurationSec) || 0, 0),
    callLogHygieneMaxCaseRefreshesPerDomain:
      Math.min(Math.max(Number(options.callLogHygieneMaxCaseRefreshesPerDomain) || 10000, 1), 10000),
    callLogHygieneMaxScoringPerDomain:
      Math.min(Math.max(Number(options.callLogHygieneMaxScoringPerDomain) || 1000, 1), 1000),
    callLogHygieneMaxArchivePerDomain:
      Math.min(Math.max(Number(options.callLogHygieneMaxArchivePerDomain) || 1000, 1), 1000),
    callLogHygieneScorePendingCalls:
      options.callLogHygieneScorePendingCalls !== false,
    callLogHygieneArchiveRecordings:
      options.callLogHygieneArchiveRecordings !== false,
    logger: options.logger || null,
  });

  let cxCallActivityBackfill = null;
  try {
    cxCallActivityBackfill = await recoverCxCallLogsForDate({
      date: dateKey,
      timezone: options.timezone || "America/Los_Angeles",
      domains: selectedDomains,
      limit: Math.min(Math.max(Number(options.cxCallActivityBackfillLimit) || 50000, 1), 100000),
      dryRun: false,
      logger: options.logger || null,
    });
  } catch (error) {
    cxCallActivityBackfill = {
      error: error.message,
      date: dateKey,
      domains: selectedDomains,
    };
    options.logger?.warn?.("nightly-close.cx_call_activity_backfill_failed", {
      date: dateKey,
      domains: selectedDomains,
      error: error.message,
    });
  }

  const leadCadenceCaseRefresh = options.leadCadenceCaseRefreshEnabled === false
    ? { skipped: true, reason: "disabled" }
    : await runNightlyLeadCadenceCaseRefresh(
        selectedDomains,
        dateKey,
        options,
      );
  let postDateSweep = { skipped: true, reason: "disabled" };
  if (options.postDateSweepEnabled !== false) {
    try {
      const { runPostDateHoldEodSweep } = require("./cxWorkspaceService");
      postDateSweep = await runPostDateHoldEodSweep(selectedDomains, {
        dateKey,
        dryRun: Boolean(options.postDateSweepDryRun),
        limit: options.postDateSweepLimit || 250,
      });
    } catch (error) {
      postDateSweep = { ok: false, error: error.message, dateKey };
    }
  }

  // Client-case discovery: ensure every Logics client-status case has a
  // caseProfile, independent of call logs and intake (the auth-spam window
  // proved profiles born only from engagement go missing — and the payment
  // reconcile can't see a case without a profile). Skips itself politely
  // until CLIENT_CASE_DISCOVERY_STATUS_IDS is configured.
  let clientCaseDiscovery = { skipped: true, reason: "disabled" };
  const discoveryEnabled =
    options.clientCaseDiscoveryEnabled !== undefined
      ? Boolean(options.clientCaseDiscoveryEnabled)
      : String(process.env.CLIENT_CASE_DISCOVERY_ENABLED ?? "true") !== "false";
  if (discoveryEnabled) {
    try {
      const { ensureClientCaseProfiles } = require("./clientCaseDiscoveryService");
      clientCaseDiscovery = await ensureClientCaseProfiles({ logger: options.logger || null });
    } catch (error) {
      clientCaseDiscovery = { ok: false, error: error.message };
      options.logger?.warn?.("nightly-close.client_case_discovery_failed", { error: error.message });
    }
  }

  return {
    domains: selectedDomains,
    spendSync,
    ldSpendMaterializer,
    hourlySweep,
    cxCallActivityBackfill,
    leadCadenceCaseRefresh,
    postDateSweep,
    clientCaseDiscovery,
    paymentSweep: summarizePaymentSweepForOps(
      hourlySweep?.phaseA?.paymentReconcile || [],
      selectedDomains,
    ),
  };
}

function createSection(key, title) {
  return {
    key,
    title,
    status: "planned",
    summary: null,
    metrics: null,
  };
}

function buildNightlyClosePlan() {
  return {
    cadence: "nightly-close",
    groups: [
      {
        key: "final-reconcile",
        title: "Final Reconcile",
        purpose: "fresh pass at spend sync + payment reconcile so the snapshots that follow read the latest data, not stale figures from earlier in the day",
      },
      {
        key: "management-snapshot",
        title: "Management Snapshot",
        purpose: "freeze daily top-line leads, spend, calls, payments, alerts, and score counts",
      },
      {
        key: "month-to-date",
        title: "Month-to-Date Roll-Up",
        purpose: "month-window aggregates of leads / spend / payments / calls for the financial-close attachment",
      },
      {
        key: "vendor-report",
        title: "Vendor Report",
        purpose: "package source/vendor rows with spend, calls, lead counts, and scored-call quality",
      },
      {
        key: "bug-wrap-up",
        title: "Bug Wrap Up",
        purpose: "summarize unresolved hourly jobs and prune resolved retry noise from the queue",
      },
      {
        key: "reporting",
        title: "Reporting",
        purpose: "send Pool A (financial close, admins only) + Pool B (lead data + scoring, admins + LizDev partner) emails",
      },
    ],
  };
}

// ── Recipient pools ──────────────────────────────────────────────────
//
// Defined here so production cutover is a one-line uncomment per pool.
// Today everything routes to mgray@ as a single-recipient sanity-check
// pool — when the email format is locked in and verified live, swap to
// the production lists below.
//
// Pool semantics:
//   - financialPool: spend / money-in / redlines. Internal only.
//   - leadDataPool:  lead intake breakdown + scoring. Internal admins
//                    plus the LizDev partner who consumes lead-data
//                    quality signals.
const NIGHTLY_RECIPIENT_POOLS = {
  financial: {
    env: "NIGHTLY_CLOSE_FINANCIAL_RECIPIENTS",
    development: ["mgray@taxadvocategroup.com"],
    production: [
      "mgray@taxadvocategroup.com",
      "manderson@taxadvocategroup.com",
      "abanks@taxadvocategroup.com",
      "jonathan13pineda@yahoo.com",
    ],
  },
  leadData: {
    env: "NIGHTLY_CLOSE_LEAD_DATA_RECIPIENTS",
    development: ["mgray@taxadvocategroup.com"],
    production: [
      "mgray@taxadvocategroup.com",
      "manderson@taxadvocategroup.com",
      "liz@lizdev.com",
      "beth@lizdev.com",
    ],
    //   // LizDev partner — fill in once Liz confirms the recipient
  },
  // Pool D — App status / failures / things to look at. Goes to the
  // dev driving the system, not the people who only care about money
  // or leads. Stays as a single-recipient pool indefinitely.
  ops: {
    env: "NIGHTLY_CLOSE_OPS_RECIPIENTS",
    development: ["mgray@taxadvocategroup.com"],
    production: ["mgray@taxadvocategroup.com"],
  },
  // Pool E — Aged pool daily refresh report. Fires at 06:00 PT after
  // the daily age-in / re-scrub job completes. Day-1 also includes the
  // monthly graduation list. Recipients are the people who care about
  // the dial-pool composition.
  agedPool: {
    env: "AGED_REFRESH_REPORT_RECIPIENTS",
    development: ["mgray@taxadvocategroup.com"],
    production: [
      "mgray@taxadvocategroup.com",
      "manderson@taxadvocategroup.com",
      "abanks@taxadvocategroup.com",
    ],
  },
};

function parseRecipientList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getRecipientPool(poolKey) {
  const pool = NIGHTLY_RECIPIENT_POOLS[poolKey] || {};
  const envRecipients = parseRecipientList(process.env[pool.env]);
  if (envRecipients.length > 0) return envRecipients;
  return pool.production || pool.development || ["mgray@taxadvocategroup.com"];
}

function formatMoney(value) {
  return `$${toNumber(value).toFixed(2)}`;
}

async function buildPostDateHoldEmailRows(domains, dateKey) {
  const selectedDomains = normalizeNightlyDomains(domains);
  const byId = new Map();
  for (const domain of selectedDomains) {
    const [active, today] = await Promise.all([
      postDateHoldRepository.listPostDateHolds(domain, {
        status: "active",
        limit: 500,
      }).catch(() => []),
      postDateHoldRepository.listPostDateHolds(domain, {
        status: "all",
        date: dateKey,
        limit: 500,
      }).catch(() => []),
    ]);
    for (const hold of [...active, ...today]) {
      const id = String(hold._id || `${hold.domain}:${hold.caseId}:${hold.status}`);
      byId.set(id, hold);
    }
  }
  return [...byId.values()]
    .sort((left, right) => {
      const leftActive = left.status === "active" ? 0 : 1;
      const rightActive = right.status === "active" ? 0 : 1;
      if (leftActive !== rightActive) return leftActive - rightActive;
      return String(left.firstPaymentDateKey || "9999-99-99").localeCompare(
        String(right.firstPaymentDateKey || "9999-99-99"),
      );
    })
    .map((hold) => ({
      id: String(hold._id || ""),
      domain: hold.domain,
      caseId: hold.caseId,
      status: hold.status,
      caseName: hold.caseName || `Case ${hold.caseId}`,
      phone: hold.phone || "",
      sourceName: hold.sourceName || "",
      postDatedDateKey: hold.postDatedDateKey || "",
      postDatedBy: hold.postDatedByName || hold.postDatedByEmail || "",
      firstPaymentDateKey: hold.firstPaymentDateKey || "",
      paymentScheduleStatus: hold.paymentScheduleStatus || "",
      releaseReason: hold.releaseReason || "",
      rowType:
        hold.status === "active"
          ? hold.postDatedDateKey === dateKey
            ? "active today"
            : "active carryover"
          : `today ${String(hold.status || "").replace(/_/g, " ")}`,
    }));
}

async function buildLeadSummary(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const rows = await masterProspectRepository.summarizeProspectsByIntakeSource(
    domain,
    { from: start, to: end },
  );
  const entries = rows.map((row) => ({
    source: row._id || "Unknown",
    count: toNumber(row.count),
  }));
  const total = entries.reduce((sum, row) => sum + row.count, 0);
  return { total, entries };
}

async function buildPaymentSummary(domain, dateKey) {
  const payments = await paymentLedgerRepository.listPayments(domain, { limit: 5000 });
  const summary = {
    totalAmount: 0,
    totalCount: 0,
    initialAmount: 0,
    initialCount: 0,
    recurringAmount: 0,
    recurringCount: 0,
  };

  for (const payment of payments) {
    const paymentDateKey = String(payment.paymentDateKey || String(payment.paymentDate || "").slice(0, 10));
    if (paymentDateKey !== dateKey) continue;
    const amount = toNumber(payment.amount);
    summary.totalAmount += amount;
    summary.totalCount += 1;
    if (String(payment.paymentType || "").toLowerCase() === "initial") {
      summary.initialAmount += amount;
      summary.initialCount += 1;
    } else {
      summary.recurringAmount += amount;
      summary.recurringCount += 1;
    }
  }

  return summary;
}

async function buildCallSummary(domain, dateKey, timeZone = "America/Los_Angeles") {
  const excludePieces = await sourceCanonicalRepository
    .listPiecesAssignedToOtherDomains(domain)
    .catch(() => []);

  const [byChannel, byPiece] = await Promise.all([
    summarizeCallsByChannel({ date: dateKey, excludePieces }),
    summarizeCallStats({ date: dateKey, excludePieces }),
  ]);

  return {
    byChannel: byChannel.map((row) => ({
      channel: row._id || "unknown",
      totalCalls: toNumber(row.totalCalls),
      callsOver5: toNumber(row.callsOver5),
      uniqueCallers: toNumber(row.uniqueCallers),
    })),
    byPiece: byPiece.map((row) => ({
      piece: row._id?.piece || "Unknown",
      channel: row._id?.channel || null,
      totalCalls: toNumber(row.totalCalls),
      callsOver5: toNumber(row.callsOver5),
      uniqueCallers: toNumber(row.uniqueCallers),
    })),
  };
}

// CX-only call rollup for the nightly close. Runs alongside the
// existing channel/piece aggregations but reads CallLog directly so it
// can filter by platform="cx" (the disposition path stamps this on every
// CX-routed call). The numbers it produces are LD dial activity — CX is
// the dial path for LD leads, so this is the throughput signal for the
// LD CUSTOM / LD GENERAL pipelines we just split.
//
// Returns { total, uniqueCallers, callsOver5, longestSec } scoped to
// the given domain + PT date. Wrapped in a try/catch by the caller so a
// CallLog aggregation hiccup never derails the email composition.
async function buildCxCallSummary(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const rows = await CallLog.aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        callStartTime: { $gte: start, $lte: end },
        platform: "cx",
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        callsOver5: {
          $sum: { $cond: [{ $gte: [{ $ifNull: ["$durationSec", 0] }, 300] }, 1, 0] },
        },
        longestSec: { $max: { $ifNull: ["$durationSec", 0] } },
        uniqueCaseIds: { $addToSet: "$caseId" },
        uniqueSessionIds: { $addToSet: "$telephonySessionId" },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        callsOver5: 1,
        longestSec: 1,
        uniqueCallers: {
          $size: { $filter: { input: "$uniqueCaseIds", as: "c", cond: { $ne: ["$$c", null] } } },
        },
        uniqueSessions: {
          $size: { $filter: { input: "$uniqueSessionIds", as: "s", cond: { $ne: ["$$s", null] } } },
        },
      },
    },
  ]).catch(() => []);
  const row = rows[0] || {};
  return {
    total: toNumber(row.total),
    callsOver5: toNumber(row.callsOver5),
    longestSec: toNumber(row.longestSec),
    uniqueCallers: toNumber(row.uniqueCallers),
    uniqueSessions: toNumber(row.uniqueSessions),
  };
}

async function buildScoreSummary(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const rows = await CallLog.aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        callStartTime: { $gte: start, $lte: end },
        "callScore.overall": { $ne: null },
      },
    },
    {
      $group: {
        _id: "$sourceName",
        scoredCalls: { $sum: 1 },
        averageScore: { $avg: "$callScore.overall" },
        hot: {
          $sum: {
            $cond: [{ $eq: ["$callScore.lead_verdict", "hot"] }, 1, 0],
          },
        },
        warm: {
          $sum: {
            $cond: [{ $eq: ["$callScore.lead_verdict", "warm"] }, 1, 0],
          },
        },
        cold: {
          $sum: {
            $cond: [
              { $eq: ["$callScore.lead_verdict", "cold"] },
              1,
              0,
            ],
          },
        },
        dead: {
          $sum: {
            $cond: [{ $eq: ["$callScore.lead_verdict", "dead"] }, 1, 0],
          },
        },
        fake: {
          $sum: {
            $cond: [{ $eq: ["$callScore.lead_verdict", "fake"] }, 1, 0],
          },
        },
      },
    },
    { $sort: { scoredCalls: -1, _id: 1 } },
  ]);

  const entries = rows.map((row) => ({
    source: row._id || "Unknown",
    scoredCalls: toNumber(row.scoredCalls),
    averageScore: row.averageScore != null ? Number(row.averageScore.toFixed(2)) : null,
    hot: toNumber(row.hot),
    warm: toNumber(row.warm),
    cold: toNumber(row.cold),
    dead: toNumber(row.dead),
    fake: toNumber(row.fake),
  }));

  return {
    totalScoredCalls: entries.reduce((sum, row) => sum + row.scoredCalls, 0),
    entries,
  };
}

async function buildManagementSnapshot(domain, dateKey, timeZone = "America/Los_Angeles") {
  const [spendTotals, leadSummary, paymentSummary, callSummary, cxCallSummary, scoreSummary, pendingRedlines, reviewRedlines, unresolvedHourly] =
    await Promise.all([
      spendEntryRepository.getSpendTotals(domain, { date: dateKey }),
      buildLeadSummary(domain, dateKey, timeZone),
      buildPaymentSummary(domain, dateKey),
      buildCallSummary(domain, dateKey, timeZone),
      // CX-only rollup. Failure here is non-fatal — the rest of the
      // email composes with the existing byChannel data.
      buildCxCallSummary(domain, dateKey, timeZone).catch(() => ({
        total: 0, callsOver5: 0, longestSec: 0, uniqueCallers: 0, uniqueSessions: 0,
      })),
      buildScoreSummary(domain, dateKey, timeZone),
      paymentAlertRepository.countPaymentAlerts(domain, { status: "pending", paymentDate: dateKey }).catch(() => 0),
      reviewQueueRepository.countReviewQueueItems(domain, { category: "redline", status: "open" }).catch(() => 0),
      HourlyJobEvent.countDocuments({
        domain: normalizeDomain(domain),
        status: { $in: UNRESOLVED_HOURLY_STATUSES },
      }).catch(() => 0),
    ]);

  const totalCalls = callSummary.byChannel.reduce((sum, row) => sum + row.totalCalls, 0);
  const totalCallsOver5 = callSummary.byChannel.reduce((sum, row) => sum + row.callsOver5, 0);

  return {
    date: dateKey,
    spend: {
      total: toNumber(spendTotals.spend),
      pieces: toNumber(spendTotals.pieces),
      impressions: toNumber(spendTotals.impressions),
      clicks: toNumber(spendTotals.clicks),
      leadsReported: toNumber(spendTotals.leadsReported),
      rows: toNumber(spendTotals.rows),
    },
    leads: leadSummary,
    payments: paymentSummary,
    calls: {
      total: totalCalls,
      callsOver5: totalCallsOver5,
      byChannel: callSummary.byChannel,
      // CX-specific (LD dial activity). Added alongside the existing
      // byChannel rollup so downstream consumers that already read
      // .total / .byChannel keep working unchanged.
      cx: cxCallSummary,
    },
    scores: {
      totalScoredCalls: scoreSummary.totalScoredCalls,
      bySource: scoreSummary.entries,
    },
    alerts: {
      pendingRedlines: toNumber(pendingRedlines),
      reviewRedlines: toNumber(reviewRedlines),
      unresolvedHourlyJobs: toNumber(unresolvedHourly),
    },
  };
}

async function buildVendorReport(domain, dateKey, options = {}) {
  return buildVendorDailySummary(domain, {
    date: dateKey,
    timezone: options.timezone || "America/Los_Angeles",
  });
}

async function wrapHourlyJobs(domain, dateKey, options = {}) {
  const { end } = buildTimezoneDateWindow(
    dateKey,
    options.timezone || "America/Los_Angeles",
  );
  const unresolved = await HourlyJobEvent.find({
    domain: normalizeDomain(domain),
    status: { $in: UNRESOLVED_HOURLY_STATUSES },
    createdAt: { $lte: end },
  })
    .sort({ priority: -1, createdAt: 1 })
    .limit(Math.min(Number(options.unresolvedLimit) || 50, 200))
    .lean();

  let prunedResolved = 0;
  if (options.pruneResolved !== false) {
    const pruneResult = await HourlyJobEvent.deleteMany({
      domain: normalizeDomain(domain),
      status: "completed",
      completedAt: { $lte: end },
    });
    prunedResolved = toNumber(pruneResult.deletedCount);
  }

  return {
    date: dateKey,
    unresolvedCount: unresolved.length,
    unresolved,
    prunedResolved,
  };
}

async function countStatusChanges(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  return CaseProfile.countDocuments({
    domain: normalizeDomain(domain),
    statusLastChangedAt: { $gte: start, $lte: end },
  }).catch(() => 0);
}

async function countStopSignalsDetected(domain) {
  return reviewQueueRepository.countReviewQueueItems(normalizeDomain(domain), {
    workflow: "hourly-hygiene",
    category: "stop-detected",
    status: "open",
  }).catch(() => 0);
}

async function countAiCaseReviewsDue(domain, olderThanDays = 7) {
  const cutoff = new Date(Date.now() - Number(olderThanDays || 7) * 86400000);
  return CaseProfile.countDocuments({
    domain: normalizeDomain(domain),
    $or: [
      { "aiCaseReview.reviewedAt": { $exists: false } },
      { "aiCaseReview.reviewedAt": null },
      { "aiCaseReview.reviewedAt": { $lt: cutoff } },
    ],
  }).catch(() => 0);
}

async function countAiCaseReviewsCompleted(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  return CaseProfile.countDocuments({
    domain: normalizeDomain(domain),
    "aiCaseReview.reviewedAt": { $gte: start, $lte: end },
  }).catch(() => 0);
}

/**
 * Month-to-date roll-up — same axes as `buildManagementSnapshot` but
 * windowed from the 1st of the current month through `dateKey`. Used
 * by the financial close email's CSV attachment and for any "MTD"
 * lines in the body.
 *
 * Calls into the existing repos that already accept date-range
 * filters, so the surface area is small and reuse is high.
 */
async function buildMonthToDateSnapshot(domain, dateKey, timeZone = "America/Los_Angeles") {
  const monthStartKey = `${dateKey.slice(0, 7)}-01`;
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const monthStart = buildTimezoneDateWindow(monthStartKey, timeZone).start;

  // Lead intake — sum the per-day prospect counts across the month.
  const leadRows = await masterProspectRepository
    .summarizeProspectsByIntakeSource(domain, { from: monthStart, to: end })
    .catch(() => []);
  const leadEntries = leadRows.map((row) => ({
    source: row._id || "Unknown",
    count: toNumber(row.count),
  }));
  const leadsTotal = leadEntries.reduce((sum, row) => sum + row.count, 0);

  // Spend — sum daily spend totals across the month window.
  const spendTotals = await spendEntryRepository
    .getSpendTotals(domain, { from: monthStartKey, to: dateKey })
    .catch(() => ({}));

  // Payments — pull all payments in the month and tally locally.
  // (paymentLedgerRepository.listPayments doesn't accept a date filter
  // today; we slice client-side with the dateKey window.)
  const allPayments = await paymentLedgerRepository
    .listPayments(domain, { limit: 100000 })
    .catch(() => []);
  const monthPayments = {
    totalAmount: 0,
    totalCount: 0,
    initialAmount: 0,
    initialCount: 0,
    recurringAmount: 0,
    recurringCount: 0,
  };
  for (const p of allPayments) {
    const dateStr = String(p.paymentDateKey || String(p.paymentDate || "").slice(0, 10));
    if (!dateStr || dateStr < monthStartKey || dateStr > dateKey) continue;
    const amount = toNumber(p.amount);
    monthPayments.totalAmount += amount;
    monthPayments.totalCount += 1;
    if (String(p.paymentType || "").toLowerCase() === "initial") {
      monthPayments.initialAmount += amount;
      monthPayments.initialCount += 1;
    } else {
      monthPayments.recurringAmount += amount;
      monthPayments.recurringCount += 1;
    }
  }

  // Calls — aggregate daily-call-stats across the month window.
  const monthCallStats = await summarizeCallsByChannel({
    from: monthStartKey,
    to: dateKey,
  }).catch(() => []);
  const monthCalls = {
    total: monthCallStats.reduce((sum, row) => sum + toNumber(row.totalCalls), 0),
    callsOver5: monthCallStats.reduce((sum, row) => sum + toNumber(row.callsOver5), 0),
    byChannel: monthCallStats,
  };

  return {
    monthStart: monthStartKey,
    monthEnd: dateKey,
    leads: { total: leadsTotal, entries: leadEntries },
    spend: {
      total: toNumber(spendTotals.spend),
      pieces: toNumber(spendTotals.pieces),
      impressions: toNumber(spendTotals.impressions),
      clicks: toNumber(spendTotals.clicks),
      leadsReported: toNumber(spendTotals.leadsReported),
      rows: toNumber(spendTotals.rows),
    },
    payments: monthPayments,
    calls: monthCalls,
  };
}

/**
 * Build a base64-encoded CSV attachment summarizing daily + MTD
 * numbers side-by-side. SendGrid v3 expects attachments as base64
 * strings; the surrounding sendgridClient.sendEmail just passes the
 * `attachments` array through to /v3/mail/send.
 */
function buildMetricsCsvAttachment(domain, dateKey, daily, mtd) {
  const rows = [
    ["metric", "today", "mtd"],
    ["leads_total", daily.leads.total, mtd.leads.total],
    ["spend_total", daily.spend.total, mtd.spend.total],
    ["spend_pieces", daily.spend.pieces, mtd.spend.pieces],
    ["spend_leads_reported", daily.spend.leadsReported, mtd.spend.leadsReported],
    ["payments_total_amount", daily.payments.totalAmount, mtd.payments.totalAmount],
    ["payments_total_count", daily.payments.totalCount, mtd.payments.totalCount],
    ["payments_initial_amount", daily.payments.initialAmount, mtd.payments.initialAmount],
    ["payments_initial_count", daily.payments.initialCount, mtd.payments.initialCount],
    ["payments_recurring_amount", daily.payments.recurringAmount, mtd.payments.recurringAmount],
    ["payments_recurring_count", daily.payments.recurringCount, mtd.payments.recurringCount],
    ["calls_total", daily.calls.total, mtd.calls.total],
    ["calls_over_5min", daily.calls.callsOver5, mtd.calls.callsOver5],
    ["scored_calls_total", daily.scores.totalScoredCalls, "n/a"],
  ];

  // Lead by-source rows for both windows.
  rows.push(["", "", ""]);
  rows.push(["leads_by_source", "today", "mtd"]);
  const dailyBySource = new Map(daily.leads.entries.map((row) => [row.source, row.count]));
  const mtdBySource = new Map(mtd.leads.entries.map((row) => [row.source, row.count]));
  const allSources = new Set([...dailyBySource.keys(), ...mtdBySource.keys()]);
  for (const source of [...allSources].sort()) {
    rows.push([source, dailyBySource.get(source) || 0, mtdBySource.get(source) || 0]);
  }

  const csv = rows
    .map((row) => row.map((cell) => {
      const str = String(cell ?? "");
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(","))
    .join("\n");

  return {
    content: Buffer.from(csv, "utf8").toString("base64"),
    filename: `${domain}-financial-close-${dateKey}.csv`,
    type: "text/csv",
    disposition: "attachment",
  };
}

// ── Email payload helpers ───────────────────────────────────────────
//
// These compute the additional axes the new HTML templates need that
// `buildManagementSnapshot` doesn't already provide:
//   - status transitions by source (the "what moved tonight" view)
//   - new deals by source (initial-payment counts, by source)
//   - spend rolled up by channel (the spend snapshot tile)
//   - today's call log (CSV sidecar for the lead-data email)
//   - today's failed-payment alerts (Pool C body + CSV)

async function buildTransitionsBySource(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  const rows = await CaseProfile.aggregate([
    {
      $match: {
        domain: normalizeDomain(domain),
        statusLastChangedAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { source: "$sourceName", category: "$statusCategory" },
        count: { $sum: 1 },
      },
    },
  ]);

  const bySource = new Map();
  for (const row of rows) {
    const source = row._id?.source || "Unknown";
    const category = String(row._id?.category || "").toLowerCase();
    const count = toNumber(row.count);
    if (!bySource.has(source)) {
      bySource.set(source, {
        source,
        contacted: 0,
        deal: 0,
        postdate: 0,
        dnc: 0,
        redline: 0,
      });
    }
    const target = bySource.get(source);
    target.contacted += count;
    if (category === "client" || category.startsWith("tier")) target.deal += count;
    else if (category === "postdate") target.postdate += count;
    else if (category === "dnc") target.dnc += count;
    else if (category === "redline") target.redline += count;
  }
  return [...bySource.values()].sort((a, b) => b.contacted - a.contacted);
}

async function buildDealsBySource(domain, dateKey) {
  const rows = await paymentLedgerRepository.summarizeSuccessfulPaymentsBySource(
    domain,
    { from: dateKey, to: dateKey },
  );
  return rows.map((row) => ({
    source: row._id?.source || "Unknown",
    channel: row._id?.channel || null,
    deals: toNumber(row.initialPaymentCount),
    initialPayments: toNumber(row.initialPayments),
    totalCollected: toNumber(row.payments),
  })).filter((row) => row.deals > 0 || row.totalCollected > 0)
    .sort((a, b) => b.deals - a.deals || b.totalCollected - a.totalCollected);
}

// ── Deals at the case level — delegates to metricsDedupService ───
// Kept as a local entry so existing call sites keep working; the
// implementation lives in `metricsDedupService` so hourly + daily-
// summary use the same dedup primitives.
async function buildDealsByCase(domain, dateKey) {
  return sharedBuildDealsByCase(domain, dateKey);
}
async function _legacy_buildDealsByCase_unused(domain, dateKey) {
  const normalizedDomain = normalizeDomain(domain);

  // Parallel side — raw rows (not aggregated) so casePaymentId stays
  // queryable. We populate sourceCanonical for the canonical name +
  // channel, with a fall-back to whatever was stamped on `raw`.
  const parallelRows = await PaymentLedger.find({
    domain: normalizedDomain,
    paymentDateKey: dateKey,
    paymentType: "initial",
    transactionStatus: "SUCCESS",
  })
    .populate("sourceCanonicalId", "internalName channel")
    .lean();

  // Legacy side — `dailypaymentsummaries` with type=initial.
  const legacyRows = await legacyReadDb(mongoose)
    .collection("dailypaymentsummaries")
    .find({
      domain: normalizedDomain,
      date: String(dateKey),
      type: "initial",
    })
    .toArray();

  // Merge by casePaymentId (globally unique).
  const byKey = new Map();
  for (const r of parallelRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    const canonical = r.sourceCanonicalId && typeof r.sourceCanonicalId === "object"
      ? r.sourceCanonicalId
      : null;
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      sourceName_parallel: canonical?.internalName || r?.raw?.sourceName || null,
      sourceChannel_parallel: canonical?.channel || r?.raw?.sourceChannel || null,
      sourceCanonicalId: canonical?._id ? String(canonical._id) : null,
      needsSourceReview: Boolean(r.needsSourceReview),
    });
  }
  for (const r of legacyRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    const existing = byKey.get(key) || {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
    };
    existing.sourceName_legacy = r.sourceName || null;
    existing.sourceChannel_legacy = r.sourceChannel || null;
    if (!existing.amount) existing.amount = toNumber(r.amount);
    byKey.set(key, existing);
  }

  // Enrich with CaseProfile (parallel + legacy fallback) for name +
  // the source mirror that lives on the profile itself.
  const caseIds = [...new Set(
    [...byKey.values()].map((r) => r.caseId).filter(Number.isFinite),
  )];

  const parallelProfiles = caseIds.length > 0
    ? await caseProfileRepository.listCaseProfilesByCaseIds(normalizedDomain, caseIds).catch(() => [])
    : [];
  const profileByCaseId = new Map(
    parallelProfiles.map((p) => [Number(p.caseId), p]),
  );

  const legacyProfiles = caseIds.length > 0
    ? await legacyReadDb(mongoose)
        .collection("rb_caseprofiles")
        .find(
          { domain: normalizedDomain, caseId: { $in: caseIds } },
          { projection: { caseId: 1, name: 1, firstName: 1, lastName: 1, sourceName: 1, sourceChannel: 1 } },
        )
        .toArray()
    : [];
  const legacyProfileByCaseId = new Map(
    legacyProfiles.map((p) => [Number(p.caseId), p]),
  );

  const out = [];
  for (const row of byKey.values()) {
    const profile = profileByCaseId.get(row.caseId) || null;
    const legacyProfile = legacyProfileByCaseId.get(row.caseId) || null;
    const profileName =
      profile?.name ||
      [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() ||
      legacyProfile?.name ||
      [legacyProfile?.firstName, legacyProfile?.lastName].filter(Boolean).join(" ").trim() ||
      null;
    const profileSource = profile?.sourceName || legacyProfile?.sourceName || null;
    const profileChannel = profile?.sourceChannel || legacyProfile?.sourceChannel || null;

    // Best-pick source attribution. Order:
    //   1. Parallel canonical (verified manually or by canonical lookup)
    //   2. Case profile mirror (most-recent Logics enrichment)
    //   3. Legacy summary stamp
    //   4. Unknown
    let sourceName, sourceChannel, attributionPath;
    if (row.sourceCanonicalId && row.sourceName_parallel) {
      sourceName = row.sourceName_parallel;
      sourceChannel = row.sourceChannel_parallel;
      attributionPath = "parallel-canonical";
    } else if (profileSource) {
      sourceName = profileSource;
      sourceChannel = profileChannel;
      attributionPath = "case-profile";
    } else if (row.sourceName_legacy) {
      sourceName = row.sourceName_legacy;
      sourceChannel = row.sourceChannel_legacy;
      attributionPath = "legacy-summary";
    } else if (row.sourceName_parallel) {
      sourceName = row.sourceName_parallel;
      sourceChannel = row.sourceChannel_parallel;
      attributionPath = "parallel-raw";
    } else {
      sourceName = "Unknown";
      sourceChannel = null;
      attributionPath = "unknown";
    }

    // Conflict — flagged when at least two non-null source signals
    // disagree on the source name. The user can spot these and reach
    // into the Review workspace to lock the right canonical.
    const signals = [
      row.sourceName_parallel,
      row.sourceName_legacy,
      profileSource,
    ].filter(Boolean);
    const distinct = new Set(signals.map((s) => String(s).trim().toLowerCase()));
    const conflict = distinct.size > 1;

    out.push({
      domain: row.domain,
      caseId: row.caseId,
      casePaymentId: row.casePaymentId,
      amount: row.amount,
      name: profileName,
      sourceName,
      sourceChannel,
      attributionPath,
      conflict,
      sourceName_parallel: row.sourceName_parallel || null,
      sourceChannel_parallel: row.sourceChannel_parallel || null,
      sourceCanonicalId: row.sourceCanonicalId || null,
      sourceName_legacy: row.sourceName_legacy || null,
      sourceChannel_legacy: row.sourceChannel_legacy || null,
      sourceName_profile: profileSource || null,
      sourceChannel_profile: profileChannel || null,
      needsSourceReview: Boolean(row.needsSourceReview) || conflict || attributionPath === "unknown",
    });
  }

  // Sort: largest amount first, then caseId for stable ordering.
  out.sort((a, b) => b.amount - a.amount || a.caseId - b.caseId);
  return out;
}

// ── MTD ROI by source — direct passthrough to the metrics-page aggregation ──
//
// The metrics page already does the heavy lifting in
// `buildMetricSourcesWorkspace("ALL", { from, to })`. That function:
//   - reads spend from `SpendEntry` (Parallel) augmented with the
//     legacy mirror (`buildLegacyMetricSourcesWorkspace`)
//   - reads cases from `caseProfileRepository.summarizeCaseProfilesBySource`
//   - reads ROI-eligible payments from `listRoiEligiblePayments`
//   - reads call rollups from `dailyCallStatRepository.summarizeCallStats`
//   - resolves source aliases against `SourceCanonical`
//   - applies manual overlay rows
//   - falls back to the legacy mirror only when there's no live signal
//
// Tonight's email reads through that same aggregation so the numbers
// match the metrics page tile-for-tile. We just reshape the row keys
// for the email/CSV (spend/calls/callsOver5/leads/deals/initials/paid +
// derived CPL/CPA/ROAS/ROI).
async function buildMtdRoiBySource(domains, dateKey, options = {}) {
  const { buildMetricSourcesWorkspace } = require("./frontendReadService");
  const monthStart = `${dateKey.slice(0, 7)}-01`;
  const groupKey = options.groupKey || "ALL";
  let workspace;
  try {
    workspace = await buildMetricSourcesWorkspace(groupKey, {
      from: monthStart,
      to: dateKey,
    });
  } catch {
    workspace = { rows: [] };
  }
  const rows = Array.isArray(workspace?.rows) ? workspace.rows : [];

  // The metrics page treats `count` as the lead/case-profile count
  // for that source, `initialPaymentCount` as deals, `payments` as
  // total collected, and `totalCalls` as call volume. We mirror
  // those exactly so the email and the SPA agree row-for-row.
  const out = rows.map((row) => {
    const spend = toNumber(row.spend);
    const leads = toNumber(row.count) || toNumber(row.leadsReported);
    const deals = toNumber(row.initialPaymentCount);
    const initials = toNumber(row.initialPayments);
    const paid = toNumber(row.payments);
    const calls = toNumber(row.totalCalls);
    const callsOver5 = toNumber(row.callsOver5);
    const cpl = spend > 0 && leads > 0 ? spend / leads : null;
    const cpa = spend > 0 && deals > 0 ? spend / deals : null;
    const roas = spend > 0 ? initials / spend : null;
    const roi = spend > 0 ? (paid - spend) / spend : null;
    return {
      source: row.source || "Unknown",
      channel: row.channel || null,
      family: row.channelFamilyKey || null,
      spend,
      pieces: toNumber(row.pieces),
      calls,
      callsOver5,
      leads,
      deals,
      initials,
      paid,
      cpl: cpl != null ? Number(cpl.toFixed(2)) : null,
      cpa: cpa != null ? Number(cpa.toFixed(2)) : null,
      roas: roas != null ? Number(roas.toFixed(4)) : null,
      roi: roi != null ? Number(roi.toFixed(4)) : null,
    };
  });

  // Filter out pure noise rows the SPA also drops in its CSV export.
  const filtered = out.filter(
    (r) => r.spend > 0 || r.deals > 0 || r.paid > 0 || r.leads > 0 || r.calls > 0,
  );
  filtered.sort((a, b) => b.spend - a.spend || b.paid - a.paid);
  return filtered;
}

async function _legacy_buildMtdRoiBySource_unused(domains, dateKey, options = {}) {
  const list = (Array.isArray(domains) && domains.length > 0
    ? domains
    : ["TAG", "WYNN"]).map(normalizeDomain);
  const monthStart = `${dateKey.slice(0, 7)}-01`;
  const legacyDb = legacyReadDb(mongoose);

  // ── Spend (Parallel + legacy) — group by source/channel ──────────
  const bySourceKey = new Map();
  function ensureRow(source, channel) {
    const key = `${(source || "Unknown").trim()}::${(channel || "").toLowerCase()}`;
    if (!bySourceKey.has(key)) {
      bySourceKey.set(key, {
        source: source || "Unknown",
        channel: channel || null,
        spend: 0, pieces: 0,
        calls: 0, callsOver5: 0,
        leads: 0,
        deals: 0, initials: 0, paid: 0,
      });
    }
    return bySourceKey.get(key);
  }

  // Parallel spend
  for (const domain of list) {
    try {
      const rows = await spendEntryRepository.summarizeSpendBySource(domain, {
        from: monthStart, to: dateKey,
      });
      for (const r of rows) {
        const t = ensureRow(r._id?.source, r._id?.channel);
        t.spend += toNumber(r.spend);
        t.pieces += toNumber(r.pieces);
      }
    } catch {}
  }
  // Legacy spend
  for (const domain of list) {
    try {
      const rows = await legacyDb.collection("dailyspends").aggregate([
        {
          $match: {
            domain,
            date: { $gte: monthStart, $lte: String(dateKey) },
          },
        },
        {
          $group: {
            _id: { source: "$source", channel: "$channel" },
            spend: { $sum: { $ifNull: ["$spend", 0] } },
            pieces: { $sum: { $ifNull: ["$pieces", 0] } },
          },
        },
      ]).toArray();
      for (const r of rows) {
        const t = ensureRow(r._id?.source, r._id?.channel);
        t.spend += toNumber(r.spend);
        t.pieces += toNumber(r.pieces);
      }
    } catch {}
  }

  // ── Calls — DailyCallStat (cross-tenant) ─────────────────────────
  // The legacy DailyCallStat is keyed by piece (mailer name) + channel,
  // not by canonical source name. Match by piece-name to source-name
  // case-insensitively. Pieces with no spend match still get counted
  // when callers from that piece exist (e.g. organic inbound).
  try {
    const callRows = await legacyDb.collection("rb_dailycallstats").aggregate([
      { $match: { date: { $gte: monthStart, $lte: String(dateKey) } } },
      {
        $group: {
          _id: { piece: "$piece", channel: "$channel" },
          totalCalls: { $sum: { $ifNull: ["$totalCalls", 0] } },
          callsOver5: { $sum: { $ifNull: ["$callsOver5", 0] } },
        },
      },
    ]).toArray();
    for (const r of callRows) {
      const t = ensureRow(r._id?.piece, r._id?.channel);
      t.calls += toNumber(r.totalCalls);
      t.callsOver5 += toNumber(r.callsOver5);
    }
  } catch {}

  // ── Payments — Parallel ledger + legacy summary ──────────────────
  for (const domain of list) {
    try {
      const rows = await paymentLedgerRepository.summarizeSuccessfulPaymentsBySource(domain, {
        from: monthStart, to: dateKey,
      });
      for (const r of rows) {
        const t = ensureRow(r._id?.source, r._id?.channel);
        t.deals += toNumber(r.initialPaymentCount);
        t.initials += toNumber(r.initialPayments);
        t.paid += toNumber(r.payments);
      }
    } catch {}
  }
  // Legacy daily payment summaries — fold in alongside parallel.
  // Same casePaymentId concern as the daily build, but for MTD we
  // accept the small double-count risk because we want the full month
  // signal even where Parallel hasn't backfilled.
  for (const domain of list) {
    try {
      const rows = await legacyDb.collection("dailypaymentsummaries").aggregate([
        {
          $match: {
            domain,
            date: { $gte: monthStart, $lte: String(dateKey) },
          },
        },
        {
          $group: {
            _id: { source: "$sourceName", channel: "$sourceChannel" },
            paid: { $sum: { $ifNull: ["$amount", 0] } },
            initials: {
              $sum: {
                $cond: [{ $eq: ["$type", "initial"] }, { $ifNull: ["$amount", 0] }, 0],
              },
            },
            initialCount: {
              $sum: { $cond: [{ $eq: ["$type", "initial"] }, 1, 0] },
            },
          },
        },
      ]).toArray();
      for (const r of rows) {
        const t = ensureRow(r._id?.source, r._id?.channel);
        // Heuristic: prefer the larger of parallel+legacy when both
        // are present — full dedup at MTD level would need to walk
        // every casePaymentId, which is too expensive nightly.
        t.deals = Math.max(t.deals, toNumber(r.initialCount));
        t.initials = Math.max(t.initials, toNumber(r.initials));
        t.paid = Math.max(t.paid, toNumber(r.paid));
      }
    } catch {}
  }

  // ── Leads — masterProspect + legacy rb_caseprofiles by intake ────
  for (const domain of list) {
    try {
      const rows = await masterProspectRepository.summarizeProspectsByIntakeSource(domain, {
        from: new Date(`${monthStart}T00:00:00`),
        to: new Date(`${dateKey}T23:59:59.999`),
      });
      for (const r of rows) {
        const t = ensureRow(r._id, null);
        t.leads += toNumber(r.count);
      }
    } catch {}
    try {
      const rows = await legacyDb.collection("rb_caseprofiles").aggregate([
        {
          $match: {
            domain,
            createdAt: {
              $gte: new Date(`${monthStart}T00:00:00`),
              $lte: new Date(`${dateKey}T23:59:59.999`),
            },
          },
        },
        { $group: { _id: { source: "$sourceName", channel: "$sourceChannel" }, count: { $sum: 1 } } },
      ]).toArray();
      for (const r of rows) {
        const t = ensureRow(r._id?.source, r._id?.channel);
        t.leads += toNumber(r.count);
      }
    } catch {}
  }

  // Derive CPL / CPA / ROAS / ROI per row.
  const out = [];
  for (const row of bySourceKey.values()) {
    const cpl = row.spend > 0 && row.leads > 0 ? row.spend / row.leads : null;
    const cpa = row.spend > 0 && row.deals > 0 ? row.spend / row.deals : null;
    const roas = row.spend > 0 ? row.initials / row.spend : null;
    const roi = row.spend > 0 ? (row.paid - row.spend) / row.spend : null;
    out.push({
      ...row,
      cpl: cpl != null ? Number(cpl.toFixed(2)) : null,
      cpa: cpa != null ? Number(cpa.toFixed(2)) : null,
      roas: roas != null ? Number(roas.toFixed(4)) : null,
      roi: roi != null ? Number(roi.toFixed(4)) : null,
    });
  }
  // Skip pure noise: zero spend AND zero deals AND zero paid AND zero leads.
  const filtered = out.filter(
    (r) => r.spend > 0 || r.deals > 0 || r.paid > 0 || r.leads > 0,
  );
  filtered.sort((a, b) => b.spend - a.spend || b.paid - a.paid);
  return filtered;
}

// ── Payments by case — delegates to metricsDedupService ─────────
async function buildPaymentsByCase(domain, dateKey) {
  return sharedBuildPaymentsByCase(domain, dateKey);
}
async function _legacy_buildPaymentsByCase_unused(domain, dateKey) {
  const normalizedDomain = normalizeDomain(domain);

  const parallelRows = await PaymentLedger.find({
    domain: normalizedDomain,
    paymentDateKey: dateKey,
    transactionStatus: "SUCCESS",
  }).lean();

  const legacyRows = await legacyReadDb(mongoose)
    .collection("dailypaymentsummaries")
    .find({
      domain: normalizedDomain,
      date: String(dateKey),
    })
    .toArray();

  const byKey = new Map();
  for (const r of parallelRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      paymentType: String(r.paymentType || "unknown").toLowerCase(),
      paymentDate: r.paymentDate || null,
      _source: "parallel",
    });
  }
  for (const r of legacyRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    if (byKey.has(key)) continue; // Parallel wins on dupes
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      paymentType: String(r.type || "unknown").toLowerCase(),
      paymentDate: r.date || dateKey,
      _source: "legacy",
    });
  }

  return [...byKey.values()];
}

function rollupPaymentTotals(paymentsByCase) {
  return sharedRollupPaymentTotals(paymentsByCase);
}
function _legacy_rollupPaymentTotals_unused(paymentsByCase) {
  const totals = {
    totalAmount: 0, totalCount: 0,
    initialAmount: 0, initialCount: 0,
    recurringAmount: 0, recurringCount: 0,
  };
  for (const r of paymentsByCase) {
    const amount = toNumber(r.amount);
    totals.totalAmount += amount;
    totals.totalCount += 1;
    if (r.paymentType === "initial") {
      totals.initialAmount += amount;
      totals.initialCount += 1;
    } else {
      totals.recurringAmount += amount;
      totals.recurringCount += 1;
    }
  }
  return totals;
}

function rollupDealsBySource(dealsByCase) {
  return sharedRollupDealsBySource(dealsByCase);
}
function _legacy_rollupDealsBySource_unused(dealsByCase) {
  const bySource = new Map();
  for (const r of dealsByCase) {
    const k = r.sourceName || "Unknown";
    if (!bySource.has(k)) {
      bySource.set(k, {
        source: k,
        channel: r.sourceChannel || null,
        deals: 0,
        initialPayments: 0,
        totalCollected: 0,
        caseIds: [],
      });
    }
    const target = bySource.get(k);
    target.deals += 1;
    target.initialPayments += toNumber(r.amount);
    target.totalCollected += toNumber(r.amount);
    target.caseIds.push(r.caseId);
  }
  return [...bySource.values()].sort(
    (a, b) => b.deals - a.deals || b.totalCollected - a.totalCollected,
  );
}

async function buildSpendByChannel(domain, dateKey) {
  const rows = await spendEntryRepository.summarizeSpendBySource(domain, { date: dateKey });
  const byChannel = new Map();
  for (const row of rows) {
    const channel = row._id?.channel || "unknown";
    if (!byChannel.has(channel)) {
      byChannel.set(channel, {
        channel,
        spend: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
        leadsReported: 0,
      });
    }
    const target = byChannel.get(channel);
    target.spend += toNumber(row.spend);
    target.pieces += toNumber(row.pieces);
    target.impressions += toNumber(row.impressions);
    target.clicks += toNumber(row.clicks);
    target.leadsReported += toNumber(row.leadsReported);
  }
  return [...byChannel.values()].sort((a, b) => b.spend - a.spend);
}

async function buildTodaysCalls(domain, dateKey, timeZone = "America/Los_Angeles") {
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);
  return CallLog.find(
    {
      domain: normalizeDomain(domain),
      callStartTime: { $gte: start, $lte: end },
    },
    {
      callStartTime: 1,
      createdAt: 1,
      agentName: 1,
      direction: 1,
      phone: 1,
      phoneFormatted: 1,
      callerName: 1,
      contactName: 1,
      durationSeconds: 1,
      disposition: 1,
      sourceName: 1,
      sourceChannel: 1,
      caseId: 1,
      callScore: 1,
    },
  )
    .sort({ callStartTime: 1 })
    .limit(5000)
    .lean();
}

async function buildTodaysPaymentAlerts(domain, dateKey) {
  return paymentAlertRepository.listPaymentAlerts(domain, {
    paymentDate: dateKey,
    limit: 200,
  });
}

// Service alerts are stored as ReviewQueue items with workflow=
// "service-health" (see controlPlaneHealthService.recordServiceAlert).
// Pull the latest open ones for the ops email so the dev sees what's
// actively flagged.
async function buildOpenServiceAlerts(domain, limit = 15) {
  try {
    return await reviewQueueRepository.listReviewQueueItems(domain, {
      workflow: "service-health",
      status: "open",
      limit,
    });
  } catch {
    return [];
  }
}

// ── Cross-domain rollup helpers ──────────────────────────────────────
//
// Metrics is domain-agnostic. The financial close, redline alert, and
// ops status emails roll up across the full domain set (TAG + WYNN).
// Only the vendor / lead-data email stays WYNN-only — that's where the
// LD/affiliate/social vendors actually live.
//
// Each merge takes an array of per-domain payloads and returns one
// payload of the same shape with values summed (or, for entry arrays,
// merged by key).

function mergeManagementSnapshots(snapshots) {
  if (snapshots.length === 1) return snapshots[0];
  const merged = {
    date: snapshots[0]?.date || null,
    spend: { total: 0, pieces: 0, impressions: 0, clicks: 0, leadsReported: 0, rows: 0 },
    leads: { total: 0, entries: [] },
    payments: {
      totalAmount: 0, totalCount: 0,
      initialAmount: 0, initialCount: 0,
      recurringAmount: 0, recurringCount: 0,
    },
    calls: {
      total: 0,
      callsOver5: 0,
      byChannel: [],
      // Cross-domain CX rollup. Sums across TAG + WYNN so the
      // financial email can show one "LD dial activity" number
      // alongside the existing total-calls figure.
      cx: { total: 0, callsOver5: 0, longestSec: 0, uniqueCallers: 0, uniqueSessions: 0 },
    },
    scores: { totalScoredCalls: 0, bySource: [] },
    alerts: { pendingRedlines: 0, reviewRedlines: 0, unresolvedHourlyJobs: 0 },
  };
  const leadByKey = new Map();
  const channelByKey = new Map();
  const scoreBySource = new Map();

  for (const snap of snapshots) {
    if (!snap) continue;
    for (const key of ["total", "pieces", "impressions", "clicks", "leadsReported", "rows"]) {
      merged.spend[key] += toNumber(snap.spend?.[key]);
    }
    merged.leads.total += toNumber(snap.leads?.total);
    for (const entry of snap.leads?.entries || []) {
      const k = entry.source || "Unknown";
      leadByKey.set(k, toNumber(leadByKey.get(k)) + toNumber(entry.count));
    }
    for (const key of [
      "totalAmount", "totalCount",
      "initialAmount", "initialCount",
      "recurringAmount", "recurringCount",
    ]) {
      merged.payments[key] += toNumber(snap.payments?.[key]);
    }
    merged.calls.total += toNumber(snap.calls?.total);
    merged.calls.callsOver5 += toNumber(snap.calls?.callsOver5);
    // CX cross-domain sum (LD dial activity). Same shape as the
    // per-domain snapshot's calls.cx block.
    if (snap.calls?.cx) {
      merged.calls.cx.total += toNumber(snap.calls.cx.total);
      merged.calls.cx.callsOver5 += toNumber(snap.calls.cx.callsOver5);
      merged.calls.cx.uniqueCallers += toNumber(snap.calls.cx.uniqueCallers);
      merged.calls.cx.uniqueSessions += toNumber(snap.calls.cx.uniqueSessions);
      merged.calls.cx.longestSec = Math.max(
        merged.calls.cx.longestSec,
        toNumber(snap.calls.cx.longestSec),
      );
    }
    for (const row of snap.calls?.byChannel || []) {
      const k = row.channel || "unknown";
      const target = channelByKey.get(k) || { channel: k, totalCalls: 0, callsOver5: 0, uniqueCallers: 0 };
      target.totalCalls += toNumber(row.totalCalls);
      target.callsOver5 += toNumber(row.callsOver5);
      target.uniqueCallers += toNumber(row.uniqueCallers);
      channelByKey.set(k, target);
    }
    merged.scores.totalScoredCalls += toNumber(snap.scores?.totalScoredCalls);
    for (const row of snap.scores?.bySource || []) {
      const k = row.source || "Unknown";
      const target = scoreBySource.get(k) || {
        source: k,
        scoredCalls: 0, scoreSum: 0,
        hot: 0, warm: 0, cold: 0, dead: 0, fake: 0,
      };
      target.scoredCalls += toNumber(row.scoredCalls);
      if (row.averageScore != null && row.scoredCalls) {
        target.scoreSum += Number(row.averageScore) * toNumber(row.scoredCalls);
      }
      target.hot += toNumber(row.hot);
      target.warm += toNumber(row.warm);
      target.cold += toNumber(row.cold);
      target.dead += toNumber(row.dead);
      target.fake += toNumber(row.fake);
      scoreBySource.set(k, target);
    }
    merged.alerts.pendingRedlines += toNumber(snap.alerts?.pendingRedlines);
    merged.alerts.reviewRedlines += toNumber(snap.alerts?.reviewRedlines);
    merged.alerts.unresolvedHourlyJobs += toNumber(snap.alerts?.unresolvedHourlyJobs);
  }

  merged.leads.entries = [...leadByKey.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
  merged.calls.byChannel = [...channelByKey.values()].sort(
    (a, b) => b.totalCalls - a.totalCalls,
  );
  merged.scores.bySource = [...scoreBySource.values()]
    .map((row) => ({
      source: row.source,
      scoredCalls: row.scoredCalls,
      averageScore: row.scoredCalls > 0
        ? Number((row.scoreSum / row.scoredCalls).toFixed(2))
        : null,
      hot: row.hot, warm: row.warm, cold: row.cold, dead: row.dead, fake: row.fake,
    }))
    .sort((a, b) => b.scoredCalls - a.scoredCalls);
  return merged;
}

function mergeMonthToDateSnapshots(snapshots) {
  if (snapshots.length === 1) return snapshots[0];
  const merged = {
    monthStart: snapshots[0]?.monthStart || null,
    monthEnd: snapshots[0]?.monthEnd || null,
    leads: { total: 0, entries: [] },
    spend: { total: 0, pieces: 0, impressions: 0, clicks: 0, leadsReported: 0, rows: 0 },
    payments: {
      totalAmount: 0, totalCount: 0,
      initialAmount: 0, initialCount: 0,
      recurringAmount: 0, recurringCount: 0,
    },
    calls: { total: 0, callsOver5: 0, byChannel: [] },
  };
  const leadByKey = new Map();
  const channelByKey = new Map();
  for (const snap of snapshots) {
    if (!snap) continue;
    merged.leads.total += toNumber(snap.leads?.total);
    for (const entry of snap.leads?.entries || []) {
      const k = entry.source || "Unknown";
      leadByKey.set(k, toNumber(leadByKey.get(k)) + toNumber(entry.count));
    }
    for (const key of ["total", "pieces", "impressions", "clicks", "leadsReported", "rows"]) {
      merged.spend[key] += toNumber(snap.spend?.[key]);
    }
    for (const key of [
      "totalAmount", "totalCount",
      "initialAmount", "initialCount",
      "recurringAmount", "recurringCount",
    ]) {
      merged.payments[key] += toNumber(snap.payments?.[key]);
    }
    merged.calls.total += toNumber(snap.calls?.total);
    merged.calls.callsOver5 += toNumber(snap.calls?.callsOver5);
    for (const row of snap.calls?.byChannel || []) {
      const k = row._id || row.channel || "unknown";
      const target = channelByKey.get(k) || { channel: k, totalCalls: 0, callsOver5: 0 };
      target.totalCalls += toNumber(row.totalCalls);
      target.callsOver5 += toNumber(row.callsOver5);
      channelByKey.set(k, target);
    }
  }
  merged.leads.entries = [...leadByKey.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
  merged.calls.byChannel = [...channelByKey.values()].sort(
    (a, b) => b.totalCalls - a.totalCalls,
  );
  return merged;
}

function mergeDealsBySource(rowsByDomain) {
  const byKey = new Map();
  for (const rows of rowsByDomain) {
    for (const row of rows || []) {
      const k = row.source || "Unknown";
      const target = byKey.get(k) || {
        source: k, channel: row.channel || null,
        deals: 0, initialPayments: 0, totalCollected: 0,
      };
      target.deals += toNumber(row.deals);
      target.initialPayments += toNumber(row.initialPayments);
      target.totalCollected += toNumber(row.totalCollected);
      byKey.set(k, target);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.deals - a.deals || b.totalCollected - a.totalCollected,
  );
}

function mergeSpendByChannel(rowsByDomain) {
  const byKey = new Map();
  for (const rows of rowsByDomain) {
    for (const row of rows || []) {
      const k = row.channel || "unknown";
      const target = byKey.get(k) || {
        channel: k, spend: 0, pieces: 0,
        impressions: 0, clicks: 0, leadsReported: 0,
      };
      target.spend += toNumber(row.spend);
      target.pieces += toNumber(row.pieces);
      target.impressions += toNumber(row.impressions);
      target.clicks += toNumber(row.clicks);
      target.leadsReported += toNumber(row.leadsReported);
      byKey.set(k, target);
    }
  }
  return [...byKey.values()].sort((a, b) => b.spend - a.spend);
}

function mergeTransitionsBySource(rowsByDomain) {
  const byKey = new Map();
  for (const rows of rowsByDomain) {
    for (const row of rows || []) {
      const k = row.source || "Unknown";
      const target = byKey.get(k) || {
        source: k,
        contacted: 0, deal: 0, postdate: 0, dnc: 0, redline: 0,
      };
      target.contacted += toNumber(row.contacted);
      target.deal += toNumber(row.deal);
      target.postdate += toNumber(row.postdate);
      target.dnc += toNumber(row.dnc);
      target.redline += toNumber(row.redline);
      byKey.set(k, target);
    }
  }
  return [...byKey.values()].sort((a, b) => b.contacted - a.contacted);
}

function flattenAlerts(alertArrays) {
  const out = [];
  for (const arr of alertArrays) {
    for (const a of arr || []) out.push(a);
  }
  return out;
}

function mergeBugWraps(wraps) {
  const merged = {
    date: wraps[0]?.date || null,
    unresolvedCount: 0,
    prunedResolved: 0,
    unresolved: [],
  };
  for (const w of wraps) {
    if (!w) continue;
    merged.unresolvedCount += toNumber(w.unresolvedCount);
    merged.prunedResolved += toNumber(w.prunedResolved);
    for (const job of w.unresolved || []) merged.unresolved.push(job);
  }
  return merged;
}

function mergeAttributionReviews(reviews) {
  const merged = { skipped: 0, queued: 0, resolved: 0, ignored: 0 };
  for (const r of reviews) {
    if (!r) continue;
    merged.skipped += toNumber(r.skipped);
    merged.queued += toNumber(r.queued);
    merged.resolved += toNumber(r.resolved);
    merged.ignored += toNumber(r.ignored);
  }
  return merged;
}

/**
 * Build the full cross-domain payload set in a single pass. Returned
 * shape is the input each `sendXxxEmail` (now cross-domain) expects.
 *
 * Vendor data stays single-domain — `vendorDomain` (default WYNN) is
 * the only domain we pull `buildVendorReport` for, since the tracked
 * vendor families (LD posting, affiliate, social) only intake leads
 * into WYNN.
 */
async function buildGroupedNightlyPayload(domains, dateKey, options = {}) {
  const timeZone = options.timezone || "America/Los_Angeles";
  const vendorDomain = options.vendorDomain || "WYNN";
  const list = normalizeNightlyDomains(
    Array.isArray(domains) && domains.length > 0
      ? domains
      : REQUIRED_NIGHTLY_DOMAINS,
  );

  const useLegacy = options.useLegacy === true;

  // Per-domain pulls, parallelized. We pull Parallel collections
  // first (the eventual source of truth) then merge in legacy reads
  // from the old `test` DB. During cutover the legacy side carries
  // the actual volume; once Parallel ingestion is at full strength
  // the legacy reads become a redundancy check that mostly just
  // confirms the numbers already match.
  const perDomain = await Promise.all(list.map(async (domain) => {
    const [
      managementSnapshot,
      monthToDate,
      transitions,
      dealsByCase,
      paymentsByCase,
      spendByChannel,
      todaysAlerts,
      openServiceAlerts,
      bugWrap,
      todaysCalls,
    ] = await Promise.all([
      buildManagementSnapshot(domain, dateKey, timeZone),
      buildMonthToDateSnapshot(domain, dateKey, timeZone),
      buildTransitionsBySource(domain, dateKey, timeZone).catch(() => []),
      // dealsByCase is the single source of truth — Parallel + legacy
      // deduped on casePaymentId. dealsBySource is derived from it.
      buildDealsByCase(domain, dateKey).catch(() => []),
      // paymentsByCase covers ALL payment types (initial + recurring),
      // also deduped on casePaymentId. Money-collected totals are
      // derived from it so the count never double-counts a payment
      // that lives in both Parallel + legacy.
      buildPaymentsByCase(domain, dateKey).catch(() => []),
      buildSpendByChannel(domain, dateKey).catch(() => []),
      buildTodaysPaymentAlerts(domain, dateKey).catch(() => []),
      buildOpenServiceAlerts(domain, 15).catch(() => []),
      wrapHourlyJobs(domain, dateKey, { timezone: timeZone, pruneResolved: false }).catch(() => ({
        date: dateKey, unresolved: [], unresolvedCount: 0, prunedResolved: 0,
      })),
      buildTodaysCalls(domain, dateKey, timeZone).catch(() => []),
    ]);
    const dealsBySource = rollupDealsBySource(dealsByCase);

    // Override the per-domain payments total with the deduped roll-up
    // BEFORE we merge it cross-domain. Same shape that
    // `buildPaymentSummary` returns, just computed from the deduped
    // case list.
    managementSnapshot.payments = rollupPaymentTotals(paymentsByCase);

    // Legacy augmentation. Each call is independently `.catch(() => …)`
    // so a missing legacy collection doesn't sink the whole run.
    //
    // Note: `dealsByCase` already merges Parallel + legacy internally
    // (deduping on casePaymentId), so we don't need the legacy
    // `summarizeLegacyDealsBySource` here — it would double-count.
    let legacyMgmt = null;
    let legacyMtd = null;
    let legacyTransitions = [];
    let legacySpend = [];
    let legacyAlerts = [];
    let legacyCalls = [];
    if (useLegacy) {
      [
        legacyMgmt,
        legacyMtd,
        legacyTransitions,
        legacySpend,
        legacyAlerts,
        legacyCalls,
      ] = await Promise.all([
        buildLegacyManagementSnapshot(domain, dateKey, timeZone).catch(() => null),
        buildLegacyMonthToDateSnapshot(domain, dateKey).catch(() => null),
        summarizeLegacyTransitionsBySource(domain, dateKey, timeZone).catch(() => []),
        summarizeLegacySpendByChannel(domain, dateKey).catch(() => []),
        listLegacyTodaysPaymentAlerts(domain, dateKey).catch(() => []),
        listLegacyTodaysCalls(domain, dateKey, timeZone).catch(() => []),
      ]);
    }

    // Merge. For management snapshot + MTD: sum (each axis is purely
    // additive for spend/leads/calls — Parallel and legacy are
    // different lead-intake paths and in cutover legacy ~= 100% of
    // the data, post-cutover it's 0%). For per-source rows: merge by
    // key. For lists: concat with legacy first since it's where the
    // action is.
    //
    // PAYMENTS are special: we already rebuilt the per-domain totals
    // from `paymentsByCase` (deduped), so we MUST NOT let the merge
    // also fold in the legacy snapshot's payments — that would
    // re-introduce the duplicate. We zero out the legacy snapshot's
    // payments before the merge.
    if (legacyMgmt) {
      legacyMgmt = {
        ...legacyMgmt,
        payments: {
          totalAmount: 0, totalCount: 0,
          initialAmount: 0, initialCount: 0,
          recurringAmount: 0, recurringCount: 0,
        },
      };
    }
    const mergedManagement = legacyMgmt
      ? mergeManagementSnapshots([managementSnapshot, legacyMgmt])
      : managementSnapshot;
    const mergedMtd = legacyMtd
      ? mergeMonthToDateSnapshots([monthToDate, legacyMtd])
      : monthToDate;
    const mergedTransitions = legacyTransitions.length > 0
      ? mergeTransitionsBySource([transitions, legacyTransitions])
      : transitions;
    const mergedDeals = dealsBySource;
    const mergedSpend = legacySpend.length > 0
      ? mergeSpendByChannel([spendByChannel, legacySpend])
      : spendByChannel;

    // Tag each alert with its domain so the cross-domain redline list
    // shows which company each failed payment lives under. Dedup
    // legacy + Parallel by `(caseId, paymentDate)` since the legacy
    // mirror writes the same row both places.
    const allAlerts = [...todaysAlerts, ...legacyAlerts];
    const seenAlertKeys = new Set();
    const dedupedAlerts = [];
    for (const a of allAlerts) {
      if (!a) continue;
      if (!a.domain) a.domain = domain;
      const key = `${a.domain}::${a.caseId}::${a.paymentDate || dateKey}`;
      if (seenAlertKeys.has(key)) continue;
      seenAlertKeys.add(key);
      dedupedAlerts.push(a);
    }

    // Calls — merge by sessionId / record id heuristic. Legacy is
    // the volume source today, Parallel is the destination. Concat
    // and dedupe on `(callStartTime,phone,agentName,direction)`.
    const allCalls = [...todaysCalls, ...legacyCalls];
    const seenCallKeys = new Set();
    const dedupedCalls = [];
    for (const c of allCalls) {
      if (!c) continue;
      const at = c.callStartTime ? new Date(c.callStartTime).getTime() : 0;
      const key = `${at}::${c.phone || ""}::${c.agentName || ""}::${c.direction || ""}`;
      if (seenCallKeys.has(key)) continue;
      seenCallKeys.add(key);
      dedupedCalls.push(c);
    }

    return {
      domain,
      managementSnapshot: mergedManagement,
      monthToDate: mergedMtd,
      transitions: mergedTransitions,
      dealsBySource: mergedDeals,
      dealsByCase,
      spendByChannel: mergedSpend,
      todaysAlerts: dedupedAlerts,
      todaysCalls: dedupedCalls,
      openServiceAlerts,
      bugWrap,
      // Keep raw sides on the bag so the ops email can show "Parallel
      // wrote N, legacy held M" if we ever want a coverage indicator.
      sources: {
        parallelManagement: managementSnapshot,
        legacyManagement: legacyMgmt,
        parallelMtd: monthToDate,
        legacyMtd,
      },
    };
  }));

  // ── Attribution refresh pass ────────────────────────────────────
  // For every deal case landed today, walk the full CallRail → RC →
  // Logics loop and reconcile against the SourceCanonical store.
  // Logics is the authoritative leg — when you hand-correct a case's
  // SourceCampaignID during the day, this pass picks it up so
  // tonight's email reflects the correction. Best-effort: errors per
  // case don't abort the run.
  let attributionRefresh = null;
  if (options.refreshAttribution !== false) {
    const dealCases = perDomain.flatMap((p) => p.dealsByCase || []);
    if (dealCases.length > 0) {
      try {
        const audit = await refreshAttributionForCases(dealCases, {
          concurrency: Number(options.attributionConcurrency) || 4,
          updatePaymentLedger: options.updatePaymentLedger !== false,
        });
        const updatedCount = audit.filter((row) => row.update?.caseProfile).length;
        const ledgerUpdates = audit.reduce(
          (sum, row) => sum + Number(row.update?.paymentLedger || 0),
          0,
        );
        attributionRefresh = {
          casesWalked: audit.length,
          caseProfileUpdates: updatedCount,
          paymentLedgerUpdates: ledgerUpdates,
          conflicts: audit.filter((row) => row.conflict).length,
          errors: audit.filter((row) => row.error || (row.errors || []).length).length,
          audit,
        };

        // Re-pull dealsByCase per domain so the rollup + email
        // reflect the corrected source attribution. Same query, just
        // run after the writes.
        for (const p of perDomain) {
          if (!p.dealsByCase || p.dealsByCase.length === 0) continue;
          const refreshed = await buildDealsByCase(p.domain, dateKey).catch(() => null);
          if (refreshed) {
            p.dealsByCase = refreshed;
            p.dealsBySource = rollupDealsBySource(refreshed);
          }
        }
      } catch (error) {
        attributionRefresh = { error: error.message };
      }
    } else {
      attributionRefresh = { casesWalked: 0, skipped: true, reason: "no-deals-today" };
    }
  }

  // Vendor report — WYNN only. Run AFTER the attribution refresh so
  // the vendor email's per-source rollup also reads the corrected
  // attribution from CaseProfile.
  const vendorReport = list.includes(normalizeDomain(vendorDomain))
    ? await buildVendorReport(normalizeDomain(vendorDomain), dateKey, { timezone: timeZone })
    : { rows: [], families: [], trackedFamilies: [], attributionReview: {}, totals: {} };

  const vendorDetailDomain = normalizeDomain(vendorDomain);
  const [vendorLeadRows, vendorCallRows, vendorOutcomeRows] = list.includes(vendorDetailDomain)
    ? await Promise.all([
        buildVendorLeadRows(vendorDetailDomain, dateKey, {
          timezone: timeZone,
          limit: options.vendorLeadRowLimit || 50000,
        }).catch(() => []),
        buildVendorCallRows(vendorDetailDomain, dateKey, {
          timezone: timeZone,
          limit: options.vendorCallRowLimit || 50000,
        }).catch(() => []),
        buildVendorOutcomeRows(vendorDetailDomain, dateKey, {
          timezone: timeZone,
          limit: options.vendorOutcomeRowLimit || 50000,
        }).catch(() => []),
      ])
    : [[], [], []];
  const detailBackedVendorReport = buildDetailBackedVendorSummary(
    vendorReport,
    vendorCallRows,
    vendorLeadRows,
    vendorOutcomeRows,
  );

  // MTD ROI snapshot — cross-domain, per-source rows with derived
  // metrics. Drives the bottom of the financial email + the metrics-
  // page-style CSV attachment.
  const mtdRoiBySource = await buildMtdRoiBySource(list, dateKey, {}).catch(() => []);

  return {
    date: dateKey,
    timezone: timeZone,
    domains: list,
    vendorDomain: normalizeDomain(vendorDomain),
    perDomain,
    managementSnapshot: mergeManagementSnapshots(perDomain.map((p) => p.managementSnapshot)),
    monthToDate: mergeMonthToDateSnapshots(perDomain.map((p) => p.monthToDate)),
    transitions: mergeTransitionsBySource(perDomain.map((p) => p.transitions)),
    dealsBySource: mergeDealsBySource(perDomain.map((p) => p.dealsBySource)),
    // Cross-domain dealsByCase = simple concat. Each row already has
    // its `domain` tag so the email can render the company alongside
    // the caseId for unambiguous case lookup.
    dealsByCase: flattenAlerts(perDomain.map((p) => p.dealsByCase)),
    spendByChannel: mergeSpendByChannel(perDomain.map((p) => p.spendByChannel)),
    todaysAlerts: flattenAlerts(perDomain.map((p) => p.todaysAlerts)),
    todaysCalls: flattenAlerts(perDomain.map((p) => p.todaysCalls)),
    openServiceAlerts: flattenAlerts(perDomain.map((p) => p.openServiceAlerts)),
    bugWrap: mergeBugWraps(perDomain.map((p) => p.bugWrap)),
    vendorReport: detailBackedVendorReport,
    vendorLeadRows,
    vendorCallRows,
    vendorOutcomeRows,
    mtdRoiBySource,
    attributionReview: mergeAttributionReviews([detailBackedVendorReport.attributionReview]),
    attributionRefresh,
  };
}

function buildFinancialEmailBody(domain, dateKey, daily, mtd, extras = {}) {
  const postDateHolds = extras.postDateHolds || [];
  const postDateSweep = extras.postDateSweep || null;
  const postDateLines = postDateHolds.length > 0
    ? postDateHolds
        .slice(0, 20)
        .map((row) =>
          `  ${row.domain} #${row.caseId} ${row.caseName || ""} | ${row.status} | first payment ${row.firstPaymentDateKey || "n/a"} | ${row.rowType || ""}`.trim(),
        )
    : ["  (no active or newly touched post-date holds)"];
  // Plain-text fallback only — used when an HTML client can't render.
  // The HTML version is rendered from `nightly/financial-close.hbs`.
  return [
    `[${domain}] Daily financial close — ${dateKey}`,
    "",
    "Today",
    `  Leads: ${daily.leads.total}`,
    `  Spend: ${formatMoney(daily.spend.total)}`,
    `  Payments: ${formatMoney(daily.payments.totalAmount)} (${daily.payments.totalCount}) — initial ${formatMoney(daily.payments.initialAmount)} (${daily.payments.initialCount}), recurring ${formatMoney(daily.payments.recurringAmount)} (${daily.payments.recurringCount})`,
    `  Pending redlines: ${daily.alerts.pendingRedlines}`,
    `  Review redlines (open): ${daily.alerts.reviewRedlines}`,
    "",
    "Post-date holds",
    `  Sweep: checked ${toNumber(postDateSweep?.checked)}, verified ${toNumber(postDateSweep?.verified)}, released ${toNumber(postDateSweep?.released)}, review ${toNumber(postDateSweep?.review)}, errors ${toNumber(postDateSweep?.errors)}`,
    ...postDateLines,
    "",
    `Month-to-date (${mtd.monthStart} → ${mtd.monthEnd})`,
    `  Leads: ${mtd.leads.total}`,
    `  Spend: ${formatMoney(mtd.spend.total)}`,
    `  Payments: ${formatMoney(mtd.payments.totalAmount)} (${mtd.payments.totalCount}) — initial ${formatMoney(mtd.payments.initialAmount)} (${mtd.payments.initialCount}), recurring ${formatMoney(mtd.payments.recurringAmount)} (${mtd.payments.recurringCount})`,
    "",
    "Full daily + MTD breakdown attached as CSV.",
  ].join("\n");
}

function buildLeadDataEmailBody(domain, dateKey, daily, vendorReport, bugWrap) {
  const topVendorFamilyRows =
    (vendorReport.trackedFamilies?.length > 0
      ? vendorReport.trackedFamilies
      : vendorReport.families || []
    )
      .filter(isLdVendorFamily)
      .map(decorateLdVendorFamily)
      .slice(0, 8);
  const ldCost = buildLdCostSummary(topVendorFamilyRows);
  const attributionReview = vendorReport.attributionReview || {};
  const ldLeadCount = sumVendorRows(topVendorFamilyRows, "leads");
  const ldCallCount = sumVendorRows(topVendorFamilyRows, "calls");
  const ldCallsOver5 = sumVendorRows(topVendorFamilyRows, "callsOver5");

  return [
    `[${domain}] Daily lead data + scoring — ${dateKey}`,
    "",
    `LD leads: ${ldLeadCount}`,
    `LD calls: ${ldCallCount} (${ldCallsOver5} over 5 min)`,
    `LD cost: ${formatMoney(ldCost.total)} (LD CUSTOM ${ldCost.customCount} x $${ldCost.customRate} + LD CUSTOM 2 ${ldCost.custom2Count} x $${ldCost.custom2Rate} + LD GENERAL ${ldCost.generalCount} x $${ldCost.generalRate})`,
    "",
    "LD family summary",
    `Attribution held out: ${toNumber(attributionReview.skipped)} skipped, ${toNumber(attributionReview.queued)} newly queued, ${toNumber(attributionReview.resolved)} resolved by manual mapping, ${toNumber(attributionReview.ignored)} ignored`,
    ...topVendorFamilyRows.map((row) =>
      `${row.familyLabel}: leads ${row.leads}, cost ${formatMoney(row.estimatedCost)}, calls ${row.calls} (${row.callsOver5} over 5m), scored ${row.scoredCalls}, avg score ${row.averageScore ?? "n/a"}, deals ${row.dealsToday}, dnc ${row.dncToday}, postdate ${row.postdateToday}, initials ${formatMoney(row.initialPayments)}, collected ${formatMoney(row.totalCollected)}`),
    "",
    "Hourly bug wrap",
    `Pruned resolved jobs: ${bugWrap.prunedResolved}`,
    `Still unresolved: ${bugWrap.unresolvedCount}`,
    ...bugWrap.unresolved.slice(0, 10).map((job) =>
      `- ${job.handlerKey} / ${job.eventType} / ${job.status} / ${job.firstError || job.lastError || "n/a"}`),
  ].join("\n");
}

function buildNightlyEmailBody(domain, dateKey, managementSnapshot, vendorReport, bugWrap) {
  const topVendorFamilyRows =
    (vendorReport.trackedFamilies?.length > 0
      ? vendorReport.trackedFamilies
      : vendorReport.families || []
    )
      .filter(isLdVendorFamily)
      .map(decorateLdVendorFamily)
      .slice(0, 8);
  const ldCost = buildLdCostSummary(topVendorFamilyRows);
  const attributionReview = vendorReport.attributionReview || {};

  return [
    `[${domain}] Nightly close for ${dateKey}`,
    "",
    "Management snapshot",
    `LD leads: ${sumVendorRows(topVendorFamilyRows, "leads")}`,
    `LD cost: ${formatMoney(ldCost.total)} (LD CUSTOM ${ldCost.customCount} x $${ldCost.customRate} + LD CUSTOM 2 ${ldCost.custom2Count} x $${ldCost.custom2Rate} + LD GENERAL ${ldCost.generalCount} x $${ldCost.generalRate})`,
    `Spend: $${managementSnapshot.spend.total.toFixed(2)}`,
    `Payments: $${managementSnapshot.payments.totalAmount.toFixed(2)} (${managementSnapshot.payments.totalCount})`,
    `LD calls: ${sumVendorRows(topVendorFamilyRows, "calls")} (${sumVendorRows(topVendorFamilyRows, "callsOver5")} over 5 min)`,
    `Scored LD calls: ${sumVendorRows(topVendorFamilyRows, "scoredCalls")}`,
    `Pending redlines: ${managementSnapshot.alerts.pendingRedlines}`,
    `Unresolved hourly jobs: ${managementSnapshot.alerts.unresolvedHourlyJobs}`,
    "",
    "LD family summary",
    `Attribution held out: ${toNumber(attributionReview.skipped)} skipped, ${toNumber(attributionReview.queued)} newly queued, ${toNumber(attributionReview.resolved)} resolved by manual mapping, ${toNumber(attributionReview.ignored)} ignored`,
    ...topVendorFamilyRows.map((row) =>
      `${row.familyLabel}: leads ${row.leads}, cost ${formatMoney(row.estimatedCost)}, calls ${row.calls} (${row.callsOver5} over 5m), scored ${row.scoredCalls}, avg score ${row.averageScore ?? "n/a"}, deals ${row.dealsToday}, dnc ${row.dncToday}, postdate ${row.postdateToday}, initials ${formatMoney(row.initialPayments)}, collected ${formatMoney(row.totalCollected)}`),
    "",
    "Hourly bug wrap",
    `Pruned resolved jobs: ${bugWrap.prunedResolved}`,
    `Still unresolved: ${bugWrap.unresolvedCount}`,
    ...bugWrap.unresolved.slice(0, 10).map((job) =>
      `- ${job.handlerKey} / ${job.eventType} / ${job.status} / ${job.firstError || job.lastError || "n/a"}`),
  ].join("\n");
}

// ── Subject helpers ──────────────────────────────────────────────────
//
// Subjects carry the at-a-glance counts so the email can be triaged
// from the inbox without opening it. Format mirrors legacy:
//   `[TAG] Financial close 2026-04-29 | $X in, N deals, K redlines`
function financialSubject(domain, dateKey, daily, label) {
  const moneyIn = formatMoney(daily.payments.totalAmount);
  const deals = toNumber(daily.payments.initialCount);
  const redlines = toNumber(daily.alerts?.pendingRedlines);
  const tag = label || domain;
  return `[${tag}] Financial close ${dateKey} | ${moneyIn} in, ${deals} deals, ${redlines} redlines`;
}

function leadDataSubject(domain, dateKey, daily, vendorReport, label) {
  const ldFamilies = (vendorReport?.trackedFamilies?.length > 0
    ? vendorReport.trackedFamilies
    : vendorReport?.families || []
  ).filter(isLdVendorFamily);
  const leads = sumVendorRows(ldFamilies, "leads") || toNumber(daily.leads?.total);
  const calls = sumVendorRows(ldFamilies, "calls") || toNumber(daily.calls?.total);
  const scored = sumVendorRows(ldFamilies, "scoredCalls") || toNumber(daily.scores?.totalScoredCalls);
  const heldOut = toNumber(vendorReport?.attributionReview?.skipped);
  const heldOutPart = heldOut > 0 ? ` | ${heldOut} held out` : "";
  const tag = label || domain;
  return `[${tag}] Lead data + scoring ${dateKey} | ${leads} leads, ${calls} calls, ${scored} scored${heldOutPart}`;
}

function redlineSubject(domain, dateKey, alerts, label) {
  const count = alerts.length;
  const total = alerts.reduce((sum, a) => sum + toNumber(a.declinedAmount || a.amount), 0);
  const tag = label || domain;
  return `[${tag}] ⚠ Payment Alert ${dateKey} | ${count} failed (${formatMoney(total)})`;
}

/**
 * Pool A — Financial close. Goes to admins only. HTML body is rendered
 * from `nightly/financial-close.hbs`; CSV attachment carries the full
 * daily + MTD breakdown plus per-channel spend and per-source deals.
 */
async function sendFinancialCloseEmail(domain, payload, options = {}) {
  const recipients = Array.isArray(options.recipients) && options.recipients.length > 0
    ? options.recipients
    : getRecipientPool("financial");

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients", pool: "financial" };
  }

  const daily = payload.managementSnapshot;
  const mtd = payload.monthToDate;
  const dealsBySource = payload.dealsBySource || [];
  const dealsByCase = payload.dealsByCase || [];
  const spendByChannel = payload.spendByChannel || [];
  const failedPayments = payload.failedPayments || [];
  const mtdRoiBySource = payload.mtdRoiBySource || [];
  const hygiene = payload.hygiene || {};
  const postDateHolds = payload.postDateHolds || [];
  const postDateSweep = payload.postDateSweep || null;

  const csv = buildFinancialCsv({
    domain,
    dateKey: payload.date,
    daily,
    mtd,
    dealsBySource,
    dealsByCase,
    spendByChannel,
    failedPayments,
    postDateHolds,
    mtdRoiBySource,
  });

  const todayTiles = [
    { label: "Leads", value: daily.leads.total, tone: "blue" },
    { label: "Money in", value: formatMoney(daily.payments.totalAmount), tone: "green" },
    { label: "Initial $", value: formatMoney(daily.payments.initialAmount), tone: "green" },
    { label: "Deals", value: daily.payments.initialCount, tone: "green" },
    { label: "Spend", value: formatMoney(daily.spend.total), tone: "amber" },
    { label: "Redlines", value: daily.alerts.pendingRedlines, tone: "red" },
  ];

  const label = payload.groupLabel || domain;
  const data = {
    domain,
    date: payload.date,
    headerTitle: "Daily Financial Close",
    headerSub: `${label} — ${payload.date}`,
    footerLine: `Parallel nightly close · ${payload.date}`,
    footerSmall: `Daily + MTD CSV attached as ${csv.filename}`,
    csvFilename: csv.filename,
    todayTiles,
    daily,
    mtd,
    dealsBySource,
    dealsByCase,
    spendByChannel,
    failedPayments,
    postDateHolds,
    postDateSweep,
    mtdRoiBySource,
    hygiene,
    perDomain: payload.perDomain || null,
  };

  const result = await sendMail(domain, {
    to: recipients,
    subject: financialSubject(domain, payload.date, daily, payload.groupLabel),
    from: internalFromHeader("Parallel Nightly"),
    replyTo: internalFromHeader("Parallel Nightly"),
    template: "nightly/financial-close",
    data,
    text: buildFinancialEmailBody(domain, payload.date, daily, mtd, { postDateHolds, postDateSweep }),
    attachments: [csv],
  });

  return { sent: true, recipients, pool: "financial", messageId: result.messageId };
}

/**
 * Pool B — Lead data + scoring. Goes to admins + the LizDev partner
 * (when prod list is uncommented). HTML rendered from
 * `nightly/lead-data-vendor.hbs`; two CSV attachments — vendor
 * per-source rollup + today's call log.
 */
async function sendLeadDataCloseEmail(domain, payload, options = {}) {
  const recipients = Array.isArray(options.recipients) && options.recipients.length > 0
    ? options.recipients
    : getRecipientPool("leadData");

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients", pool: "leadData" };
  }

  const daily = payload.managementSnapshot;
  const vendorReport = payload.vendorReport || {};
  const bugWrap = payload.bugWrap || {};
  const leadRows = Array.isArray(payload.leadRows) ? payload.leadRows : [];
  const todaysCalls = Array.isArray(payload.todaysCalls) ? payload.todaysCalls : [];
  const outcomeRows = Array.isArray(payload.outcomeRows) ? payload.outcomeRows : [];
  const ldLeadRows = leadRows.filter(isLdVendorFamily);
  const ldTodaysCalls = todaysCalls.filter(isLdVendorFamily);
  const ldOutcomeRows = outcomeRows.filter(isLdVendorFamily);
  const transitions = outcomeRows.length > 0
    ? rollupVendorOutcomeRows(ldOutcomeRows)
    : (payload.transitions || []).filter(isLdTransitionRow);

  const vendorFamilies = (vendorReport.trackedFamilies?.length > 0
    ? vendorReport.trackedFamilies
    : vendorReport.families || [])
      .filter(isLdVendorFamily)
      .map(decorateLdVendorFamily)
      .slice(0, 12);
  const ldCost = buildLdCostSummary(vendorFamilies);
  const vendorRows = (vendorReport.rows || [])
    .filter(isLdVendorFamily)
    .slice(0, 20);

  const vendorCsv = buildVendorCsv({
    domain,
    dateKey: payload.date,
    vendorRows,
    vendorFamilies,
  });
  const callLogCsv = buildCallLogCsv({
    domain,
    dateKey: payload.date,
    calls: ldTodaysCalls,
  });
  const leadReconciliationCsv = buildLeadReconciliationCsv({
    domain,
    dateKey: payload.date,
    leads: ldLeadRows,
  });

  const leadEntries = [];

  // Lead intake split by routeCampaignKey — surfaces the LD CUSTOM /
  // LD GENERAL split. Non-LD source detail stays in the attached CSVs.
  // stamps at ingest time. Rows without a routeCampaignKey roll up
  // under "(uncategorized)" rather than getting dropped. Sorted by
  // volume desc.
  const campaignBreakdown = ldLeadRows.length > 0
    ? [...ldLeadRows.reduce((map, row) => {
        const key = row.routeCampaignKey || row.sourceFamilyKey || "(uncategorized)";
        const bucket = map.get(key) || {
          key,
          label: LD_CAMPAIGN_LABELS[key] || row.routeCampaignName || key,
          count: 0,
        };
        bucket.count += 1;
        map.set(key, bucket);
        return map;
      }, new Map()).values()]
        .filter((row) => LD_VENDOR_FAMILY_KEYS.has(row.key))
        .map((row) => ({
          ...row,
          estimatedCost: campaignEstimatedCost(row),
        }))
        .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    : [];

  const totalDeal =
    sumVendorRows(vendorFamilies, "dealsToday") ||
    sumVendorRows(vendorFamilies, "initialPaymentCount") ||
    transitions.reduce((sum, r) => sum + toNumber(r.deal), 0);
  const totalDnc =
    sumVendorRows(vendorFamilies, "dncToday") ||
    transitions.reduce((sum, r) => sum + toNumber(r.dnc), 0);
  const totalPostdate =
    sumVendorRows(vendorFamilies, "postdateToday") ||
    transitions.reduce((sum, r) => sum + toNumber(r.postdate), 0);

  // ── Build the call-scoring slice the email body shows inline ──────
  // Three lists:
  //   - scoredCalls: every call with a callScore.overall, sorted by
  //     score descending so the best calls land at the top
  //   - missedCalls: short / no-answer calls (under 30s, no-answer
  //     dispositions) so the team can see what got dropped
  //   - allCallSummary: top-level rollup matching the metrics page
  //     "calls" tile (mirrors what we ship in the call-log CSV)
  const scoredCalls = ldTodaysCalls
    .filter((c) => (c?.callScore && c.callScore.overall != null) || c?.scoreOverall != null)
    .map((c) => ({
      time: c.callStartTime || c.createdAt || null,
      agent: c.agentName || null,
      phone: c.phoneFormatted || c.phone || null,
      name: c.callerName || c.contactName || null,
      duration: toNumber(c.durationSeconds ?? c.durationSec),
      disposition: c.disposition || null,
      sourceName: c.sourceName || null,
      sourceChannel: c.sourceChannel || null,
      caseId: c.caseId || null,
      score: Number(c.callScore?.overall ?? c.scoreOverall) || null,
      verdict: c.callScore?.lead_verdict || c.scoreVerdict || null,
      summary: c.callScore?.summary || c.scoreSummary || null,
      redFlags: Array.isArray(c.callScore?.red_flags) ? c.callScore.red_flags : [],
    }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const scoredHot = scoredCalls.filter((c) => String(c.verdict || "").toLowerCase() === "hot").length;
  const scoredWarm = scoredCalls.filter((c) => String(c.verdict || "").toLowerCase() === "warm").length;
  const scoredCold = scoredCalls.filter((c) => String(c.verdict || "").toLowerCase() === "cold").length;
  const scoredDead = scoredCalls.filter((c) => String(c.verdict || "").toLowerCase() === "dead").length;
  const scoredFake = scoredCalls.filter((c) => String(c.verdict || "").toLowerCase() === "fake").length;
  const avgScore = scoredCalls.length > 0
    ? Number(
        (scoredCalls.reduce((s, c) => s + toNumber(c.score), 0) / scoredCalls.length).toFixed(2),
      )
    : null;

  // Unique caller / unique session counts — distinct from raw call
  // attempts. Lets readers see "we placed 547 calls but only reached
  // 277 unique leads" at a glance, alongside the totals.
  const uniqueCallerCount = new Set(
    ldTodaysCalls.map((c) => c?.caseId).filter(Boolean),
  ).size;
  const uniqueSessionCount = new Set(
    ldTodaysCalls
      .map((c) => c?.telephonySessionId || c?.uii)
      .filter(Boolean),
  ).size;

  const ldLeadCount = sumVendorRows(vendorFamilies, "leads");
  const ldCallCount = sumVendorRows(vendorFamilies, "calls") || ldTodaysCalls.length;
  const ldCallsOver5 = sumVendorRows(vendorFamilies, "callsOver5");

  const topTiles = [
    { label: "LD leads", value: ldLeadCount, tone: "blue" },
    { label: "LD calls", value: ldCallCount, tone: "blue" },
    { label: "LD cost", value: formatMoney(ldCost.total), tone: "amber" },
    { label: "Unique callers", value: uniqueCallerCount, tone: "blue" },
    { label: "Unique sessions", value: uniqueSessionCount, tone: "blue" },
    { label: "5 min+", value: ldCallsOver5, tone: "blue" },
    { label: "Scored", value: scoredCalls.length, tone: "blue" },
    { label: "Avg score", value: avgScore != null ? avgScore : "—", tone: "blue" },
    { label: "Deal", value: totalDeal, tone: "green" },
    { label: "Postdate", value: totalPostdate, tone: "amber" },
    { label: "DNC", value: totalDnc, tone: "red" },
  ];

  // The lead-data email is intentionally vendor-scoped (WYNN). The
  // header label says "WYNN vendors" rather than the meta "Parallel"
  // label so recipients know which intake stream they're looking at.
  const data = {
    domain,
    date: payload.date,
    headerTitle: "Vendor Lead Data + Scoring",
    headerSub: `${domain} vendors — ${payload.date}`,
    footerLine: `Parallel nightly close · ${payload.date}`,
    footerSmall: `${vendorCsv.filename}${ldTodaysCalls.length > 0 ? ` · ${callLogCsv.filename}` : ""}`,
    csvFilename: vendorCsv.filename,
    callLogCsvFilename: callLogCsv.filename,
    leadReconciliationCsvFilename: leadReconciliationCsv.filename,
    topTiles,
    ldCost,
    leadEntries,
    campaignBreakdown,
    transitions,
    vendorFamilies,
    vendorRows,
    outcomeRows: ldOutcomeRows,
    scoredCalls,
    scoredCallsTop: scoredCalls.slice(0, 25),
    scoredCounts: {
      total: scoredCalls.length,
      hot: scoredHot, warm: scoredWarm,
      cold: scoredCold, dead: scoredDead, fake: scoredFake,
      avg: avgScore,
    },
    attributionReview: vendorReport.attributionReview || {},
    hourlyBugs: (bugWrap.unresolved || []).slice(0, 10),
  };

  const attachments = ldTodaysCalls.length > 0
    ? [vendorCsv, leadReconciliationCsv, callLogCsv]
    : [vendorCsv, leadReconciliationCsv];

  const result = await sendMail(domain, {
    to: recipients,
    subject: leadDataSubject(domain, payload.date, daily, vendorReport),
    from: internalFromHeader("Parallel Lead Data"),
    replyTo: internalFromHeader("Parallel Lead Data"),
    template: "nightly/lead-data-vendor",
    data,
    text: buildLeadDataEmailBody(domain, payload.date, daily, vendorReport, bugWrap),
    attachments,
  });

  return { sent: true, recipients, pool: "leadData", messageId: result.messageId };
}

/**
 * Pool C — Redline alert. Only fires when there are failed payments
 * for the date. Goes to the financial pool. Dramatic-styled banner
 * + per-alert table + redline CSV attachment.
 */
async function sendRedlineAlertEmail(domain, payload, options = {}) {
  const alerts = payload.alerts || [];
  if (alerts.length === 0) {
    return { sent: false, skipped: true, reason: "no-alerts", pool: "redline" };
  }

  const recipients = Array.isArray(options.recipients) && options.recipients.length > 0
    ? options.recipients
    : getRecipientPool("financial"); // redlines route to financial pool

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients", pool: "redline" };
  }

  const csv = buildRedlineCsv({
    domain,
    dateKey: payload.date,
    alerts,
  });

  const label = payload.groupLabel || domain;
  const data = {
    domain,
    date: payload.date,
    headerTitle: "⚠ Payment Alert",
    headerSub: `${label} — ${payload.date} — ${alerts.length} failed payment(s)`,
    dangerHeader: true,
    alertHead: "These clients will receive a payment reminder text at 7:00 AM PT tomorrow.",
    alertSub: "To prevent a client from being contacted, remove them from the list before 7 AM.",
    footerLine: `Parallel payment monitor · ${payload.date}`,
    footerSmall: `Per-alert CSV attached as ${csv.filename}`,
    csvFilename: csv.filename,
    alerts,
  };

  const result = await sendMail(domain, {
    to: recipients,
    subject: redlineSubject(domain, payload.date, alerts, payload.groupLabel),
    from: internalFromHeader("Parallel Payment Alert"),
    replyTo: internalFromHeader("Parallel Payment Alert"),
    template: "nightly/redline-alert",
    data,
    text: `${alerts.length} failed payment(s) on ${payload.date}. Remove clients before 7 AM PT to suppress the reminder text.`,
    attachments: [csv],
  });

  return { sent: true, recipients, pool: "redline", messageId: result.messageId };
}

/**
 * Pool D — Ops status. Goes to the dev only. Carries the app-health
 * signals the financial + lead-data emails intentionally don't show:
 * spend-sync result, payment-reconcile sweep stats, hourly job
 * failures, attribution holdout volume, open service alerts. Plain
 * text fallback summarizes the same signals for terminal-only
 * inboxes.
 */
function opsStatusSubject(domain, dateKey, payload, label) {
  const failures = toNumber(payload.bugWrap?.unresolvedCount);
  const heldOut = toNumber(payload.attributionReview?.skipped);
  const alerts = (payload.openServiceAlerts || []).length;
  const issues = failures + heldOut + alerts;
  const flag = issues > 0 ? `⚠ ${issues}` : "all clear";
  const tag = label || domain;
  return `[${tag}] Ops status ${dateKey} | ${flag}`;
}

async function sendOpsStatusEmail(domain, payload, options = {}) {
  const recipients = Array.isArray(options.recipients) && options.recipients.length > 0
    ? options.recipients
    : getRecipientPool("ops");

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients", pool: "ops" };
  }

  const bugWrap = payload.bugWrap || {};
  const attributionReview = payload.attributionReview || {};
  const openServiceAlerts = payload.openServiceAlerts || [];
  const spendSync = payload.spendSync || {};
  const paymentSweep = payload.paymentSweep || {};
  const leadCadenceCaseRefresh = payload.leadCadenceCaseRefresh || {};
  const leadRefreshTotals = leadCadenceCaseRefresh.totals || {};

  const topTiles = [
    {
      label: "Hourly failures",
      value: toNumber(bugWrap.unresolvedCount),
      tone: bugWrap.unresolvedCount > 0 ? "red" : "green",
    },
    {
      label: "Attr. held out",
      value: toNumber(attributionReview.skipped),
      tone: attributionReview.skipped > 0 ? "amber" : "green",
    },
    {
      label: "Open alerts",
      value: openServiceAlerts.length,
      tone: openServiceAlerts.length > 0 ? "red" : "green",
    },
    {
      label: "Spend sync",
      value: spendSync.ok === false ? "fail" : "ok",
      tone: spendSync.ok === false ? "red" : "green",
    },
    {
      label: "Cases scanned",
      value: toNumber(paymentSweep.casesScanned),
      tone: "blue",
    },
    {
      label: "New ledger rows",
      value: toNumber(paymentSweep.newLedgerRows),
      tone: "blue",
    },
    {
      label: "Lead cases refreshed",
      value: toNumber(leadRefreshTotals.casesScanned),
      tone: "blue",
    },
    {
      label: "Status changes",
      value: toNumber(leadRefreshTotals.statusChanges),
      tone: toNumber(leadRefreshTotals.statusChanges) > 0 ? "amber" : "green",
    },
  ];

  // Flag-style "things to look at" callouts. Cheap rule-based for
  // now — anything truly worth looking at gets surfaced. Quiet when
  // everything is healthy.
  const notes = [];
  if (spendSync.ok === false && !spendSync.skipped) {
    notes.push(`Spend sync failed: ${spendSync.error || "see payload"}`);
  }
  if (toNumber(bugWrap.unresolvedCount) >= 5) {
    notes.push(`Hourly job queue has ${bugWrap.unresolvedCount} unresolved jobs — check the top items in the table above.`);
  }
  if (toNumber(attributionReview.skipped) >= 5) {
    notes.push(`${attributionReview.skipped} unresolved attribution rows excluded from the lead-data report. Walk the Review workspace.`);
  }
  if (toNumber(paymentSweep.flaggedFailures) > 0) {
    notes.push(`Payment reconcile flagged ${paymentSweep.flaggedFailures} new failures. Cross-check the redline email.`);
  }
  if (toNumber(leadRefreshTotals.errors) > 0) {
    notes.push(`Lead-cadence final refresh hit ${leadRefreshTotals.errors} case refresh error(s).`);
  }

  const label = payload.groupLabel || domain;
  const data = {
    domain,
    date: payload.date,
    headerTitle: "App Status",
    headerSub: `${label} — ${payload.date}${payload.domains?.length ? ` — ${payload.domains.join(" + ")}` : ""}`,
    footerLine: `Parallel ops monitor · ${payload.date}`,
    footerSmall: `Hourly + attribution + service alerts.`,
    topTiles,
    spendSync,
    paymentSweep,
    leadCadenceCaseRefresh,
    bugWrap,
    hourlyBugs: (bugWrap.unresolved || []).slice(0, 12),
    attributionReview,
    openServiceAlerts,
    leadIntake: payload.leadIntake || { total: 0, entries: [] },
    notes,
  };

  // Plain-text fallback — readable in terminal mail clients. Mirrors
  // the HTML structure but trimmed to one-liners.
  const text = [
    `[${domain}] Ops status ${payload.date}`,
    "",
    `Spend sync: ${spendSync.ok === false ? `FAIL (${spendSync.error || spendSync.reason})` : "ok"}`,
    `Payment reconcile: ${toNumber(paymentSweep.casesScanned)} scanned, ${toNumber(paymentSweep.newLedgerRows)} new ledger rows, ${toNumber(paymentSweep.flaggedFailures)} flagged`,
    `Hourly queue: ${toNumber(bugWrap.unresolvedCount)} unresolved (${toNumber(bugWrap.prunedResolved)} pruned)`,
    `Attribution review: ${toNumber(attributionReview.skipped)} held out, ${toNumber(attributionReview.queued)} queued, ${toNumber(attributionReview.resolved)} resolved`,
    `Open service alerts: ${openServiceAlerts.length}`,
    "",
    notes.length > 0 ? "Things to look at:" : "(no actionable issues flagged)",
    ...notes.map((n) => ` - ${n}`),
  ].join("\n");

  const result = await sendMail(domain, {
    to: recipients,
    subject: opsStatusSubject(domain, payload.date, {
      bugWrap,
      attributionReview,
      openServiceAlerts,
    }, payload.groupLabel),
    from: internalFromHeader("Parallel Ops"),
    replyTo: internalFromHeader("Parallel Ops"),
    template: "nightly/ops-status",
    data,
    text,
  });

  return { sent: true, recipients, pool: "ops", messageId: result.messageId };
}

// Combined nightly email — kept as a thin wrapper that just dispatches
// the financial pool email for backward-compat with any caller still
// using the old single-email entry point.
async function sendNightlyCloseEmail(domain, payload, options = {}) {
  return sendFinancialCloseEmail(domain, payload, options);
}

// ── Grouped (cross-domain) orchestrator ─────────────────────────────
//
// One call to send the full nightly close across all domains. Sends:
//   - Financial close   → cross-domain (TAG + WYNN combined)
//   - Vendor / lead-data → WYNN-only data (vendors only intake here)
//   - Redline alert      → cross-domain, only when alerts > 0
//   - Ops status         → cross-domain, dev only
//
// SMTP credentials still pick a transport per "send" — we use the
// vendor domain (WYNN) for the vendor email and TAG for the rest, so
// each domain's SendGrid reputation stays clean.

async function runGroupedNightlyClose(domains, options = {}) {
  const dateKey = options.date
    || formatDateKey(new Date(), options.timezone || "America/Los_Angeles");
  const sendDomain = options.sendDomain || "TAG"; // SMTP-from for cross-domain emails
  const vendorDomain = options.vendorDomain || "WYNN";
  const selectedDomains = normalizeNightlyDomains(domains);
  const shouldSendEmail = options.sendEmail !== false;

  const finalClose = options.skipFinalClosePass
    ? {
        domains: selectedDomains,
        spendSync: options.spendSync || { ok: true, skipped: true, reason: "final-close-pass-skipped" },
        hourlySweep: options.hourlySweep || null,
        paymentSweep: options.paymentSweep || { casesScanned: 0, newLedgerRows: 0, flaggedFailures: 0 },
      }
    : await runNightlyFinalClosePass(selectedDomains, {
        ...options,
        vendorDomain,
        dateKey,
      });

  const payload = await buildGroupedNightlyPayload(selectedDomains, dateKey, {
    ...options,
    timezone: options.timezone,
    vendorDomain,
  });
  const postDateHolds = await buildPostDateHoldEmailRows(selectedDomains, dateKey);

  const results = {};

  // Pool A — Financial (cross-domain summed). Now also carries the
  // failed-payments list and the MTD ROI per-source rollup. The
  // separate redline-alert email is folded into this email's
  // "Payments that didn't process today" section.
  if (shouldSendEmail) {
    try {
      results.financial = await sendFinancialCloseEmail(sendDomain, {
        date: dateKey,
        managementSnapshot: payload.managementSnapshot,
        monthToDate: payload.monthToDate,
        dealsBySource: payload.dealsBySource,
        dealsByCase: payload.dealsByCase,
        spendByChannel: payload.spendByChannel,
        failedPayments: payload.todaysAlerts || [],
        postDateHolds,
        postDateSweep: finalClose.postDateSweep || null,
        mtdRoiBySource: payload.mtdRoiBySource || [],
        hygiene: {
          prunedResolved: toNumber(payload.bugWrap?.prunedResolved),
          unresolvedCount: toNumber(payload.bugWrap?.unresolvedCount),
          casesCorrected: toNumber(finalClose.paymentSweep?.casesScanned),
          attributionsResolved: toNumber(payload.vendorReport?.attributionReview?.resolved),
        },
        groupLabel: "Parallel",
        // Cross-domain CX rollup. LD is the only source that feeds the
        // CX dial path today, so this number is effectively
        // "LD outbound dial activity for the day."
        cxToday: {
          calls: toNumber(payload.managementSnapshot?.calls?.cx?.total),
          callsOver5: toNumber(payload.managementSnapshot?.calls?.cx?.callsOver5),
          uniqueCallers: toNumber(payload.managementSnapshot?.calls?.cx?.uniqueCallers),
          uniqueSessions: toNumber(payload.managementSnapshot?.calls?.cx?.uniqueSessions),
          longestSec: toNumber(payload.managementSnapshot?.calls?.cx?.longestSec),
        },
        perDomain: payload.perDomain.map((p) => ({
          domain: p.domain,
          leads: p.managementSnapshot.leads.total,
          calls: p.managementSnapshot.calls.total,
          cxCalls: toNumber(p.managementSnapshot.calls.cx?.total),
          cxUniqueCallers: toNumber(p.managementSnapshot.calls.cx?.uniqueCallers),
          spend: p.managementSnapshot.spend.total,
          moneyIn: p.managementSnapshot.payments.totalAmount,
          deals: (p.dealsByCase || []).length,
          redlines: (p.todaysAlerts || []).length,
        })),
      }, options.financialEmail || options.email || {});
    } catch (error) {
      results.financial = { sent: false, error: error.message, pool: "financial" };
    }
  } else {
    results.financial = {
      sent: false,
      skipped: true,
      reason: "email-disabled",
      pool: "financial",
    };
  }

  // Pool B — Vendor / lead-data. WYNN only since vendor families only
  // route into WYNN. We pass the per-domain WYNN snapshot so the lead
  // intake numbers + status transitions stay WYNN-scoped, plus the
  // WYNN-only call log so the CSV reflects vendor calls only.
  const vendorPerDomain = payload.perDomain.find((p) => p.domain === payload.vendorDomain);
  if (!shouldSendEmail) {
    results.leadData = {
      sent: false,
      skipped: true,
      reason: "email-disabled",
      pool: "leadData",
    };
  } else if (vendorPerDomain) {
    try {
      results.leadData = await sendLeadDataCloseEmail(payload.vendorDomain, {
        date: dateKey,
        managementSnapshot: vendorPerDomain.managementSnapshot,
        vendorReport: payload.vendorReport,
        bugWrap: vendorPerDomain.bugWrap,
        transitions: vendorPerDomain.transitions,
        leadRows: payload.vendorLeadRows || [],
        todaysCalls: payload.vendorCallRows?.length > 0
          ? payload.vendorCallRows
          : vendorPerDomain.todaysCalls || [],
        outcomeRows: payload.vendorOutcomeRows || [],
      }, options.leadDataEmail || options.email || {});
    } catch (error) {
      results.leadData = { sent: false, error: error.message, pool: "leadData" };
    }
  } else {
    results.leadData = { sent: false, skipped: true, reason: `vendor-domain-${payload.vendorDomain}-not-in-list`, pool: "leadData" };
  }

  // Redline pool — folded into the financial close email above. We
  // keep the result slot for back-compat with anything that reads
  // `results.redline`, but we never send a separate email anymore.
  results.redline = {
    sent: false,
    skipped: true,
    reason: "folded-into-financial",
    pool: "redline",
    failedPaymentsCount: (payload.todaysAlerts || []).length,
  };

  // Pool D — Ops status. Cross-domain merge.
  if (shouldSendEmail) {
    try {
      results.ops = await sendOpsStatusEmail(sendDomain, {
        date: dateKey,
        spendSync: finalClose.spendSync || { ok: true, skipped: true, reason: "grouped-run" },
        paymentSweep: finalClose.paymentSweep || { casesScanned: 0, newLedgerRows: 0, flaggedFailures: 0 },
        leadCadenceCaseRefresh: finalClose.leadCadenceCaseRefresh || { skipped: true, reason: "not-run" },
        bugWrap: payload.bugWrap,
        attributionReview: payload.vendorReport.attributionReview || {},
        openServiceAlerts: payload.openServiceAlerts,
        leadIntake: payload.managementSnapshot.leads,
        groupLabel: "Parallel",
        domains: payload.domains,
      }, options.opsEmail || {});
    } catch (error) {
      results.ops = { sent: false, error: error.message, pool: "ops" };
    }
  } else {
    results.ops = {
      sent: false,
      skipped: true,
      reason: "email-disabled",
      pool: "ops",
    };
  }

  // Resolution bank close — LAST, deliberately after every email is out.
  // The tier-weighted Logics sweep is paced per-case GETs and can run
  // ~25 minutes at full cap; the close reports must never wait on it.
  // Isolated like every other step: a Logics outage costs one night of
  // bank freshness, nothing else.
  const resolutionEnabled =
    options.resolutionBankCloseEnabled !== undefined
      ? Boolean(options.resolutionBankCloseEnabled)
      : String(process.env.RESOLUTION_NIGHTLY_CLOSE_ENABLED ?? "true") !== "false";
  if (resolutionEnabled && !options.skipFinalClosePass) {
    try {
      const { runResolutionBankClose } = require("./resolutionBankService");
      finalClose.resolutionBankClose = await runResolutionBankClose({
        logger: options.logger || null,
        ...(options.resolutionCloseMaxCases ? { maxCases: Number(options.resolutionCloseMaxCases) } : {}),
      });
    } catch (error) {
      finalClose.resolutionBankClose = { ok: false, error: error.message };
      options.logger?.warn?.("nightly-close.resolution_bank_close_failed", { error: error.message });
    }
  } else {
    finalClose.resolutionBankClose = { skipped: true, reason: resolutionEnabled ? "final-close-pass-skipped" : "disabled" };
  }

  return { date: dateKey, domains: payload.domains, finalClose, payload, results };
}

async function executeNightlyCloseRun(runId, domain, options = {}) {
  const company = getCompanyConfig(domain);
  const timeZone = company.cadence?.timezone || "America/Los_Angeles";
  const dateKey = options.date || formatDateKey(new Date(), timeZone);
  const sections = new Map(
    buildNightlyClosePlan().groups.map((group) => [
      group.key,
      createSection(group.key, group.title),
    ]),
  );

  await deepCutRunRepository.updateDeepCutRun(runId, {
    status: "running",
    sections: [...sections.values()],
    payload: {
      date: dateKey,
      timezone: timeZone,
    },
  });

  const setSection = async (key, patch) => {
    sections.set(key, {
      ...sections.get(key),
      ...patch,
    });
    await deepCutRunRepository.updateDeepCutRun(runId, {
      sections: [...sections.values()],
    });
  };

  let paymentSweep;
  let spendSyncResult = null;
  let managementSnapshot;
  let monthToDateSnapshot;
  let vendorReport;
  let bugWrap;
  let postDateSweep = null;
  let financialEmailResult = null;
  let leadDataEmailResult = null;

  try {
    // ── Final Reconcile ─────────────────────────────────────
    // Run spend sync + payment reconcile one last time so the
    // snapshots below read freshly-landed numbers. Both are
    // idempotent — a re-run after a clean scheduled run just
    // observes "nothing new" and exits fast.
    await setSection("final-reconcile", { status: "running" });
    if (options.spendSyncRuntime?.syncAll) {
      try {
        spendSyncResult = await options.spendSyncRuntime.syncAll();
      } catch (error) {
        // Non-fatal — log onto the section and proceed. Email will
        // still send with whatever spend data is already in mongo.
        spendSyncResult = { ok: false, error: error.message };
      }
    } else {
      spendSyncResult = { ok: false, skipped: true, reason: "no-spend-sync-runtime-passed" };
    }
    paymentSweep = await reconcilePaymentsForDomain({
      domain,
      maxCases: Number(options.maxCases) || 500,
      staleAfterMs: 0,
    });
    if (options.postDateSweepEnabled !== false) {
      try {
        const { runPostDateHoldEodSweep } = require("./cxWorkspaceService");
        postDateSweep = await runPostDateHoldEodSweep([domain], {
          dateKey,
          dryRun: Boolean(options.postDateSweepDryRun),
          limit: options.postDateSweepLimit || 250,
        });
      } catch (error) {
        postDateSweep = { ok: false, error: error.message, dateKey };
      }
    } else {
      postDateSweep = { skipped: true, reason: "disabled", dateKey };
    }
    await setSection("final-reconcile", {
      status: "completed",
      summary: `Spend sync: ${spendSyncResult?.ok === false ? `skipped/error (${spendSyncResult?.error || spendSyncResult?.reason || "unknown"})` : "ok"}. Payment sweep: ${paymentSweep.newLedgerRows || 0} new ledger rows; ${paymentSweep.flaggedFailures || 0} flagged. Post-date sweep: ${toNumber(postDateSweep?.checked)} checked, ${toNumber(postDateSweep?.released)} released.`,
      metrics: { spendSync: spendSyncResult, paymentSweep, postDateSweep },
    });

    await setSection("management-snapshot", { status: "running" });
    managementSnapshot = await buildManagementSnapshot(domain, dateKey, timeZone);
    await setSection("management-snapshot", {
      status: "completed",
      summary: `${managementSnapshot.leads.total} leads, ${formatMoney(managementSnapshot.spend.total)} spend, ${formatMoney(managementSnapshot.payments.totalAmount)} paid.`,
      metrics: managementSnapshot,
    });

    await setSection("month-to-date", { status: "running" });
    monthToDateSnapshot = await buildMonthToDateSnapshot(domain, dateKey, timeZone);
    await setSection("month-to-date", {
      status: "completed",
      summary: `MTD ${monthToDateSnapshot.monthStart} → ${monthToDateSnapshot.monthEnd}: ${monthToDateSnapshot.leads.total} leads, ${formatMoney(monthToDateSnapshot.spend.total)} spend, ${formatMoney(monthToDateSnapshot.payments.totalAmount)} paid.`,
      metrics: monthToDateSnapshot,
    });

    await setSection("vendor-report", { status: "running" });
    vendorReport = await buildVendorReport(domain, dateKey, { timezone: timeZone });
    await setSection("vendor-report", {
      status: "completed",
      summary: `${vendorReport.rows.length} source rows prepared for vendor reporting. ${toNumber(vendorReport.attributionReview?.skipped)} unresolved rows held out.`,
      metrics: {
        totals: vendorReport.totals,
        attributionReview: vendorReport.attributionReview || null,
        rows: vendorReport.rows.slice(0, 25),
      },
    });

    await setSection("bug-wrap-up", { status: "running" });
    bugWrap = await wrapHourlyJobs(domain, dateKey, {
      ...options,
      timezone: timeZone,
    });
    await setSection("bug-wrap-up", {
      status: "completed",
      summary: `${bugWrap.unresolvedCount} unresolved hourly jobs remain; ${bugWrap.prunedResolved} resolved jobs pruned.`,
      metrics: {
        unresolvedCount: bugWrap.unresolvedCount,
        prunedResolved: bugWrap.prunedResolved,
        unresolved: bugWrap.unresolved.slice(0, 25),
      },
    });

    // ── Build the extra payloads the templates need ────────
    // These are quick aggregations that the management snapshot
    // doesn't already produce: status transitions by source, deals
    // by source, spend by channel, today's calls, today's failed
    // payment alerts. Computed in parallel; each is bounded.
    const [
      transitions,
      dealsBySource,
      spendByChannel,
      todaysCalls,
      todaysAlerts,
      openServiceAlerts,
      postDateHolds,
    ] = await Promise.all([
      buildTransitionsBySource(domain, dateKey, timeZone).catch(() => []),
      buildDealsBySource(domain, dateKey).catch(() => []),
      buildSpendByChannel(domain, dateKey).catch(() => []),
      buildTodaysCalls(domain, dateKey, timeZone).catch(() => []),
      buildTodaysPaymentAlerts(domain, dateKey).catch(() => []),
      buildOpenServiceAlerts(domain, 15).catch(() => []),
      buildPostDateHoldEmailRows([domain], dateKey).catch(() => []),
    ]);

    const hygiene = {
      prunedResolved: toNumber(bugWrap.prunedResolved),
      unresolvedCount: toNumber(bugWrap.unresolvedCount),
      casesCorrected: toNumber(paymentSweep?.casesScanned),
      attributionsResolved: toNumber(vendorReport.attributionReview?.resolved),
    };

    // ── Reporting — up to FOUR emails, isolated failures ───
    // Financial → admins (money). Lead-data → admins + partner
    // (vendors + scoring, no app health). Redline → admins,
    // only when there are failed payments. Ops status → dev
    // only (failures + things to look at). Each wrapped so a
    // single failure doesn't drop the others.
    await setSection("reporting", { status: "running" });
    let redlineEmailResult = null;
    let opsStatusEmailResult = null;
    if (options.sendEmail !== false) {
      try {
        financialEmailResult = await sendFinancialCloseEmail(domain, {
          date: dateKey,
          managementSnapshot,
          monthToDate: monthToDateSnapshot,
          dealsBySource,
          spendByChannel,
          failedPayments: todaysAlerts,
          postDateHolds,
          postDateSweep,
          hygiene,
        }, options.financialEmail || options.email || {});
      } catch (error) {
        financialEmailResult = { sent: false, error: error.message, pool: "financial" };
      }
      try {
        leadDataEmailResult = await sendLeadDataCloseEmail(domain, {
          date: dateKey,
          managementSnapshot,
          vendorReport,
          bugWrap,
          transitions,
          todaysCalls,
        }, options.leadDataEmail || options.email || {});
      } catch (error) {
        leadDataEmailResult = { sent: false, error: error.message, pool: "leadData" };
      }
      redlineEmailResult = {
        sent: false,
        skipped: true,
        reason: "folded-into-financial",
        pool: "redline",
        failedPaymentsCount: todaysAlerts.length,
      };

      try {
        opsStatusEmailResult = await sendOpsStatusEmail(domain, {
          date: dateKey,
          spendSync: spendSyncResult,
          paymentSweep,
          bugWrap,
          attributionReview: vendorReport.attributionReview || {},
          openServiceAlerts,
          leadIntake: managementSnapshot.leads || { total: 0, entries: [] },
        }, options.opsEmail || {});
      } catch (error) {
        opsStatusEmailResult = { sent: false, error: error.message, pool: "ops" };
      }
    }
    await setSection("reporting", {
      status: "completed",
      summary: [
        financialEmailResult?.sent
          ? `Financial: ${financialEmailResult.recipients.join(", ")}`
          : `Financial: ${financialEmailResult?.error || financialEmailResult?.reason || "skipped"}`,
        leadDataEmailResult?.sent
          ? `Lead data: ${leadDataEmailResult.recipients.join(", ")}`
          : `Lead data: ${leadDataEmailResult?.error || leadDataEmailResult?.reason || "skipped"}`,
        redlineEmailResult?.sent
          ? `Redline: ${redlineEmailResult.recipients.join(", ")}`
          : `Redline: ${redlineEmailResult?.error || redlineEmailResult?.reason || "skipped"}`,
        opsStatusEmailResult?.sent
          ? `Ops: ${opsStatusEmailResult.recipients.join(", ")}`
          : `Ops: ${opsStatusEmailResult?.error || opsStatusEmailResult?.reason || "skipped"}`,
      ].join(" | "),
      metrics: { financialEmailResult, leadDataEmailResult, redlineEmailResult, opsStatusEmailResult },
    });

    const [
      statusChanges,
      stopSignalsDetected,
      aiCaseReviewsDue,
      aiCaseReviewsCompleted,
    ] = await Promise.all([
      countStatusChanges(domain, dateKey, timeZone),
      countStopSignalsDetected(domain),
      countAiCaseReviewsDue(domain, 7),
      countAiCaseReviewsCompleted(domain, dateKey, timeZone),
    ]);

    const summary = {
      totalCasesTouched: toNumber(paymentSweep.casesScanned),
      statusChanges: toNumber(statusChanges),
      paymentsDetected: toNumber(paymentSweep.newLedgerRows),
      redlinesDetected: toNumber(managementSnapshot.alerts.pendingRedlines) + toNumber(managementSnapshot.alerts.reviewRedlines),
      attributionUpdates: toNumber(vendorReport.attributionReview?.resolved),
      stopSignalsDetected: toNumber(stopSignalsDetected),
      spendRowsSynced: toNumber(managementSnapshot.spend.rows),
      aiCaseReviewsDue: toNumber(aiCaseReviewsDue),
      aiCaseReviewsCompleted: toNumber(aiCaseReviewsCompleted),
    };

    await deepCutRunRepository.updateDeepCutRun(runId, {
      status: "completed",
      completedAt: new Date(),
      summary,
      sections: [...sections.values()],
      payload: {
        date: dateKey,
        timezone: timeZone,
        managementSnapshot,
        monthToDate: monthToDateSnapshot,
        vendorReport,
        bugWrap,
        financialEmailResult,
        leadDataEmailResult,
        spendSyncResult,
      },
    });
  } catch (error) {
    const failedSection = [...sections.values()].find((section) => section.status === "running");
    if (failedSection) {
      await setSection(failedSection.key, {
        status: "failed",
        summary: error.message,
        metrics: { error: error.message },
      });
    }
    await deepCutRunRepository.updateDeepCutRun(runId, {
      status: "failed",
      completedAt: new Date(),
      sections: [...sections.values()],
      notes: [error.message],
      payload: {
        date: dateKey,
        timezone: timeZone,
        managementSnapshot: managementSnapshot || null,
        vendorReport: vendorReport || null,
        bugWrap: bugWrap || null,
      },
    });
  }
}

async function startNightlyCloseRun(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const run = await deepCutRunRepository.createDeepCutRun({
    domain: normalizedDomain,
    runType: "nightly-close",
    status: "planned",
    startedAt: new Date(),
    sections: buildNightlyClosePlan().groups.map((group) => createSection(group.key, group.title)),
    notes: options.notes || [],
  });

  const runId = String(run._id);
  setTimeout(() => {
    executeNightlyCloseRun(runId, normalizedDomain, options).catch(async (error) => {
      await deepCutRunRepository.updateDeepCutRun(runId, {
        status: "failed",
        completedAt: new Date(),
        notes: [error.message],
      });
    });
  }, 0);

  return {
    ok: true,
    runId,
    status: "planned",
    runType: "nightly-close",
  };
}

/**
 * Pool E — Aged pool daily refresh report. Fires at 06:00 PT after the
 * daily age-in / re-scrub sweep completes. Day-1 also passes the monthly
 * graduation summary so both lists land in one email.
 *
 * @param {object} options
 * @param {object} options.dailySummary    - return of runDailyAgedRefresh
 * @param {object} [options.monthlySummary]- return of runMonthlyGraduationSweep (day-1 only)
 * @param {string[]} [options.recipients]  - override recipients
 */
async function sendAgedRefreshReportEmail(options = {}) {
  const daily = options.dailySummary || {};
  const monthly = options.monthlySummary || null;
  const recipients = Array.isArray(options.recipients) && options.recipients.length > 0
    ? options.recipients
    : getRecipientPool("agedPool");

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients", pool: "agedPool" };
  }

  const dateKey = formatDateKey(daily.now || new Date());
  const dncRetired = toNumber(daily.evicted) + toNumber(daily.droppedAtIntake);
  const expiredRetired = toNumber(daily.expiredRetirement?.retired);
  const totalRetired = dncRetired + expiredRetired;

  // MPI count for the "currently in red" headline tile.
  const currentlyInRed = await mongoose.connection.db
    .collection("controlplanemasterprospectindices")
    .countDocuments({ "pool.tag": { $regex: /^filler-/ } })
    .catch(() => null);

  const perDomain = Object.entries(daily.perDomain || {}).map(([domain, stats]) => ({
    domain,
    checked: stats.checked || 0,
    promoted: stats.promoted || 0,
    stayed: stats.stayed || 0,
    cleared: stats.cleared || 0,
    evicted: (stats.evicted || 0) + (stats.droppedAtIntake || 0),
    dncLookupFailures: stats.dncLookupFailures || 0,
    noPhone: stats.noPhone || 0,
  }));

  const data = {
    date: dateKey,
    dryRun: Boolean(daily.dryRun),
    tag: daily.tag || null,
    counts: {
      checked: toNumber(daily.checked),
      promoted: toNumber(daily.promoted),
      stayed: toNumber(daily.stayed),
      cleared: toNumber(daily.cleared),
      evicted: dncRetired,
      expiredRetired,
      totalRetired,
      lookupFailures: toNumber(daily.dncLookupFailures),
      noPhone: toNumber(daily.noPhone),
      currentlyInRed,
    },
    perDomain,
    retiredToday: Array.isArray(daily.retiredToday) ? daily.retiredToday.slice(0, 50) : [],
    retiredOverflow: Array.isArray(daily.retiredToday) && daily.retiredToday.length > 50
      ? daily.retiredToday.length - 50
      : 0,
    monthly: monthly
      ? {
          scanned: toNumber(monthly.scanned),
          graduated: toNumber(monthly.graduated),
          threshold: monthly.threshold,
          windowDays: monthly.windowDays,
          graduatedToday: Array.isArray(monthly.graduatedToday)
            ? monthly.graduatedToday.slice(0, 50)
            : [],
          graduatedOverflow: Array.isArray(monthly.graduatedToday) && monthly.graduatedToday.length > 50
            ? monthly.graduatedToday.length - 50
            : 0,
        }
      : null,
    durationMs: toNumber(daily.durationMs),
  };

  const subject = monthly
    ? `Aged pool refresh — ${dateKey} — ${data.counts.checked} checked, ${totalRetired} retired, ${monthly.graduated} graduated`
    : `Aged pool refresh — ${dateKey} — ${data.counts.checked} checked, ${totalRetired} retired`;

  // No domain-specific branding — this is a cross-tenant ops email.
  const result = await sendMail(null, {
    to: recipients,
    subject,
    from: internalFromHeader("Parallel Aged Pool"),
    replyTo: internalFromHeader("Parallel Aged Pool"),
    template: "nightly/aged-refresh",
    data,
    text:
      `Aged pool refresh ${dateKey}: ${data.counts.checked} checked, ` +
      `${data.counts.promoted} promoted, ${dncRetired} DNC retired, ${expiredRetired} expired retired` +
      (monthly ? `, ${monthly.graduated} graduated.` : "."),
  });

  return {
    sent: true,
    recipients,
    pool: "agedPool",
    messageId: result.messageId,
  };
}

module.exports = {
  buildManagementSnapshot,
  buildMonthToDateSnapshot,
  buildNightlyClosePlan,
  buildVendorReport,
  buildTransitionsBySource,
  buildDealsBySource,
  buildSpendByChannel,
  buildTodaysCalls,
  buildTodaysPaymentAlerts,
  buildOpenServiceAlerts,
  buildGroupedNightlyPayload,
  executeNightlyCloseRun,
  runGroupedNightlyClose,
  sendFinancialCloseEmail,
  sendLeadDataCloseEmail,
  sendRedlineAlertEmail,
  sendOpsStatusEmail,
  sendAgedRefreshReportEmail,
  startNightlyCloseRun,
  wrapHourlyJobs,
};
