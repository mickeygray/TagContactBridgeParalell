"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  monthKeyOf,
  currentMonthKey,
  priorMonthKey,
  isPeriodFinal,
  buildCloseRecord,
  runMetricCloseFreeze,
} = require("../../packages/shared-services/src/metricCloseService");

const NOW_JUNE = new Date("2026-06-16T18:00:00Z"); // PT 2026-06-16
const NOW_JULY = new Date("2026-07-02T18:00:00Z"); // PT 2026-07-02

const DOC = {
  kind: "monthly-call-honesty",
  version: 1,
  range: { fromKey: "2026-06-01", toKey: "2026-06-16", timeZone: "America/Los_Angeles" },
  cxOutbound: {
    softDedupedAttempts: 16783,
    attemptsAgainstActiveGeneratedLeads: 10442,
    totalsAgainstActiveGeneratedLeads: {
      cxAttempts: 10442, cxOver2: 75, cxOver5: 23, generatedLeadsDialed: 3250, leadsGeneratedActive: 3371,
    },
    bySource: [{ source: "LD CUSTOM", cxAttempts: 4396 }],
  },
  mailerResponses: { totals: { calls: 747, over2: 402, over5: 311 } },
  deals: { initialDealCount: 32, initialAmount: 37226.47, totalCollected: 331747.66 },
};

// ── period helpers ────────────────────────────────────────────────────────────
test("monthKeyOf / currentMonthKey (PT) / isPeriodFinal", () => {
  assert.equal(monthKeyOf("2026-06-16"), "2026-06");
  assert.equal(currentMonthKey(NOW_JUNE), "2026-06");
  assert.equal(currentMonthKey(NOW_JULY), "2026-07");
  assert.equal(isPeriodFinal("2026-06", NOW_JUNE), false); // live month
  assert.equal(isPeriodFinal("2026-05", NOW_JUNE), true); // prior month is frozen
  assert.equal(isPeriodFinal("2026-06", NOW_JULY), true); // June is final once it's July
});

// ── buildCloseRecord (pure) ───────────────────────────────────────────────────
test("buildCloseRecord: live month snapshot with extracted headline totals", () => {
  const rec = buildCloseRecord({ reconciliationDoc: DOC, now: NOW_JUNE });
  assert.equal(rec.scope, "all");
  assert.equal(rec.grain, "month");
  assert.equal(rec.periodKey, "2026-06");
  assert.equal(rec.asOfDateKey, "2026-06-16");
  assert.equal(rec.status, "live");
  assert.equal(rec.totals.cxAttempts, 10442);
  assert.equal(rec.totals.cxOver5, 23);
  assert.equal(rec.totals.generatedLeadsDialed, 3250);
  assert.equal(rec.totals.mailerCalls, 747);
  assert.equal(rec.totals.initialDealCount, 32);
  assert.equal(rec.totals.totalCollected, 331747.66);
  assert.ok(rec.snapshot.cxOutbound, "full payload is snapshot immutably");
  assert.equal(rec.recordedAt.getTime(), NOW_JUNE.getTime());
});

test("buildCloseRecord: a closed (prior) month is marked final", () => {
  assert.equal(buildCloseRecord({ reconciliationDoc: DOC, now: NOW_JULY }).status, "final");
});

test("buildCloseRecord: missing doc / range returns null (never throws)", () => {
  assert.equal(buildCloseRecord({ reconciliationDoc: null }), null);
  assert.equal(buildCloseRecord({ reconciliationDoc: {} }), null);
  assert.equal(buildCloseRecord({ reconciliationDoc: { range: {} } }), null);
});

test("buildCloseRecord: tolerates a partial reconciliation shape (0-fills)", () => {
  const rec = buildCloseRecord({ reconciliationDoc: { range: { fromKey: "2026-06-01", toKey: "2026-06-10" } }, now: NOW_JUNE });
  assert.equal(rec.totals.cxAttempts, 0);
  assert.equal(rec.totals.initialDealCount, 0);
  assert.equal(rec.periodKey, "2026-06");
});

// ── runMetricCloseFreeze (orchestrator, injected fakes) ───────────────────────
test("priorMonthKey: handles month + year rollover", () => {
  assert.equal(priorMonthKey(NOW_JUNE), "2026-05");
  assert.equal(priorMonthKey(new Date("2026-01-15T18:00:00Z")), "2025-12");
});

test("runMetricCloseFreeze: snapshots current month (live) AND finalizes the prior month", async () => {
  const calls = { find: [], freeze: [], final: [] };
  const deps = {
    findReconciliation: async (q) => {
      calls.find.push(q.periodKey);
      return q.periodKey === "2026-06" ? DOC : { ...DOC, range: { fromKey: "2026-05-01", toKey: "2026-05-31" } };
    },
    freezeClose: async (record) => { calls.freeze.push(record); return { frozen: true }; },
    findFinalClose: async (s, g, p) => { calls.final.push(p); return null; }, // prior NOT yet final
  };
  const out = await runMetricCloseFreeze({ now: NOW_JUNE, deps });
  assert.equal(out.current.periodKey, "2026-06");
  assert.equal(out.current.status, "live");
  assert.equal(out.prior.periodKey, "2026-05");
  assert.equal(out.prior.status, "final");
  assert.deepEqual(calls.find, ["2026-06", "2026-05"]);
  assert.equal(calls.freeze.length, 2);
  assert.equal(calls.final[0], "2026-05");
});

test("runMetricCloseFreeze: skips the prior month once it's already final (no recon lookup)", async () => {
  const calls = { find: [] };
  const deps = {
    findReconciliation: async (q) => { calls.find.push(q.periodKey); return DOC; },
    freezeClose: async () => ({ frozen: true }),
    findFinalClose: async () => ({ status: "final" }),
  };
  const out = await runMetricCloseFreeze({ now: NOW_JUNE, deps });
  assert.equal(out.prior.skipped, true);
  assert.equal(out.prior.reason, "already-final");
  assert.deepEqual(calls.find, ["2026-06"], "prior reconciliation is not re-fetched when already final");
});

test("runMetricCloseFreeze: no current-month doc → current skipped", async () => {
  const deps = {
    findReconciliation: async () => null,
    freezeClose: async () => ({ frozen: true }),
    findFinalClose: async () => ({ status: "final" }),
  };
  const out = await runMetricCloseFreeze({ now: NOW_JUNE, deps });
  assert.equal(out.current.skipped, true);
  assert.equal(out.current.reason, "no-reconciliation-doc");
});
