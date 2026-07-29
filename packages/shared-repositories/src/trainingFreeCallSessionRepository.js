"use strict";
const { TrainingFreeCallSession } = require("../../shared-models/src");

async function create(document) {
  return (await TrainingFreeCallSession.create(document)).toObject();
}

async function findByAttemptId(attemptId) {
  return TrainingFreeCallSession.findOne({ attemptId }).select("+sealed").lean();
}

async function appendTurnCas({
  sessionId,
  eventId,
  inputFingerprint,
  expectedVersion,
  expectedTurn,
  turn,
  nextProspectState,
  nextMessages,
}) {
  const payload = {
    reply: turn?.reply || null,
    transcript: turn?.transcript || null,
    audio: turn?.audio || null,
  };
  const accepted = await TrainingFreeCallSession.findOneAndUpdate({
    sessionId,
    version: expectedVersion,
    nextTurn: expectedTurn,
    eventIds: { $ne: eventId },
  }, {
    $push: {
      eventIds: eventId,
      turns: {
        eventId,
        turn: expectedTurn,
        inputFingerprint,
        payload,
        occurredAt: new Date(),
      },
    },
    $inc: { version: 1, nextTurn: 1 },
    $set: {
      status: "in_progress",
      "sealed.prospectState": nextProspectState,
      "sealed.messages": nextMessages,
    },
  }, { new: true, runValidators: true }).select("+sealed").lean();
  if (accepted) return { session: accepted, turn: payload, duplicate: false, conflict: false };
  const current = await TrainingFreeCallSession.findOne({ sessionId }).select("+sealed").lean();
  const existing = (current?.turns || []).find((entry) => entry.eventId === eventId);
  if (existing) {
    return existing.inputFingerprint === inputFingerprint
      ? { session: current, turn: existing.payload, duplicate: true, conflict: false }
      : { session: current, duplicate: false, conflict: true };
  }
  return { session: current, duplicate: false, conflict: Boolean(current) };
}

async function mergeObserverCas({
  sessionId,
  eventId,
  expectedVersion,
  expectedTurn,
  prospectState,
}) {
  const accepted = await TrainingFreeCallSession.findOneAndUpdate({
    sessionId,
    version: expectedVersion,
    nextTurn: expectedTurn,
    eventIds: { $ne: eventId },
  }, {
    $push: { eventIds: eventId },
    $inc: { version: 1 },
    $set: { "sealed.prospectState": prospectState },
  }, { new: true, runValidators: true }).select("+sealed").lean();
  if (accepted) return { session: accepted, duplicate: false, conflict: false };
  const current = await TrainingFreeCallSession.findOne({ sessionId }).select("+sealed").lean();
  return {
    session: current,
    duplicate: Boolean(current?.eventIds?.includes(eventId)),
    conflict: !current?.eventIds?.includes(eventId),
  };
}

module.exports = { appendTurnCas, create, findByAttemptId, mergeObserverCas };
