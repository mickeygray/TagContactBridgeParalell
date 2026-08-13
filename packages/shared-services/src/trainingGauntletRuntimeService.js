"use strict";

const {
  createAnthropicClient,
  extractToolUse,
} = require("../../shared-integrations/src");
const trainingCourseRepository = require("../../shared-repositories/src/trainingCourseRepository");
const publishedTrainingContent = require("./trainer-content/publishedTrainingContent.v1");
const { getSalesTrainerFeatureFlags } = require("./salesTrainerFeatureFlags");
const {
  createTrainingEvidenceEvaluatorService,
} = require("./trainingEvidenceEvaluatorService");
const {
  createTrainingProspectDialogueService,
} = require("./trainingProspectDialogueService");
const { createTrainingGauntletService } = require("./trainingGauntletService");

function runtimeError(code) {
  const error = new Error(code);
  error.status = 503;
  error.code = code;
  return error;
}

function folded(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

function quoteAppearsIn(quote, text) {
  const needle = folded(quote);
  return needle.length >= 4 && folded(text).includes(needle);
}

function modelName(kind) {
  if (kind === "evaluation") {
    return String(
      process.env.SALES_TRAINER_ANTHROPIC_MODEL ||
      process.env.SALES_TRAINER_DIALOGUE_MODEL ||
      "claude-haiku-4-5-20251001",
    ).trim();
  }
  return String(
    process.env.SALES_TRAINER_DIALOGUE_MODEL ||
    "claude-haiku-4-5-20251001",
  ).trim();
}

function client() {
  try {
    return createAnthropicClient();
  } catch {
    throw runtimeError("TRAINER_GAUNTLET_PROVIDER_UNAVAILABLE");
  }
}

async function evaluateSemantic({ text, turnId, criteria }) {
  const response = await client().createMessage({
    model: modelName("evaluation"),
    maxTokens: 700,
    temperature: 0,
    timeoutMs: 25_000,
    system: [
      "You are a strict evidence evaluator for one bounded sales-training practice.",
      "Judge only the learner's newest utterance against the supplied criteria.",
      "Mark a criterion only when the utterance clearly demonstrates it and quote the exact evidence.",
      "Do not reward intent, implication, the prospect's words, or material outside this newest turn.",
      "Return only the required tool call.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        newestLearnerUtterance: String(text),
        criteria,
      }),
    }],
    tools: [{
      name: "record_training_evidence",
      description: "Record only clearly demonstrated criteria with exact quotes.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          evidence: {
            type: "array",
            maxItems: criteria.length,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                criterionId: {
                  type: "string",
                  enum: criteria.map((criterion) => criterion.criterionId),
                },
                evidenceQuote: { type: "string", minLength: 4, maxLength: 300 },
              },
              required: ["criterionId", "evidenceQuote"],
            },
          },
        },
        required: ["evidence"],
      },
    }],
    toolChoice: { type: "tool", name: "record_training_evidence" },
  });
  const tool = extractToolUse(response, "record_training_evidence");
  if (!tool || !Array.isArray(tool.input?.evidence)) {
    throw runtimeError("TRAINER_GAUNTLET_EVALUATOR_UNAVAILABLE");
  }
  const byId = new Map(criteria.map((criterion) => [criterion.criterionId, criterion]));
  const seen = new Set();
  const accepted = [];
  for (const entry of tool.input.evidence) {
    const criterion = byId.get(String(entry?.criterionId || ""));
    if (!criterion || seen.has(criterion.criterionId)) continue;
    if (!quoteAppearsIn(entry?.evidenceQuote, text)) continue;
    seen.add(criterion.criterionId);
    accepted.push({
      criterionId: criterion.criterionId,
      ruleId: criterion.ruleId,
      ruleRevision: criterion.ruleRevision,
      status: "satisfied",
      citedTurnIds: [turnId],
    });
  }
  return accepted;
}

async function generateDialogue({
  cachedSkillHeader,
  turnDirective,
  learnerUtterance,
}) {
  const allowed = [...new Set(turnDirective.allowedSpeechActs || [])];
  const response = await client().createMessage({
    model: modelName("dialogue"),
    maxTokens: 300,
    temperature: 0.45,
    timeoutMs: 25_000,
    system: [
      "You are the prospect in one short, bounded sales-training conversation.",
      "React naturally to what the learner just said while staying inside the supplied section and objective.",
      "Never coach, grade, reveal criteria, quote a fee, close, or advance to another call section.",
      "Use one or two natural sentences and return only the required tool call.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        skillHeader: cachedSkillHeader,
        turnDirective,
        learnerUtterance: String(learnerUtterance || ""),
      }),
    }],
    tools: [{
      name: "speak_as_prospect",
      description: "Return the prospect's next bounded response.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1, maxLength: 700 },
          speechActs: {
            type: "array",
            minItems: 1,
            maxItems: Math.max(1, allowed.length),
            uniqueItems: true,
            items: { type: "string", enum: allowed },
          },
        },
        required: ["text", "speechActs"],
      },
    }],
    toolChoice: { type: "tool", name: "speak_as_prospect" },
  });
  const tool = extractToolUse(response, "speak_as_prospect");
  if (!tool?.input?.text || !Array.isArray(tool.input.speechActs)) {
    throw runtimeError("TRAINER_PROSPECT_DIALOGUE_UNAVAILABLE");
  }
  return {
    text: String(tool.input.text).trim(),
    speechActs: tool.input.speechActs,
  };
}

async function gradeAnswer({ answer, question, scenario }) {
  const gradingPoints = (question.gradingPoints || [])
    .map((point) => String(point || "").trim())
    .filter(Boolean);
  const response = await client().createMessage({
    model: modelName("evaluation"),
    maxTokens: 450,
    temperature: 0,
    timeoutMs: 25_000,
    system: [
      "Grade one short learner reflection against the server-supplied points.",
      "Be strict but accept correct reasoning in the learner's own words.",
      "Return only the required tool call.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: JSON.stringify({
        sectionObjective: scenario.localObjective,
        question: question.prompt,
        gradingPoints,
        answer: String(answer),
      }),
    }],
    tools: [{
      name: "grade_training_reflection",
      description: "Grade the learner's reflection.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          score: { type: "number", minimum: 0, maximum: 1 },
          feedback: { type: "string", minLength: 1, maxLength: 500 },
        },
        required: ["score", "feedback"],
      },
    }],
    toolChoice: { type: "tool", name: "grade_training_reflection" },
  });
  const tool = extractToolUse(response, "grade_training_reflection");
  const score = Number(tool?.input?.score);
  if (!Number.isFinite(score) || !tool?.input?.feedback) {
    throw runtimeError("TRAINER_GAUNTLET_GRADER_UNAVAILABLE");
  }
  const bounded = Math.max(0, Math.min(1, score));
  return {
    passed: bounded >= 0.7,
    score: bounded,
    feedback: String(tool.input.feedback).slice(0, 500),
  };
}

async function authorizeAttempt(attempt, principal) {
  const email = String(principal?.email || "").trim().toLowerCase();
  const company = String(principal?.company || "").trim().toUpperCase();
  if (
    !email || !company ||
    String(attempt?.learnerEmailNormalized || "").trim().toLowerCase() !== email ||
    String(attempt?.companySnapshot || "").trim().toUpperCase() !== company
  ) {
    const error = new Error("TRAINER_GAUNTLET_FORBIDDEN");
    error.status = 403;
    error.code = "TRAINER_GAUNTLET_FORBIDDEN";
    throw error;
  }
}

function createTrainingGauntletRuntimeService(options = {}) {
  const evaluator = createTrainingEvidenceEvaluatorService({
    evaluateSemantic: options.evaluateSemantic || evaluateSemantic,
  });
  const dialogueService = createTrainingProspectDialogueService({
    generateDialogue: options.generateDialogue || generateDialogue,
  });
  return createTrainingGauntletService({
    repository: options.repository || trainingCourseRepository,
    contentProvider: options.contentProvider || (async () => publishedTrainingContent),
    authorizeAttempt: options.authorizeAttempt || authorizeAttempt,
    evaluator,
    dialogueService,
    gradeAnswer: options.gradeAnswer || gradeAnswer,
    flagsProvider: options.flagsProvider || getSalesTrainerFeatureFlags,
    now: options.now,
  });
}

module.exports = {
  authorizeAttempt,
  createTrainingGauntletRuntimeService,
  evaluateSemantic,
  generateDialogue,
  gradeAnswer,
};
