"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildVersionGuardOptions,
  describeBulkLoadMutationEligibility,
} = require("../../packages/shared-services/src/cxBulkLoadMutationEligibility");

test("buildVersionGuardOptions prefers __v, falls back to updatedAt, else returns empty options", () => {
  assert.deepEqual(buildVersionGuardOptions({ __v: 3, updatedAt: "old" }), {
    expectedVersion: 3,
    versionGuard: true,
  });
  assert.deepEqual(buildVersionGuardOptions({ updatedAt: "2026-06-24T10:00:00.000Z" }), {
    expectedUpdatedAt: "2026-06-24T10:00:00.000Z",
    versionGuard: true,
  });
  assert.deepEqual(buildVersionGuardOptions({}), {});
});

test("describeBulkLoadMutationEligibility blocks busy sessions", () => {
  const result = describeBulkLoadMutationEligibility({ session: { __v: 1 }, busy: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "session-busy");
  assert.deepEqual(result.writeOptions, { expectedVersion: 1, versionGuard: true });
});

test("describeBulkLoadMutationEligibility rejects stale projections by __v", () => {
  const result = describeBulkLoadMutationEligibility({
    session: { __v: 1 },
    latest: { __v: 2 },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale-projection");
  assert.equal(result.expectedVersion, 1);
  assert.equal(result.latestVersion, 2);
});

test("describeBulkLoadMutationEligibility rejects stale projections by updatedAt when __v is absent", () => {
  const result = describeBulkLoadMutationEligibility({
    session: { updatedAt: "2026-06-24T10:00:00.000Z" },
    latest: { updatedAt: "2026-06-24T10:00:01.000Z" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale-projection");
  assert.equal(result.expectedUpdatedAt, "2026-06-24T10:00:00.000Z");
  assert.equal(result.latestUpdatedAt, "2026-06-24T10:00:01.000Z");
});

test("describeBulkLoadMutationEligibility allows matching versions and missing latest", () => {
  assert.equal(describeBulkLoadMutationEligibility({ session: { __v: 2 }, latest: { __v: 2 } }).ok, true);
  assert.equal(describeBulkLoadMutationEligibility({ session: { updatedAt: "2026-06-24T10:00:00.000Z" } }).ok, true);
});
