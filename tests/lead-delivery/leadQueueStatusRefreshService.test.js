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

test("morning first-touch proof reads untouched LeadCadence rows and writes Logics membership", async () => {
  const rows = [
    { _id: "a", domain: "TAG", caseId: 101 },
    { _id: "b", domain: "TAG", caseId: 102 },
    { _id: "c", domain: "WYNN", caseId: 201 },
    { _id: "d", domain: "WYNN", caseId: 202 },
  ];
  const reads = [];
  const writes = [];
  const leadCadenceModel = {
    find(filter, projection) {
      reads.push({ filter, projection, sort: null, limit: null });
      const call = reads.at(-1);
      return {
        sort(value) { call.sort = value; return this; },
        limit(value) { call.limit = value; return this; },
        async lean() { return rows; },
      };
    },
    async bulkWrite(operations, options) {
      writes.push({ operations, options });
    },
  };
  const statusMembership = new Map([
    ["TAG:1", [101]],
    ["TAG:2", [102]],
    ["WYNN:1", [201]],
    ["WYNN:2", []],
  ]);
  const result = await refreshUntouchedLeadCadenceStatuses({
    domains: ["tag", "WYNN"],
    allowedProspectStatusIds: [1, 2],
    leadCadenceModel,
    logicsClientFactory: (domain) => ({
      async getCasesByStatus(statusId) {
        return { Data: statusMembership.get(`${domain}:${statusId}`) || [] };
      },
    }),
  });

  assert.deepEqual(result, { scanned: 4, refreshed: 4, eligible: 3, blocked: 1 });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].filter.active, true);
  assert.deepEqual(reads[0].sort, { createdAt: -1, _id: -1 });
  assert.equal(reads[0].limit, 20000);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.ordered, false);
  assert.deepEqual(
    writes[0].operations.map((operation) => ({
      id: operation.updateOne.filter._id,
      statusId: operation.updateOne.update.$set.statusId,
      eligible: operation.updateOne.update.$set.logicsProspectEligible,
    })),
    [
      { id: "a", statusId: 1, eligible: true },
      { id: "b", statusId: 2, eligible: true },
      { id: "c", statusId: 1, eligible: true },
      { id: "d", statusId: undefined, eligible: false },
    ],
  );
});
