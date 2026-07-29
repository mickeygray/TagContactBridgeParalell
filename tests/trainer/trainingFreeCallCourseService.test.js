"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createTrainingFreeCallCourseService,
} = require("../../packages/shared-services/src/trainingFreeCallCourseService");

function fixture(overrides = {}) {
  let session = null;
  const service = createTrainingFreeCallCourseService({
    attemptRepository: {
      findAttemptById: async () => ({ attemptId: "attempt-1", itemType: "free_call" }),
    },
    sessionRepository: {
      findByAttemptId: async () => session,
      create: async (value) => (session = value),
      appendTurnCas: async ({ eventId, inputFingerprint, expectedVersion, expectedTurn, turn }) => {
        if (session.version !== expectedVersion || session.nextTurn !== expectedTurn) return { conflict: true };
        session = {
          ...session,
          version: session.version + 1,
          nextTurn: session.nextTurn + 1,
          turns: [...(session.turns || []), { eventId, inputFingerprint, payload: turn }],
        };
        return { session, turn };
      },
      mergeObserverCas: async ({ expectedVersion, expectedTurn }) => {
        if (session.version !== expectedVersion || session.nextTurn !== expectedTurn) return { conflict: true };
        session = { ...session, version: session.version + 1 };
        return { session };
      },
    },
    authorizeAttempt: async () => true,
    resolveServerProfile: async () => ({
      profileId: "profile-1",
      voiceProfileId: "voice-1",
      direction: "outbound",
      playbook: { promptVersion: "fixture" },
      messages: [],
      prospectState: {},
    }),
    runSalesTrainerTurn: async (input) => ({
      reply: "Tell me more.",
      messages: [{ role: "user", content: input.text }],
      prospectState: { disposition: "curious" },
    }),
    evaluateTransfer: async () => [{ criterionId: "transfer-1", citedTurnIds: ["turn-1"] }],
    flagsProvider: () => ({ courseV1Enabled: true }),
    now: () => new Date("2026-07-29T23:59:59.000Z"),
    ...overrides,
  });
  return { service, readSession: () => session };
}

test("sealed Free Call mints all profile authority server-side and pins manifest date", async () => {
  const { service, readSession } = fixture();
  const result = await service.mint({ attemptId: "attempt-1", requestId: "session-1", principal: {} });
  assert.equal(result.session.manifestDate, "2026-07-29");
  assert.equal(readSession().sealed.playbook.promptVersion, "fixture");
  assert.equal(readSession().nextTurn, 1);
});

test("sealed Free Call turn accepts text and CAS stamps but no client profile authority", async () => {
  const { service } = fixture();
  await service.mint({ attemptId: "attempt-1", requestId: "session-1", principal: {} });
  const result = await service.submitTextTurn({
    attemptId: "attempt-1",
    eventId: "turn-1",
    expectedVersion: 0,
    expectedTurn: 1,
    text: "Hi, this is Michael.",
    principal: {},
  });
  assert.equal(result.session.nextTurn, 2);
  assert.equal(result.turn.reply, "Tell me more.");
  const duplicate = await service.submitTextTurn({
    attemptId: "attempt-1",
    eventId: "turn-1",
    expectedVersion: 0,
    expectedTurn: 1,
    text: "Hi, this is Michael.",
    principal: {},
  });
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(service.submitTextTurn({
    attemptId: "attempt-1",
    eventId: "turn-1",
    expectedVersion: 0,
    expectedTurn: 1,
    text: "Changed payload.",
    principal: {},
  }), { code: "TRAINER_FREE_CALL_CONFLICT" });
});

test("stale observer writes cannot race the in-band Free Call turn", async () => {
  const { service } = fixture();
  await service.mint({ attemptId: "attempt-1", requestId: "session-1", principal: {} });
  await service.submitTextTurn({
    attemptId: "attempt-1", eventId: "turn-1", expectedVersion: 0,
    expectedTurn: 1, text: "Hello", principal: {},
  });
  await assert.rejects(service.mergeObserverState({
    attemptId: "attempt-1", eventId: "observer-1", expectedVersion: 0,
    expectedTurn: 1, prospectState: {}, principal: {},
  }), { code: "TRAINER_FREE_CALL_CONFLICT" });
});

test("Free Call evaluation records transfer only and never implies certification", async () => {
  const { service } = fixture();
  const result = await service.evaluate({ attemptId: "attempt-1", transcript: [], principal: {} });
  assert.equal(result.masteryDimension, "transfer");
  assert.equal(result.certificationEligible, false);
});
