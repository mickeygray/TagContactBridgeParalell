"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createTrainingEvidenceEvaluatorService,
} = require("../../packages/shared-services/src/trainingEvidenceEvaluatorService");
const {
  buildValidTrainingContentFixture,
} = require("../fixtures/trainer/trainingContentRegistry.fixture");

test("semantic evaluator can propose cited evidence but cannot invent criteria", async () => {
  const scenario = buildValidTrainingContentFixture().scenarioBlueprints[0];
  const state = { currentNodeId: "fixture-node-check" };
  const evaluator = createTrainingEvidenceEvaluatorService({
    evaluateSemantic: async ({ criteria, turnId }) =>
      criteria.map((criterion) => ({
        ...criterion,
        status: "satisfied",
        citedTurnIds: [turnId],
      })),
  });
  const evidence = await evaluator.evaluate({
    scenario,
    state,
    turnId: "turn-2",
    text: "Synthetic acknowledgement and question.",
  });
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every((entry) => entry.citedTurnIds[0] === "turn-2"));

  const invalid = createTrainingEvidenceEvaluatorService({
    evaluateSemantic: async () => [
      {
        criterionId: "invented",
        ruleId: "invented",
        ruleRevision: "invented",
        status: "satisfied",
        citedTurnIds: ["turn-2"],
      },
    ],
  });
  await assert.rejects(
    invalid.evaluate({
      scenario,
      state,
      turnId: "turn-2",
      text: "Synthetic.",
    }),
    (error) => error.code === "TRAINER_EVIDENCE_OUTPUT_INVALID",
  );
});
