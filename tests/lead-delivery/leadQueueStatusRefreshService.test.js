"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  refreshExactLeadStatus,
  refreshUntouchedLeadCadenceStatuses,
  statusFreshnessKey,
  unwrapStatusCaseIds,
} = require("../../packages/shared-services/src/leadQueueStatusRefreshService");

test("exact due-status refresh writes LeadCadence authority before retry selection", async () => {
  const profileWrites = [];
  const cadenceWrites = [];
  const result = await refreshExactLeadStatus({
    domain: " tag ",
    caseId: "101",
    checkedAt: new Date("2026-08-12T17:00:00.000Z"),
    retireDnc: false,
    db: null,
    logicsClientFactory: (domain) => ({
      async getCaseInfo(caseId) {
        assert.equal(domain, "TAG");
        assert.equal(caseId, 101);
        return { Data: { StatusID: 1, FirstName: "Test", LastName: "Lead" } };
      },
    }),
    profileRepository: {
      async upsertCaseProfile(...args) {
        profileWrites.push(args);
      },
    },
    leadCadenceModel: {
      async updateMany(filter, update) {
        cadenceWrites.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.deepEqual(result, {
    status: "refreshed",
    refreshed: 1,
    failed: 0,
    dnc: false,
    nonProspect: false,
    retired: false,
    cadenceDeactivated: 0,
    profileMirrored: true,
    profileMirrorFailed: false,
  });
  assert.equal(profileWrites.length, 1);
  assert.equal(cadenceWrites.length, 1);
  assert.equal(cadenceWrites[0].filter.domain, "TAG");
  assert.deepEqual(cadenceWrites[0].filter.$or, [{ caseId: 101 }, { caseId: "101" }]);
  assert.equal(cadenceWrites[0].update.$set.logicsProspectEligible, true);
  assert.equal(
    cadenceWrites[0].update.$set.logicsStatusCheckedAt.toISOString(),
    "2026-08-12T17:00:00.000Z",
  );
});

test("exact due-status refresh retires a proved Logics DNC before claim", async () => {
  const itemWrites = [];
  const cadenceWrites = [];
  const item = { _id: "item-101", domain: "TAG", caseId: 101 };
  const result = await refreshExactLeadStatus({
    domain: "TAG",
    caseId: 101,
    item,
    checkedAt: new Date("2026-08-12T17:00:00.000Z"),
    db: {
      collection(name) {
        assert.equal(name, "leaddeliveryitems");
        return {
          async updateOne(filter, update) {
            itemWrites.push({ filter, update });
            return { matchedCount: 1, modifiedCount: 1 };
          },
        };
      },
    },
    logicsClientFactory: () => ({
      async getCaseInfo() {
        return { Data: { StatusID: 173, StatusName: "DNC" } };
      },
    }),
    profileRepository: { async upsertCaseProfile() {} },
    leadCadenceModel: {
      async updateMany(filter, update) {
        cadenceWrites.push({ filter, update });
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(result.status, "refreshed");
  assert.equal(result.dnc, true);
  assert.equal(result.retired, true);
  assert.equal(result.cadenceDeactivated, 1);
  assert.equal(itemWrites.length, 1);
  assert.equal(itemWrites[0].update.$set.state, "terminal");
  assert.equal(itemWrites[0].update.$set.activeAttempt, false);
  assert.equal(cadenceWrites.length, 2);
  assert.equal(cadenceWrites[1].update.$set.active, false);
});

test("exact due-status refresh does not depend on the optional CaseProfile mirror", async () => {
  const result = await refreshExactLeadStatus({
    domain: "TAG",
    caseId: 102,
    checkedAt: new Date("2026-08-12T17:00:00.000Z"),
    retireDnc: false,
    db: null,
    logicsClientFactory: () => ({
      async getCaseInfo() {
        return { Data: { StatusID: 1 } };
      },
    }),
    profileRepository: {
      async upsertCaseProfile() {
        throw new Error("optional-mirror-unavailable");
      },
    },
    leadCadenceModel: {
      async updateMany() {
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
  });

  assert.equal(result.status, "refreshed");
  assert.equal(result.failed, 0);
  assert.equal(result.profileMirrored, false);
  assert.equal(result.profileMirrorFailed, true);
});

test("exact due-status refresh makes no optional mirror write when cadence authority is absent", async () => {
  let profileWrites = 0;
  const result = await refreshExactLeadStatus({
    domain: "TAG",
    caseId: 103,
    checkedAt: new Date("2026-08-12T17:00:00.000Z"),
    retireDnc: false,
    db: null,
    logicsClientFactory: () => ({
      async getCaseInfo() {
        return { Data: { StatusID: 1 } };
      },
    }),
    profileRepository: {
      async upsertCaseProfile() {
        profileWrites += 1;
      },
    },
    leadCadenceModel: {
      async updateMany() {
        return { matchedCount: 0, modifiedCount: 0 };
      },
    },
  });

  assert.deepEqual(result, {
    status: "failed",
    refreshed: 0,
    failed: 1,
    reason: "lead-cadence-not-found",
  });
  assert.equal(profileWrites, 0);
});

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
