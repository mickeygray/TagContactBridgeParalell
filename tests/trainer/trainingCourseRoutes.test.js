"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  createSalesTrainerCourseRouter,
} = require("../../apps/control-plane/src/routes/salesTrainerCourse");
const {
  createSalesTrainerRouter,
} = require("../../apps/control-plane/src/routes/salesTrainer");
const {
  issueSalesTrainerToken,
} = require("../../packages/shared-services/src/taxResolutionSalesTrainerService");

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

async function requestJson(
  baseUrl,
  path,
  { method = "GET", body, headers = {} } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    body: await response.json(),
  };
}

function serviceStub() {
  const calls = [];
  const record = (operation, result) => async (input) => {
    calls.push({ operation, input });
    return result;
  };
  return {
    calls,
    getHome: record("getHome", {
      course: {
        courseId: "fixture-course",
        courseVersion: "1-test",
        title: "Fixture",
        status: "published",
      },
      enrollment: null,
      capabilities: {
        courseV1Enabled: true,
        gauntletV1Enabled: false,
        callReviewV1Enabled: false,
      },
    }),
    enroll: record("enroll", { enrollment: { enrollmentId: "enrollment-1" } }),
    getItem: record("getItem", {
      item: {
        itemId: "item-1",
        content: { prompt: "Synthetic prompt" },
      },
    }),
    startAttempt: record("startAttempt", {
      attempt: { attemptId: "attempt-1", version: 0 },
    }),
    submitAnswer: record("submitAnswer", {
      attemptId: "attempt-1",
      version: 1,
      grade: { passed: true, score: 1, evidence: ["canonical_match"] },
    }),
    completeAttempt: record("completeAttempt", {
      attemptId: "attempt-1",
      version: 2,
    }),
    addReflection: record("addReflection", {
      attemptId: "attempt-1",
      version: 3,
    }),
    getResults: record("getResults", {
      attempt: { attemptId: "attempt-1", version: 3 },
      events: [],
    }),
  };
}

test("course routes derive learner/company from authenticated server state", async (t) => {
  const courseService = serviceStub();
  const middleware = [];
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      middleware.push("auth");
      req.salesTrainerUser = { email: "learner@example.test" };
      req.user = {
        email: "learner@example.test",
        company: "TAG",
      };
      next();
    },
    courseLimit(_req, _res, next) {
      middleware.push("limit");
      next();
    },
    courseService,
  });
  const baseUrl = await listen(t, router);

  const home = await requestJson(baseUrl, "/course/home");
  assert.equal(home.status, 200);
  assert.match(home.cacheControl, /no-store/);
  assert.match(home.cacheControl, /no-cache/);
  assert.deepEqual(middleware, ["limit", "auth"]);
  assert.deepEqual(courseService.calls[0], {
    operation: "getHome",
    input: {
      principal: {
        email: "learner@example.test",
        company: "TAG",
      },
      courseAlias: null,
    },
  });

  const attempt = await requestJson(baseUrl, "/attempts", {
    method: "POST",
    body: {
      itemId: "item-1",
      requestId: "request-1",
    },
  });
  assert.equal(attempt.status, 200);
  assert.deepEqual(courseService.calls.at(-1).input, {
    principal: {
      email: "learner@example.test",
      company: "TAG",
    },
    itemId: "item-1",
    requestId: "request-1",
  });

  const answer = await requestJson(baseUrl, "/attempts/attempt-1/answers", {
    method: "POST",
    body: {
      answer: "a",
      eventId: "answer-event-1",
      expectedVersion: 0,
    },
  });
  assert.equal(answer.status, 200);
  assert.equal(courseService.calls.at(-1).operation, "submitAnswer");
  assert.equal(courseService.calls.at(-1).input.answer, "a");
});

test("Gauntlet turn route accepts only learner text and server CAS fields", async (t) => {
  const calls = [];
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = { email: "learner@example.test" };
      req.user = { email: "learner@example.test", company: "TAG" };
      next();
    },
    courseService: serviceStub(),
    gauntletService: {
      async submitTextTurn(input) {
        calls.push(input);
        return { state: { status: "in_progress", nextTurn: 2 } };
      },
      async gradeModuleAnswer(input) {
        calls.push(input);
        return { passed: true, score: 1, feedback: "Synthetic feedback." };
      },
    },
  });
  const baseUrl = await listen(t, router);
  const accepted = await requestJson(
    baseUrl,
    "/course/gauntlet/attempts/attempt-1/turns",
    {
      method: "POST",
      body: {
        eventId: "event-1",
        expectedVersion: 1,
        expectedTurn: 1,
        text: "Synthetic learner response.",
      },
    },
  );
  assert.equal(accepted.status, 200);
  assert.equal(calls[0].text, "Synthetic learner response.");
  assert.equal("evidence" in calls[0], false);

  const rejected = await requestJson(
    baseUrl,
    "/course/gauntlet/attempts/attempt-1/turns",
    {
      method: "POST",
      body: {
        eventId: "event-2",
        expectedVersion: 1,
        expectedTurn: 1,
        text: "Synthetic.",
        evidence: [{ criterionId: "browser-invented" }],
      },
    },
  );
  assert.equal(rejected.status, 422);

  const reflection = await requestJson(
    baseUrl,
    "/course/gauntlet/attempts/attempt-1/module-answer",
    { method: "POST", body: { answer: "Synthetic reflection." } },
  );
  assert.equal(reflection.status, 200);
  assert.equal(calls.at(-1).answer, "Synthetic reflection.");
  assert.deepEqual(calls.at(-1).principal, {
    email: "learner@example.test",
    company: "TAG",
  });

  const forgedReflection = await requestJson(
    baseUrl,
    "/course/gauntlet/attempts/attempt-1/module-answer",
    {
      method: "POST",
      body: { answer: "Synthetic.", gradingPoints: ["browser-owned"] },
    },
  );
  assert.equal(forgedReflection.status, 422);
});

test("sealed Free Call routes reject browser profile and recording authority", async (t) => {
  const calls = [];
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = { email: "learner@example.test" };
      req.user = { email: "learner@example.test", company: "TAG" };
      next();
    },
    courseService: serviceStub(),
    freeCallService: {
      async get(input) { calls.push({ operation: "get", input }); return { status: "ready" }; },
      async mint(input) { calls.push({ operation: "mint", input }); return { status: "ready" }; },
      async submitTextTurn(input) { calls.push({ operation: "turn", input }); return { status: "ready" }; },
      async mergeObserverState(input) { calls.push({ operation: "observer", input }); return { status: "ready" }; },
    },
  });
  const baseUrl = await listen(t, router);
  const accepted = await requestJson(baseUrl, "/course/free-call/attempts/attempt-1/turns", {
    method: "POST",
    body: {
      eventId: "turn-1",
      expectedVersion: 0,
      expectedTurn: 1,
      text: "Hello.",
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(calls.at(-1).operation, "turn");
  assert.equal("profileId" in calls.at(-1).input, false);

  const rejected = await requestJson(baseUrl, "/course/free-call/attempts/attempt-1/turns", {
    method: "POST",
    body: {
      eventId: "turn-2",
      expectedVersion: 1,
      expectedTurn: 2,
      text: "Hello.",
      profileId: "browser-selected",
      recordTurn: false,
    },
  });
  assert.equal(rejected.status, 422);
  assert.equal(calls.filter((call) => call.operation === "turn").length, 1);
});

test("course routes reject browser authority fields before the service", async (t) => {
  const courseService = serviceStub();
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = {
        email: "learner@example.test",
        company: "TAG",
      };
      req.user = req.salesTrainerUser;
      next();
    },
    courseService,
  });
  const baseUrl = await listen(t, router);

  const attempt = await requestJson(baseUrl, "/attempts", {
    method: "POST",
    body: {
      itemId: "item-1",
      requestId: "request-1",
      enrollmentId: "browser-selected-enrollment",
      courseId: "browser-selected-course",
    },
  });
  assert.equal(attempt.status, 422);
  assert.equal(courseService.calls.length, 0);

  const answer = await requestJson(baseUrl, "/attempts/attempt-1/answers", {
    method: "POST",
    body: {
      answer: "Browser answer",
      eventId: "answer-event-1",
      expectedVersion: 0,
      questionId: "browser-selected-question",
      canonicalAnswer: "Browser answer",
      rubric: { passEverything: true },
      learnerEmail: "other@example.test",
      company: "OTHER",
    },
  });
  assert.equal(answer.status, 422);
  assert.equal(courseService.calls.length, 0);
  assert.equal(
    JSON.stringify(answer.body).includes("browser-selected-question"),
    false,
  );
});

test("course routes reload company when reduced Trainer principal omits it", async (t) => {
  const courseService = serviceStub();
  const accountReads = [];
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = { email: "learner@example.test" };
      req.user = { email: "learner@example.test" };
      next();
    },
    userAccountRepository: {
      async findUserAccountByEmail(email) {
        accountReads.push(email);
        return { email, company: "WYNN" };
      },
    },
    courseService,
  });
  const baseUrl = await listen(t, router);

  const home = await requestJson(baseUrl, "/course/home");
  assert.equal(home.status, 200);
  assert.deepEqual(accountReads, ["learner@example.test"]);
  assert.equal(courseService.calls[0].input.principal.company, "WYNN");
});

test("course route errors are neutral and do not leak private service detail", async (t) => {
  const privateError = Object.assign(
    new Error("private rubric https://private.example.test"),
    {
      status: 503,
      code: "PRIVATE_INTERNAL_CODE",
    },
  );
  const router = createSalesTrainerCourseRouter({
    requireSalesTrainerAccess(req, _res, next) {
      req.salesTrainerUser = {
        email: "learner@example.test",
        company: "TAG",
      };
      req.user = req.salesTrainerUser;
      next();
    },
    courseService: {
      async getHome() {
        throw privateError;
      },
    },
  });
  const baseUrl = await listen(t, router);
  const result = await requestJson(baseUrl, "/course/home");
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "TRAINER_COURSE_UNAVAILABLE");
  assert.equal(JSON.stringify(result.body).includes("private.example.test"), false);
  assert.equal(JSON.stringify(result.body).includes("PRIVATE_INTERNAL_CODE"), false);
});

test("allowlist tokens rebuild a server-owned company and revalidate membership", async (t) => {
  const email = "allowlisted-course@example.test";
  const previousAllowed = process.env.SALES_TRAINER_ALLOWED_EMAILS;
  const previousCourseFlag = process.env.SALES_TRAINER_COURSE_V1_ENABLED;
  process.env.SALES_TRAINER_ALLOWED_EMAILS = email;
  process.env.SALES_TRAINER_COURSE_V1_ENABLED = "true";
  t.after(() => {
    if (previousAllowed == null) {
      delete process.env.SALES_TRAINER_ALLOWED_EMAILS;
    } else {
      process.env.SALES_TRAINER_ALLOWED_EMAILS = previousAllowed;
    }
    if (previousCourseFlag == null) {
      delete process.env.SALES_TRAINER_COURSE_V1_ENABLED;
    } else {
      process.env.SALES_TRAINER_COURSE_V1_ENABLED = previousCourseFlag;
    }
  });

  const config = { jwtSecret: "synthetic-trainer-route-secret" };
  const issued = issueSalesTrainerToken(config, email, null);
  const passthrough = (_req, _res, next) => next();
  const baseUrl = await listen(
    t,
    createSalesTrainerRouter(
      { requireAuth: passthrough, requireAdmin: passthrough },
      config,
    ),
  );
  const headers = { authorization: `Bearer ${issued.token}` };
  const check = await requestJson(baseUrl, "/auth/check", { headers });
  assert.equal(check.status, 200);
  assert.equal(check.body.user.company, "TAG");
  assert.equal(check.body.user.trainerAccess, "allowlist");


  process.env.SALES_TRAINER_ALLOWED_EMAILS = "removed@example.test";
  const removed = await requestJson(baseUrl, "/auth/check", { headers });
  assert.equal(removed.status, 401);
});
