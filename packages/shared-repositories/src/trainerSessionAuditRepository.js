"use strict";

const { TrainerSessionAudit } = require("../../shared-models/src");

const MAX_TURNS = 80;
const MAX_ERROR_CODES = 20;

function lean(value) {
  if (!value) return value;
  return typeof value.toObject === "function"
    ? value.toObject({ depopulate: true })
    : value;
}

async function findOrCreateSession({ sessionKey, create }) {
  try {
    return await TrainerSessionAudit.findOneAndUpdate(
      { sessionKey },
      { $setOnInsert: create },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return TrainerSessionAudit.findOne({ sessionKey }).lean();
  }
}

async function findBySessionKey(sessionKey) {
  return TrainerSessionAudit.findOne({ sessionKey }).lean();
}

async function appendEntry({
  sessionKey,
  eventId,
  entry,
  increments = {},
  maxTurnLatencyMs = null,
  occurredAt = new Date(),
}) {
  const update = {
    $push: {
      eventIds: eventId,
      turns: { $each: [entry], $slice: -MAX_TURNS },
    },
    $set: { lastActivityAt: occurredAt },
  };
  if (Object.keys(increments).length > 0) {
    update.$inc = Object.fromEntries(
      Object.entries(increments).map(([key, value]) => [`metrics.${key}`, Number(value) || 0]),
    );
  }
  if (Number.isFinite(Number(maxTurnLatencyMs))) {
    update.$max = { "metrics.maxTurnLatencyMs": Math.max(0, Number(maxTurnLatencyMs)) };
  }
  const accepted = await TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: { $in: ["active", "report_pending"] }, eventIds: { $ne: eventId } },
    update,
    { new: true, runValidators: true },
  ).lean();
  if (accepted) return { session: accepted, duplicate: false };
  return {
    session: await TrainerSessionAudit.findOne({ sessionKey }).lean(),
    duplicate: true,
  };
}

async function recordMetricEvent({
  sessionKey,
  eventId,
  increments = {},
  errorCode = null,
  occurredAt = new Date(),
}) {
  const update = {
    $push: { eventIds: eventId },
    $set: { lastActivityAt: occurredAt },
  };
  if (Object.keys(increments).length > 0) {
    update.$inc = Object.fromEntries(
      Object.entries(increments).map(([key, value]) => [`metrics.${key}`, Number(value) || 0]),
    );
  }
  if (errorCode) {
    update.$push = {
      ...update.$push,
      "metrics.errorCodes": {
        $each: [String(errorCode).slice(0, 80)],
        $slice: -MAX_ERROR_CODES,
      },
    };
  }
  const accepted = await TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: { $in: ["active", "report_pending"] }, eventIds: { $ne: eventId } },
    update,
    { new: true },
  ).lean();
  if (accepted) return { session: accepted, duplicate: false };
  return {
    session: await TrainerSessionAudit.findOne({ sessionKey }).lean(),
    duplicate: true,
  };
}

async function touch({ sessionKey, occurredAt = new Date(), activeMs = 0 }) {
  const inc = Math.max(0, Math.min(Number(activeMs) || 0, 60_000));
  const update = { $set: { lastActivityAt: occurredAt } };
  if (inc > 0) update.$inc = { activeMs: inc };
  return TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: "active" },
    update,
    { new: true },
  ).lean();
}

async function finish({ sessionKey, endedAt = new Date(), endReason = "completed" }) {
  return TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: "active" },
    {
      $set: {
        status: "report_pending",
        endedAt,
        endReason: String(endReason || "completed").slice(0, 60),
        lastActivityAt: endedAt,
        nextReportAttemptAt: endedAt,
      },
    },
    { new: true },
  ).lean();
}

async function findStaleActive({ staleBefore, limit = 25 }) {
  return TrainerSessionAudit.find({ status: "active", lastActivityAt: { $lte: staleBefore } })
    .sort({ lastActivityAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 25, 100)))
    .lean();
}

async function claimNextReport({ now = new Date(), staleBefore, maxAttempts = 3 }) {
  return TrainerSessionAudit.findOneAndUpdate(
    {
      reportAttempts: { $lt: Math.max(1, Number(maxAttempts) || 3) },
      $or: [
        { status: "report_pending", nextReportAttemptAt: { $lte: now } },
        { status: "report_pending", nextReportAttemptAt: null },
        { status: "report_failed", nextReportAttemptAt: { $lte: now } },
        { status: "reporting", reportClaimedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: {
        status: "reporting",
        reportClaimedAt: now,
        reportErrorCode: null,
      },
      $inc: { reportAttempts: 1, reportGeneration: 1 },
    },
    { new: true, sort: { endedAt: 1, createdAt: 1 } },
  ).lean();
}

async function markReported({ sessionKey, generation, report, reportedAt = new Date() }) {
  return TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: "reporting", reportGeneration: Number(generation) },
    {
      $set: {
        status: "reported",
        report,
        reportedAt,
        reportClaimedAt: null,
        nextReportAttemptAt: null,
        reportErrorCode: null,
      },
    },
    { new: true },
  ).lean();
}

async function markReportFailed({
  sessionKey,
  generation,
  errorCode,
  nextAttemptAt,
}) {
  return TrainerSessionAudit.findOneAndUpdate(
    { sessionKey, status: "reporting", reportGeneration: Number(generation) },
    {
      $set: {
        status: "report_failed",
        reportClaimedAt: null,
        nextReportAttemptAt: nextAttemptAt,
        reportErrorCode: String(errorCode || "TRAINER_SESSION_REPORT_FAILED").slice(0, 100),
      },
    },
    { new: true },
  ).lean();
}

module.exports = {
  MAX_ERROR_CODES,
  MAX_TURNS,
  appendEntry,
  claimNextReport,
  findBySessionKey,
  findOrCreateSession,
  findStaleActive,
  finish,
  lean,
  markReportFailed,
  markReported,
  recordMetricEvent,
  touch,
};
