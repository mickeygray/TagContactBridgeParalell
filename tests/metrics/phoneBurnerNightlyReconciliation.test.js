"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  reconcilePhoneBurnerCallsForNightly,
} = require("../../packages/shared-services/src/nightlyCloseService");

test("nightly close reuses the exact DailyDial projector as an idempotent retry trigger", async () => {
  const calls = [];
  const result = await reconcilePhoneBurnerCallsForNightly("2026-07-17", {
    reconcileDailyDialCalls: async (input) => {
      calls.push(input);
      return { status: "completed", attempts: 7, reconciled: 7, rejected: 0 };
    },
  });

  assert.deepEqual(calls, [{ dateKey: "2026-07-17" }]);
  assert.equal(result.status, "completed");
  assert.equal(result.trigger, "nightly-retry");
  assert.equal(result.reconciled, 7);
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
  assert.equal(result.trigger, "nightly-retry");
  assert.equal(result.errorCode, "DB_TEMPORARY");
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

test("scheduled vendor calls have one live source and PB reconciliation precedes enrichment", () => {
  const vendorSource = fs.readFileSync(
    path.join(__dirname, "../../packages/shared-services/src/vendorNightlyEmailService.js"),
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
  const liveBuilder = vendorSource.match(
    /async function buildVendorCallRows[\s\S]*?\n}\n\nasync function _legacy_buildVendorLeadRows_unused/,
  )?.[0] || "";

  assert.match(vendorSource, /async function _legacy_buildVendorCallRows_unused/);
  assert.match(liveBuilder, /CallLog\.find/);
  assert.doesNotMatch(liveBuilder, /CallLedger\.find/);
  assert.ok(
    nightlySource.indexOf("reconcilePhoneBurnerCallsForNightly(dateKey")
      < nightlySource.indexOf("runNightlyFinalClosePass(selectedDomains"),
  );
  assert.match(
    serverSource,
    /reconcileDailyDialCalls: leadDeliveryActionHandlers\.reconcile_daily_dials_to_call_log/,
  );
});
