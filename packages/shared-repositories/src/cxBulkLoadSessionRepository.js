"use strict";

const { CxBulkLoadSession } = require("../../shared-models/src");

const ACTIVE_STATUSES = Object.freeze(["running"]);
const MAX_EVENT_HISTORY = 160;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
}

function trimEvents(events) {
  return (Array.isArray(events) ? events : []).slice(-MAX_EVENT_HISTORY);
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asPlain(doc = null) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : doc;
}

function applyRuntimeScope(query, input = {}) {
  const runtime = String(input.runtime || "").trim();
  if (runtime) query.runtime = runtime;
  else query.runtime = { $ne: "boring" };
  return query;
}

async function createBulkLoadSession(input = {}) {
  const session = await CxBulkLoadSession.create({
    ...input,
    runtime: String(input.runtime || "bulk_load").trim(),
    agentEmail: normalizeEmail(input.agentEmail),
    agentExtensionId: normalizeExternalId(input.agentExtensionId),
    cxAgentId: normalizeExternalId(input.cxAgentId),
    domain: normalizeDomain(input.domain),
    acceptedBuffer: normalizeArray(input.acceptedBuffer),
    completed: normalizeArray(input.completed),
    events: trimEvents(input.events),
  });
  return asPlain(session);
}

async function findBulkLoadSessionById(sessionId) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  return CxBulkLoadSession.findOne({ sessionId: normalized }).lean();
}

async function findActiveBulkLoadSessionForAgent(input = {}) {
  const agentEmail = normalizeEmail(input.agentEmail);
  const agentExtensionId = normalizeExternalId(input.agentExtensionId);
  const query = applyRuntimeScope({ status: { $in: ACTIVE_STATUSES } }, input);
  if (agentEmail) {
    query.agentEmail = agentEmail;
  } else if (agentExtensionId) {
    query.agentExtensionId = agentExtensionId;
  } else {
    return null;
  }
  return CxBulkLoadSession.findOne(query).sort({ updatedAt: -1 }).lean();
}

async function findActiveBulkLoadSessionsForAgent(input = {}) {
  const agentEmail = normalizeEmail(input.agentEmail);
  const agentExtensionId = normalizeExternalId(input.agentExtensionId);
  const query = applyRuntimeScope({ status: { $in: ACTIVE_STATUSES } }, input);
  if (agentEmail) {
    query.agentEmail = agentEmail;
  } else if (agentExtensionId) {
    query.agentExtensionId = agentExtensionId;
  } else {
    return [];
  }
  return CxBulkLoadSession.find(query).sort({ updatedAt: -1 }).lean();
}

async function listActiveBulkLoadSessions(input = {}) {
  const query = applyRuntimeScope({ status: { $in: ACTIVE_STATUSES } }, input);
  if (input.sessionId) query.sessionId = String(input.sessionId || "").trim();
  if (input.agentEmail) query.agentEmail = normalizeEmail(input.agentEmail);
  if (input.agentExtensionId) query.agentExtensionId = normalizeExternalId(input.agentExtensionId);
  if (input.domain) query.domain = normalizeDomain(input.domain);
  if (input.accountId) query["ringcx.accountId"] = normalizeExternalId(input.accountId);
  return CxBulkLoadSession.find(query).sort({ "ringcx.accountId": 1, agentEmail: 1, updatedAt: -1 }).lean();
}

// Sessions that left "running" while still holding deferred sys-dispo terminal writes —
// the watcher's orphan flush drains these so no call outcome ever strands on a dead doc.
async function listBulkLoadSessionsWithPendingSysDispoRetries() {
  return CxBulkLoadSession.find({
    status: { $ne: "running" },
    sysDispoRetries: { $ne: null },
  }).lean();
}

async function updateBulkLoadSession(sessionId, update = {}, options = {}) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  const patch = { ...update };
  delete patch._id;
  delete patch.__v;
  if (patch.agentEmail !== undefined) patch.agentEmail = normalizeEmail(patch.agentEmail);
  if (patch.agentExtensionId !== undefined) patch.agentExtensionId = normalizeExternalId(patch.agentExtensionId);
  if (patch.cxAgentId !== undefined) patch.cxAgentId = normalizeExternalId(patch.cxAgentId);
  if (patch.domain !== undefined) patch.domain = normalizeDomain(patch.domain);
  if (patch.runtime !== undefined) patch.runtime = String(patch.runtime || "bulk_load").trim();
  if (patch.ringcx !== undefined && (!patch.ringcx || typeof patch.ringcx !== "object" || Array.isArray(patch.ringcx))) {
    patch.ringcx = {};
  }
  if (patch.acceptedBuffer !== undefined) patch.acceptedBuffer = normalizeArray(patch.acceptedBuffer);
  if (patch.completed !== undefined) patch.completed = normalizeArray(patch.completed);
  if (patch.events !== undefined) patch.events = trimEvents(patch.events);
  const query = { sessionId: normalized, ...(options.match || {}) };
  if (options.expectedVersion !== undefined && options.expectedVersion !== null) {
    const expectedVersion = Number(options.expectedVersion);
    if (Number.isFinite(expectedVersion)) query.__v = expectedVersion;
  }
  if (options.expectedUpdatedAt) {
    const expectedUpdatedAt = options.expectedUpdatedAt instanceof Date
      ? options.expectedUpdatedAt
      : new Date(options.expectedUpdatedAt);
    if (!Number.isNaN(expectedUpdatedAt.getTime())) query.updatedAt = expectedUpdatedAt;
  }
  const updateDoc = { $set: patch };
  if (options.versionGuard) updateDoc.$inc = { __v: 1 };
  return CxBulkLoadSession.findOneAndUpdate(
    query,
    updateDoc,
    { new: true },
  ).lean();
}



module.exports = {
  createBulkLoadSession,
  findActiveBulkLoadSessionForAgent,
  findActiveBulkLoadSessionsForAgent,
  findBulkLoadSessionById,
  listActiveBulkLoadSessions,
  updateBulkLoadSession,
  listBulkLoadSessionsWithPendingSysDispoRetries,
};
