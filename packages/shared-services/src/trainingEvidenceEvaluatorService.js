"use strict";

function evaluatorError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createTrainingEvidenceEvaluatorService({ evaluateSemantic }) {
  if (typeof evaluateSemantic !== "function") {
    throw new TypeError("evaluateSemantic is required");
  }

  async function evaluate({ scenario, state, turnId, text }) {
    const node = (scenario?.nodes || []).find(
      (entry) => entry.id === state?.currentNodeId,
    );
    if (!node || node.sectionId !== scenario.sectionId) {
      throw evaluatorError("TRAINER_EVIDENCE_NODE_INVALID");
    }
    const criteria = new Map(
      (node.requiredCriteria || []).map((criterion) => [
        criterion.criterionId,
        criterion,
      ]),
    );
    if (criteria.size === 0) return [];

    const proposed = await evaluateSemantic({
      text,
      turnId,
      criteria: [...criteria.values()].map((criterion) => ({
        criterionId: criterion.criterionId,
        ruleId: criterion.ruleId,
        ruleRevision: criterion.ruleRevision,
      })),
    });
    if (!Array.isArray(proposed)) {
      throw evaluatorError("TRAINER_EVIDENCE_OUTPUT_INVALID");
    }

    return proposed.map((entry) => {
      const criterion = criteria.get(entry?.criterionId);
      if (
        !criterion ||
        entry.status !== "satisfied" ||
        entry.ruleId !== criterion.ruleId ||
        entry.ruleRevision !== criterion.ruleRevision ||
        !Array.isArray(entry.citedTurnIds) ||
        !entry.citedTurnIds.includes(turnId)
      ) {
        throw evaluatorError("TRAINER_EVIDENCE_OUTPUT_INVALID");
      }
      return {
        criterionId: criterion.criterionId,
        ruleId: criterion.ruleId,
        ruleRevision: criterion.ruleRevision,
        status: "satisfied",
        citedTurnIds: [...new Set(entry.citedTurnIds)],
      };
    });
  }

  return Object.freeze({ evaluate });
}

module.exports = {
  createTrainingEvidenceEvaluatorService,
  evaluatorError,
};
