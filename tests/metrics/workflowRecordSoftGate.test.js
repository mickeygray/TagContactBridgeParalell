"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWorkflowRecordSoftGate,
  shouldPersistWorkflowRecord,
} = require("../../packages/shared-services/src/workflowRecordPersistencePolicy");

test("dedupe-keyed workflow receipts always remain durable", () => {
  assert.equal(shouldPersistWorkflowRecord({
    family: "metrics",
    stage: "completed",
    dedupeKey: "nightly-ops:aged-refresh:2026-08-14",
  }, {}), true);
});

test("outbound preserves only stages with active same-day readers", () => {
  assert.equal(shouldPersistWorkflowRecord({ family: "outbound", stage: "completed" }, {}), true);
  assert.equal(shouldPersistWorkflowRecord({ family: "outbound", stage: "skipped" }, {}), true);
  assert.equal(shouldPersistWorkflowRecord({ family: "outbound", stage: "attempting" }, {}), false);
  assert.equal(shouldPersistWorkflowRecord({ family: "outbound", stage: "failed" }, {}), false);
  assert.equal(shouldPersistWorkflowRecord({ family: "outbound", stage: "deferred" }, {}), false);
});

test("known narrative families suppress while unknown families fail open", () => {
  for (const family of [
    "attribution-reconcile",
    "dispatch",
    "filler-pool",
    "lead",
    "logics",
    "metric",
    "metrics",
    "phoneburner",
  ]) {
    assert.equal(shouldPersistWorkflowRecord({ family, stage: "completed" }, {}), false, family);
  }
  assert.equal(shouldPersistWorkflowRecord({ family: "lexis", stage: "completed" }, {}), true);
  assert.equal(shouldPersistWorkflowRecord({ family: "blogger", stage: "completed" }, {}), true);
  assert.equal(shouldPersistWorkflowRecord({ family: "ringcentral", stage: "completed" }, {}), true);
  assert.equal(shouldPersistWorkflowRecord({ family: "future-family", stage: "observed" }, {}), true);
});

test("exact rollback flag restores write-through behavior", () => {
  assert.equal(shouldPersistWorkflowRecord(
    { family: "metric", stage: "observed" },
    { WORKFLOW_RECORD_NARRATIVE_WRITES_ENABLED: "true" },
  ), true);
  assert.equal(shouldPersistWorkflowRecord(
    { family: "metric", stage: "observed" },
    { WORKFLOW_RECORD_NARRATIVE_WRITES_ENABLED: "yes" },
  ), false);
});

test("journal evidence is count-only, bounded, and category-sanitized", () => {
  const entries = [];
  const gate = createWorkflowRecordSoftGate({
    env: {},
    now: () => new Date("2026-08-14T20:00:00.000Z"),
    journal: (entry) => entries.push(entry),
    setIntervalFn: () => ({ unref() {} }),
  });

  const first = gate.evaluate({
    family: "lead",
    subtype: "observed",
    stage: "observed",
    sourceService: "control-plane",
    aggregateType: "case",
    aggregateId: "customer-value-must-not-appear",
    caseId: 12345,
    payload: { private: "must-not-appear" },
    summary: "private summary",
  });
  gate.evaluate({
    family: "metric",
    subtype: "not safe / dynamic value",
    stage: "observed",
    sourceService: "control-plane",
    aggregateType: "daily-metric",
    result: { private: "must-not-appear" },
  });
  const summary = gate.flush("test");

  assert.equal(first.persist, false);
  assert.equal(first.record._id, null);
  assert.equal(entries[0].event, "workflow-record.soft-gate.active");
  assert.equal(summary.suppressed, 2);
  assert.equal(summary.categories.length, 2);
  assert.equal(summary.categories.find((row) => row.family === "lead").withPayload, 1);
  assert.equal(summary.categories.find((row) => row.family === "metric").subtype, "other");
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /customer-value|12345|must-not-appear|private summary/);
});

test("workflow state service bypasses Mongo only for suppressed records", async () => {
  const { workflowRecordRepository } = require("../../packages/shared-repositories/src");
  const { recordWorkflowStage } = require("../../packages/shared-services/src/workflowStateService");
  const original = workflowRecordRepository.createWorkflowRecord;
  const writes = [];
  workflowRecordRepository.createWorkflowRecord = async (record) => {
    writes.push(record);
    return { _id: "durable-record" };
  };

  try {
    const suppressed = await recordWorkflowStage({
      family: "metric",
      subtype: "daily",
      stage: "observed",
      aggregateType: "daily-metric",
      aggregateId: "safe-test",
    });
    const durable = await recordWorkflowStage({
      family: "lexis",
      subtype: "ncoa-upload-batch",
      stage: "completed",
      aggregateType: "ncoa-upload",
      aggregateId: "safe-test",
    });

    assert.equal(suppressed.suppressed, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].family, "lexis");
    assert.equal(durable._id, "durable-record");
  } finally {
    workflowRecordRepository.createWorkflowRecord = original;
  }
});
