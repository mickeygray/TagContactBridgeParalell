"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAgedReceiptIncrement,
  summarizeOperationalRecords,
} = require("../../packages/shared-services/src/nightlyOperationalReceiptService");
const {
  classifyDncLookupFailure,
} = require("../../packages/shared-services/src/fillerPoolRefreshService");

test("aged receipt keeps count-only totals and payment failures", () => {
  const increment = buildAgedReceiptIncrement({
    checked: 20,
    promoted: 5,
    evicted: 2,
    droppedAtIntake: 1,
    expiredRetirement: { retired: 3 },
    dncLookupFailures: 9,
    dncLookupFailureReasons: { paymentRequired: 9 },
  });
  assert.equal(increment["result.checked"], 20);
  assert.equal(increment["result.retired"], 6);
  assert.equal(increment["result.lookupFailures"], 9);
  assert.equal(increment["result.lookupFailureReasons.paymentRequired"], 9);
});

test("provider failure classifier distinguishes credit exhaustion", () => {
  assert.equal(classifyDncLookupFailure(new Error("request failed with status 402")), "paymentRequired");
  assert.equal(classifyDncLookupFailure(new Error("Insufficient Balance on account")), "paymentRequired");
  assert.equal(classifyDncLookupFailure(new Error("socket timed out")), "network");
});

test("operational summary exposes aged and blogger terminal status only", () => {
  const summary = summarizeOperationalRecords({
    agedRecord: {
      stage: "completed",
      result: {
        batches: 2,
        checked: 10,
        promoted: 4,
        retired: 1,
        lookupFailures: 5,
        lookupFailureReasons: { paymentRequired: 5 },
      },
    },
    bloggerRecord: {
      stage: "completed",
      result: { ok: true, durationMs: 1234, code: 0 },
    },
  });
  assert.equal(summary.aged.checked, 10);
  assert.equal(summary.aged.lookupFailureReasons.paymentRequired, 5);
  assert.equal(summary.blogger.status, "completed");
  assert.equal(summary.blogger.durationMs, 1234);
});
