"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  nightlyLookbackDateKeys,
  reconcilePhoneBurnerNightlyLookback,
} = require("../../packages/shared-services/src/dailyDialNightlyLookbackService");

test("nightly lookback retries three closed calendar dates oldest first", async () => {
  const calls = [];
  const result = await reconcilePhoneBurnerNightlyLookback("2026-07-23", {
    reconcileDailyDialCalls: async ({ dateKey }) => {
      calls.push(dateKey);
      return { status: "completed", attempts: 2, reconciled: 2, rejected: 0 };
    },
  });

  assert.deepEqual(calls, ["2026-07-21", "2026-07-22", "2026-07-23"]);
  assert.deepEqual(result.dateKeys, calls);
  assert.equal(result.status, "completed");
  assert.equal(result.attempts, 6);
  assert.equal(result.reconciled, 6);
  assert.equal(result.trigger, "nightly-retry-lookback");
});

test("one failed lookback date stays visible while later dates still retry", async () => {
  const calls = [];
  const result = await reconcilePhoneBurnerNightlyLookback("2026-07-23", {
    reconcileDailyDialCalls: async ({ dateKey }) => {
      calls.push(dateKey);
      if (dateKey === "2026-07-22") {
        const error = new Error("temporary");
        error.code = "DB_TEMPORARY";
        throw error;
      }
      return { status: "completed", attempts: 1, reconciled: 1, rejected: 0 };
    },
  });

  assert.deepEqual(calls, ["2026-07-21", "2026-07-22", "2026-07-23"]);
  assert.equal(result.status, "failed");
  assert.equal(result.reconciled, 2);
  assert.equal(result.dates[1].errorCode, "DB_TEMPORARY");
});

test("preview lookback remains write-free", async () => {
  let calls = 0;
  const result = await reconcilePhoneBurnerNightlyLookback("2026-07-23", {
    skip: true,
    reconcileDailyDialCalls: async () => { calls += 1; },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "skipped");
  assert.deepEqual(result.dateKeys, ["2026-07-21", "2026-07-22", "2026-07-23"]);
});

test("date-key lookback crosses month boundaries deterministically", () => {
  assert.deepEqual(
    nightlyLookbackDateKeys("2026-07-01", 3),
    ["2026-06-29", "2026-06-30", "2026-07-01"],
  );
});
