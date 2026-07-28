"use strict";

// LIVE GATHER — pull a date range straight from the authoritative services.
//
// Mickey 2026-07-28: "we are just a face plate and a tool to make gathering
// info from the services we use easier now, not an aggregator of stats" and
// "its probably worth it to just generate this from the apis every time
// because those are authoritative."
//
// ── WHY THIS IS AFFORDABLE (measured, not assumed) ──────────────────────
// The Logics ActivityReport is RANGE-NATIVE: one call per domain covers any
// window. 9 days = 13,414 rows in 3.7s. So a month of activity is ~10s
// across three domains, NOT thirty pulls. Per-case billing is ~364ms, and
// only cases that actually moved need it.
//
//   today  ≈ 30s      ·      a full month ≈ 3 min at concurrency 3
//
// That is fast enough that nothing needs to be kept. No parallel stats
// database, no drift, no "is this number stale?" — the answer always comes
// from the system that owns it.
//
// The ONE thing a live pull cannot reproduce is history that has since
// changed: who the officer was AT SALE, what the source was AT SALE. A
// re-pull gives today's assignment, not July's. Those snapshots are the
// only thing worth persisting — see events-vs-state doctrine.

const { createLogicsClient } = require("../../shared-integrations/src");
const { parseReportRows } = require("./activityEventService");
const { runMoneyLoop, unwrapLogics, mapLimit } = require("./paymentTruthService");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Logics 400s on a non-zero-padded date. */
function fmtLogicsDate(dateKey) {
  const [y, m, d] = String(dateKey).split("-");
  return `${m}/${d}/${y}`;
}

// ── THE 50,000-ROW CAP ───────────────────────────────────────────────────
// PROVEN 2026-07-28: the ActivityReport returns AT MOST 50,000 rows and
// truncates SILENTLY. A single TAG pull for 2025-01-01→2026-07-28 returned
// exactly 50,000; so did each half, summing to 100,000. The window filters
// on LastModifiedDate (not Created), and the cap keeps the NEWEST modified,
// dropping the oldest.
//
// A capped window is not an answer — it is a partial one wearing an
// answer's clothes. So any window that comes back at the cap is split and
// re-pulled until every piece is under it.
const ROW_CAP = 50000;
const MAX_SPLIT_DEPTH = 7;

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

async function requestWindow(client, from, to) {
  const res = await client.requestActivityReport({
    StartDate: fmtLogicsDate(from),
    EndDate: fmtLogicsDate(to),
    ReportName: "ActivityReport",
    Email: process.env.LOGICS_REPORT_EMAIL || "mgray@taxadvocategroup.com",
  });
  const data = unwrapLogics(res);
  return Array.isArray(data) ? data : (Array.isArray(data?.Data) ? data.Data : []);
}

/**
 * Every raw row for a domain over a range, cap-safe.
 *
 * Dedupes on (CaseID, ActivitySubject, Created) — the same immutable triple
 * the event parser keys on, so overlapping windows collapse cleanly.
 */
async function pullDomainRows({ client, domain, from, to, logger = null }) {
  const seen = new Set();
  const rows = [];
  let windows = 0;
  let cappedWindows = 0;

  async function take(a, b, depth) {
    const batch = await requestWindow(client, a, b);
    windows += 1;
    if (batch.length >= ROW_CAP && depth < MAX_SPLIT_DEPTH && a !== b) {
      const span = daysBetween(a, b);
      const mid = addDays(a, Math.max(0, Math.floor(span / 2)));
      await take(a, mid, depth + 1);
      await take(addDays(mid, 1), b, depth + 1);
      return;
    }
    // A single DAY at the cap cannot be split further — report it rather
    // than pretending the day is complete.
    if (batch.length >= ROW_CAP) cappedWindows += 1;
    for (const r of batch) {
      const key = `${r.CaseID}|${r.ActivitySubject}|${r.Created}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }
  }

  await take(from, to, 0);
  if (windows > 1) {
    logger?.info?.(`[${domain}] cap-split into ${windows} window(s)`);
  }
  return { rows, windows, cappedWindows };
}

/**
 * Pull the whole range's activity per domain, splitting only when the cap
 * forces it. Rows carry their own Created timestamp, so a range pull is
 * indistinguishable from concatenated day pulls.
 */
async function gatherActivityRange({
  from, to, domains = ["TAG", "WYNN", "AMITY"], logger = null, session = null,
} = {}) {
  const out = {
    rows: 0, byDomain: {}, events: [], moneyCases: new Map(),
    errors: [], truncated: false,
  };
  for (const domain of domains) {
    try {
      const client = createLogicsClient(domain);
      // One pull per (domain, window) per report — a session makes the
      // second consumer free instead of doubling the API cost.
      const rows = session
        ? await session.fetch("activity", { domain, from, to },
          async () => (await pullDomainRows({ client, domain, from, to, logger })).rows)
        : null;
      const pulled = rows
        ? { rows, windows: 1, cappedWindows: 0, fromCache: true }
        : await pullDomainRows({ client, domain, from, to, logger });
      // dateKey is per-ROW here (the range spans many days), so the parser is
      // handed the range label and each event keeps its own Created stamp.
      const parsed = parseReportRows(pulled.rows, { domain, dateKey: from });
      out.rows += parsed.stats.rows;
      out.byDomain[domain] = {
        rows: parsed.stats.rows,
        staffCases: parsed.staffCases.size,
        windows: pulled.windows,
        cappedWindows: pulled.cappedWindows,
      };
      out.events.push(...parsed.events);
      out.moneyCases.set(domain, parsed.moneyCases);
      if (pulled.cappedWindows) {
        out.truncated = true;
        out.errors.push(`${domain}: ${pulled.cappedWindows} single-day window(s) still at the ${ROW_CAP} cap — data incomplete`);
        logger?.warn?.("live_gather.still_capped", { domain, cappedWindows: pulled.cappedWindows });
      }
      logger?.info?.(`[${domain}] ${parsed.stats.rows} rows · ${parsed.moneyCases.size} cases to confirm`);
    } catch (error) {
      out.errors.push(`${domain}: ${String(error.message).slice(0, 140)}`);
      logger?.warn?.("live_gather.activity_failed", { domain, error: String(error.message).slice(0, 160) });
    }
  }
  return out;
}

/**
 * Confirm money for every case that moved in the range. This is the only
 * expensive part, and it scales with CASES TOUCHED, not with days.
 */
async function gatherPaymentsForCases({ moneyCases, from, to, concurrency = 3, logger = null }) {
  const truths = [];
  const unconfirmed = [];
  for (const [domain, caseIds] of moneyCases.entries()) {
    if (!caseIds || !caseIds.size) continue;
    const client = createLogicsClient(domain);
    const loop = await runMoneyLoop({
      domain, caseIds, client, dateKey: to, concurrency, logger,
    });
    truths.push(...loop.truths);
    unconfirmed.push(...loop.unconfirmed.map((u) => ({ domain, ...u })));
  }
  // Keep only payments whose ACCOUNTING date falls in the window — a case
  // touched today may have paid months ago, and its full history came back.
  const inRange = truths.filter((t) => t.paymentDateKey >= from && t.paymentDateKey <= to);
  return { truths: inRange, allTruths: truths, unconfirmed };
}

/**
 * The whole live gather for a range: activity + confirmed money.
 * Attribution (officer/source) is resolved by the caller, because that is
 * the part with a stored-history exception.
 */
async function gatherRange({
  from, to, domains = ["TAG", "WYNN", "AMITY"], concurrency = 3, logger = null, session = null,
} = {}) {
  const started = Date.now();
  const activity = await gatherActivityRange({ from, to, domains, logger, session });
  const money = await gatherPaymentsForCases({
    moneyCases: activity.moneyCases, from, to, concurrency, logger,
  });

  const totalCases = [...activity.moneyCases.values()].reduce((s, set) => s + set.size, 0);
  const confirmed = money.truths.filter((t) => t.transactionStatus === "SUCCESS" && !t.isChargeback);

  return {
    from, to, domains,
    activity: { rows: activity.rows, byDomain: activity.byDomain, events: activity.events },
    payments: money.truths,
    allPayments: money.allTruths,
    unconfirmed: money.unconfirmed,
    errors: activity.errors,
    truncated: Boolean(activity.truncated),
    totals: {
      casesConfirmed: totalCases,
      payments: confirmed.length,
      cash: round2(confirmed.reduce((s, t) => s + t.amount, 0)),
      deals: confirmed.filter((t) => t.paymentType === "initial").length,
    },
    gatheredAt: new Date(),
    durationMs: Date.now() - started,
    source: "live",
  };
}

module.exports = {
  ROW_CAP,
  addDays,
  fmtLogicsDate,
  gatherActivityRange,
  gatherPaymentsForCases,
  gatherRange,
  mapLimit,
  pullDomainRows,
};
