"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { WorkflowRecord } = require("../../packages/shared-models/src");
const {
  buildWorkflowDedupeFilter,
  createWorkflowRecord,
} = require("../../packages/shared-repositories/src/workflowRecordRepository");

const expected = (dedupeKey) => ({
  $and: [
    { dedupeKey },
    { dedupeKey: { $type: "string" } },
  ],
});

test("the shared workflow dedupe filter states the partial-index predicate", () => {
  assert.deepEqual(buildWorkflowDedupeFilter("receipt:one"), expected("receipt:one"));
  assert.throws(() => buildWorkflowDedupeFilter(""), /dedupeKey is required/);
});

test("every deduped workflow upsert uses the indexable shared filter", async () => {
  const original = WorkflowRecord.findOneAndUpdate;
  let observed = null;
  WorkflowRecord.findOneAndUpdate = async (filter) => {
    observed = filter;
    return { _id: "workflow" };
  };
  try {
    await createWorkflowRecord({ dedupeKey: "receipt:two" });
    assert.deepEqual(observed, expected("receipt:two"));
  } finally {
    WorkflowRecord.findOneAndUpdate = original;
  }
});

test("mailbox and NCOA bypasses use the same indexed filter", () => {
  for (const file of ["mailboxIngestService", "ncoaMailboxIngestService"]) {
    const source = fs.readFileSync(
      require.resolve(`../../packages/shared-services/src/${file}`),
      "utf8",
    );
    assert.match(source, /buildWorkflowDedupeFilter/);
    assert.doesNotMatch(source, /findOne\(\{\s*dedupeKey(?:\s*:|\s*,)/);
  }
});
