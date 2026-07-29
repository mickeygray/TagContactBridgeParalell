"use strict";

const crypto = require("node:crypto");

function turnInputFingerprint({ expectedVersion, expectedTurn, text }) {
  return crypto.createHash("sha256").update(JSON.stringify({
    expectedVersion,
    expectedTurn,
    text: String(text || "").trim(),
  })).digest("hex");
}

function freeCallError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function manifestDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function createTrainingFreeCallCourseService({
  attemptRepository,
  sessionRepository,
  authorizeAttempt,
  resolveServerProfile,
  runSalesTrainerTurn,
  evaluateTransfer,
  flagsProvider = () => ({ courseV1Enabled: false }),
  now = () => new Date(),
}) {
  if (!attemptRepository || !sessionRepository || typeof authorizeAttempt !== "function" ||
      typeof resolveServerProfile !== "function" || typeof runSalesTrainerTurn !== "function") {
    throw new TypeError("sealed Free Call dependencies are required");
  }
  function requireEnabled() {
    if (flagsProvider()?.courseV1Enabled !== true) {
      throw freeCallError(503, "TRAINER_FREE_CALL_COURSE_DISABLED");
    }
  }
  async function ownedAttempt(attemptId, principal) {
    const attempt = await attemptRepository.findAttemptById(attemptId);
    if (!attempt) throw freeCallError(404, "TRAINER_FREE_CALL_NOT_FOUND");
    await authorizeAttempt(attempt, principal);
    if (attempt.itemType !== "free_call" && attempt.itemType !== "free-call") {
      throw freeCallError(422, "TRAINER_FREE_CALL_ATTEMPT_INVALID");
    }
    return attempt;
  }
  async function mint({ attemptId, requestId, principal }) {
    requireEnabled();
    const attempt = await ownedAttempt(attemptId, principal);
    const existing = await sessionRepository.findByAttemptId(attemptId);
    if (existing) return { session: existing, duplicate: true };
    const profile = await resolveServerProfile({ attempt, principal });
    if (!profile?.profileId || !profile?.voiceProfileId || !profile?.playbook || !profile?.direction) {
      throw freeCallError(503, "TRAINER_FREE_CALL_PROFILE_UNAVAILABLE");
    }
    const createdAt = now();
    const session = await sessionRepository.create({
      sessionId: requestId,
      attemptId,
      status: "ready",
      version: 0,
      nextTurn: 1,
      manifestDate: manifestDate(createdAt),
      profileId: profile.profileId,
      voiceProfileId: profile.voiceProfileId,
      direction: profile.direction,
      sealed: {
        playbook: profile.playbook,
        prospectState: profile.prospectState || {},
        messages: profile.messages || [],
        recordingPolicy: profile.recordingPolicy || { enabled: true },
      },
      createdAt,
    });
    return { session, duplicate: false };
  }
  async function get({ attemptId, principal }) {
    await ownedAttempt(attemptId, principal);
    const session = await sessionRepository.findByAttemptId(attemptId);
    if (!session) throw freeCallError(422, "TRAINER_FREE_CALL_SESSION_NOT_INITIALIZED");
    return {
      sessionId: session.sessionId,
      attemptId,
      status: session.status,
      version: session.version,
      nextTurn: session.nextTurn,
      manifestDate: session.manifestDate,
      voiceProfileId: session.voiceProfileId,
      direction: session.direction,
    };
  }
  async function submitTextTurn({
    attemptId,
    eventId,
    expectedVersion,
    expectedTurn,
    text,
    principal,
  }) {
    requireEnabled();
    await ownedAttempt(attemptId, principal);
    const session = await sessionRepository.findByAttemptId(attemptId);
    if (!session?.sealed) throw freeCallError(422, "TRAINER_FREE_CALL_SESSION_NOT_INITIALIZED");
    const outbound = String(text || "").trim();
    if (!outbound) throw freeCallError(422, "TRAINER_FREE_CALL_INPUT_INVALID");
    const inputFingerprint = turnInputFingerprint({
      expectedVersion,
      expectedTurn,
      text: outbound,
    });
    const existing = (session.turns || []).find((turn) => turn.eventId === eventId);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) {
        throw freeCallError(409, "TRAINER_FREE_CALL_CONFLICT");
      }
      return {
        duplicate: true,
        session,
        turn: existing.payload,
      };
    }
    if (session.version !== expectedVersion || session.nextTurn !== expectedTurn) {
      throw freeCallError(409, "TRAINER_FREE_CALL_CONFLICT");
    }
    const turn = await runSalesTrainerTurn({
      text: outbound,
      direction: session.direction,
      profileId: session.profileId,
      voiceProfileId: session.voiceProfileId,
      playbook: session.sealed.playbook,
      prospectState: session.sealed.prospectState,
      messages: session.sealed.messages,
      recordTurn: session.sealed.recordingPolicy?.enabled === true,
      manifestDate: session.manifestDate,
    });
    const updated = await sessionRepository.appendTurnCas({
      sessionId: session.sessionId,
      eventId,
      inputFingerprint,
      expectedVersion,
      expectedTurn,
      turn,
      nextProspectState: turn.prospectState,
      nextMessages: turn.messages,
    });
    if (!updated?.session || updated.conflict) throw freeCallError(409, "TRAINER_FREE_CALL_CONFLICT");
    return { duplicate: updated.duplicate === true, session: updated.session, turn: updated.turn || turn };
  }
  async function mergeObserverState({
    attemptId,
    eventId,
    expectedVersion,
    expectedTurn,
    prospectState,
    principal,
  }) {
    requireEnabled();
    await ownedAttempt(attemptId, principal);
    const session = await sessionRepository.findByAttemptId(attemptId);
    if (!session?.sealed) throw freeCallError(422, "TRAINER_FREE_CALL_SESSION_NOT_INITIALIZED");
    const updated = await sessionRepository.mergeObserverCas({
      sessionId: session.sessionId,
      eventId,
      expectedVersion,
      expectedTurn,
      prospectState,
    });
    if (!updated?.session || updated.conflict) throw freeCallError(409, "TRAINER_FREE_CALL_CONFLICT");
    return updated;
  }
  async function evaluate({ attemptId, transcript, principal }) {
    requireEnabled();
    const attempt = await ownedAttempt(attemptId, principal);
    if (typeof evaluateTransfer !== "function") {
      throw freeCallError(503, "TRAINER_FREE_CALL_EVALUATOR_UNAVAILABLE");
    }
    const evidence = await evaluateTransfer({ attempt, transcript });
    return {
      masteryDimension: "transfer",
      evidence,
      certificationEligible: false,
    };
  }
  return Object.freeze({ evaluate, get, mergeObserverState, mint, submitTextTurn });
}

module.exports = {
  createTrainingFreeCallCourseService,
  manifestDate,
  turnInputFingerprint,
};
