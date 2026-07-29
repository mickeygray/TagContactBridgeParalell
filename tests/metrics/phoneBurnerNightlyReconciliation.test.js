"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  reconcilePhoneBurnerCallsForNightly,
} = require("../../packages/shared-services/src/nightlyCloseService");

test("nightly close retries the selected day and two preceding DailyDial days", async () => {
  const calls = [];
  const result = await reconcilePhoneBurnerCallsForNightly("2026-07-17", {
    reconcileDailyDialCalls: async (input) => {
      calls.push(input);
      return { status: "completed", attempts: 7, reconciled: 7, rejected: 0 };
    },
  });

  assert.deepEqual(calls, [
    { dateKey: "2026-07-15" },
    { dateKey: "2026-07-16" },
    { dateKey: "2026-07-17" },
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.trigger, "nightly-retry-lookback");
  assert.equal(result.reconciled, 21);
});

test("nightly PB reconciliation failure stays visible and does not invent success", async () => {
  const result = await reconcilePhoneBurnerCallsForNightly("2026-07-17", {
    reconcileDailyDialCalls: async () => {
      const error = new Error("temporary database failure");
      error.code = "DB_TEMPORARY";
      throw error;
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.trigger, "nightly-retry-lookback");
  assert.equal(result.errorCode, "DB_TEMPORARY");
  assert.equal(result.dates.length, 3);
  assert.ok(result.dates.every((row) => row.status === "failed"));
});

test("preview close never mutates CallLog through the retry trigger", async () => {
  let calls = 0;
  const result = await reconcilePhoneBurnerCallsForNightly("2026-07-17", {
    skip: true,
    reconcileDailyDialCalls: async () => { calls += 1; },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "skipped");
});

test("scheduled reporting reads CallLog and PB reconciliation precedes enrichment", () => {
  const marketingSource = fs.readFileSync(
    path.join(__dirname, "../../packages/shared-services/src/simpleMarketingReadService.js"),
    "utf8",
  );
  const nightlySource = fs.readFileSync(
    path.join(__dirname, "../../packages/shared-services/src/nightlyCloseService.js"),
    "utf8",
  );
  const serverSource = fs.readFileSync(
    path.join(__dirname, "../../apps/control-plane/src/server.js"),
    "utf8",
  );

  assert.match(marketingSource, /collection\("controlplanecalllogs"\)/);
  assert.match(marketingSource, /LONG_CALL_RECORDING_PLATFORMS/);
  assert.doesNotMatch(marketingSource, /CallLedger\.find/);
  assert.ok(
    nightlySource.indexOf("reconcilePhoneBurnerCallsForNightly(dateKey")
      < nightlySource.indexOf("runNightlyFinalClosePass(selectedDomains"),
  );
  assert.match(
    serverSource,
    /reconcileDailyDialCalls: leadDeliveryActionHandlers\.reconcile_daily_dials_to_call_log/,
  );
});
