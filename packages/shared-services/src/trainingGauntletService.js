"use strict";

const crypto = require("node:crypto");
const {
  normalizeGauntletState,
  reconstructGauntletState,
} = require("./trainerGauntletState");
const { advanceGauntletTurn, startRetryRun } = require("./trainingGauntletController");

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
        return {
          attempt,
          duplicate: true,
          state: existing.payload?.stateAfter || attempt.gauntletState,
        };
      }
      throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    }
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const state = initializeState({ scenario, attempt });
    const result = await repository.appendAttemptEvent({ attemptId, eventId, expectedVersion, expectedTurn: undefined, gauntletState: state, event: { eventId, sequence: expectedVersion + 1, type: "gauntlet_initialized", occurredAt: now(), expectedPriorVersion: expectedVersion, payload: { stateVersion: 0, stateAfter: state } } });
    if (!result.attempt || result.conflict) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    return { attempt: result.attempt, duplicate: result.duplicate, state: result.attempt.gauntletState };
  }
  async function getAttempt({ attemptId, principal }) {
    const attempt = await owned(attemptId, principal);
    const readableState = attempt.gauntletState ||
      reconstructGauntletState(attempt.events || []);
    if (!readableState) {
      throw gauntletError(422, "TRAINER_GAUNTLET_NOT_INITIALIZED");
    }
    return {
      attemptId: attempt.attemptId,
      version: attempt.version,
      state: normalizeGauntletState(readableState),
    };
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
      return {
        attempt,
        duplicate: true,
        state: existing.payload.stateAfter,
        prospectReply: existing.payload.prospectReply || null,
        reactionIntent: existing.payload.reactionIntent || null,
        terminal: existing.payload.terminal || null,
      };
    }
    const state = normalizeGauntletState(attempt.gauntletState);
    if (state.nextTurn !== expectedTurn) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    const scenario = scenarioForAttempt(await contentProvider(attempt), attempt);
    const decision = advanceGauntletTurn({ scenario, state, turnId, evidence });
    const prospectReply = dialogueService && !decision.terminal
      ? await dialogueService.respond({
          scenario,
          state: decision.nextState,
          reactionIntent: decision.reactionIntent,
          learnerText,
        })
      : null;
    const textInputFingerprint = learnerText == null ? null : inputFingerprint({
      expectedVersion,
      expectedTurn,
      text: String(learnerText),
    });
    const result = await repository.appendAttemptEvent({ attemptId, eventId, expectedVersion, expectedGauntletStateVersion: state.stateVersion, expectedTurn, gauntletState: decision.nextState, event: { eventId, sequence: expectedVersion + 1, type: "gauntlet_turn_accepted", occurredAt: now(), expectedPriorVersion: expectedVersion, payload: { turnId, inputFingerprint: fingerprint, textInputFingerprint, selectedEdgeId: decision.selectedEdgeId, prospectReply, reactionIntent: decision.reactionIntent, terminal: decision.terminal, stateAfter: decision.nextState } } });
    if (!result.attempt || result.conflict) throw gauntletError(409, "TRAINER_GAUNTLET_CONFLICT");
    return { attempt: result.attempt, duplicate: result.duplicate, state: result.attempt.gauntletState, prospectReply, reactionIntent: decision.reactionIntent, terminal: decision.terminal };
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
      return {
        attempt,
        duplicate: true,
        state: existing.payload.stateAfter,
        prospectReply: existing.payload.prospectReply || null,
        reactionIntent: existing.payload.reactionIntent || null,
        terminal: existing.payload.terminal || null,
      };
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
      return { attempt, duplicate: true, state: existing.payload.stateAfter };
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
    return {
      attempt: result.attempt,
      duplicate: result.duplicate,
      state: result.attempt.gauntletState,
    };
  }
  return Object.freeze({
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
};
