"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { classifyCxTerminalOutcome } = require("../../packages/shared-services/src/cxCadenceService");
const {
  buildBadNumberAlertEmail,
  createCxBadNumberOutcomeHandler,
  isBadNumberOutcome,
} = require("../../packages/shared-services/src/cxBadNumberOutcomeService");

test("bad-number terminal outcomes classify as DNC for cadence", () => {
  const classification = classifyCxTerminalOutcome({
    sourceService: "cx-bulk-load",
    outcome: "bad_number",
  });
  assert.equal(classification.safeToAdvance, true);
  assert.equal(classification.normalizedOutcome, "dnc");
  assert.equal(classification.matchedValue, "bad_number");
});

test("bad-number detector accepts the explicit button outcome", () => {
  assert.equal(isBadNumberOutcome({ outcome: "bad_number" }), true);
  assert.equal(isBadNumberOutcome({ badNumber: true }), true);
  assert.equal(isBadNumberOutcome({ outcome: "did_not_connect" }), false);
});

test("bad-number alert email names the Wynn case plainly", () => {
  const email = buildBadNumberAlertEmail({ domain: "WYNN", caseId: 101617 });
  assert.equal(email.subject, "[CX Bad Number] Wynn Case 101617");
  assert.match(email.text, /Wynn Case ID 101617 was a disconnected or out of service number\./);
});

test("bad-number handler marks Logics DNC, sends one alert, and stamps queue metadata", async () => {
  const updates = [];
  const logicsCalls = [];
  const emails = [];
  const handler = createCxBadNumberOutcomeHandler({
    findQueueItemById: async () => ({
      _id: "q1",
      domain: "WYNN",
      caseId: 101617,
      metadata: {},
    }),
    updateQueueItem: async (id, patch) => {
      updates.push({ id, patch });
      return { id, ...patch };
    },
    updateLogicsDncStatus: async (input) => {
      logicsCalls.push(input);
      return { ok: true, workflowId: "wf-dnc" };
    },
    sendMail: async (domain, message) => {
      emails.push({ domain, message });
      return { messageId: "msg-1" };
    },
    alertRecipient: "mgray@taxadvocategroup.com",
    now: () => new Date("2026-07-08T12:00:00.000Z"),
    logger: { info() {}, warn() {} },
  });

  const result = await handler.handle({
    payload: {
      queueItemId: "q1",
      outcome: "bad_number",
      badNumber: true,
      badNumberReason: "disconnected-or-out-of-service",
      agentEmail: "agent@example.com",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.domain, "WYNN");
  assert.equal(result.caseId, 101617);
  assert.equal(logicsCalls.length, 1);
  assert.deepEqual(logicsCalls[0], {
    domain: "WYNN",
    caseId: 101617,
    actorEmail: "agent@example.com",
    notes: "DNC set from CX Bad Number button: disconnected or out of service number.",
  });
  assert.equal(emails.length, 1);
  assert.equal(emails[0].domain, "TAG");
  assert.equal(emails[0].message.to, "mgray@taxadvocategroup.com");
  assert.match(emails[0].message.text, /Wynn Case ID 101617 was a disconnected or out of service number\./);
  assert.ok(updates.some(({ patch }) => patch["metadata.badNumberOutcome.logicsDncAt"]));
  assert.ok(updates.some(({ patch }) => patch["metadata.badNumberOutcome.emailSentAt"]));
});

test("bad-number handler is idempotent when queue metadata already carries side-effect stamps", async () => {
  const logicsCalls = [];
  const emails = [];
  const handler = createCxBadNumberOutcomeHandler({
    findQueueItemById: async () => ({
      _id: "q1",
      domain: "WYNN",
      caseId: 101617,
      metadata: {
        badNumberOutcome: {
          logicsDncAt: "2026-07-08T12:00:00.000Z",
          emailSentAt: "2026-07-08T12:00:01.000Z",
        },
      },
    }),
    updateQueueItem: async () => ({}),
    updateLogicsDncStatus: async (input) => {
      logicsCalls.push(input);
      return { ok: true };
    },
    sendMail: async (domain, message) => {
      emails.push({ domain, message });
      return { messageId: "msg-2" };
    },
    logger: { info() {}, warn() {} },
  });

  const result = await handler.handle({
    payload: { queueItemId: "q1", outcome: "bad_number", badNumber: true },
  });

  assert.equal(result.ok, true);
  assert.equal(logicsCalls.length, 0);
  assert.equal(emails.length, 0);
  assert.equal(result.logicsResult.skipped, true);
  assert.equal(result.emailResult.skipped, true);
});
