"use strict";

const crypto = require("node:crypto");
const {
  normalizeGauntletState,
  reconstructGauntletState,
} = require("./trainerGauntletState");
const {
  advanceGauntletTurn,
  canStartAnotherRun,
  startRetryRun,
} = require("./trainingGauntletController");

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function inputFingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function gauntletError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function scenarioForAttempt(bundle, attempt) {
  const scenario = (bundle?.scenarioBlueprints || []).find((entry) => entry.id === attempt.blueprintId && entry.version === attempt.blueprintVersion);
  if (!scenario || scenario.experienceMode !== "gauntlet") throw gauntletError(503, "TRAINER_GAUNTLET_CONTENT_UNAVAILABLE");
  return scenario;
}

function publicAttempt(attempt) {
  return {
    attemptId: attempt.attemptId,
    enrollmentId: attempt.enrollmentId,
    itemId: attempt.itemId,
    itemVersion: attempt.itemVersion,
    itemType: attempt.itemType,
    version: Number(attempt.version) || 0,
    status: attempt.terminalSummary ? "completed" : "in_progress",
    createdAt: attempt.createdAt || null,
  };
}

function publicModule(scenario) {
  const value = scenario?.presentation || {};
  const questions = (Array.isArray(value.questions) ? value.questions : [])
    .filter((question) => question?.prompt)
    .map((question, questionIndex) => ({
      questionIndex,
      prompt: String(question.prompt),
    }));
  return {
    moduleId: String(value.moduleId || scenario.id),
    title: String(value.title || scenario.localObjective || scenario.id),
    objective: String(value.objective || scenario.localObjective || ""),
    reading: String(value.reading || ""),
    moduleNumber: 1,
    moduleAttempt: 1,
    moduleCount: 1,
    // `question` remains during the alpha transition for older cached clients.
    question: questions[0] || null,
    questions,
  };
}

function publicCoach(scenario, prospectText = "") {
  const value = scenario?.presentation || {};
  return {
    sectionTitle: String(value.sectionTitle || value.title || scenario.sectionId),
    objective: String(value.objective || scenario.localObjective || ""),
    notice: prospectText
      ? `Listen closely to what the prospect just said: “${String(prospectText).slice(0, 240)}”`
      : "Listen for what the prospect needs before choosing the next move.",
    prospectPattern: null,
    suggestedMove: value.coachNudge ? String(value.coachNudge).slice(0, 400) : null,
    exactLanguage: null,
    listenFor: String(value.listenFor || "A direct answer or reduced resistance."),
  };
}

function publicDebrief(scenario, state) {
  if (state?.status !== "failed") return null;
  const criterionDefinitions = new Map();
  for (const node of scenario?.nodes || []) {
    for (const criterion of node.requiredCriteria || []) {
      if (!criterion?.criterionId || !criterion?.description) continue;
      criterionDefinitions.set(criterion.criterionId, criterion);
    }
  }
  const missingMoves = [];
  const demonstratedMoves = [];
  for (const criterion of state.criteria || []) {
    const definition = criterionDefinitions.get(criterion.criterionId);
    if (!definition) continue;
    const description = String(definition.description).slice(0, 500);
    if (criterion.status === "satisfied") demonstratedMoves.push(description);
    else missingMoves.push(description);
  }
  const reasonByKind = {
    "hard-rule": "A hard rule ended this attempt before the required move was complete.",
    "prohibited-move": "A prohibited move ended this attempt.",
    "turns-exhausted": "The conversation ended before every required move was demonstrated.",
  };
  const presentation = scenario?.presentation || {};
  return {
    summary: reasonByKind[state.failureReason?.kind] ||
      "The required move was not demonstrated clearly enough in this attempt.",
    missingMoves: missingMoves.slice(0, 6),
    demonstratedMoves: demonstratedMoves.slice(0, 6),
    tryNext: String(
      presentation.coachNudge || missingMoves[0] || presentation.objective ||
      scenario?.localObjective || "Try the required move directly.",
    ).slice(0, 500),
    successLooksLike: String(
      presentation.listenFor || "The prospect gives the response this practice is designed to earn.",
    ).slice(0, 500),
  };
}

function publicResult({ attempt, state, duplicate = false, scenario, prospectReply = null,
  reactionIntent = null, terminal = null }) {
  const variant = (scenario?.variants || []).find((entry) =>
    entry.variantId === state?.variantId &&
    (!state?.variantVersion || entry.version === state.variantVersion));
  return {
    attemptId: attempt.attemptId,
    version: Number(attempt.version) || 0,
    attempt: publicAttempt(attempt),
    duplicate,
    state,
    prospectReply,
    reactionIntent,
    terminal,
    canPracticeAgain: canStartAnotherRun(scenario, state),
    openingLine: String(
      variant?.situation || scenario?.presentation?.openingLine || "The prospect is ready.",
    ),
    coach: publicCoach(scenario, prospectReply?.text || ""),
    debrief: publicDebrief(scenario, state),
    module: publicModule(scenario),
  };
}

function initializeState({ scenario, attempt }) {
  const variant = scenario.variants?.[0];
  if (!variant) throw gauntletError(503, "TRAINER_GAUNTLET_CONTENT_UNAVAILABLE");
  return normalizeGauntletState({
    schemaVersion: "1", experienceMode: "gauntlet", direction: scenario.direction,
    sectionId: scenario.sectionId, status: "ready", stateVersion: 0, runNumber: 0,
    nextTurn: 1, currentNodeId: scenario.startNodeId, blueprintId: scenario.id,
    blueprintVersion: scenario.version, variantId: variant.variantId, variantVersion: variant.version,
    promptVersion: attempt.contentSnapshot?.promptVersion || "synthetic-v1",
    graderVersion: attempt.contentSnapshot?.gradingVersion || "synthetic-v1",
    voiceProfileId: variant.voiceProfileId, audioManifestId: scenario.audioManifest.id,
    criteria: scenario.nodes.flatMap((node) => node.requiredCriteria || []).map((criterion) => ({
      criterionId: criterion.criterionId, ruleId: criterion.ruleId, ruleRevision: criterion.ruleRevision,
      status: "pending", evidenceTurnIds: [],
    })), retryByNode: {}, hintLevelByNode: {}, completedVariantIds: [],
    lastAcceptedEventId: null, invalidationReasonCode: null,
  });
}

function createTrainingGauntletService({
  repository,
  contentProvider,
  authorizeAttempt,
  evaluator = null,
  dialogueService = null,
  gradeAnswer = null,
  flagsProvider = () => ({ gauntletV1Enabled: false }),
  now = () => new Date(),
}) {
  if (!repository || !contentProvider || !authorizeAttempt) throw new TypeError("Trainer Gauntlet dependencies are required");
  function requireMutationEnabled() {
    if (flagsProvider()?.gauntletV1Enabled !== true) {
      throw gauntletError(503, "TRAINER_GAUNTLET_DISABLED");
    }
  }
  async function owned(attemptId, principal) {
    const attempt = await repository.findAttemptById(attemptId);
    if (!attempt) throw gauntletError(404, "TRAINER_GAUNTLET_NOT_FOUND");
    await authorizeAttempt(attempt, principal);
    return attempt;
  }
  async function initialize({ attemptId, eventId, expectedVersion, principal }) {
    requireMutationEnabled();
    const attempt = await owned(attemptId, principal);
    if (attempt.gauntletState) {
      const existing = (attempt.events || []).find((event) => event.eventId === eventId);
      if (existing?.type === "gauntlet_initialized" &&
          existing.expectedPriorVersion === expectedVersion) {
        const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
        return publicResult({
          attempt,
          duplicate: true,
          state: existing.payload?.stateAfter || attempt.gauntletState,
          scenario,
        });
      }
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const state = initializeState({ scenario, attempt });
    const result = await repository.appendAttemptEvent({ attemptId, eventId, expectedVersion, expectedTurn: undefined, gauntletState: state, event: { eventId, sequence: expectedVersion + 1, type: "gauntlet_initialized", occurredAt: now(), expectedPriorVersion: expectedVersion, payload: { stateVersion: 0, stateAfter: state } } });
    if (!result.attempt || result.conflict) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    return publicResult({
      attempt: result.attempt,
      duplicate: result.duplicate,
      state: result.attempt.gauntletState,
      scenario,
    });
  }
  async function getAttempt({ attemptId, principal }) {
    const attempt = await owned(attemptId, principal);
    const readableState = attempt.gauntletState ||
      reconstructGauntletState(attempt.events || []);
    if (!readableState) {
      throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    }
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    return publicResult({
      attempt,
      state: normalizeGauntletState(readableState),
      scenario,
    });
  }
  async function submitTurn({ attemptId, eventId, expectedVersion, expectedTurn, turnId, evidence, learnerText = null, principal }) {
    requireMutationEnabled();
    const attempt = await owned(attemptId, principal);
    if (!attempt.gauntletState) throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    const fingerprint = inputFingerprint({
      expectedVersion,
      expectedTurn,
      turnId,
      learnerText: String(learnerText || ""),
      evidence: evidence || [],
    });
    const existing = (attempt.events || []).find((event) => event.eventId === eventId);
    if (existing) {
      if (existing.type !== "gauntlet_turn_accepted" ||
          existing.payload?.inputFingerprint !== fingerprint) {
        throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
      }
      const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
      return publicResult({
        attempt,
        duplicate: true,
        state: existing.payload.stateAfter,
        prospectReply: existing.payload.prospectReply || null,
        reactionIntent: existing.payload.reactionIntent || null,
        terminal: existing.payload.terminal || null,
        scenario,
      });
    }
    const state = normalizeGauntletState(attempt.gauntletState);
    if (state.nextTurn !== expectedTurn) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const decision = advanceGauntletTurn({ scenario, state, turnId, evidence });
    // A terminal transition still needs a final prospect reaction. Otherwise a
    // learner who succeeds on the first turn hears silence and the voice
    // exercise looks broken even though the state machine correctly passed it.
    // Terminal nodes intentionally cannot speak, so generate that closing
    // reaction from the last bounded, non-terminal node.
    const dialogueState = decision.terminal ? state : decision.nextState;
    const prospectReply = dialogueService
      ? await dialogueService.respond({
          scenario,
          state: dialogueState,
          reactionIntent: decision.reactionIntent,
          learnerText,
        })
      : null;
    const textInputFingerprint = learnerText == null ? null : inputFingerprint({
      expectedVersion,
      expectedTurn,
      text: String(learnerText),
    });
    const result = await repository.appendAttemptEvent({ attemptId, eventId, expectedVersion, expectedGauntletStateVersion: state.stateVersion, expectedTurn, gauntletState: decision.nextState, event: { eventId, sequence: expectedVersion + 1, type: "gauntlet_turn_accepted", occurredAt: now(), expectedPriorVersion: expectedVersion, payload: { turnId, inputFingerprint: fingerprint, textInputFingerprint, learnerText: learnerText == null ? null : String(learnerText).slice(0, 4000), selectedEdgeId: decision.selectedEdgeId, prospectReply, reactionIntent: decision.reactionIntent, terminal: decision.terminal, stateAfter: decision.nextState } } });
    if (!result.attempt || result.conflict) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    return publicResult({
      attempt: result.attempt,
      duplicate: result.duplicate,
      state: result.attempt.gauntletState,
      prospectReply,
      reactionIntent: decision.reactionIntent,
      terminal: decision.terminal,
      scenario,
    });
  }
  async function submitTextTurn({
    attemptId,
    eventId,
    expectedVersion,
    expectedTurn,
    text,
    principal,
  }) {
    if (!evaluator || typeof evaluator.evaluate !== "function") {
      throw gauntletError(503, "TRAINER_GAUNTLET_EVALUATOR_UNAVAILABLE");
    }
    const safeText = String(text || "").trim();
    if (!safeText) {
      throw gauntletError(422, "TRAINER_GAUNTLET_INPUT_INVALID");
    }
    const attempt = await owned(attemptId, principal);
    if (!attempt.gauntletState) {
      throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    }
    const textFingerprint = inputFingerprint({
      expectedVersion,
      expectedTurn,
      text: safeText,
    });
    const existing = (attempt.events || []).find((event) => event.eventId === eventId);
    if (existing) {
      if (existing.type !== "gauntlet_turn_accepted" ||
          existing.payload?.textInputFingerprint !== textFingerprint) {
        throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
      }
      const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
      return publicResult({
        attempt,
        duplicate: true,
        state: existing.payload.stateAfter,
        prospectReply: existing.payload.prospectReply || null,
        reactionIntent: existing.payload.reactionIntent || null,
        terminal: existing.payload.terminal || null,
        scenario,
      });
    }
    const state = normalizeGauntletState(attempt.gauntletState);
    if (state.nextTurn !== expectedTurn) {
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const turnId = eventId;
    const evidence = await evaluator.evaluate({
      scenario,
      state,
      turnId,
      text: safeText,
    });
    return submitTurn({
      attemptId,
      eventId,
      expectedVersion,
      expectedTurn,
      turnId,
      evidence,
      learnerText: safeText,
      principal,
    });
  }
  async function retry({ attemptId, eventId, expectedVersion, principal }) {
    requireMutationEnabled();
    const attempt = await owned(attemptId, principal);
    if (!attempt.gauntletState) {
      throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    }
    const existing = (attempt.events || []).find((event) => event.eventId === eventId);
    if (existing) {
      if (existing.type !== "gauntlet_retry_started" ||
          existing.expectedPriorVersion !== expectedVersion) {
        throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
      }
      const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
      return publicResult({
        attempt,
        duplicate: true,
        state: existing.payload.stateAfter,
        scenario,
      });
    }
    const state = normalizeGauntletState(attempt.gauntletState);
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const nextState = normalizeGauntletState(
      startRetryRun({ scenario, state, eventId }),
    );
    const result = await repository.appendAttemptEvent({
      attemptId,
      eventId,
      expectedVersion,
      expectedGauntletStateVersion: state.stateVersion,
      expectedTurn: state.nextTurn,
      gauntletState: nextState,
      event: {
        eventId,
        sequence: expectedVersion + 1,
        type: "gauntlet_retry_started",
        occurredAt: now(),
        expectedPriorVersion: expectedVersion,
        payload: {
          priorRunNumber: state.runNumber,
          runNumber: nextState.runNumber,
          variantId: nextState.variantId,
          stateAfter: nextState,
        },
      },
    });
    if (!result.attempt || result.conflict) {
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    return publicResult({
      attempt: result.attempt,
      duplicate: result.duplicate,
      state: result.attempt.gauntletState,
      scenario,
    });
  }

  async function gradeModuleAnswer({
    attemptId,
    answer,
    questionIndex = 0,
    eventId,
    expectedVersion,
    principal,
  }) {
    requireMutationEnabled();
    if (typeof gradeAnswer !== "function") {
      throw gauntletError(503, "TRAINER_GAUNTLET_GRADER_UNAVAILABLE");
    }
    const safeAnswer = String(answer || "").trim();
    if (!safeAnswer) throw gauntletError(422, "TRAINER_GAUNTLET_INPUT_INVALID");
    const safeQuestionIndex = Number(questionIndex);
    if (!Number.isInteger(safeQuestionIndex) || safeQuestionIndex < 0) {
      throw gauntletError(422, "TRAINER_GAUNTLET_QUESTION_INVALID");
    }
    const safeEventId = String(eventId || "").trim();
    const safeExpectedVersion = Number(expectedVersion);
    if (
      !safeEventId ||
      !Number.isInteger(safeExpectedVersion) ||
      safeExpectedVersion < 0
    ) {
      throw gauntletError(422, "TRAINER_GAUNTLET_INPUT_INVALID");
    }
    const attempt = await owned(attemptId, principal);
    const fingerprint = inputFingerprint({
      answer: safeAnswer,
      questionIndex: safeQuestionIndex,
    });
    const existing = (attempt.events || []).find(
      (event) => event?.eventId === safeEventId,
    );
    if (existing) {
      if (
        existing.type !== "gauntlet_module_answer_graded" ||
        existing.payload?.inputFingerprint !== fingerprint
      ) {
        throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
      }
      return {
        ...(existing.payload?.grade || {}),
        questionIndex: Number(existing.payload?.questionIndex) || 0,
        questionCount: Number(existing.payload?.questionCount) || 0,
        version: Number(attempt.version) || 0,
        duplicate: true,
      };
    }
    if (Number(attempt.version) !== safeExpectedVersion) {
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    if (!attempt.gauntletState) {
      throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    }
    const state = normalizeGauntletState(attempt.gauntletState);
    if (!["passed", "failed"].includes(state.status)) {
      throw gauntletError(409, "TRAINER_GAUNTLET_NOT_COMPLETE");
    }
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const questions = Array.isArray(scenario.presentation?.questions)
      ? scenario.presentation.questions
      : [];
    const question = questions[safeQuestionIndex];
    if (questions.length && !question) {
      throw gauntletError(422, "TRAINER_GAUNTLET_QUESTION_INVALID");
    }
    if (!question) {
      return {
        passed: true,
        score: 1,
        feedback: "Practice complete.",
        questionIndex: safeQuestionIndex,
        questionCount: 0,
        version: Number(attempt.version) || 0,
        duplicate: false,
      };
    }
    const grade = await gradeAnswer({
      answer: safeAnswer,
      question,
      scenario,
    });
    const result = await repository.appendAttemptEvent({
      attemptId,
      eventId: safeEventId,
      expectedVersion: safeExpectedVersion,
      event: {
        eventId: safeEventId,
        sequence: safeExpectedVersion + 1,
        type: "gauntlet_module_answer_graded",
        occurredAt: now(),
        expectedPriorVersion: safeExpectedVersion,
        payload: {
          inputFingerprint: fingerprint,
          runNumber: Number(state.runNumber) || 0,
          questionIndex: safeQuestionIndex,
          questionCount: questions.length,
          questionId: String(question.questionId || ""),
          answer: safeAnswer,
          grade,
        },
        provenance: {
          authority: "server_owned_content",
          graderVersion: state.graderVersion,
        },
      },
    });
    if (!result.attempt || result.conflict) {
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    return {
      ...grade,
      questionIndex: safeQuestionIndex,
      questionCount: questions.length,
      version: Number(result.attempt.version) || 0,
      duplicate: result.duplicate === true,
    };
  }
  return Object.freeze({
    gradeModuleAnswer,
    getAttempt,
    initialize,
    retry,
    submitTextTurn,
    submitTurn,
  });
}

module.exports = {
  createTrainingGauntletService,
  gauntletError,
  inputFingerprint,
  publicDebrief,
};
