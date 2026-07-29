"use strict";

function coachError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeCitations(value, allowedEvidenceIds) {
  if (!Array.isArray(value) || value.length === 0) {
    throw coachError(503, "TRAINER_COACH_CITATION_REQUIRED");
  }
  const citations = [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))];
  if (citations.length === 0 || citations.some((id) => !allowedEvidenceIds.has(id))) {
    throw coachError(503, "TRAINER_COACH_CITATION_INVALID");
  }
  return citations;
}

function createTrainingReviewCoachService({ gradeSemanticAnswer }) {
  if (typeof gradeSemanticAnswer !== "function") {
    throw new TypeError("semantic answer grader is required");
  }

  async function gradeQuestion({ rubric, response, evidence }) {
    if (!rubric?.questionId || !rubric?.version || !Array.isArray(rubric.criteria)) {
      throw coachError(503, "TRAINER_QA_RUBRIC_UNAVAILABLE");
    }
    const answer = String(response || "").trim();
    if (!answer) throw coachError(422, "TRAINER_QA_ANSWER_REQUIRED");
    const safeEvidence = Array.isArray(evidence) ? evidence.map((entry) => ({
      evidenceId: String(entry.evidenceId || ""),
      text: String(entry.text || ""),
    })) : [];
    const allowedEvidenceIds = new Set(safeEvidence.map((entry) => entry.evidenceId).filter(Boolean));
    let raw;
    try {
      raw = await gradeSemanticAnswer({
        questionId: rubric.questionId,
        rubricVersion: rubric.version,
        criteria: rubric.criteria.map(({ criterionId, ruleId, ruleRevision, description }) => ({
          criterionId,
          ruleId,
          ruleRevision,
          description,
        })),
        response: answer,
        evidence: safeEvidence,
      });
    } catch {
      throw coachError(503, "TRAINER_QA_GRADER_UNAVAILABLE");
    }
    const allowedCriteria = new Map(rubric.criteria.map((criterion) => [criterion.criterionId, criterion]));
    const findings = (Array.isArray(raw?.findings) ? raw.findings : []).map((finding) => {
      const criterion = allowedCriteria.get(finding?.criterionId);
      if (!criterion ||
          finding.ruleId !== criterion.ruleId ||
          finding.ruleRevision !== criterion.ruleRevision) {
        throw coachError(503, "TRAINER_QA_GRADE_INVALID");
      }
      return Object.freeze({
        criterionId: criterion.criterionId,
        ruleId: criterion.ruleId,
        ruleRevision: criterion.ruleRevision,
        satisfied: finding.satisfied === true,
        citedEvidenceIds: normalizeCitations(finding.citedEvidenceIds, allowedEvidenceIds),
      });
    });
    return Object.freeze({
      questionId: rubric.questionId,
      rubricVersion: rubric.version,
      passed: rubric.criteria.every((criterion) =>
        findings.some((finding) => finding.criterionId === criterion.criterionId && finding.satisfied)),
      findings: Object.freeze(findings),
    });
  }

  function feedbackAfterReflection({ events, observedGrade, modelSuggestions }) {
    const reflection = [...(events || [])].reverse().find((event) =>
      event?.type === "reflection_added" && String(event?.payload?.reflection || "").trim());
    if (!reflection) {
      return Object.freeze({
        feedbackAvailable: false,
        reflectionRequired: true,
        observedGrade,
        thingsToConsider: Object.freeze([]),
      });
    }
    return Object.freeze({
      feedbackAvailable: true,
      reflectionRequired: false,
      observedGrade,
      reflection: String(reflection.payload.reflection).trim(),
      thingsToConsider: Object.freeze((modelSuggestions || []).map((suggestion) => Object.freeze({
        title: String(suggestion?.title || "Things to consider").trim(),
        summary: String(suggestion?.summary || "").trim(),
        authority: "model_generated_consideration",
        label: "Things to consider",
      }))),
    });
  }

  return Object.freeze({ feedbackAfterReflection, gradeQuestion });
}

module.exports = { createTrainingReviewCoachService };
