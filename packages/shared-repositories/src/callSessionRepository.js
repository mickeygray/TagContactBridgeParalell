"use strict";

const { CallSession } = require("../../shared-models/src");

async function createSession(payload) {
  const doc = new CallSession({
    startedAt: payload.startedAt || new Date(),
    state: payload.state || "placing",
    ...payload,
  });
  return doc.save();
}

function findById(id) {
  return CallSession.findById(id).lean();
}

function findByRcxUii(rcxUii) {
  return CallSession.findOne({ rcxUii }).lean();
}

function findActiveByAgent(agentId) {
  return CallSession.findOne({
    agentId,
    state: { $in: ["placing", "ringing", "connected"] },
  })
    .sort({ startedAt: -1 })
    .lean();
}

function findActiveByQueueItem(queueItemId) {
  return CallSession.findOne({
    queueItemId,
    state: { $in: ["placing", "ringing", "connected"] },
  }).lean();
}

function findActiveByLead(leadId) {
  return CallSession.findOne({
    leadId,
    state: { $in: ["placing", "ringing", "connected"] },
  }).lean();
}

function listForAgentRecent(agentId, { limit = 50 } = {}) {
  return CallSession.find({ agentId }).sort({ startedAt: -1 }).limit(limit).lean();
}

function listSessionsAwaitingDisposition({ agentId = null, asOf = new Date() } = {}) {
  // Sessions that ended but were never dispositioned. Useful for the
  // idle reaper to detect "agent walked away after a call."
  const filter = { state: "ended", dispositionedAt: null };
  if (agentId) filter.agentId = agentId;
  return CallSession.find(filter).sort({ endedAt: 1 }).lean();
}

// ── Atomic state transitions ───────────────────────────────────────

async function markRinging(sessionId, { sessionRcId, telephonySessionId } = {}) {
  return CallSession.findOneAndUpdate(
    { _id: sessionId, state: "placing" },
    {
      $set: {
        state: "ringing",
        ringingAt: new Date(),
        ...(sessionRcId ? { sessionId: sessionRcId } : {}),
        ...(telephonySessionId ? { telephonySessionId } : {}),
      },
    },
    { new: true, lean: true },
  );
}

async function markConnected(sessionId, { sessionRcId, telephonySessionId } = {}) {
  return CallSession.findOneAndUpdate(
    { _id: sessionId, state: { $in: ["placing", "ringing"] } },
    {
      $set: {
        state: "connected",
        connectedAt: new Date(),
        ...(sessionRcId ? { sessionId: sessionRcId } : {}),
        ...(telephonySessionId ? { telephonySessionId } : {}),
      },
    },
    { new: true, lean: true },
  );
}

async function markEnded(sessionId, { reason = null } = {}) {
  // Idempotent: works even if already ended (returns existing doc)
  const existing = await CallSession.findById(sessionId).lean();
  if (!existing) return null;
  if (["ended", "dispositioned", "failed"].includes(existing.state)) return existing;
  const endedAt = new Date();
  const durationMs = existing.connectedAt
    ? endedAt.getTime() - new Date(existing.connectedAt).getTime()
    : null;
  const updated = await CallSession.findOneAndUpdate(
    { _id: sessionId, state: { $in: ["placing", "ringing", "connected"] } },
    {
      $set: {
        state: "ended",
        endedAt,
        durationMs,
        ...(reason ? { failureReason: reason } : {}),
      },
    },
    { new: true, lean: true },
  );
  return updated || CallSession.findById(sessionId).lean();
}

async function markFailed(sessionId, { failureReason, placementError = null } = {}) {
  const updated = await CallSession.findOneAndUpdate(
    { _id: sessionId, state: { $in: ["placing", "ringing", "connected"] } },
    {
      $set: {
        state: "failed",
        endedAt: new Date(),
        failureReason,
        ...(placementError ? { placementError } : {}),
      },
    },
    { new: true, lean: true },
  );
  return updated || CallSession.findById(sessionId).lean();
}

async function markDispositioned(sessionId, {
  dispositionResult,
  rcxDispositionCode,
  dispositionPayload,
  dispositionedBy,
}) {
  const now = new Date();
  const connected = await CallSession.findById(sessionId).lean();
  if (!connected) return null;
  if (connected.state === "dispositioned") return connected;
  if (!["ended", "connected"].includes(connected.state)) return connected;

  if (connected.state === "connected") {
    const endedAt = connected.endedAt || now;
    const durationMs = connected.connectedAt
      ? endedAt.getTime() - new Date(connected.connectedAt).getTime()
      : null;
    await CallSession.findOneAndUpdate(
      { _id: sessionId, state: "connected" },
      {
        $set: {
          state: "ended",
          endedAt,
          durationMs,
        },
      },
      { new: true, lean: true },
    );
  }

  const updated = await CallSession.findOneAndUpdate(
    { _id: sessionId, state: "ended" },
    {
      $set: {
        state: "dispositioned",
        dispositionResult,
        rcxDispositionCode,
        dispositionPayload,
        dispositionedBy,
        dispositionedAt: now,
      },
    },
    { new: true, lean: true },
  );
  return updated || CallSession.findById(sessionId).lean();
}

async function recordRcxApiError(sessionId, { op, message }) {
  return CallSession.findOneAndUpdate(
    { _id: sessionId },
    {
      $push: {
        rcxApiErrors: { at: new Date(), op, message },
      },
    },
    { new: true, lean: true },
  );
}

async function attachRcIds(sessionId, { sessionRcId = null, telephonySessionId = null, rcxUii = null }) {
  const $set = {};
  if (sessionRcId) $set.sessionId = sessionRcId;
  if (telephonySessionId) $set.telephonySessionId = telephonySessionId;
  if (rcxUii) $set.rcxUii = rcxUii;
  if (!Object.keys($set).length) return null;
  return CallSession.findOneAndUpdate(
    { _id: sessionId },
    { $set },
    { new: true, lean: true },
  );
}

module.exports = {
  // reads
  findById,
  findByRcxUii,
  findActiveByAgent,
  findActiveByQueueItem,
  findActiveByLead,
  listForAgentRecent,
  listSessionsAwaitingDisposition,
  // writes
  createSession,
  markRinging,
  markConnected,
  markEnded,
  markFailed,
  markDispositioned,
  recordRcxApiError,
  attachRcIds,
};
