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
const {
  reconcilePhoneBurnerNightlyLookback,
} = require("./dailyDialNightlyLookbackService");
const { sendMail } = require("./mailerService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");
const { runHourlySweep } = require("./hourlySweeperService");
const {
  recoverCxCallLogsForDate,
} = require("./cxCallActivityBackfillService");
const { refreshTouchedCase } = require("./hourlyCallLogHygieneService");
const { getInternalFromEmail } = require("../../shared-config/src");

const UNRESOLVED_HOURLY_STATUSES = ["pending", "processing", "failed", "dead-letter"];
const REQUIRED_NIGHTLY_DOMAINS = ["WYNN", "TAG"];
const LD_VENDOR_FAMILY_KEYS = new Set(["ld-custom", "ld-custom-2", "ld-custom-3", "ld-general", "ld-posting"]);
const LD_CAMPAIGN_LABELS = {
  "ld-custom": "LD CUSTOM",
  "ld-custom-2": "LD CUSTOM 2",
  "ld-custom-3": "LD CUSTOM 3",
  "ld-general": "LD GENERAL",
  "ld-posting": "LD Posting",
  "ld": "LD (unsplit)",
};

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

// Master kill switch for the nightly REPORT emails (financial-close,
// lead-data-vendor, redline-alert, ops-status, aged-refresh). The
// operational close (payment sweep, cadence refresh, PB reconcile) is
// NOT affected — this only silences the inbox.
// Off while the metrics simplification rebuilds the report one solid
// number at a time (2026-07-24).
function nightlyReportEmailsEnabled() {
  return String(process.env.NIGHTLY_CLOSE_EMAILS_ENABLED ?? "true") !== "false";
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

function normalizeNightlyDomains(domains) {
  const requested = (Array.isArray(domains) ? domains : [])
    .map(normalizeDomain)
    .filter(Boolean);
  return [...new Set([...requested, ...REQUIRED_NIGHTLY_DOMAINS])];
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
  // LD spend materializer RETIRED 2026-07-27: LD cost is CPL configured in
  // Logics (Mickey: "no need to do the multiply by 3"). Nothing here
  // computes or writes LD dollars anymore.
  const ldSpendMaterializer = { skipped: true, reason: "retired-cpl-in-logics" };

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

  // Queue-wide status re-verification (2026-07-24 DNC incident). The pass
  // above only covers leads CREATED today; a lead living in the queue for
  // weeks never got re-checked and stayed dialable on a frozen status.
  // This re-verifies everything still in the queue so a case that goes DNC
  // after intake stops being deliverable by the next nightly run.
  let leadQueueStatusRefresh = { skipped: true, reason: "disabled" };
  if (options.leadQueueStatusRefreshEnabled !== false) {
    try {
      const { refreshQueuedLeadStatuses } = require("./leadQueueStatusRefreshService");
      leadQueueStatusRefresh = await refreshQueuedLeadStatuses({
        maxAgeHours: options.leadQueueStatusMaxAgeHours ?? 20,
        limit: options.leadQueueStatusRefreshLimit ?? 20000,
        logger: options.logger || null,
      });
    } catch (error) {
      leadQueueStatusRefresh = { error: error.message };
      options.logger?.warn?.("nightly.lead_queue_status_refresh.failed", { error: error.message });
    }
  }
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

  // The "accurate nightly" pair — a month-to-date call-totals reconciliation
  // and an immutable MetricClose freeze on top of it — was DELETED 2026-07-31.
  // It was never armed (METRIC_CLOSE_FREEZE_ENABLED was never set), and both
  // halves wrote to collections with zero readers anywhere in the repo: the
  // web client, the API routes, every script and the report blocks were all
  // grepped. The whole reporting story is live-gathered now, so a frozen
  // snapshot has nothing to protect against and nothing to feed.
  //
  // scripts/reconcile-monthly-call-totals.js is KEPT — it is still a useful
  // thing to run by hand; it just no longer runs itself every night.

  return {
    domains: selectedDomains,
    spendSync,
    ldSpendMaterializer,
    hourlySweep,
    cxCallActivityBackfill,
    leadCadenceCaseRefresh,
    leadQueueStatusRefresh,
    postDateSweep,
    clientCaseDiscovery,
    paymentSweep: summarizePaymentSweepForOps(
      hourlySweep?.phaseA?.paymentReconcile || [],
      selectedDomains,
    ),
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

/**
 * Month-to-date roll-up — same axes as `buildManagementSnapshot` but
 * windowed from the 1st of the current month through `dateKey`. Used
 * by the financial close email's CSV attachment and for any "MTD"
 * lines in the body.
 *
 * Calls into the existing repos that already accept date-range
 * filters, so the surface area is small and reuse is high.
 */
/**
 * Build a base64-encoded CSV attachment summarizing daily + MTD
 * numbers side-by-side. SendGrid v3 expects attachments as base64
 * strings; the surrounding sendgridClient.sendEmail just passes the
 * `attachments` array through to /v3/mail/send.
 */
// ── Email payload helpers ───────────────────────────────────────────
//
// These compute the additional axes the new HTML templates need that
// `buildManagementSnapshot` doesn't already provide:
//   - status transitions by source (the "what moved tonight" view)
//   - new deals by source (initial-payment counts, by source)
//   - spend rolled up by channel (the spend snapshot tile)
//   - today's call log (CSV sidecar for the lead-data email)
//   - today's failed-payment alerts (Pool C body + CSV)

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

/**
 * Build the full cross-domain payload set in a single pass. Returned
 * shape is the input each `sendXxxEmail` (now cross-domain) expects.
 *
 * Vendor data stays single-domain — `vendorDomain` (default WYNN) is
 * the only domain we pull `buildVendorReport` for, since the tracked
 * vendor families (LD posting, affiliate, social) only intake leads
 * into WYNN.
 */
/**
 * Pool A — Financial close. Goes to admins only. HTML body is rendered
 * from `nightly/financial-close.hbs`; CSV attachment carries the full
 * daily + MTD breakdown plus per-channel spend and per-source deals.
 */
/**
 * Pool B — Lead data + scoring. Goes to admins + the LizDev partner
 * (when prod list is uncommented). HTML rendered from
 * `nightly/lead-data-vendor.hbs`; two CSV attachments — vendor
 * per-source rollup + today's call log.
 */
/**
 * Pool C — Redline alert. Only fires when there are failed payments
 * for the date. Goes to the financial pool. Dramatic-styled banner
 * + per-alert table + redline CSV attachment.
 */
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
  if (!nightlyReportEmailsEnabled()) {
    return { sent: false, skipped: true, reason: "emails-disabled", pool: "ops" };
  }
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

async function reconcilePhoneBurnerCallsForNightly(dateKey, options = {}) {
  return reconcilePhoneBurnerNightlyLookback(dateKey, options);
}

async function runGroupedNightlyClose(domains, options = {}) {
  const dateKey = options.date
    || formatDateKey(new Date(), options.timezone || "America/Los_Angeles");
  const sendDomain = options.sendDomain || "TAG"; // SMTP-from for cross-domain email
  const vendorDomain = options.vendorDomain || "WYNN";
  const selectedDomains = normalizeNightlyDomains(domains);

  // PAYMENTS-SHEET GATE. The hourly API reconcile is not a complete record
  // of revenue — measured against Logics' own export, TAG July was 34.6%
  // short ($279,500.86 vs $412,579.15) and every missing dollar was
  // recurring. Publishing money off the API alone means publishing a number
  // that is a third light, confidently labelled.
  //
  // The gate holds MONEY only. Safety work below runs regardless: blocking
  // the DNC / lead-status refresh on a missing spreadsheet would leave DNC
  // leads dialable overnight — precisely the bleed fixed 2026-07-24 (WYNN
  // 137190). A finance control must never become a compliance regression.
  let paymentsSheetGate = { holdMoney: false, skipped: true, reason: "gate-not-evaluated" };
  try {
    const { evaluatePaymentsSheetGate } = require("./paymentsSheetGateService");
    paymentsSheetGate = await evaluatePaymentsSheetGate({ dateKey });
  } catch (error) {
    // A broken gate must not block the close — fail OPEN here, because the
    // alternative is silently sending nothing every night if this service
    // ever throws. The absence is logged instead.
    paymentsSheetGate = { holdMoney: false, error: error.message };
    options.logger?.warn?.("nightly_close.payments_sheet_gate_failed", { error: error.message });
  }

  const shouldSendEmail = options.sendEmail !== false && !paymentsSheetGate.holdMoney;
  if (paymentsSheetGate.holdMoney) {
    options.logger?.warn?.("nightly_close.money_held_no_payments_sheet", {
      dateKey,
      reason: paymentsSheetGate.reason,
      missing: paymentsSheetGate.missing,
      stale: paymentsSheetGate.stale,
    });
  }

  const phoneBurnerCallReconciliation = await reconcilePhoneBurnerCallsForNightly(dateKey, {
    reconcileDailyDialCalls: options.reconcileDailyDialCalls,
    skip: options.skipFinalClosePass === true,
    logger: options.logger,
  });

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

  finalClose.phoneBurnerCallReconciliation = phoneBurnerCallReconciliation;

  const results = {};

  // METRICS EMAILS RETIRED 2026-07-27. The financial + vendor/lead-data
  // close emails and every rollup that fed them (management snapshot,
  // month-to-date, deals/payments-by-case, vendor report, LD cost summary)
  // are gone: reported money is the payment sheet now. The snapshot email
  // that briefly replaced them (simpleNightlyEmailService) was itself deleted
  // 2026-07-31 — metrics mail is the 20:00 report scheduler and nothing else.
  // The one thing those emails carried that had to survive — "payments
  // that didn't process today" — is `listFailedPayments()` in
  // simpleMarketingReadService.
  //
  // The runtime dispatches the simple email itself; this close does not
  // send it. `results` keeps its shape for callers reading emails.*.
  results.financial = { sent: false, skipped: true, reason: "retired-see-simple-nightly-email", pool: "financial" };
  results.leadData = { sent: false, skipped: true, reason: "retired-see-simple-nightly-email", pool: "leadData" };
  results.redline = { sent: false, skipped: true, reason: "retired-folded-into-simple-email", pool: "redline" };

  // Pool D — Ops status. OPERATIONAL health, not metrics, so it survives.
  // Fed entirely from the close's own work plus the hourly-job wrap and
  // open service alerts; it no longer depends on any metrics payload.
  if (shouldSendEmail) {
    try {
      const [bugWrap, openServiceAlerts] = await Promise.all([
        wrapHourlyJobs(sendDomain, dateKey, options).catch(() => null),
        buildOpenServiceAlerts(sendDomain).catch(() => []),
      ]);
      results.ops = await sendOpsStatusEmail(sendDomain, {
        date: dateKey,
        spendSync: finalClose.spendSync || { ok: true, skipped: true, reason: "grouped-run" },
        paymentSweep: finalClose.paymentSweep || { casesScanned: 0, newLedgerRows: 0, flaggedFailures: 0 },
        leadCadenceCaseRefresh: finalClose.leadCadenceCaseRefresh || { skipped: true, reason: "not-run" },
        leadQueueStatusRefresh: finalClose.leadQueueStatusRefresh || { skipped: true, reason: "not-run" },
        bugWrap,
        openServiceAlerts,
        groupLabel: "Parallel",
        domains: selectedDomains,
      }, options.opsEmail || {});
    } catch (error) {
      results.ops = { sent: false, error: error.message, pool: "ops" };
    }
  } else {
    results.ops = { sent: false, skipped: true, reason: "email-disabled", pool: "ops" };
  }

  // Resolution bank close — LAST, deliberately. The tier-weighted Logics
  // sweep is paced per-case GETs and can run ~25 minutes at full cap; the
  // close must never wait on it. Isolated like every other step: a Logics
  // outage costs one night of bank freshness, nothing else.
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
    finalClose.resolutionBankClose = {
      skipped: true,
      reason: resolutionEnabled ? "final-close-pass-skipped" : "disabled",
    };
  }

  return {
    date: dateKey,
    domains: selectedDomains,
    finalClose,
    results,
    // Visible in the run result so a silent night is explainable: if money
    // was held, this says which company's sheet was missing. Safety work is
    // unaffected either way.
    paymentsSheetGate,
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
  if (!nightlyReportEmailsEnabled()) {
    return { sent: false, skipped: true, reason: "emails-disabled", pool: "agedPool" };
  }
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
  runGroupedNightlyClose,
  reconcilePhoneBurnerCallsForNightly,
  sendOpsStatusEmail,
  sendAgedRefreshReportEmail,
  wrapHourlyJobs,
};
