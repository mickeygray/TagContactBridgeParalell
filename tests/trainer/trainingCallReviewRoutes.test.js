"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  createTrainingCallReviewTokenService,
} = require("../../packages/shared-services/src/trainingCallReviewTokenService");
const {
  createSalesTrainerCallReviewRouter,
} = require("../../apps/control-plane/src/routes/salesTrainerCallReview");
const {
  buildSalesTrainerAccount,
  issueSalesTrainerToken,
} = require("../../packages/shared-services/src/taxResolutionSalesTrainerService");
const {
  createSalesTrainerRouter,
} = require("../../apps/control-plane/src/routes/salesTrainer");

const LEARNER = "learner@example.test";
const TEST_SECRET = "synthetic-case-review-secret-32-bytes";
const STARTED_AT = "2026-07-28T17:00:00.000Z";

function routeError(status, code, message = "private upstream detail") {
  return Object.assign(new Error(message), { status, statusCode: status, code });
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

async function requestJson(baseUrl, path, { method = "GET", body, headers } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(headers || {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

function exactSourceInput(overrides = {}) {
  return {
    authorization: {
      actorEmail: LEARNER,
      domain: "TAG",
      caseId: 12345,
      ...(overrides.authorization || {}),
    },
    callLog: {
      _id: "private-call-row",
      telephonySessionId: "private-ex-session",
      providerCallId: "private-provider-call",
      callStartTime: STARTED_AT,
      durationSec: 321,
      direction: "outbound",
      agentName: "Safe Agent",
      outcome: "completed",
      ...(overrides.callLog || {}),
    },
    recordingCandidate: {
      eligible: true,
      provider: "ex",
      kind: "exact-telephony-session-lookup",
      locator: { telephonySessionId: "private-ex-session" },
      ...(overrides.recordingCandidate || {}),
    },
  };
}

test("case and recording source capabilities are opaque, bound, deterministic, and short-lived", () => {
  let clockMs = Date.parse("2026-07-28T18:00:00.000Z");
  const tokens = createTrainingCallReviewTokenService({
    secret: TEST_SECRET,
    ttlMs: 5_000,
    now: () => new Date(clockMs),
    randomBytes: () => Buffer.alloc(12, 7),
  });

  const caseSourceId = tokens.issueCaseSource({
    learnerKey: LEARNER,
    domain: "tag",
    caseId: "12345",
  });
  assert.match(caseSourceId, /^trcase_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(caseSourceId.includes(LEARNER), false);
  assert.equal(caseSourceId.includes("TAG"), false);
  assert.deepEqual(tokens.resolveCaseSource({ caseSourceId, learnerKey: LEARNER }), {
    learnerKey: LEARNER,
    domain: "TAG",
    caseId: 12345,
  });

  const unavailable = (error) => error?.status === 404 &&
    error?.code === "TRAINER_CALL_REVIEW_CASE_SOURCE_UNAVAILABLE";
  assert.throws(
    () => tokens.resolveCaseSource({ caseSourceId, learnerKey: "other@example.test" }),
    unavailable,
  );
  const finalCharacter = caseSourceId.at(-1);
  const tampered = `${caseSourceId.slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
  assert.throws(() => tokens.resolveCaseSource({ caseSourceId: tampered, learnerKey: LEARNER }), unavailable);
  assert.throws(() => tokens.resolveCaseSource({ caseSourceId: "trcase_v1.bad", learnerKey: LEARNER }), unavailable);
  assert.throws(
    () => tokens.resolveCaseSource({ caseSourceId: `trcase_v1.${"A".repeat(2_100)}`, learnerKey: LEARNER }),
    unavailable,
  );

  clockMs += 5_001;
  assert.throws(() => tokens.resolveCaseSource({ caseSourceId, learnerKey: LEARNER }), unavailable);

  const exact = exactSourceInput();
  const first = tokens.issueRecordingSource(exact);
  const second = tokens.issueRecordingSource(exact);
  assert.deepEqual(second, first);
  assert.match(first.sourceId, /^trsrc_[A-Za-z0-9_-]{43}$/);
  assert.match(first.callFingerprint, /^callfp:[a-f0-9]{64}$/);
  assert.match(first.recordingFingerprint, /^recfp:[a-f0-9]{64}$/);
  assert.notEqual(
    tokens.issueRecordingSource(exactSourceInput({
      authorization: { actorEmail: "other@example.test" },
    })).sourceId,
    first.sourceId,
  );
  assert.notEqual(
    tokens.issueRecordingSource(exactSourceInput({
      callLog: { telephonySessionId: "different-private-session" },
      recordingCandidate: {
        locator: { telephonySessionId: "different-private-session" },
      },
    })).sourceId,
    first.sourceId,
  );
});

test("Call Review routes enforce opaque inputs, fresh authorization, safe projections, and separate limits", async (t) => {
  const now = new Date("2026-07-28T18:00:00.000Z");
  const tokenService = createTrainingCallReviewTokenService({
    secret: TEST_SECRET,
    now: () => now,
    randomBytes: () => Buffer.alloc(12, 9),
  });
  const sourceInput = exactSourceInput();
  const issuedSource = tokenService.issueRecordingSource(sourceInput);
  const resolvedSource = Object.freeze({
    authorization: Object.freeze({ actorEmail: LEARNER, domain: "TAG", caseId: 12345 }),
    callLog: Object.freeze(sourceInput.callLog),
    recordingCandidate: Object.freeze(sourceInput.recordingCandidate),
    source: issuedSource,
  });

  let learnerEmail = LEARNER;
  let listFailure = null;
  let resolveFailure = null;
  let listCalls = 0;
  const resolvedArguments = [];
  const middlewareSequence = [];
  const analysisInputs = [];
  const sourceService = {
    async listCaseCalls() {
      listCalls += 1;
      if (listFailure) throw listFailure;
      return {
        calls: [
          {
            sourceId: issuedSource.sourceId,
            provider: "ex",
            startedAt: STARTED_AT,
            durationSec: 321,
            direction: "outbound",
            agentName: "Agent https://private.example.test/profile",
            outcome: "Reached jane@example.test",
            recordingStatus: "available",
          },
          {
            sourceId: null,
            provider: "phoneburner",
            startedAt: "2026-07-28T16:00:00.000Z",
            durationSec: 300,
            direction: "outbound",
            agentName: null,
            outcome: null,
            recordingStatus: "pending",
          },
        ],
      };
    },
    async resolveAuthorizedSource(args) {
      resolvedArguments.push(args);
      if (resolveFailure) throw resolveFailure;
      return resolvedSource;
    },
  };

  const publicReview = {
    reviewId: "review_123",
    status: "completed",
    generation: 2,
    versions: {
      scriptVersion: "script-v1",
      transcriptVersion: "transcript-v1",
      graderVersion: "grader-v1",
    },
    source: {
      provider: "ex",
      startedAt: STARTED_AT,
      durationSec: 321,
      direction: "outbound",
      agentName: "Agent https://private.example.test/profile",
      outcome: "Reached jane@example.test",
      sourceId: issuedSource.sourceId,
    },
    transcript: {
      status: "completed",
      segments: [{
        segmentId: "segment-1",
        startMs: 0,
        endMs: 1_000,
        speaker: "agent",
        speakerConfidence: 0.95,
        text: "Email jane@example.test and open https://private.example.test/call",
      }],
    },
    scriptFindings: [{
      findingId: "script-1",
      sectionId: "opening",
      beatId: "permission",
      status: "uncertain",
      title: "Permission check",
      summary: "The evidence is incomplete.",
      confidence: 0.65,
      citations: [{
        segmentId: "segment-1",
        startMs: 0,
        endMs: 1_000,
        quote: "Visit https://private.example.test/evidence",
      }],
    }],
    thingsToConsider: [{
      findingId: "coach-1",
      title: "Slow down",
      summary: "Pause after the question.",
      confidence: 0.8,
      citations: [],
    }],
    createdAt: "2026-07-28T18:00:00.000Z",
    completedAt: "2026-07-28T18:01:00.000Z",
    domain: "TAG",
    caseId: 12345,
  };
  const privateReview = {
    ...publicReview,
    learnerKey: LEARNER,
    domain: "TAG",
    caseId: 12345,
    recordingSourceId: issuedSource.sourceId,
    privateLocator: "https://private.example.test/raw-recording",
  };

  const router = createSalesTrainerCallReviewRouter({
    requireSalesTrainerAccess(req, _res, next) {
      middlewareSequence.push("auth");
      req.salesTrainerUser = { email: learnerEmail, role: "user" };
      req.user = req.salesTrainerUser;
      next();
    },
    lookupLimit(_req, _res, next) {
      middlewareSequence.push("lookup");
      next();
    },
    analyzeLimit(_req, _res, next) {
      middlewareSequence.push("analyze");
      next();
    },
    dependencies: {
      tokenService,
      sourceService,
      now: () => now,
      findReviewById: async () => privateReview,
      toPublicReview: (review) => {
        assert.strictEqual(review, privateReview);
        return publicReview;
      },
      createAnalysisService({ resolveAuthorizedSource }) {
        return {
          async analyzeCallReview(input) {
            analysisInputs.push(input);
            const first = await resolveAuthorizedSource();
            const second = await resolveAuthorizedSource();
            assert.strictEqual(first.callLog, resolvedSource.callLog);
            assert.strictEqual(second.recordingCandidate, resolvedSource.recordingCandidate);
            return publicReview;
          },
        };
      },
    },
  });
  const baseUrl = await listen(t, router);

  const listed = await requestJson(baseUrl, "/call-review/case-calls", {
    method: "POST",
    body: { domain: "tag", caseNumber: "12345" },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(middlewareSequence, ["auth", "lookup"]);
  assert.deepEqual(Object.keys(listed.body.result).sort(), [
    "authorizationCheckedAt",
    "calls",
    "caseSourceId",
  ]);
  assert.equal(listed.body.result.calls[1].sourceId, null);
  assert.equal(JSON.stringify(listed.body).includes("private.example.test"), false);
  assert.equal(JSON.stringify(listed.body).includes("jane@example.test"), false);
  assert.deepEqual(
    tokenService.resolveCaseSource({
      caseSourceId: listed.body.result.caseSourceId,
      learnerKey: LEARNER,
    }),
    { learnerKey: LEARNER, domain: "TAG", caseId: 12345 },
  );

  const rejectedLocator = await requestJson(baseUrl, "/call-review/case-calls", {
    method: "POST",
    body: { domain: "TAG", caseNumber: 12345, driveFileId: "private-drive-locator" },
  });
  assert.equal(rejectedLocator.status, 422);
  assert.equal(listCalls, 1, "strict request rejection happens before any source read");
  assert.equal(JSON.stringify(rejectedLocator.body).includes("private-drive-locator"), false);

  const rejectedAnalyze = await requestJson(baseUrl, "/call-reviews", {
    method: "POST",
    body: {
      caseSourceId: listed.body.result.caseSourceId,
      sourceId: issuedSource.sourceId,
      requestId: "request-123",
      sourceUri: "https://private.example.test/recording",
    },
  });
  assert.equal(rejectedAnalyze.status, 422);
  assert.equal(resolvedArguments.length, 0);

  const analyzed = await requestJson(baseUrl, "/call-reviews", {
    method: "POST",
    body: {
      caseSourceId: listed.body.result.caseSourceId,
      sourceId: issuedSource.sourceId,
      requestId: "request-123",
    },
  });
  assert.equal(analyzed.status, 200);
  assert.deepEqual(analyzed.body.result, {
    reviewId: "review_123",
    status: "completed",
    generation: 2,
  });
  assert.equal(resolvedArguments.length, 1, "Analyze performs one fresh source-service resolution");
  assert.equal(analysisInputs.length, 1);
  assert.equal(analysisInputs[0].source.sourceId, issuedSource.sourceId);
  assert.equal(analysisInputs[0].source.recordingFingerprint, issuedSource.recordingFingerprint);
  assert.deepEqual(middlewareSequence.slice(-2), ["auth", "analyze"]);

  const saved = await requestJson(baseUrl, "/call-reviews/review_123");
  assert.equal(saved.status, 200);
  assert.equal(resolvedArguments.length, 2, "saved GET freshly reauthorizes exact source membership");
  assert.deepEqual(resolvedArguments[1], {
    principal: { email: LEARNER, role: "user" },
    domain: "TAG",
    caseId: 12345,
    sourceId: issuedSource.sourceId,
  });
  assert.deepEqual(saved.body.result.versions, publicReview.versions);
  assert.equal(saved.body.result.scriptFindings[0].status, "uncertain");
  assert.equal(saved.body.result.thingsToConsider[0].title, "Slow down");
  assert.equal("domain" in saved.body.result, false);
  assert.equal("caseId" in saved.body.result, false);
  assert.equal("recordingSourceId" in saved.body.result, false);
  assert.equal("sourceId" in saved.body.result.source, false);
  assert.equal(JSON.stringify(saved.body).includes("private.example.test"), false);
  assert.equal(JSON.stringify(saved.body).includes("jane@example.test"), false);
  assert.deepEqual(middlewareSequence.slice(-2), ["auth", "lookup"]);

  learnerEmail = "other@example.test";
  const otherLearner = await requestJson(baseUrl, "/call-reviews/review_123");
  assert.equal(otherLearner.status, 404);
  assert.equal(resolvedArguments.length, 2, "learner mismatch denies before source reauthorization");

  learnerEmail = LEARNER;
  resolveFailure = routeError(
    404,
    "TRAINER_CALL_REVIEW_SOURCE_NOT_FOUND",
    "removed source https://private.example.test/rebound",
  );
  const removed = await requestJson(baseUrl, "/call-reviews/review_123");
  assert.equal(removed.status, 404);
  assert.deepEqual(removed.body, {
    ok: false,
    error: "The requested Case Review resource is unavailable.",
    code: "TRAINER_CALL_REVIEW_NOT_FOUND",
  });
  assert.equal(JSON.stringify(removed.body).includes("private.example.test"), false);
  resolveFailure = null;

  listFailure = new Error("upstream https://private.example.test?token=secret-fixture");
  const unavailable = await requestJson(baseUrl, "/call-review/case-calls", {
    method: "POST",
    body: { domain: "TAG", caseNumber: 12345 },
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, "TRAINER_CALL_REVIEW_UNAVAILABLE");
  assert.equal(JSON.stringify(unavailable.body).includes("private.example.test"), false);
});

test("feature-on Trainer route disables legacy score-call before loading its provider pipeline", async (t) => {
  const prior = Object.fromEntries([
    "SALES_TRAINER_ALLOWED_EMAILS",
    "SALES_TRAINER_TOKEN_SECRET",
    "SALES_TRAINER_CALL_REVIEW_V1_ENABLED",
  ].map((key) => [key, process.env[key]]));
  process.env.SALES_TRAINER_ALLOWED_EMAILS = LEARNER;
  process.env.SALES_TRAINER_TOKEN_SECRET = TEST_SECRET;
  process.env.SALES_TRAINER_CALL_REVIEW_V1_ENABLED = "true";
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const token = issueSalesTrainerToken(
    { jwtSecret: "unused-synthetic-fallback" },
    LEARNER,
    buildSalesTrainerAccount(LEARNER),
  ).token;
  const pass = (_req, _res, next) => next();
  const router = createSalesTrainerRouter(
    { requireAuth: pass, requireAdmin: pass },
    { jwtSecret: "unused-synthetic-fallback" },
  );
  const baseUrl = await listen(t, router);
  const response = await requestJson(baseUrl, "/score-call", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: { driveFileId: "private-drive-locator" },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: "Legacy call scoring is unavailable while Case Review is enabled.",
    code: "TRAINER_LEGACY_SCORE_CALL_DISABLED",
  });
  assert.equal(JSON.stringify(response.body).includes("private-drive-locator"), false);
});
