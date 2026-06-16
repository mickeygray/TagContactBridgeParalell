"use strict";

// callMetricsReconciliationService — run the honest call-totals reconciliation
// NIGHTLY against the already-open mongoose connection, so the nightly close
// produces the accurate version (CX outbound lead work + status-aware deals)
// instead of the understated DailyCallStat view. It reuses the SAME proven
// computation as scripts/reconcile-monthly-call-totals.js (buildReport/saveReport,
// unchanged) — we only call it; we don't re-implement it. The freeze layer
// (metricCloseService) then snapshots the fresh doc immutably.
//
// FOLLOW-UP (architectural smell, intentional for this pass): a shared-service
// requiring a script is backwards. The clean end-state relocates buildReport's
// pure compute into this service; until then we expose-and-call to avoid
// re-transcribing ~600 lines we cannot verify against a live DB here.
//
// deps are injectable so the orchestration is unit-testable with fakes.

function currentDateKeyPT(now = new Date()) {
  const when = now instanceof Date ? now : new Date(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

// Month-to-date PT window: first of the current month -> today (the same range
// the one-off runs for the live month).
function monthToDateRange(now = new Date()) {
  const toKey = currentDateKeyPT(now);
  const fromKey = `${toKey.slice(0, 7)}-01`;
  return { fromKey, toKey };
}

function extractSavedId(saved) {
  if (!saved) return null;
  const id = saved._id || (saved.value && saved.value._id) || null;
  return id ? String(id) : null;
}

async function runNightlyCallReconciliation({ now = new Date(), timeZone = null, logger = null, deps = {} } = {}) {
  const recon = deps.recon || require("../../../scripts/reconcile-monthly-call-totals");
  const { fromKey, toKey } = monthToDateRange(now);
  const tz = timeZone || recon.DEFAULT_TIMEZONE || "America/Los_Angeles";

  const report = await recon.buildReport({ fromKey, toKey, timeZone: tz });
  const saved = await recon.saveReport(report);
  const savedId = extractSavedId(saved);

  logger?.info?.("call_reconciliation.nightly", {
    fromKey,
    toKey,
    savedId,
    cxAttempts: report?.cxOutbound?.totalsAgainstActiveGeneratedLeads?.cxAttempts ?? null,
    initialDealCount: report?.deals?.initialDealCount ?? null,
  });

  return { ok: true, fromKey, toKey, savedId };
}

module.exports = {
  monthToDateRange,
  runNightlyCallReconciliation,
};
