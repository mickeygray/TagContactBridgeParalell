"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { SpendEntry, PaymentLedger, DailyCallStat, MetricsSnapshot } = require("../../packages/shared-models/src");
const spendEntryRepository = require("../../packages/shared-repositories/src/spendEntryRepository");
const sourceCanonicalRepository = require("../../packages/shared-repositories/src/sourceCanonicalRepository");
const marketingMoneyService = require("../../packages/shared-services/src/marketingMoneyService");
const { listManualMetricSourceRows } = require("../../packages/shared-services/src/metricsManualOverlayService");
const { refreshMetricsSnapshotsForDate } = require("../../packages/shared-services/src/metricsBackfillService");

test("spend entry key is stable and changes with the source identity", () => {
  const base = { date: "2026-07-17", domain: "tag", channel: "mailer", sheetId: "sheet-a", jobNumber: "123" };
  assert.equal(spendEntryRepository.buildSpendEntryKey(base), spendEntryRepository.buildSpendEntryKey({ ...base, domain: "TAG" }));
  assert.notEqual(spendEntryRepository.buildSpendEntryKey(base), spendEntryRepository.buildSpendEntryKey({ ...base, jobNumber: "124" }));
});

test("sheet reconciliation activates current rows and retires rows missing from the new source image", async () => {
  const originalBulkWrite = SpendEntry.bulkWrite;
  const originalUpdateMany = SpendEntry.updateMany;
  const seen = {};
  SpendEntry.bulkWrite = async (operations) => { seen.operations = operations; return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 }; };
  SpendEntry.updateMany = async (filter, update) => { seen.retireFilter = filter; seen.retireUpdate = update; return { modifiedCount: 2 }; };
  try {
    const result = await marketingMoneyService.reconcileSpendSheet({
      sheetId: "sheet-a",
      domain: "TAG",
      channel: "mailer",
      runId: "run-1",
      rows: [{ date: "2026-07-17", source: "Mail A", jobNumber: "123", spend: 50 }],
    });
    assert.equal(result.retiredCount, 2);
    assert.equal(seen.operations.length, 1);
    assert.equal(seen.operations[0].updateOne.update.$set.active, true);
    assert.equal(seen.retireFilter.reconciliationRunId.$ne, "run-1");
    assert.deepEqual(seen.retireUpdate.$set.active, false);
  } finally {
    SpendEntry.bulkWrite = originalBulkWrite;
    SpendEntry.updateMany = originalUpdateMany;
  }
});

test("empty sheet results fail closed instead of retiring all spend", async () => {
  await assert.rejects(
    marketingMoneyService.reconcileSpendSheet({ rows: [], sheetId: "sheet-a", domain: "TAG", channel: "mailer", runId: "empty" }),
    /refuses to retire/,
  );
});

test("payment observations cannot overwrite an existing reconciled money fact", async () => {
  const original = PaymentLedger.findOneAndUpdate;
  let captured = null;
  PaymentLedger.findOneAndUpdate = async (...args) => { captured = args; return {}; };
  try {
    await marketingMoneyService.observePayment(99, {
      domain: "TAG", caseId: 7, paymentDate: new Date(), paymentDateKey: "2026-07-17", amount: 100, transactionStatus: null,
    });
    const update = captured[1];
    assert.deepEqual(Object.keys(update.$set), ["lastObservedAt"]);
    assert.equal(update.$setOnInsert.authoritativeSource, "event-observation");
    assert.equal(update.$setOnInsert.transactionStatus, null);
  } finally {
    PaymentLedger.findOneAndUpdate = original;
  }
});

test("historical manual overlays can preserve lead counts but cannot add money", () => {
  const rows = listManualMetricSourceRows("TAG", { from: "2026-04-01", to: "2026-04-30" });
  assert.ok(rows.some((row) => row.leadsReported > 0));
  assert.ok(rows.every((row) => row.spend === 0));
});

test("metrics projections include active spend and successful payments only", async () => {
  const originals = {
    spendAggregate: SpendEntry.aggregate, paymentAggregate: PaymentLedger.aggregate,
    callAggregate: DailyCallStat.aggregate, snapshotUpdate: MetricsSnapshot.findOneAndUpdate,
    excluded: sourceCanonicalRepository.listPiecesAssignedToOtherDomains,
  };
  const spendPipelines = [];
  const paymentPipelines = [];
  SpendEntry.aggregate = async (pipeline) => { spendPipelines.push(pipeline); return []; };
  PaymentLedger.aggregate = async (pipeline) => { paymentPipelines.push(pipeline); return []; };
  DailyCallStat.aggregate = async () => [];
  MetricsSnapshot.findOneAndUpdate = async () => ({});
  sourceCanonicalRepository.listPiecesAssignedToOtherDomains = async () => [];
  try {
    await refreshMetricsSnapshotsForDate({ domain: "TAG", date: "2026-07-17" });
    assert.equal(spendPipelines.length, 2);
    assert.equal(paymentPipelines.length, 2);
    for (const pipeline of spendPipelines) assert.deepEqual(pipeline[0].$match.active, { $ne: false });
    for (const pipeline of paymentPipelines) assert.equal(pipeline[0].$match.transactionStatus, "SUCCESS");
  } finally {
    SpendEntry.aggregate = originals.spendAggregate; PaymentLedger.aggregate = originals.paymentAggregate;
    DailyCallStat.aggregate = originals.callAggregate; MetricsSnapshot.findOneAndUpdate = originals.snapshotUpdate;
    sourceCanonicalRepository.listPiecesAssignedToOtherDomains = originals.excluded;
  }
});
