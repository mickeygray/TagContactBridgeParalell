"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { TrainingAttempt } = require("../../packages/shared-models/src");
const {
  GAUNTLET_ATTEMPT_STATUSES,
  GAUNTLET_PERSISTED_EVENT_TYPES,
  normalizeGauntletState,
} = require("../../packages/shared-services/src/trainerGauntletState");

function validState(overrides = {}) {
  return {
    schemaVersion: "1",
    experienceMode: "gauntlet",
    direction: "inbound",
    sectionId: "fixture-section-listen-clarify",
    status: "in_progress",
    stateVersion: 1,
    runNumber: 0,
    nextTurn: 1,
    currentNodeId: "fixture-node-start",
    blueprintId: "fixture-blueprint-listen-clarify",
    blueprintVersion: "1.0.0-test",
    variantId: "fixture-variant-calm",
    variantVersion: "1.0.0-test",
    promptVersion: "1.0.0-test",
    graderVersion: "1.0.0-test",
    voiceProfileId: "fixture-voice-calm",
    audioManifestId: "fixture-audio-manifest",
    criteria: [{
      criterionId: "fixture-criterion-acknowledge",
      ruleId: "fixture-rule-acknowledge",
      ruleRevision: "1.0.0-test",
      status: "pending",
      evidenceTurnIds: [],
    }],
    retryByNode: {},
    hintLevelByNode: {},
    completedVariantIds: [],
    lastAcceptedEventId: null,
    invalidationReasonCode: null,
    ...overrides,
  };
}

test("Targeted Talk state requires a fully pinned, bounded runtime identity", () => {
  const state = normalizeGauntletState(validState());
  assert.equal(Object.isFrozen(state), true);
  assert.equal(state.currentNodeId, "fixture-node-start");
  assert.equal(state.stateVersion, 1);
  assert.equal(state.lastAcceptedEventId, null);

  for (const mutate of [
    { status: "unrecognized" },
    { nextTurn: -1 },
    { sectionId: "" },
    { direction: "sideways" },
    { experienceMode: "free" },
    { audioManifestId: null },
    { criteria: [{ ...validState().criteria[0], status: "model-passed" }] },
  ]) {
    assert.throws(() => normalizeGauntletState(validState(mutate)), TypeError);
  }
});

test("TrainingAttempt reserves persisted event names and the opaque Gauntlet checkpoint", () => {
  assert.ok(TrainingAttempt.schema.path("gauntletState"));
  const eventType = TrainingAttempt.schema.path("events").schema.path("type");
  for (const type of GAUNTLET_PERSISTED_EVENT_TYPES) {
    assert.ok(eventType.enumValues.includes(type), type);
  }
  assert.ok(GAUNTLET_ATTEMPT_STATUSES.includes("invalidated"));
});

test("attempt event append binds the ordinary and Gauntlet state revisions atomically", async () => {
  const repository = require("../../packages/shared-repositories/src/trainingCourseRepository");
  const originalFindOneAndUpdate = TrainingAttempt.findOneAndUpdate;
  const originalFindOne = TrainingAttempt.findOne;
  let captured = null;

  TrainingAttempt.findOneAndUpdate = (query, update) => {
    captured = { query, update };
    return { lean: async () => ({ attemptId: "fixture-attempt", eventIds: ["fixture-event"], version: 2, gauntletState: validState({ stateVersion: 2, nextTurn: 2 }) }) };
  };
  TrainingAttempt.findOne = () => ({ lean: async () => null });

  try {
    const result = await repository.appendAttemptEvent({
      attemptId: "fixture-attempt",
      eventId: "fixture-event",
      expectedVersion: 1,
      expectedGauntletStateVersion: 1,
      event: { eventId: "fixture-event", sequence: 2, type: "gauntlet_turn_accepted", occurredAt: new Date("2026-07-29T17:00:00.000Z"), expectedPriorVersion: 1 },
      gauntletState: validState({ stateVersion: 2, nextTurn: 2 }),
    });
    assert.equal(result.conflict, false);
    assert.equal(result.duplicate, false);
    assert.equal(captured.query.version, 1);
    assert.equal(captured.query["gauntletState.stateVersion"], 1);
    assert.equal(captured.update.$set.gauntletState.stateVersion, 2);
  } finally {
    TrainingAttempt.findOneAndUpdate = originalFindOneAndUpdate;
    TrainingAttempt.findOne = originalFindOne;
  }
});