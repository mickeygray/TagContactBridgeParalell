"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  statusFreshnessKey,
} = require("../../packages/shared-services/src/leadQueueStatusRefreshService");

test("queue status freshness identity is tenant-scoped and normalized", () => {
  assert.equal(statusFreshnessKey("tag", "137190"), "TAG:137190");
  assert.equal(statusFreshnessKey(" WYNN ", 137190), "WYNN:137190");
  assert.notEqual(
    statusFreshnessKey("TAG", 137190),
    statusFreshnessKey("WYNN", 137190),
  );
  assert.equal(statusFreshnessKey("", 137190), null);
  assert.equal(statusFreshnessKey("TAG", "not-a-case"), null);
});
