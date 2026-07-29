"use strict";

const crypto = require("crypto");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createTrainingCallReviewSourceService,
  foldLatestSettlementOfficerAssignment,
  normalizeSettlementOfficerName,
} = require("../../packages/shared-services/src/trainingCallReviewSourceService");

const PRINCIPAL = Object.freeze({ email: "agent@example.test" });

function assignment(name, created, extra = {}) {
  return {
    Subject: `Assigned to Set. Officer : ${name}`,
    CreatedDate: created,
    ...extra,
  };
}

function activeAccount(overrides = {}) {
  return {
    id: "account-fixture",
    email: PRINCIPAL.email,
    role: "internal-agent",
    status: "active",
    tagLogicsName: "Casey Smith",
    wynnLogicsName: "Wynn Casey",
    ...overrides,
  };
}

function stableIssuer({ authorization, callLog }) {
  const seed = [
    authorization.actorEmail,
    authorization.domain,
    authorization.caseId,
    callLog.telephonySessionId,
  ].join("|");
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return {
    sourceId: `trsrc_${digest}`,
    callFingerprint: `call:${digest}`,
    recordingFingerprint: `recording:${digest}`,
  };
}

function serviceWith(overrides = {}) {
  return createTrainingCallReviewSourceService({
    isCallReviewEnabled: true,
    findUserAccountByEmail: async () => activeAccount(),
    getActivitiesForCase: async () => [
      assignment("Casey Smith", "2026-07-28T17:00:00.000Z"),
    ],
    listCallLogsByCaseId: async () => [],
    issueRecordingSource: stableIssuer,
    ...overrides,
  });
}

function expectError(code, status) {
  return (error) => error?.code === code && error?.status === status;
}

test("latest settlement-officer assignment uses immutable Created time and ignores unrelated activities", () => {
  const folded = foldLatestSettlementOfficerAssignment([
    assignment("Old Officer", "2026-07-01T17:00:00.000Z", {
      ModifiedDate: "2026-07-30T17:00:00.000Z",
    }),
    {
      ActivitySubject: "Assigned to Case Manager : Not The Officer",
      Created: "2026-07-31T17:00:00.000Z",
    },
    { Subject: "Left a voicemail", CreatedDate: "2026-08-01T17:00:00.000Z" },
    {
      "Activity Subject": "Assigned to Set. Officer :  Casey   Smith ",
      "Created Date": "2026-07-02T17:00:00.000Z",
    },
  ]);

  assert.deepEqual(folded, {
    state: "assigned",
    assignee: "Casey   Smith",
    canonicalAssignee: "casey smith",
    observedAt: "2026-07-02T17:00:00.000Z",
    reason: null,
  });
  assert.equal(normalizeSettlementOfficerName("  CASEY\tSmith  "), "casey smith");
});

test("unassignment, missing/invalid dates, and conflicting latest events fail closed", () => {
  assert.equal(
    foldLatestSettlementOfficerAssignment([
      assignment("Casey Smith", "2026-07-01T00:00:00.000Z"),
      assignment("--Unassigned--", "2026-07-02T00:00:00.000Z"),
    ]).state,
    "unassigned",
  );
  assert.equal(
    foldLatestSettlementOfficerAssignment([
      assignment("Casey Smith", "not-a-date"),
    ]).state,
    "ambiguous",
  );
  assert.equal(
    foldLatestSettlementOfficerAssignment([
      assignment("Casey Smith", "2026-07-02T00:00:00.000Z"),
      assignment("Other Officer", "2026-07-02T00:00:00.000Z"),
    ]).state,
    "ambiguous",
  );
  assert.equal(foldLatestSettlementOfficerAssignment([]).state, "missing");
});

test("non-admin authorization reloads the account and reads only one case activity feed", async () => {
  const seen = { accounts: [], activities: [], calls: [] };
  const service = serviceWith({
    findUserAccountByEmail: async (email) => {
      seen.accounts.push(email);
      return activeAccount({ tagLogicsName: "  CASEY   SMITH " });
    },
    getActivitiesForCase: async (...args) => {
      seen.activities.push(args);
      return [assignment("Casey Smith", "2026-07-28T17:00:00.000Z")];
    },
    listCallLogsByCaseId: async (...args) => {
      seen.calls.push(args);
      return [];
    },
  });

  const result = await service.listCaseCalls({
    principal: { email: " Agent@Example.Test " },
    domain: "tag",
    caseId: "12345",
  });

  assert.deepEqual(result, { minimumDurationSec: 300, calls: [] });
  assert.deepEqual(seen.accounts, [PRINCIPAL.email]);
  assert.deepEqual(seen.activities, [["TAG", 12345]]);
  assert.deepEqual(seen.calls, [["TAG", 12345, { limit: 500, includeLegacy: false }]]);
});

test("only a freshly loaded admin role bypasses assignment comparison after one case activity read", async () => {
  let activityReads = 0;
  const adminService = serviceWith({
    findUserAccountByEmail: async () => activeAccount({ role: "admin" }),
    getActivitiesForCase: async (...args) => {
      activityReads += 1;
      assert.deepEqual(args, ["AMITY", 55]);
      return [];
    },
  });
  const authorization = await adminService.authorizeCaseAccess({
    principal: PRINCIPAL,
    domain: "AMITY",
    caseId: 55,
  });
  assert.equal(authorization.isAdmin, true);
  assert.equal(authorization.assignmentAuthority, "admin-bypass");
  assert.equal(activityReads, 1);

  const claimedAdminService = serviceWith({
    findUserAccountByEmail: async () =>
      activeAccount({ role: "manager", permissions: ["system.admin"], audience: "admin" }),
    getActivitiesForCase: async () => [
      assignment("Another Officer", "2026-07-28T17:00:00.000Z"),
    ],
  });
  await assert.rejects(
    claimedAdminService.authorizeCaseAccess({
      principal: { ...PRINCIPAL, role: "admin" },
      domain: "TAG",
      caseId: 55,
    }),
    expectError("TRAINER_CALL_REVIEW_CASE_FORBIDDEN", 403),
  );
});

test("domain identity, account state, and provider failures fail closed without leaking details", async () => {
  let accountReads = 0;
  const service = serviceWith({
    findUserAccountByEmail: async () => {
      accountReads += 1;
      return activeAccount();
    },
  });
  await assert.rejects(
    service.authorizeCaseAccess({ principal: PRINCIPAL, domain: "unknown", caseId: 1 }),
    expectError("TRAINER_CALL_REVIEW_DOMAIN_UNSUPPORTED", 422),
  );
  assert.equal(accountReads, 0);

  await assert.rejects(
    serviceWith({ findUserAccountByEmail: async () => activeAccount({ status: "disabled" }) })
      .authorizeCaseAccess({ principal: PRINCIPAL, domain: "TAG", caseId: 1 }),
    expectError("TRAINER_CALL_REVIEW_ACCOUNT_UNAVAILABLE", 403),
  );
  await assert.rejects(
    serviceWith({ getActivitiesForCase: async () => { throw new Error("secret-token-fixture"); } })
      .authorizeCaseAccess({ principal: PRINCIPAL, domain: "TAG", caseId: 1 }),
    (error) =>
      expectError("TRAINER_CALL_REVIEW_ACTIVITIES_UNAVAILABLE", 503)(error) &&
      !JSON.stringify(error).includes("secret-token-fixture"),
  );
});

test("resolveAuthorizedSource rechecks reassignment before analyzing an earlier source", async () => {
  let currentOfficer = "Casey Smith";
  let callReads = 0;
  const exactExCall = {
    domain: "TAG",
    caseId: 909,
    telephonySessionId: "private-ex-session",
    platform: "ex",
    provider: "ringcentral",
    connected: true,
    missed: false,
    outcome: "completed",
    durationSec: 300,
    callStartTime: "2026-07-28T17:00:00.000Z",
  };
  const service = serviceWith({
    getActivitiesForCase: async () => [
      assignment(currentOfficer, "2026-07-28T17:00:00.000Z"),
    ],
    listCallLogsByCaseId: async () => {
      callReads += 1;
      return [exactExCall];
    },
  });

  const listed = await service.listCaseCalls({
    principal: PRINCIPAL,
    domain: "TAG",
    caseId: 909,
  });
  assert.equal(listed.calls.length, 1);
  assert.equal(listed.calls[0].analysisEligible, true);

  currentOfficer = "New Officer";
  await assert.rejects(
    service.resolveAuthorizedSource({
      principal: PRINCIPAL,
      domain: "TAG",
      caseId: 909,
      sourceId: listed.calls[0].sourceId,
    }),
    expectError("TRAINER_CALL_REVIEW_CASE_FORBIDDEN", 403),
  );
  assert.equal(callReads, 1, "reassignment denies before rereading private call rows");
});

test("flag-off behavior performs no account, activity, or call reads", async () => {
  let reads = 0;
  const service = serviceWith({
    isCallReviewEnabled: false,
    findUserAccountByEmail: async () => { reads += 1; return activeAccount(); },
    getActivitiesForCase: async () => { reads += 1; return []; },
    listCallLogsByCaseId: async () => { reads += 1; return []; },
  });
  await assert.rejects(
    service.listCaseCalls({ principal: PRINCIPAL, domain: "TAG", caseId: 1 }),
    expectError("TRAINER_CALL_REVIEW_DISABLED", 503),
  );
  assert.equal(reads, 0);
});
