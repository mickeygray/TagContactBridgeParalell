"use strict";

const crypto = require("crypto");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  createTrainingCallReviewSourceService,
} = require("../../packages/shared-services/src/trainingCallReviewSourceService");
const {
  createTrainingCallReviewTokenService,
} = require("../../packages/shared-services/src/trainingCallReviewTokenService");
const {
  createSalesTrainerCallReviewRouter,
} = require("../../apps/control-plane/src/routes/salesTrainerCallReview");

const LEARNER = "learner@example.test";
const DOMAIN = "TAG";
const CASE_ID = 808;
const STARTED_AT = "2026-07-28T17:00:00.000Z";
const TEST_SECRET = "synthetic-reassignment-secret-32-bytes";

function exactCall() {
  return {
    _id: "private-call-row",
    domain: DOMAIN,
    caseId: CASE_ID,
    telephonySessionId: "private-ex-session",
    platform: "ex",
    provider: "ringcentral",
    connected: true,
    missed: false,
    outcome: "completed",
    durationSec: 300,
    callStartTime: STARTED_AT,
  };
}

function stableIssuer({ authorization, callLog, recordingCandidate }) {
  const seed = JSON.stringify({
    learner: authorization.actorEmail,
    domain: authorization.domain,
    caseId: authorization.caseId,
    call: callLog.telephonySessionId,
    provider: recordingCandidate.provider,
  });
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return {
    sourceId: `trsrc_${digest}`,
    callFingerprint: `callfp:${digest}`,
    recordingFingerprint: `recfp:${digest}`,
  };
}

function assignedActivity(name) {
  return {
    Subject: `Assigned to Set. Officer : ${name}`,
    CreatedDate: "2026-07-28T16:00:00.000Z",
  };
}

function errorMatches(code, status) {
  return (error) => error?.code === code && error?.status === status;
}

async function listen(t, router) {
  const app = express();
  app.use(express.json());
  app.use("/api/sales-trainer", router);
  const server = await new Promise((resolve) => {
    const active = app.listen(0, "127.0.0.1", () => resolve(active));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/sales-trainer`;
}

async function requestJson(baseUrl, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: await response.json() };
}

test("reassignment after listing denies exact source resolution before rereading private calls", async () => {
  let currentOfficer = "Casey Smith";
  let activityReads = 0;
  let callReads = 0;
  const service = createTrainingCallReviewSourceService({
    isCallReviewEnabled: true,
    findUserAccountByEmail: async () => ({
      id: "synthetic-account",
      email: LEARNER,
      role: "internal-agent",
      status: "active",
      tagLogicsName: "Casey Smith",
    }),
    getActivitiesForCase: async () => {
      activityReads += 1;
      return [assignedActivity(currentOfficer)];
    },
    listCallLogsByCaseId: async () => {
      callReads += 1;
      return [exactCall()];
    },
    issueRecordingSource: stableIssuer,
  });

  const listed = await service.listCaseCalls({
    principal: { email: LEARNER },
    domain: DOMAIN,
    caseId: CASE_ID,
  });
  assert.equal(listed.calls.length, 1);
  assert.match(listed.calls[0].sourceId, /^trsrc_[A-Za-z0-9_-]+$/);
  assert.equal(activityReads, 1);
  assert.equal(callReads, 1);

  currentOfficer = "New Officer";
  await assert.rejects(
    service.resolveAuthorizedSource({
      principal: { email: LEARNER },
      domain: DOMAIN,
      caseId: CASE_ID,
      sourceId: listed.calls[0].sourceId,
    }),
    errorMatches("TRAINER_CALL_REVIEW_CASE_FORBIDDEN", 403),
  );
  assert.equal(activityReads, 2, "Analyze performs one fresh case-scoped assignment read");
  assert.equal(callReads, 1, "reassignment denies before private call rows are reread");
});

test("Analyze and saved-review read fail closed when fresh authorization reports reassignment", async (t) => {
  const tokenService = createTrainingCallReviewTokenService({
    secret: TEST_SECRET,
    now: () => new Date("2026-07-28T18:00:00.000Z"),
    randomBytes: () => Buffer.alloc(12, 4),
  });
  const callLog = exactCall();
  const recordingCandidate = {
    eligible: true,
    provider: "ex",
    kind: "exact-telephony-session-lookup",
    locator: { telephonySessionId: callLog.telephonySessionId },
  };
  const source = tokenService.issueRecordingSource({
    authorization: { actorEmail: LEARNER, domain: DOMAIN, caseId: CASE_ID },
    callLog,
    recordingCandidate,
  });
  const caseSourceId = tokenService.issueCaseSource({
    learnerKey: LEARNER,
    domain: DOMAIN,
    caseId: CASE_ID,
  });

  const resolveArguments = [];
  let analysisFactories = 0;
  let publicProjections = 0;
  const reassigned = Object.assign(
    new Error("private activity payload https://private.example.test/reassigned"),
    { status: 403, code: "TRAINER_CALL_REVIEW_CASE_FORBIDDEN" },
  );
  const privateReview = {
    reviewId: "review_reassigned",
    learnerKey: LEARNER,
    domain: DOMAIN,
    caseId: CASE_ID,
    recordingSourceId: source.sourceId,
  };
  const router = createSalesTrainerCallReviewRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = { email: LEARNER, role: "user" };
      req.user = req.salesTrainerUser;
      next();
    },
    dependencies: {
      tokenService,
      now: () => new Date("2026-07-28T18:00:00.000Z"),
      sourceService: {
        async resolveAuthorizedSource(args) {
          resolveArguments.push(args);
          throw reassigned;
        },
      },
      createAnalysisService() {
        analysisFactories += 1;
        throw new Error("analysis must not start after reassignment");
      },
      findReviewById: async () => privateReview,
      toPublicReview() {
        publicProjections += 1;
        throw new Error("saved evidence must not project after reassignment");
      },
    },
  });
  const baseUrl = await listen(t, router);

  const analyzed = await requestJson(baseUrl, "/call-reviews", {
    method: "POST",
    body: {
      caseSourceId,
      sourceId: source.sourceId,
      requestId: "reassign-request-1",
    },
  });
  assert.equal(analyzed.status, 403);
  assert.deepEqual(analyzed.body, {
    ok: false,
    error: "This case is unavailable for this Trainer account.",
    code: "TRAINER_CALL_REVIEW_FORBIDDEN",
  });
  assert.equal(analysisFactories, 0);

  const saved = await requestJson(baseUrl, "/call-reviews/review_reassigned");
  assert.equal(saved.status, 403);
  assert.deepEqual(saved.body, analyzed.body);
  assert.equal(publicProjections, 0);
  assert.equal(resolveArguments.length, 2);
  for (const args of resolveArguments) {
    assert.equal(args.domain, DOMAIN);
    assert.equal(args.caseId, CASE_ID);
    assert.equal(args.sourceId, source.sourceId);
  }
  const serialized = JSON.stringify({ analyzed: analyzed.body, saved: saved.body });
  assert.equal(serialized.includes("private.example.test"), false);
  assert.equal(serialized.includes(source.sourceId), false);
  assert.equal(serialized.includes(String(CASE_ID)), false);
});
