"use strict";

// THE REPORTING LAYER — named reports over any date range, on demand.
//
// Mickey 2026-07-28: "i just want you to focus on reporting. getting
// everything organized so that at any given time if i want to generate a
// report about settlement officer performance i can, if i want to do source
// metrics i can, if i want to provide recordings i can."
//
// ── LIVE BY DEFAULT ─────────────────────────────────────────────────────
// Mickey 2026-07-28: "we are just a face plate and a tool to make gathering
// info from the services we use easier now, not an aggregator of stats."
//
// So reports GATHER from the authoritative service on every run. The
// ActivityReport is range-native (one call per domain for any window) and
// per-case billing is ~364ms, which measures out at ~30s for five days and
// ~3min for a month. Fast enough that keeping a parallel copy buys nothing
// but drift.
//
// `--cached` reads the nightly persistence instead, for instant repeats.
// It is a CACHE, rebuildable at will, and never the reason a number is
// believed. Cached reports carry `coverage` so a thin answer is visible.
//
// ── EVENTS vs STATE (Mickey 2026-07-28) ─────────────────────────────────
// "the key thing is stale data in our system ... call stats for a day,
// recordings for a day, spend for a day can get saved and rebuilt from our
// mongo, but certain things should get pulled as a starting point in case
// theres divergence and change. things like status, total payments etc
// change in a way we shouldnt track."
//
// So there are two kinds of data and only one of them belongs in here:
//
//   EVENTS — something that HAPPENED on a day. A payment was taken. A
//   status changed. A call came in. Money was spent. These are immutable
//   once observed, safe to persist, and safe to aggregate over a range.
//   Every report in this file is event-based.
//
//   STATE — what is TRUE RIGHT NOW. Current case status, current balance,
//   total paid to date, who the case is assigned to today. These change
//   underneath us and a stored copy silently rots. NEVER report these from
//   Mongo — pull them fresh at the moment of asking.
//
// The tell: if the answer could change without any new event occurring,
// it is state, and it does not live here. `billingContext` on PaymentTruth
// is a deliberate exception — it is stored as an AS-OF snapshot for audit
// ("what did Logics say when we recorded this?"), never as a current
// balance. Anything reporting live balances must re-pull.

const { PaymentTruth, ActivityEvent, DailyLoopRun } = require("../../shared-models/src");
const SpendEntry = require("../../shared-models/src/SpendEntry");
const DailyCallStat = require("../../shared-models/src/DailyCallStat");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function normalizeRange({ from, to } = {}) {
  const f = String(from || "").slice(0, 10);
  const t = String(to || from || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    throw new Error("report range requires from/to as YYYY-MM-DD");
  }
  return f <= t ? { from: f, to: t } : { from: t, to: f };
}

/** Which days in the range actually have persisted facts. A report over a
 * range the pass never covered should say so, not return a confident zero. */
async function readCoverage({ from, to }) {
  const [runs, paymentDays] = await Promise.all([
    DailyLoopRun.find({ dateKey: { $gte: from, $lte: to } })
      .select("dateKey dayDocCompletedAt activityPassAt").lean(),
    PaymentTruth.distinct("detectedDateKey", { detectedDateKey: { $gte: from, $lte: to } }),
  ]);
  const complete = runs.filter((r) => r.dayDocCompletedAt).map((r) => r.dateKey).sort();
  const expected = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    expected.push(d.toISOString().slice(0, 10));
  }
  const withFacts = new Set([...complete, ...paymentDays.filter(Boolean)]);
  return {
    from, to,
    daysInRange: expected.length,
    daysWithFacts: withFacts.size,
    missingDays: expected.filter((d) => !withFacts.has(d)),
    complete: withFacts.size === expected.length,
  };
}

/**
 * SETTLEMENT OFFICER PERFORMANCE.
 * Money is cash-basis off PaymentTruth; the officer comes from the snapshot
 * taken when the deal landed (officerAtSale), NOT from whoever holds the
 * case now — a reassignment months later must not rewrite history.
 */
/**
 * Payment rows for a range, from whichever source the caller asked for.
 * LIVE gathers from Logics (authoritative); CACHED reads the nightly
 * persistence. Both yield the same row shape so every report below is
 * source-agnostic.
 */
async function readPayments({ range, domain = null, live = true, logger = null }) {
  if (live) {
    const { gatherRange } = require("./liveGatherService");
    const domains = domain ? [String(domain).toUpperCase()] : ["TAG", "WYNN", "AMITY"];
    const g = await gatherRange({ from: range.from, to: range.to, domains, logger });
    return {
      rows: g.payments.filter((t) => t.supersededAt == null),
      source: "live",
      gathered: {
        activityRows: g.activity.rows, casesConfirmed: g.totals.casesConfirmed,
        durationMs: g.durationMs, unconfirmed: g.unconfirmed.length, errors: g.errors,
      },
      // Attribution is a STORED exception: officer/source as they were AT
      // SALE. A live pull reproduces today's assignment, not July's, so
      // enrich live rows from the snapshot where we have one.
      needsAttributionEnrichment: true,
    };
  }
  const filter = {
    paymentDateKey: { $gte: range.from, $lte: range.to },
    transactionStatus: "SUCCESS",
    supersededAt: null,
  };
  if (domain) filter.domain = String(domain).toUpperCase();
  const rows = await PaymentTruth.find(filter).lean();
  return { rows, source: "cached", gathered: null, needsAttributionEnrichment: false };
}

/** Fill officerAtSale/sourceAtSale on live rows from the stored snapshot —
 * the one fact a re-pull genuinely cannot reconstruct. */
async function enrichAttribution(rows = []) {
  const ids = rows.map((r) => r.casePaymentId).filter(Boolean);
  if (!ids.length) return rows;
  const stored = await PaymentTruth.find({ casePaymentId: { $in: ids } })
    .select("domain casePaymentId officerAtSale sourceAtSale clientName").lean().catch(() => []);
  const byId = new Map(stored.map((s) => [`${s.domain}:${s.casePaymentId}`, s]));
  return rows.map((r) => {
    const snap = byId.get(`${r.domain}:${r.casePaymentId}`);
    // "no officer on the snapshot" and "no snapshot at all" are different
    // facts. Collapsing them prints "(unassigned)" over money that simply
    // was not looked up yet, which reads as a management problem that is
    // really a coverage gap. Mark which one it is.
    if (!snap) return { ...r, attributionSnapshot: "missing" };
    return {
      ...r,
      attributionSnapshot: "found",
      officerAtSale: r.officerAtSale || snap.officerAtSale || null,
      sourceAtSale: r.sourceAtSale || snap.sourceAtSale || null,
      clientName: r.clientName || snap.clientName || null,
    };
  });
}

async function reportOfficerPerformance({ from, to, domain = null, live = true, logger = null } = {}) {
  const range = normalizeRange({ from, to });
  const read = await readPayments({ range, domain, live, logger });
  const rows = read.needsAttributionEnrichment ? await enrichAttribution(read.rows) : read.rows;

  const byOfficer = new Map();
  const bucket = (name) => {
    const key = name || "(unassigned)";
    if (!byOfficer.has(key)) {
      byOfficer.set(key, {
        officer: key, deals: 0, initialCash: 0, recurringCash: 0,
        totalCash: 0, chargebacks: 0, chargebackAmount: 0, cases: new Set(),
      });
    }
    return byOfficer.get(key);
  };

  for (const r of rows) {
    const b = bucket(r.officerAtSale);
    b.cases.add(`${r.domain}:${r.caseId}`);
    if (r.isChargeback) {
      b.chargebacks += 1;
      b.chargebackAmount = round2(b.chargebackAmount + Math.abs(r.amount));
      continue;
    }
    b.totalCash = round2(b.totalCash + r.amount);
    if (r.paymentType === "initial") { b.deals += 1; b.initialCash = round2(b.initialCash + r.amount); }
    else b.recurringCash = round2(b.recurringCash + r.amount);
  }

  const officers = [...byOfficer.values()]
    .map((b) => ({ ...b, cases: b.cases.size, avgDeal: b.deals ? round2(b.initialCash / b.deals) : null }))
    .sort((a, b) => b.totalCash - a.totalCash);

  return {
    report: "officer-performance", ...range, domain: domain || "ALL",
    officers,
    totals: {
      deals: officers.reduce((s, o) => s + o.deals, 0),
      cash: round2(officers.reduce((s, o) => s + o.totalCash, 0)),
      chargebacks: officers.reduce((s, o) => s + o.chargebacks, 0),
    },
    source: read.source,
    gathered: read.gathered,
    coverage: read.source === "cached" ? await readCoverage(range) : null,
  };
}

/**
 * SOURCE METRICS. Deals and cash by the source pinned at sale time.
 * Spend joins from the caller (SpendEntry / BCD) so this stays a pure
 * fact-read; the ROI roster lives in the board, not here — a source report
 * should be able to show everything when asked.
 */
async function reportSourceMetrics({ from, to, domain = null, live = true, logger = null } = {}) {
  const range = normalizeRange({ from, to });
  const read = await readPayments({ range, domain, live, logger });
  const all = read.needsAttributionEnrichment ? await enrichAttribution(read.rows) : read.rows;
  const rows = all.filter((r) => !r.isChargeback);

  const bySource = new Map();
  for (const r of rows) {
    const key = r.sourceAtSale || "(unsourced)";
    if (!bySource.has(key)) bySource.set(key, { source: key, deals: 0, initialCash: 0, recurringCash: 0, cases: new Set() });
    const b = bySource.get(key);
    b.cases.add(`${r.domain}:${r.caseId}`);
    if (r.paymentType === "initial") { b.deals += 1; b.initialCash = round2(b.initialCash + r.amount); }
    else b.recurringCash = round2(b.recurringCash + r.amount);
  }

  // Spend and calls are DAY-SCOPED FACTS already in Mongo, so a range joins
  // them without touching an API — this is what makes range ROI cheap.
  const [spendRows, callRows] = await Promise.all([
    SpendEntry.find({ date: { $gte: range.from, $lte: range.to }, active: { $ne: false } })
      .select("channel source spend cost pieces leadsReported").lean(),
    DailyCallStat.find({
      date: { $gte: range.from, $lte: range.to }, active: { $ne: false },
      $or: [{ syncSource: "callrail-direct" }, { channel: "bcd" }],
    }).select("piece channel totalCalls firstTimeCallers").lean(),
  ]);

  const bcdRate = Number(process.env.BCD_COST_PER_CALL) > 0 ? Number(process.env.BCD_COST_PER_CALL) : 4;
  const ensure = (key) => {
    if (!bySource.has(key)) bySource.set(key, { source: key, deals: 0, initialCash: 0, recurringCash: 0, cases: new Set() });
    const b = bySource.get(key);
    b.spend = b.spend || 0; b.responses = b.responses || 0; b.leads = b.leads || 0;
    return b;
  };
  for (const r of spendRows) {
    const b = ensure(r.source);
    b.spend = round2(b.spend + Number(r.spend || 0));
    b.leads += Number(r.leadsReported || 0);
  }
  for (const r of callRows) {
    if (r.channel === "bcd") {
      const b = ensure("BCD");
      b.responses += Number(r.totalCalls || 0);
      b.spend = round2(b.spend + Number(r.totalCalls || 0) * bcdRate);   // pay-per-call
      continue;
    }
    const b = ensure(r.piece);
    b.responses += Number(r.firstTimeCallers || 0);
  }

  const sources = [...bySource.values()].map((b) => {
    const spend = b.spend || 0;
    const totalCash = round2(b.initialCash + b.recurringCash);
    const denom = b.responses || b.leads || 0;
    return {
      ...b, cases: b.cases.size, spend, totalCash,
      responses: b.responses || 0, leads: b.leads || 0,
      costPer: denom > 0 && spend > 0 ? round2(spend / denom) : null,
      net: round2(totalCash - spend),
      roi: spend > 0 ? round2((totalCash - spend) / spend * 100) : null,
    };
  }).sort((a, b) => b.initialCash - a.initialCash || b.spend - a.spend);

  return {
    report: "source-metrics", ...range, domain: domain || "ALL",
    sources,
    totals: {
      deals: sources.reduce((s, x) => s + x.deals, 0),
      cash: round2(sources.reduce((s, x) => s + x.totalCash, 0)),
      spend: round2(sources.reduce((s, x) => s + x.spend, 0)),
      net: round2(sources.reduce((s, x) => s + x.net, 0)),
    },
    source: read.source,
    gathered: read.gathered,
    coverage: read.source === "cached" ? await readCoverage(range) : null,
  };
}

/**
 * DEALS. One row per initial payment, with everything needed to explain it.
 */
async function reportDeals({ from, to, domain = null, source = null, officer = null, live = true, logger = null } = {}) {
  const range = normalizeRange({ from, to });
  const read = await readPayments({ range, domain, live, logger });
  const enriched = read.needsAttributionEnrichment ? await enrichAttribution(read.rows) : read.rows;
  let deals = enriched.filter((r) => r.paymentType === "initial" && !r.isChargeback);
  if (source) deals = deals.filter((d) => d.sourceAtSale === source);
  if (officer) deals = deals.filter((d) => d.officerAtSale === officer);
  deals.sort((a, b) => String(a.paymentDateKey).localeCompare(b.paymentDateKey) || b.amount - a.amount);

  return {
    report: "deals", ...range, domain: domain || "ALL",
    deals,
    totals: { count: deals.length, amount: round2(deals.reduce((s, d) => s + d.amount, 0)) },
    source: read.source, gathered: read.gathered,
    coverage: read.source === "cached" ? await readCoverage(range) : null,
  };
}

/**
 * ACTIVITY / STATUS movement over a range — DNC, post-dates, suspensions,
 * conversions. Straight off the typed events.
 */
async function reportStatusMovement({ from, to, domain = null, live = true, logger = null } = {}) {
  const range = normalizeRange({ from, to });

  if (live) {
    // One activity call per domain covers the whole window — this report
    // never needs storage at all.
    const { gatherActivityRange } = require("./liveGatherService");
    const domains = domain ? [String(domain).toUpperCase()] : ["TAG", "WYNN", "AMITY"];
    const g = await gatherActivityRange({ from: range.from, to: range.to, domains, logger });
    const counts = { dnc: 0, postdate: 0, suspended: 0, otherStatus: 0, conversions: 0 };
    for (const e of g.events) {
      if (e.kind === "conversion") { counts.conversions += 1; continue; }
      if (e.kind !== "status-change" || e.payload?.selfTransition) continue;
      const cls = e.payload?.safetyClass;
      if (cls === "dnc") counts.dnc += 1;
      else if (cls === "postdate") counts.postdate += 1;
      else if (cls === "suspended") counts.suspended += 1;
      else counts.otherStatus += 1;
    }
    return {
      report: "status-movement", ...range, domain: domain || "ALL",
      counts, source: "live",
      gathered: { activityRows: g.rows, errors: g.errors }, coverage: null,
    };
  }

  const match = { dateKey: { $gte: range.from, $lte: range.to } };
  if (domain) match.domain = String(domain).toUpperCase();

  const rows = await ActivityEvent.aggregate([
    { $match: { ...match, kind: { $in: ["status-change", "conversion"] } } },
    {
      $group: {
        _id: { kind: "$kind", safety: "$payload.safetyClass" },
        n: { $sum: 1 },
        cases: { $addToSet: "$caseId" },
      },
    },
  ]);

  const out = { dnc: 0, postdate: 0, suspended: 0, otherStatus: 0, conversions: 0 };
  for (const r of rows) {
    if (r._id.kind === "conversion") { out.conversions += r.n; continue; }
    if (r._id.safety === "dnc") out.dnc += r.n;
    else if (r._id.safety === "postdate") out.postdate += r.n;
    else if (r._id.safety === "suspended") out.suspended += r.n;
    else out.otherStatus += r.n;
  }
  return { report: "status-movement", ...range, domain: domain || "ALL", counts: out, source: "cached", coverage: await readCoverage(range) };
}

/**
 * COHORT / VINTAGE — how much of this window's revenue comes from clients
 * who signed this year versus prior years.
 *
 * Mickey 2026-07-28: "2024 is irrelevant for metrics ... but as a baseline,
 * percentage of our revenue from cases created this year, last year, etc —
 * that's of value." This is company health, not marketing attribution:
 * SOURCING only matters where we are currently spending money, but the
 * back book's contribution to revenue matters regardless of where it came
 * from years ago.
 *
 * Free to compute: the money loop already pulls each case's FULL payment
 * history, so `metricsTreatment.firstPaidDateKey` — the day they became a
 * client — is on every row. No extra call, no stored history needed.
 */
async function reportCohort({ from, to, domain = null, live = true, logger = null } = {}) {
  const range = normalizeRange({ from, to });
  const read = await readPayments({ range, domain, live, logger });
  const rows = read.rows.filter((r) => !r.isChargeback);

  const byYear = new Map();
  const bucket = (year) => {
    const k = year || "(unknown)";
    if (!byYear.has(k)) byYear.set(k, { cohort: k, cash: 0, initialCash: 0, recurringCash: 0, payments: 0, cases: new Set() });
    return byYear.get(k);
  };

  for (const r of rows) {
    const first = r.metricsTreatment?.firstPaidDateKey || r.paymentDateKey;
    const b = bucket(String(first || "").slice(0, 4) || null);
    b.payments += 1;
    b.cash = round2(b.cash + r.amount);
    b.cases.add(`${r.domain}:${r.caseId}`);
    if (r.paymentType === "initial") b.initialCash = round2(b.initialCash + r.amount);
    else b.recurringCash = round2(b.recurringCash + r.amount);
  }

  const total = round2([...byYear.values()].reduce((s, b) => s + b.cash, 0));
  const cohorts = [...byYear.values()]
    .map((b) => ({
      ...b, cases: b.cases.size,
      pctOfRevenue: total > 0 ? Math.round((b.cash / total) * 1000) / 10 : null,
    }))
    .sort((a, b) => String(b.cohort).localeCompare(String(a.cohort)));

  return {
    report: "cohort", ...range, domain: domain || "ALL",
    cohorts,
    totals: { cash: total, payments: rows.length },
    source: read.source, gathered: read.gathered,
    coverage: read.source === "cached" ? await readCoverage(range) : null,
  };
}

/** The registry — what `generateReport` will answer to. */
const REPORTS = Object.freeze({
  "officer-performance": reportOfficerPerformance,
  "source-metrics": reportSourceMetrics,
  deals: reportDeals,
  "status-movement": reportStatusMovement,
  cohort: reportCohort,
});

async function generateReport(type, params = {}) {
  const fn = REPORTS[String(type)];
  if (!fn) throw new Error(`unknown report "${type}" — have: ${Object.keys(REPORTS).join(", ")}`);
  return fn(params);
}

/**
 * Reports that need CURRENT state (status, balances, assignment today)
 * must fetch it live — this is the seam that makes that explicit rather
 * than letting a stale snapshot pass for truth.
 *
 * `fetchLive` is injected so the reporting layer never imports the Logics
 * client directly; callers that cannot pull live get `null` and must render
 * the field as unavailable rather than substituting a stored value.
 */
async function withLiveState(rows = [], { fetchLive = null, key = "caseId" } = {}) {
  if (typeof fetchLive !== "function") {
    return rows.map((r) => ({ ...r, liveState: null, liveStateUnavailable: true }));
  }
  const out = [];
  for (const row of rows) {
    let liveState = null;
    try { liveState = await fetchLive(row[key], row.domain); } catch { liveState = null; }
    out.push({ ...row, liveState, liveStateUnavailable: liveState == null });
  }
  return out;
}

module.exports = {
  REPORTS,
  enrichAttribution,
  readPayments,
  withLiveState,
  generateReport,
  normalizeRange,
  readCoverage,
  reportCohort,
  reportDeals,
  reportOfficerPerformance,
  reportSourceMetrics,
  reportStatusMovement,
};
