"use strict";

const {
  dailyCallStatRepository,
  masterProspectRepository,
  paymentAlertRepository,
  reviewQueueRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
} = require("../../shared-repositories/src");
const { getCompanyKeys } = require("../../shared-config/src");
const {
  listRoiEligiblePayments,
  summarizeRoiPayments,
} = require("./paymentRoiService");

function normalizeDomain(domain) {
  return String(domain || "").toUpperCase();
}

const GLOBAL_METRICS_DOMAIN = "ALL";

function isGlobalMetricsDomain(domain) {
  return normalizeDomain(domain) === GLOBAL_METRICS_DOMAIN || !normalizeDomain(domain);
}

function listMetricsDomains() {
  return [...new Set(getCompanyKeys().map((value) => normalizeDomain(value)).filter(Boolean))];
}

function todayIsoLA() {
  // "today" in LA timezone — the old app's pulse used the same timezone
  // for all per-day aggregations. Matching it here keeps numbers in sync.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function classifyChannel(channelRaw) {
  const c = String(channelRaw || "").toLowerCase();
  if (c === "mailer" || c === "mail" || c.includes("mail")) return "mail";
  if (c === "bcd" || c.includes("broadcast")) return "bcd";
  if (c === "ld" || c === "lead-distribution" || c === "lead-data") return "ld";
  if (c === "meta" || c === "facebook" || c === "instagram") return "meta";
  if (c === "dialer" || c.includes("dial")) return "dialer";
  if (c === "rvm" || c.includes("callback")) return "rvm";
  if (c === "website" || c === "web" || c === "landing-page") return "web";
  if (c === "social") return "social";
  return "other";
}

async function buildMailToday(domain, date) {
  const rows = isGlobalMetricsDomain(domain)
    ? (
        await Promise.all(
          listMetricsDomains().map((key) =>
            spendEntryRepository.summarizeSpendBySource(key, { date }).catch(() => []),
          ),
        )
      ).flat()
    : await spendEntryRepository.summarizeSpendBySource(domain, { date });
  const bySource = new Map();
  for (const row of rows) {
    if (classifyChannel(row._id?.channel) !== "mail") continue;
    const source = row._id?.source || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, { source, pieces: 0, spend: 0 });
    }
    const entry = bySource.get(source);
    entry.pieces += Number(row.pieces || 0);
    entry.spend += Number(row.spend || 0);
  }
  const entries = [...bySource.values()].sort((a, b) => b.spend - a.spend);
  const total = entries.reduce(
    (acc, entry) => {
      acc.pieces += entry.pieces;
      acc.spend += entry.spend;
      return acc;
    },
    { pieces: 0, spend: 0 },
  );
  return { entries, total };
}

async function buildMailCalls(date, excludePieces) {
  const rows = await dailyCallStatRepository.summarizeCallStats({
    date,
    excludePieces,
  });
  const entries = rows
    .filter((r) => classifyChannel(r._id?.channel) === "mail")
    .map((r) => ({
      piece: r._id?.piece || "Unknown",
      totalCalls: Number(r.totalCalls || 0),
      callsOver5: Number(r.callsOver5 || 0),
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)
    .slice(0, 20);
  const total = entries.reduce(
    (acc, entry) => {
      acc.totalCalls += entry.totalCalls;
      acc.callsOver5 += entry.callsOver5;
      return acc;
    },
    { totalCalls: 0, callsOver5: 0 },
  );
  return { entries, total };
}

async function buildOtherChannels(date, excludePieces) {
  const rows = await dailyCallStatRepository.summarizeCallStats({
    date,
    excludePieces,
  });
  const buckets = {
    bcd: { label: "BCD calls", totalCalls: 0 },
    social: { label: "Social calls", totalCalls: 0 },
    rvm: { label: "RVM / Text callbacks", totalCalls: 0 },
    web: { label: "Web / Other", totalCalls: 0 },
    dialer: { label: "Dialer calls", totalCalls: 0 },
  };
  for (const row of rows) {
    const ch = classifyChannel(row._id?.channel);
    if (ch === "mail") continue;
    const key = buckets[ch] ? ch : "web";
    buckets[key].totalCalls += Number(row.totalCalls || 0);
  }
  return Object.entries(buckets).map(([key, value]) => ({
    key,
    label: value.label,
    totalCalls: value.totalCalls,
  }));
}

async function buildPaymentsToday(domain, date) {
  const roiPayments = isGlobalMetricsDomain(domain)
    ? (
        await Promise.all(
          listMetricsDomains().map((key) =>
            listRoiEligiblePayments(key, { date }).catch(() => []),
          ),
        )
      ).flat()
    : await listRoiEligiblePayments(domain, { date });
  const summary = summarizeRoiPayments(roiPayments);

  // Needs-review = any payment that tripped an alert today
  let needsReview = 0;
  try {
    if (isGlobalMetricsDomain(domain)) {
      const counts = await Promise.all(
        listMetricsDomains().map((key) =>
          paymentAlertRepository.countPaymentAlerts(key, {
            status: "pending",
            paymentDate: date,
          }).catch(() => 0),
        ),
      );
      needsReview = counts.reduce((sum, count) => sum + Number(count || 0), 0);
    } else {
      needsReview = await paymentAlertRepository.countPaymentAlerts(domain, {
        status: "pending",
        paymentDate: date,
      });
    }
  } catch {
    needsReview = 0;
  }

  return {
    initialCount: summary.initialCount,
    initialAmount: summary.initialAmount,
    recurringCount: summary.recurringCount,
    recurringAmount: summary.recurringAmount,
    total: summary.total,
    needsReview: needsReview || 0,
  };
}

async function buildLeadsToday(domain, date) {
  // MasterProspect rows created today, grouped by intakeSource.
  // Uses a direct aggregation on the index so we don't undercount on
  // busy days — the earlier list-200-then-filter path dropped rows the
  // moment volume exceeded the limit.
  const start = new Date(`${date}T00:00:00-08:00`);
  const end = new Date(`${date}T23:59:59-08:00`);
  const rows = isGlobalMetricsDomain(domain)
    ? (
        await Promise.all(
          listMetricsDomains().map((key) =>
            masterProspectRepository.summarizeProspectsByIntakeSource(
              key,
              { from: start, to: end },
            ).catch(() => []),
          ),
        )
      ).flat()
    : await masterProspectRepository.summarizeProspectsByIntakeSource(
        domain,
        { from: start, to: end },
      );
  const bySource = new Map();
  for (const row of rows) {
    const source = row._id || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, { source, count: 0 });
    }
    bySource.get(source).count += Number(row.count || 0);
  }
  const entries = [...bySource.values()];
  const total = entries.reduce((sum, entry) => sum + entry.count, 0);
  return { entries, total };
}

async function buildAlerts(domain) {
  // Pending payment-alert (redline) count — the old app's single metric.
  let pending = 0;
  try {
    if (isGlobalMetricsDomain(domain)) {
      const counts = await Promise.all(
        listMetricsDomains().map((key) =>
          paymentAlertRepository.countPaymentAlerts(key, { status: "pending" }).catch(() => 0),
        ),
      );
      pending = counts.reduce((sum, count) => sum + Number(count || 0), 0);
    } else {
      pending = await paymentAlertRepository.countPaymentAlerts(domain, { status: "pending" });
    }
  } catch {
    pending = 0;
  }
  // Also surface any attribution-review items from our own resolver pipeline.
  let attributionReview = 0;
  try {
    if (isGlobalMetricsDomain(domain)) {
      const counts = await Promise.all(
        listMetricsDomains().map((key) =>
          reviewQueueRepository.countReviewQueueItems(
            key,
            {
              workflow: "attribution-review",
              status: "open",
            },
          ).catch(() => 0),
        ),
      );
      attributionReview = counts.reduce((sum, count) => sum + Number(count || 0), 0);
    } else {
      attributionReview = await reviewQueueRepository.countReviewQueueItems(
        domain,
        {
          workflow: "attribution-review",
          status: "open",
        },
      );
    }
  } catch {
    attributionReview = 0;
  }
  return { pendingRedlines: pending || 0, attributionReview: attributionReview || 0 };
}

/**
 * Pulse groups for "today" — mirrors the old app's right-sidebar
 * (MetricsDashboard.js → PulsePanelContent). Always locked to today
 * in LA time regardless of the main dashboard's date range.
 *
 * Groups:
 *   - mailToday: per-mail-source pieces + spend
 *   - mailCalls: per-mail-piece total/over5 calls
 *   - otherChannels: BCD / Social / RVM / Dialer / Web call totals
 *   - paymentsToday: initials/recurring split + total + needsReview
 *   - leadsToday: per-source new leads count
 *   - alerts: pending redlines + attribution-review count
 *
 * Returns a stable shape even when sub-queries fail (errors → empty
 * entries with `_error` flag). Pulse refresh on the FE should be
 * resilient to partial failures.
 */
async function buildMetricsPulse(domain, options = {}) {
  const normalizedDomain = isGlobalMetricsDomain(domain)
    ? GLOBAL_METRICS_DOMAIN
    : normalizeDomain(domain);
  const date = options.date || todayIsoLA();

  // Resolve the cross-tenant piece-exclusion list once up-front so the
  // three call-stat sub-queries can reuse it. Pieces explicitly owned
  // by other domains get filtered out; unowned pieces stay visible.
  let excludePieces = [];
  try {
    excludePieces = normalizedDomain === GLOBAL_METRICS_DOMAIN
      ? []
      : (await sourceCanonicalRepository.listPiecesAssignedToOtherDomains(
          normalizedDomain,
        )) || [];
  } catch {
    excludePieces = [];
  }

  const safe = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      return { _error: error.message };
    }
  };

  const [mailToday, mailCalls, otherChannels, paymentsToday, leadsToday, alerts] =
    await Promise.all([
      safe(() => buildMailToday(normalizedDomain, date)),
      safe(() => buildMailCalls(date, excludePieces)),
      safe(() => buildOtherChannels(date, excludePieces)),
      safe(() => buildPaymentsToday(normalizedDomain, date)),
      safe(() => buildLeadsToday(normalizedDomain, date)),
      safe(() => buildAlerts(normalizedDomain)),
    ]);

  return {
    domain: normalizedDomain,
    date,
    generatedAt: new Date().toISOString(),
    mailToday,
    mailCalls,
    otherChannels,
    paymentsToday,
    leadsToday,
    alerts,
  };
}

module.exports = {
  buildMetricsPulse,
};
