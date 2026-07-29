"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { advanceGauntletTurn } = require("../../packages/shared-services/src/trainingGauntletController");
const { buildValidTrainingContentFixture } = require("../fixtures/trainer/trainingContentRegistry.fixture");

function initialState(scenario) {
  const variant = scenario.variants[0];
  return {
    schemaVersion: "1", experienceMode: "gauntlet", direction: scenario.direction,
    sectionId: scenario.sectionId, status: "ready", stateVersion: 0, runNumber: 0,
    nextTurn: 1, currentNodeId: scenario.startNodeId, blueprintId: scenario.id,
    blueprintVersion: scenario.version, variantId: variant.variantId, variantVersion: variant.version,
    promptVersion: "fixture-prompt", graderVersion: "fixture-grader", voiceProfileId: variant.voiceProfileId,
    audioManifestId: scenario.audioManifest.id,
    criteria: scenario.nodes.flatMap((node) => node.requiredCriteria || []).map((criterion) => ({
      criterionId: criterion.criterionId, ruleId: criterion.ruleId, ruleRevision: criterion.ruleRevision,
      status: "pending", evidenceTurnIds: [],
    })),
    retryByNode: {}, hintLevelByNode: {}, completedVariantIds: [], lastAcceptedEventId: null,
    invalidationReasonCode: null,
  };
}

test("the deterministic controller advances only by the declared local graph", () => {
  const scenario = buildValidTrainingContentFixture().scenarioBlueprints[0];
  const first = advanceGauntletTurn({ scenario, state: initialState(scenario), turnId: "turn-1" });
  assert.equal(first.selectedEdgeId, "fixture-edge-open");
  assert.equal(first.nextState.currentNodeId, "fixture-node-check");
  assert.equal(first.reactionIntent, "React to the learner's acknowledgement and clarification.");

  const second = advanceGauntletTurn({
    scenario,
    state: first.nextState,
    turnId: "turn-2",
    evidence: [
      { criterionId: "fixture-criterion-acknowledge", ruleId: "fixture-rule-alpha", ruleRevision: "1.0.0-test", status: "satisfied", citedTurnIds: ["turn-2"] },
      { criterionId: "fixture-criterion-clarify", ruleId: "fixture-rule-beta", ruleRevision: "1.0.0-test", status: "satisfied", citedTurnIds: ["turn-2"] },
    ],
  });
  assert.equal(second.selectedEdgeId, "fixture-edge-finish");
  assert.equal(second.terminal, "passed");
  assert.equal(second.nextState.status, "passed");
});

test("the controller rejects evidence that is not tied to this turn and never trusts a model pass", () => {
  const scenario = buildValidTrainingContentFixture().scenarioBlueprints[0];
  const first = advanceGauntletTurn({ scenario, state: initialState(scenario), turnId: "turn-1" });
  assert.throws(() => advanceGauntletTurn({
    scenario, state: first.nextState, turnId: "turn-2",
    evidence: [{ criterionId: "fixture-criterion-acknowledge", ruleId: "fixture-rule-alpha", ruleRevision: "1.0.0-test", status: "satisfied", citedTurnIds: ["other-turn"] }],
  }), (error) => error.code === "GAUNTLET_EVIDENCE_REJECTED");

  const failed = advanceGauntletTurn({ scenario, state: first.nextState, turnId: "turn-2" });
  assert.equal(failed.terminal, "failed");
  assert.equal(failed.nextState.status, "failed");
});

test("the controller fails closed on a changed section or pinned blueprint", () => {
  const scenario = buildValidTrainingContentFixture().scenarioBlueprints[0];
  assert.throws(() => advanceGauntletTurn({ scenario: { ...scenario, sectionId: "escaped" }, state: initialState(scenario), turnId: "turn-1" }), (error) => error.code === "GAUNTLET_PINNED_IDENTITY_MISMATCH" || error.code === "GAUNTLET_SECTION_BOUNDARY");
  assert.throws(() => advanceGauntletTurn({ scenario, state: { ...initialState(scenario), blueprintVersion: "changed" }, turnId: "turn-1" }), (error) => error.code === "GAUNTLET_PINNED_IDENTITY_MISMATCH");
});
test("a failed run stays inside its attempt and can restart on an unused variant", () => {
  const scenario = buildValidTrainingContentFixture().scenarioBlueprints[0];
  const { startRetryRun } = require("../../packages/shared-services/src/trainingGauntletController");
  const retried = startRetryRun({ scenario, state: { ...initialState(scenario), status: "failed", currentNodeId: "fixture-node-terminal" }, eventId: "retry-1" });
  assert.equal(retried.runNumber, 1);
  assert.equal(retried.nextTurn, 1);
  assert.equal(retried.variantId, "fixture-variant-direct");
  assert.equal(retried.status, "ready");
});
