"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createTrainingReviewCoachService,
} = require("../../packages/shared-services/src/trainingReviewCoachService");

const rubric = {
  questionId: "fixture-question",
  version: "1-test",
  criteria: [{
    criterionId: "fixture-criterion",
    ruleId: "fixture-rule",
    ruleRevision: "1-test",
    description: "Names the required move",
  }],
};

test("semantic Q&A accepts only server-rubric criteria with cited evidence", async () => {
  const service = createTrainingReviewCoachService({
    gradeSemanticAnswer: async () => ({
      findings: [{
        criterionId: "fixture-criterion",
        ruleId: "fixture-rule",
        ruleRevision: "1-test",
        satisfied: true,
        citedEvidenceIds: ["evidence-1"],
      }],
    }),
  });
  const result = await service.gradeQuestion({
    rubric,
    response: "I would acknowledge and clarify.",
    evidence: [{ evidenceId: "evidence-1", text: "The learner acknowledged concern." }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings[0].citedEvidenceIds, ["evidence-1"]);
});

test("semantic Q&A fails closed on invented or uncited model findings", async () => {
  const invented = createTrainingReviewCoachService({
    gradeSemanticAnswer: async () => ({
      findings: [{
        criterionId: "invented",
        ruleId: "invented",
        ruleRevision: "1",
        satisfied: true,
        citedEvidenceIds: ["evidence-1"],
      }],
    }),
  });
  await assert.rejects(invented.gradeQuestion({
    rubric,
    response: "answer",
    evidence: [{ evidenceId: "evidence-1", text: "evidence" }],
  }), { code: "TRAINER_QA_GRADE_INVALID" });
});

test("Review Coach withholds teaching until reflection and labels model advice", () => {
  const service = createTrainingReviewCoachService({ gradeSemanticAnswer: async () => ({ findings: [] }) });
  const hidden = service.feedbackAfterReflection({
    events: [],
    observedGrade: { passed: false },
    modelSuggestions: [{ title: "Slow down", summary: "Pause after the answer." }],
  });
  assert.equal(hidden.feedbackAvailable, false);
  assert.deepEqual(hidden.thingsToConsider, []);
  const revealed = service.feedbackAfterReflection({
    events: [{ type: "reflection_added", payload: { reflection: "I rushed." } }],
    observedGrade: { passed: false },
    modelSuggestions: [{ title: "Slow down", summary: "Pause after the answer." }],
  });
  assert.equal(revealed.feedbackAvailable, true);
  assert.equal(revealed.thingsToConsider[0].label, "Things to consider");
  assert.equal(revealed.thingsToConsider[0].authority, "model_generated_consideration");
});

test("semantic Q&A converts provider failure to a neutral fail-closed error", async () => {
  const service = createTrainingReviewCoachService({
    gradeSemanticAnswer: async () => {
      throw new Error("provider payload with private detail");
    },
  });
  await assert.rejects(service.gradeQuestion({
    rubric,
    response: "answer",
    evidence: [{ evidenceId: "evidence-1", text: "evidence" }],
  }), (error) =>
    error.code === "TRAINER_QA_GRADER_UNAVAILABLE" &&
    !error.message.includes("private detail"));
});
