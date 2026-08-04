"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  refreshUntouchedLeadCadenceStatuses,
  statusFreshnessKey,
  unwrapStatusCaseIds,
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

test("morning Logics membership accepts supported response shapes and deduplicates ids", () => {
  assert.deepEqual(unwrapStatusCaseIds({ Data: [101, "102", { CaseID: 103 }, { caseId: 101 }] }), [101, 102, 103]);
  assert.deepEqual(unwrapStatusCaseIds({ data: [{ ID: "201" }, { Id: 202 }, { id: 203 }] }), [201, 202, 203]);
  assert.deepEqual(unwrapStatusCaseIds([{ CaseID: "not-a-case" }, null]), []);
  assert.deepEqual(unwrapStatusCaseIds({ Data: null }), []);
});

test("morning first-touch proof trusts intake evidence without a second Logics read", async () => {
  let clientReads = 0;
  let cadenceReads = 0;
  const result = await refreshUntouchedLeadCadenceStatuses({
    domains: ["tag", "WYNN"],
    allowedProspectStatusIds: [1, 2],
    leadCadenceModel: { find() { cadenceReads += 1; throw new Error("must not read cadence"); } },
    logicsClientFactory: () => { clientReads += 1; throw new Error("must not read Logics"); },
  });

  assert.deepEqual(result, {
    status: "intake-authority",
    scanned: 0,
    refreshed: 0,
    eligible: 0,
    blocked: 0,
    failed: 0,
  });
  assert.equal(clientReads, 0);
  assert.equal(cadenceReads, 0);
});
