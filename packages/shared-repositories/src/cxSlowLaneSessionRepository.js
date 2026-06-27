"use strict";

const { CxSlowLaneSession } = require("../../shared-models/src");

const ACTIVE_STATUSES = Object.freeze(["running"]);
const MAX_EVENT_HISTORY = 120;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeExtensionId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
}

function trimEvents(events) {
  return (Array.isArray(events) ? events : []).slice(-MAX_EVENT_HISTORY);
}

function asPlain(doc = null) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

async function createSlowLaneSession(input = {}) {
  const session = await CxSlowLaneSession.create({
    ...input,
    agentEmail: normalizeEmail(input.agentEmail),
    agentExtensionId: normalizeExtensionId(input.agentExtensionId),
    cxAgentId: normalizeExtensionId(input.cxAgentId),
    domain: normalizeDomain(input.domain),
    events: trimEvents(input.events),
  });
  return asPlain(session);
}

async function findSlowLaneSessionById(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  return CxSlowLaneSession.findOne({ sessionId: normalized }).lean();
}

async function findActiveSlowLaneSessionForAgent(input = {}) {
  const agentEmail = normalizeEmail(input.agentEmail);
  const agentExtensionId = normalizeExtensionId(input.agentExtensionId);
  const query = { status: { $in: ACTIVE_STATUSES } };
  if (agentEmail) {
    query.agentEmail = agentEmail;
  } else if (agentExtensionId) {
    query.agentExtensionId = agentExtensionId;
  } else {
    return null;
  }
  return CxSlowLaneSession.findOne(query).sort({ updatedAt: -1 }).lean();
}

async function updateSlowLaneSession(sessionId, update = {}, options = {}) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  const patch = { ...update };
  delete patch._id;
  delete patch.__v;
  if (patch.agentEmail !== undefined) patch.agentEmail = normalizeEmail(patch.agentEmail);
  if (patch.agentExtensionId !== undefined) patch.agentExtensionId = normalizeExtensionId(patch.agentExtensionId);
  if (patch.cxAgentId !== undefined) patch.cxAgentId = normalizeExtensionId(patch.cxAgentId);
  if (patch.domain !== undefined) patch.domain = normalizeDomain(patch.domain);
  if (patch.events !== undefined) patch.events = trimEvents(patch.events);
  return CxSlowLaneSession.findOneAndUpdate(
    { sessionId: normalized, ...(options.match || {}) },
    { $set: patch },
    { new: true },
  ).lean();
}

async function appendSlowLaneSessionEvent(sessionId, event = {}, options = {}) {
  const session = await findSlowLaneSessionById(sessionId);
  if (!session) return null;
  const now = options.now instanceof Date ? options.now : new Date();
  const events = trimEvents([
    ...(Array.isArray(session.events) ? session.events : []),
    {
      type: event.type || "event",
      at: now.toISOString(),
      ...event,
    },
  ]);
  return updateSlowLaneSession(sessionId, { events, updatedAt: now }, options);
}

async function killActiveSlowLaneSessionsForAgent(input = {}) {
  const agentEmail = normalizeEmail(input.agentEmail);
  const agentExtensionId = normalizeExtensionId(input.agentExtensionId);
  const reason = String(input.reason || "replaced").trim() || "replaced";
  const query = { status: { $in: ACTIVE_STATUSES } };
  if (agentEmail) {
    query.agentEmail = agentEmail;
  } else if (agentExtensionId) {
    query.agentExtensionId = agentExtensionId;
  } else {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  return CxSlowLaneSession.updateMany(query, {
    $set: {
      status: "killed",
      phase: "released",
      killedAt: new Date(),
      lastError: reason,
    },
  });
}

module.exports = {
  appendSlowLaneSessionEvent,
  createSlowLaneSession,
  findActiveSlowLaneSessionForAgent,
  findSlowLaneSessionById,
  killActiveSlowLaneSessionsForAgent,
  updateSlowLaneSession,
};
