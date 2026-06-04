"use strict";

const { AgentState, CxAppointment } = require("../../shared-models/src");

const ACTIVE_APPOINTMENT_STATUSES = Object.freeze(["scheduled", "due", "fired", "blocked"]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeStatusList(value, fallback = ACTIVE_APPOINTMENT_STATUSES) {
  if (value === "all") return [];
  if (String(value || "").trim().toLowerCase() === "active") return [...fallback];
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const statuses = source
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean);
  return statuses.length > 0 ? Array.from(new Set(statuses)) : [...fallback];
}

function toPlain(doc) {
  return doc && typeof doc.toObject === "function" ? doc.toObject() : doc;
}

function buildAgentAppointmentMirror(appointment = {}) {
  return {
    appointmentId: String(appointment.appointmentId || ""),
    domain: normalizeDomain(appointment.domain),
    caseId: Number.isFinite(Number(appointment.caseId)) ? Number(appointment.caseId) : null,
    leadCadenceId: appointment.leadCadenceId || null,
    cxQueueRecordId: appointment.cxQueueRecordId || null,
    queueActionKey: appointment.queueActionKey || null,
    prospectName: appointment.prospectName || null,
    phone: appointment.phone || null,
    sourceName: appointment.sourceName || null,
    appointmentAt: appointment.appointmentAt || null,
    appointmentTimezone: appointment.appointmentTimezone || "America/Los_Angeles",
    legalDialAt: appointment.legalDialAt || null,
    legalDialTimezone: appointment.legalDialTimezone || "America/Los_Angeles",
    status: appointment.status || "scheduled",
    note: appointment.note || null,
    createdAt: appointment.createdAt || new Date(),
    updatedAt: appointment.updatedAt || new Date(),
  };
}

async function upsertAppointment(appointmentId, patch = {}) {
  const normalizedId = String(appointmentId || patch.appointmentId || "").trim();
  const { historyEntry, ...setPatch } = patch;
  if (!normalizedId) throw new Error("appointmentId is required");
  const normalizedDomain = normalizeDomain(setPatch.domain);
  if (!normalizedDomain) throw new Error("domain is required");
  const caseId = Number(setPatch.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) throw new Error("caseId is required");

  return CxAppointment.findOneAndUpdate(
    { appointmentId: normalizedId },
    {
      $set: {
        ...setPatch,
        appointmentId: normalizedId,
        domain: normalizedDomain,
        caseId,
      },
      ...(historyEntry
        ? {
          $push: {
            history: historyEntry,
          },
        }
        : {}),
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function findAppointmentById(appointmentId) {
  const normalizedId = String(appointmentId || "").trim();
  if (!normalizedId) return null;
  return CxAppointment.findOne({ appointmentId: normalizedId }).lean();
}

async function findActiveAppointmentForCase(domain, caseId) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) return null;
  return CxAppointment.findOne({
    domain: normalizedDomain,
    caseId: numericCaseId,
    status: { $in: ACTIVE_APPOINTMENT_STATUSES },
  })
    .sort({ legalDialAt: 1, updatedAt: -1 })
    .lean();
}

async function listAppointments(filters = {}) {
  const query = {};
  if (filters.domain) query.domain = normalizeDomain(filters.domain);
  if (filters.caseId != null && filters.caseId !== "") query.caseId = Number(filters.caseId);
  if (filters.agentExtensionId) query.agentExtensionId = String(filters.agentExtensionId).trim();
  if (filters.agentEmail) query.agentEmail = String(filters.agentEmail).trim().toLowerCase();
  const statuses = normalizeStatusList(filters.status || filters.statuses);
  if (statuses.length > 0) query.status = { $in: statuses };

  const legalDialAt = {};
  if (filters.from) {
    const date = new Date(filters.from);
    if (!Number.isNaN(date.getTime())) legalDialAt.$gte = date;
  }
  if (filters.to) {
    const date = new Date(filters.to);
    if (!Number.isNaN(date.getTime())) legalDialAt.$lte = date;
  }
  if (Object.keys(legalDialAt).length > 0) query.legalDialAt = legalDialAt;

  return CxAppointment.find(query)
    .sort({ legalDialAt: 1, updatedAt: -1 })
    .limit(Math.min(Math.max(Number(filters.limit) || 200, 1), 1000))
    .lean();
}

async function listDueAppointments(now = new Date(), limit = 50) {
  return CxAppointment.find({
    status: { $in: ["scheduled", "blocked"] },
    legalDialAt: { $lte: now },
  })
    .sort({ legalDialAt: 1, updatedAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
    .lean();
}

async function patchAppointment(appointmentId, patch = {}, historyEntry = null) {
  const normalizedId = String(appointmentId || "").trim();
  if (!normalizedId) return null;
  const update = {
    $set: patch,
  };
  if (historyEntry) {
    update.$push = { history: historyEntry };
  }
  return CxAppointment.findOneAndUpdate(
    { appointmentId: normalizedId },
    update,
    { new: true },
  );
}

async function mirrorAgentAppointment(extensionId, appointment) {
  const normalizedExtensionId = String(extensionId || appointment?.agentExtensionId || "").trim();
  const normalizedAppointmentId = String(appointment?.appointmentId || "").trim();
  if (!normalizedExtensionId || !normalizedAppointmentId) return null;
  const mirror = buildAgentAppointmentMirror(toPlain(appointment));
  await AgentState.updateOne(
    { extensionId: normalizedExtensionId },
    {
      $pull: {
        appointments: { appointmentId: normalizedAppointmentId },
      },
    },
  );
  return AgentState.findOneAndUpdate(
    { extensionId: normalizedExtensionId },
    {
      $push: {
        appointments: {
          $each: [mirror],
          $sort: { legalDialAt: 1 },
          $slice: 100,
        },
      },
    },
    { new: true },
  );
}

async function patchAgentAppointment(extensionId, appointmentId, patch = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  const normalizedAppointmentId = String(appointmentId || "").trim();
  if (!normalizedExtensionId || !normalizedAppointmentId) return null;
  const set = {};
  for (const [key, value] of Object.entries(patch)) {
    set[`appointments.$.${key}`] = value;
  }
  set["appointments.$.updatedAt"] = new Date();
  return AgentState.findOneAndUpdate(
    {
      extensionId: normalizedExtensionId,
      "appointments.appointmentId": normalizedAppointmentId,
    },
    { $set: set },
    { new: true },
  );
}

async function removeAgentAppointment(extensionId, appointmentId) {
  const normalizedExtensionId = String(extensionId || "").trim();
  const normalizedAppointmentId = String(appointmentId || "").trim();
  if (!normalizedExtensionId || !normalizedAppointmentId) return null;
  return AgentState.findOneAndUpdate(
    { extensionId: normalizedExtensionId },
    {
      $pull: {
        appointments: { appointmentId: normalizedAppointmentId },
      },
    },
    { new: true },
  );
}

module.exports = {
  ACTIVE_APPOINTMENT_STATUSES,
  findActiveAppointmentForCase,
  findAppointmentById,
  listAppointments,
  listDueAppointments,
  mirrorAgentAppointment,
  patchAgentAppointment,
  patchAppointment,
  removeAgentAppointment,
  upsertAppointment,
};
