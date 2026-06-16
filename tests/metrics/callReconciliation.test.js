"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  monthToDateRange,
  runNightlyCallReconciliation,
} = require("../../packages/shared-services/src/callMetricsReconciliationService");

const NOW = new Date("2026-06-16T18:00:00Z"); // PT 2026-06-16

test("monthToDateRange: PT first-of-month → today", () => {
  assert.deepEqual(monthToDateRange(NOW), { fromKey: "2026-06-01", toKey: "2026-06-16" });
});

test("runNightlyCallReconciliation: computes the range, runs buildReport then saveReport (unchanged compute)", async () => {
  const calls = { build: [], save: [] };
  const fakeReport = {
    range: { fromKey: "2026-06-01", toKey: "2026-06-16" },
    cxOutbound: { totalsAgainstActiveGeneratedLeads: { cxAttempts: 10442 } },
    deals: { initialDealCount: 32 },
  };
  const deps = {
    recon: {
      DEFAULT_TIMEZONE: "America/Los_Angeles",
      buildReport: async (args) => { calls.build.push(args); return fakeReport; },
      saveReport: async (report) => { calls.save.push(report); return { _id: "abc123" }; },
    },
  };
  const out = await runNightlyCallReconciliation({ now: NOW, deps });
  assert.equal(out.ok, true);
  assert.equal(out.fromKey, "2026-06-01");
  assert.equal(out.toKey, "2026-06-16");
  assert.equal(out.savedId, "abc123");
  assert.equal(calls.build.length, 1);
  assert.deepEqual(calls.build[0], { fromKey: "2026-06-01", toKey: "2026-06-16", timeZone: "America/Los_Angeles" });
  assert.equal(calls.save.length, 1, "persists exactly once");
  assert.equal(calls.save[0], fakeReport);
});

test("runNightlyCallReconciliation: tolerates the findOneAndUpdate {value:{_id}} wrapper", async () => {
  const deps = {
    recon: {
      DEFAULT_TIMEZONE: "America/Los_Angeles",
      buildReport: async () => ({ range: { fromKey: "2026-06-01", toKey: "2026-06-16" } }),
      saveReport: async () => ({ value: { _id: "wrapped" } }),
    },
  };
  const out = await runNightlyCallReconciliation({ now: NOW, deps });
  assert.equal(out.savedId, "wrapped");
});
