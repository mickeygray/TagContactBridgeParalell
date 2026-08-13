"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const models = require("../../packages/shared-models/src");
const repositories = require("../../packages/shared-repositories/src");
const services = require("../../packages/shared-services/src");
const {
  createTrainerSessionAuditService,
  getTrainerSessionAuditConfig,
  gradeLetter,
  renderReport,
  softwareAssessment,
} = require("../../packages/shared-services/src/trainerSessionAuditService");

function fixtureSession(overrides = {}) {
  return {
    sessionKey: "free:fixture-session",
    sourceId: "fixture-session",
    learnerEmailNormalized: "learner@example.test",
    companySnapshot: "TAG",
    kind: "free_conversation",
    title: "Free conversation",
    status: "reporting",
    startedAt: new Date("2026-08-13T16:00:00.000Z"),
    lastActivityAt: new Date("2026-08-13T16:05:00.000Z"),
    endedAt: new Date("2026-08-13T16:05:00.000Z"),
    endReason: "completed",
    reportAttempts: 1,
    reportGeneration: 1,
    metrics: {
      turns: 1,
      learnerWords: 8,
      prospectWords: 6,
      answers: 0,
      failedAnswers: 0,
      retries: 0,
      errors: 0,
      conflicts: 0,
      noSpeech: 0,
      sttFailures: 0,
      ttsFailures: 0,
      slowTurns: 0,
      totalTurnLatencyMs: 4000,
      maxTurnLatencyMs: 4000,
      errorCodes: [],
    },
    turns: [{
      eventId: "turn:1",
      sequence: 1,
      kind: "conversation",
      learnerText: "I am calling to understand what happened.",
      prospectText: "Why are you calling me?",
      outcome: "turn completed",
      latencyMs: 4000,
      occurredAt: new Date("2026-08-13T16:01:00.000Z"),
    }],
    ...overrides,
  };
}

test("trainer session audit persistence is exported with bounded queue indexes", () => {
  assert.ok(models.TrainerSessionAudit);
  assert.ok(models.listModels().includes("TrainerSessionAudit"));
  assert.ok(repositories.trainerSessionAuditRepository);
  assert.ok(services.trainerSessionAuditService);
  const schema = models.TrainerSessionAudit.schema;
  assert.ok(schema.path("sessionKey"));
  assert.ok(schema.path("turns"));
  assert.ok(schema.path("expiresAt"));
  assert.equal(
    schema.indexes().some(([fields, options]) =>
      JSON.stringify(fields) === JSON.stringify({ expiresAt: 1 }) &&
      options.expireAfterSeconds === 0),
    true,
  );
  assert.equal(
    schema.indexes().some(([fields]) =>
      JSON.stringify(fields) === JSON.stringify({ status: 1, nextReportAttemptAt: 1, lastActivityAt: 1 })),
    true,
  );
});

test("audit defaults off and monitoring requires an exact learner allowlist", () => {
  const config = getTrainerSessionAuditConfig({
    enabled: true,
    monitoredLearners: ["one@example.test"],
    recipients: ["owner@example.test"],
  });
  assert.equal(config.enabled, true);
  const service = createTrainerSessionAuditService({
    config,
    repository: {},
    courseRepository: {},
  });
  assert.equal(service.isMonitored({ email: "ONE@example.test" }), true);
  assert.equal(service.isMonitored({ email: "two@example.test" }), false);
  service.stop();
});

test("software grade is deterministic and does not alter the trainee grade", () => {
  assert.equal(gradeLetter(94), "A");
  assert.equal(gradeLetter(81), "B-");
  const healthy = softwareAssessment(fixtureSession());
  assert.equal(healthy.score, 100);
  assert.equal(healthy.grade, "A");

  const degraded = softwareAssessment(fixtureSession({
    endReason: "abandoned_idle",
    metrics: {
      ...fixtureSession().metrics,
      errors: 1,
      sttFailures: 1,
      noSpeech: 2,
      slowTurns: 1,
    },
  }));
  assert.ok(degraded.score < healthy.score);
  assert.ok(degraded.issues.includes("sttFailures: 1"));
  assert.equal(degraded.stuckSignals, 2);
});

test("report contains both grades and safely escapes trainee transcript", () => {
  const session = fixtureSession({
    turns: [{
      ...fixtureSession().turns[0],
      learnerText: "<script>alert('x')</script> I can help.",
    }],
  });
  const trainee = {
    score: 84,
    grade: "B",
    verdict: "solid",
    summary: "Good start.",
    strengths: ["Asked a direct question."],
    gaps: ["Needed one more discovery question."],
    nextPractice: "Ask for the timeline.",
    stuckPoint: "Discovery depth.",
  };
  const rendered = renderReport(session, trainee, softwareAssessment(session));
  assert.match(rendered.subject, /trainee B, software A/);
  assert.match(rendered.text, /TRAINEE — B/);
  assert.match(rendered.text, /SOFTWARE — A/);
  assert.doesNotMatch(rendered.html, /<script>/i);
  assert.match(rendered.html, /&lt;script&gt;/);
});

test("one claimed session produces one dual-grade email and durable reported state", async () => {
  const session = fixtureSession();
  const calls = { mail: [], reported: [], failed: [] };
  let claim = session;
  const repository = {
    async findStaleActive() { return []; },
    async claimNextReport() {
      const value = claim;
      claim = null;
      return value;
    },
    async markReported(input) { calls.reported.push(input); return { status: "reported" }; },
    async markReportFailed(input) { calls.failed.push(input); return null; },
  };
  const anthropicClient = {
    async createMessage() {
      return {
        model: "fixture-model",
        content: [{
          type: "tool_use",
          name: "submit_trainer_session_grade",
          input: {
            score: 88,
            verdict: "solid",
            summary: "The trainee established purpose and stayed curious.",
            strengths: ["Clear purpose."],
            gaps: ["Could probe urgency."],
            nextPractice: "Ask one more timeline question.",
            stuckPoint: "No material stall.",
          },
        }],
      };
    },
  };
  const service = createTrainerSessionAuditService({
    config: {
      enabled: true,
      monitoredLearners: ["learner@example.test"],
      recipients: ["owner@example.test"],
      maxReportAttempts: 3,
    },
    repository,
    courseRepository: {},
    anthropicClient,
    mailer: {
      async sendMail(domain, options) {
        calls.mail.push({ domain, options });
        return { messageId: "fixture-message" };
      },
    },
    clock: () => new Date("2026-08-13T16:06:00.000Z"),
  });

  await service.processOneReport();
  await service.processOneReport();
  assert.equal(calls.mail.length, 1);
  assert.deepEqual(calls.mail[0].options.to, ["owner@example.test"]);
  assert.match(calls.mail[0].options.subject, /trainee B\+, software A/);
  assert.equal(calls.reported.length, 1);
  assert.equal(calls.reported[0].report.trainee.score, 88);
  assert.equal(calls.reported[0].report.software.score, 100);
  assert.equal(calls.failed.length, 0);
  service.stop();
});
