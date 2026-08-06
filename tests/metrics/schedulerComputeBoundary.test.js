"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  normalizeBusinessWeekdays,
} = require("../../apps/control-plane/src/services/logicsActivityReviewRuntime");
const {
  normalizeActiveWeekdays: normalizeRecordingWeekdays,
} = require("../../apps/control-plane/src/services/eodRecordingArchiveRuntime");
const {
  normalizeActiveWeekdays: normalizeSpendWeekdays,
} = require("../../packages/shared-services/src/spendSyncService");
const DailyLoopRun = require("../../packages/shared-models/src/DailyLoopRun");

test("Logics review is fail-closed to Pacific weekdays", () => {
  assert.deepEqual(normalizeBusinessWeekdays(), [1, 2, 3, 4, 5]);
  assert.deepEqual(normalizeBusinessWeekdays([0, 1, 5, 6]), [1, 5]);
  assert.deepEqual(normalizeBusinessWeekdays([0, 6]), [1, 2, 3, 4, 5]);
});

test("recording and spend owners reject configured weekend days", () => {
  for (const normalize of [normalizeRecordingWeekdays, normalizeSpendWeekdays]) {
    assert.deepEqual(normalize(), [1, 2, 3, 4, 5]);
    assert.deepEqual(normalize([0, 1, 5, 6]), [1, 5]);
    assert.deepEqual(normalize([0, 6]), [1, 2, 3, 4, 5]);
  }
});

test("generic hourly stays hard-gated, and the cx recording owner is GONE", () => {
  const source = fs.readFileSync(require.resolve("../../apps/control-plane/src/server"), "utf8");
  assert.match(source, /const runScheduledPhase = false/);
  assert.match(source, /mode: "durable-retry-drain-only"/);
  assert.doesNotMatch(source, /workerState:\s*hourlySweepState,\s*spendSyncRuntime/);

  // The cx recording worker used to be pinned here as "hard-gated" by a
  // hardcoded `legacyHourlyRecordingOwnerEnabled = false`. It is deleted now,
  // so the assertion flips: a gated duplicate can be re-armed by editing one
  // word, and this repo has twice found a "dark" trigger that was not.
  // Matched against CODE, not prose: the tombstone comment left at the call
  // site names the deleted function on purpose, so a bare word match would
  // fail on the very comment that explains the deletion.
  assert.doesNotMatch(source, /const legacyHourlyRecordingOwnerEnabled/);
  assert.doesNotMatch(source, /async function startCxRecordingWorker/);
  assert.doesNotMatch(source, /await startCxRecordingWorker\(/);
  assert.doesNotMatch(source, /cxRecordingState\./);
  assert.doesNotMatch(source, /runCxRecordingHourly\(/,
    "the service survives for the admin route and the backfill scripts, but nothing in server.js calls it");
});

test("nightly close cannot invoke duplicate spend or full hourly discovery when scheduled", () => {
  const source = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/nightlyCloseService"),
    "utf8",
  );
  assert.match(source, /options\.scheduled !== true[\s\S]*allowLegacySpendSync/);
  assert.match(source, /reason: "dedicated-scheduled-owner"/);
  assert.match(source, /reason: "retired-from-nightly-close"/);
});

test("nightly hygiene has a durable claim and completion schema", () => {
  assert.ok(DailyLoopRun.schema.path("nightlyHygieneClaimedAt"));
  assert.ok(DailyLoopRun.schema.path("nightlyHygieneCompletedAt"));
  assert.ok(DailyLoopRun.schema.path("nightlyHygieneNextTaskIndex"));
  assert.ok(DailyLoopRun.schema.path("nightlyHygieneCounts"));
  assert.ok(DailyLoopRun.schema.path("nightlyHygieneLastErrorCode"));
});

test("index promotion is additive and narrowly named", () => {
  const { INDEXES } = require("../../scripts/ensure-lead-delivery-compute-indexes");
  assert.deepEqual(INDEXES.map((definition) => definition.options.name), [
    "lead_cadence_active_delivery_cursor",
    "lead_delivery_event_pending_recovery",
    "lead_delivery_event_failed_recovery",
    "lead_delivery_event_processing_recovery",
  ]);
  const source = fs.readFileSync(
    require.resolve("../../scripts/ensure-lead-delivery-compute-indexes"),
    "utf8",
  );
  assert.doesNotMatch(source, /syncIndexes\s*\(|dropIndex\s*\(|deleteMany\s*\(/);
});

test("index proof reports only count and plan metadata", () => {
  const {
    groupExactPairs, sameKey, summarizeExplain,
  } = require("../../scripts/verify-lead-delivery-compute-indexes");
  assert.equal(sameKey({ domain: 1, caseId: 1 }, { domain: 1, caseId: 1 }), true);
  assert.deepEqual(groupExactPairs([
    { domain: "TAG", caseId: 1 },
    { domain: "TAG", caseId: 2 },
    { domain: "WYNN", caseId: 1 },
  ]), [
    { domain: "TAG", caseId: { $in: [1, 2] } },
    { domain: "WYNN", caseId: { $in: [1] } },
  ]);
  assert.deepEqual(summarizeExplain({
    queryPlanner: { winningPlan: { stage: "FETCH", inputStage: { stage: "IXSCAN", indexName: "safe" } } },
    executionStats: { totalKeysExamined: 4, totalDocsExamined: 3, nReturned: 2 },
  }), {
    winningStage: "FETCH",
    blockingSort: false,
    collectionScan: false,
    indexNames: ["safe"],
    keysExamined: 4,
    documentsExamined: 3,
    returned: 2,
  });
  const source = fs.readFileSync(
    require.resolve("../../scripts/verify-lead-delivery-compute-indexes"), "utf8",
  );
  assert.doesNotMatch(source, /console\.log|\.env|MONGO_URI|mongodb\+srv/);
});
