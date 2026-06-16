"use strict";

// metricCloseService — Stab 1 (Freeze) of the anti-drift architecture
// (docs/CALL_TOTALS_RECONCILIATION_PLAN.md). Snapshots the cross-tenant
// reconciliation doc (controlplanemetriccallreconciliations) into an IMMUTABLE
// MetricClose row per as-of date. The pure builder is unit-tested; the I/O
// (read doc + freeze) is a thin injectable orchestrator so the nightly hook
// stays best-effort and can never break the close.

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// "2026-06-16" -> "2026-06"
function monthKeyOf(dateKey) {
  return String(dateKey || "").slice(0, 7);
}

// Current PT calendar date / month — the basis for deciding a period is closed.
function currentDateKeyPT(now = new Date()) {
  const when = now instanceof Date ? now : new Date(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

function currentMonthKey(now = new Date()) {
  return currentDateKeyPT(now).slice(0, 7);
}

// A month period is FINAL once we're in a later month (PT). The live month can
// still drift; everything before it is frozen.
function isPeriodFinal(periodKey, now = new Date()) {
  return String(periodKey) < currentMonthKey(now);
}

// Pure: a reconciliation doc -> the immutable close record. No DB, deterministic
// given (doc, now). Defensive extraction so we never throw on a shape change.
function buildCloseRecord({ reconciliationDoc = null, now = new Date(), scope = "all" } = {}) {
  if (!reconciliationDoc || !reconciliationDoc.range || !reconciliationDoc.range.fromKey) {
    return null;
  }
  const periodKey = monthKeyOf(reconciliationDoc.range.fromKey);
  const asOfDateKey = String(reconciliationDoc.range.toKey || reconciliationDoc.range.fromKey);
  const cx = reconciliationDoc.cxOutbound || {};
  const cxTotals = cx.totalsAgainstActiveGeneratedLeads || {};
  const mailer = (reconciliationDoc.mailerResponses && reconciliationDoc.mailerResponses.totals) || {};
  const deals = reconciliationDoc.deals || {};

  return {
    scope,
    grain: "month",
    periodKey,
    asOfDateKey,
    status: isPeriodFinal(periodKey, now) ? "final" : "live",
    kind: reconciliationDoc.kind || "monthly-call-honesty",
    sourceVersion: num(reconciliationDoc.version) || 1,
    range: reconciliationDoc.range,
    recordedAt: now instanceof Date ? now : new Date(now),
    totals: {
      softDedupedCxAttempts: num(cx.softDedupedAttempts),
      attemptsAgainstActiveGeneratedLeads: num(cx.attemptsAgainstActiveGeneratedLeads),
      cxAttempts: num(cxTotals.cxAttempts),
      cxOver2: num(cxTotals.cxOver2),
      cxOver5: num(cxTotals.cxOver5),
      generatedLeadsDialed: num(cxTotals.generatedLeadsDialed),
      leadsGeneratedActive: num(cxTotals.leadsGeneratedActive),
      mailerCalls: num(mailer.calls),
      initialDealCount: num(deals.initialDealCount),
      initialAmount: num(deals.initialAmount),
      totalCollected: num(deals.totalCollected),
    },
    snapshot: {
      cxOutbound: reconciliationDoc.cxOutbound || null,
      mailerResponses: reconciliationDoc.mailerResponses || null,
      deals: reconciliationDoc.deals || null,
    },
  };
}

// "2026-07" -> "2026-06" (handles year rollover).
function priorMonthKey(now = new Date()) {
  const [y, m] = currentMonthKey(now).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// Read a period's reconciliation doc, build the close record, freeze it (write-once).
async function freezePeriod({ periodKey, now, scope, findReconciliation, freeze, logger }) {
  const doc = await findReconciliation({ periodKey, now });
  if (!doc) return { skipped: true, reason: "no-reconciliation-doc", periodKey };
  const record = buildCloseRecord({ reconciliationDoc: doc, now, scope });
  if (!record) return { skipped: true, reason: "unparseable-reconciliation", periodKey };
  const result = await freeze(record);
  logger?.info?.("metric_close.freeze", {
    periodKey: record.periodKey,
    asOfDateKey: record.asOfDateKey,
    status: record.status,
    frozen: Boolean(result?.frozen),
    skippedReason: result?.reason || null,
  });
  return { ...result, periodKey: record.periodKey, asOfDateKey: record.asOfDateKey, status: record.status };
}

// Best-effort orchestrator: (1) snapshot the CURRENT month (a live as-of row), and
// (2) FINALIZE the prior month once on rollover — without (2) the prior month would
// never get its immutable `final` close. deps are injectable for unit testing.
async function runMetricCloseFreeze({ now = new Date(), scope = "all", logger = null, deps = {} } = {}) {
  const repo = () => require("../../shared-repositories/src/metricCloseRepository");
  const findReconciliation = deps.findReconciliation || ((a) => repo().findCurrentMonthReconciliation(a));
  const freeze = deps.freezeClose || ((r) => repo().freezeClose(r));
  const findFinal = deps.findFinalClose || ((s, g, p) => repo().findFinalClose(s, g, p));

  const current = await freezePeriod({ periodKey: currentMonthKey(now), now, scope, findReconciliation, freeze, logger });

  const priorKey = priorMonthKey(now);
  const existingFinal = await findFinal(scope, "month", priorKey);
  const prior = existingFinal
    ? { skipped: true, reason: "already-final", periodKey: priorKey }
    : await freezePeriod({ periodKey: priorKey, now, scope, findReconciliation, freeze, logger });

  return { current, prior };
}

module.exports = {
  monthKeyOf,
  currentMonthKey,
  priorMonthKey,
  isPeriodFinal,
  buildCloseRecord,
  runMetricCloseFreeze,
};
