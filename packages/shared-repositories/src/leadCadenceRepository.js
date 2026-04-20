"use strict";

const { LeadCadence } = require("../../shared-models/src");

async function findLeadCadence(domain, caseId) {
  return LeadCadence.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

async function upsertLeadCadence(domain, caseId, update = {}) {
  return LeadCadence.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    { $set: update },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function listLeadCadence(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (typeof filters.active === "boolean") query.active = filters.active;
  if (filters.intakeSource) query.intakeSource = filters.intakeSource;
  if (filters.intakeRoute) query.intakeRoute = filters.intakeRoute;

  const limit = Math.min(Number(filters.limit) || 50, 200);
  return LeadCadence.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
}

async function listLeadCadenceByCaseIds(domain, caseIds = []) {
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];

  return LeadCadence.find({
    domain: String(domain || "").toUpperCase(),
    caseId: { $in: normalizedIds },
  })
    .sort({ updatedAt: -1, caseId: -1 })
    .lean();
}

async function listDueLeadCadenceByChannel(domain, {
  channel,
  actionType = null,
  now = new Date(),
  limit = 100,
} = {}) {
  return LeadCadence.find({
    domain: String(domain || "").toUpperCase(),
    active: true,
    "schedule.actions": {
      $elemMatch: {
        channel,
        status: { $in: ["pending", "requested"] },
        scheduledFor: { $lte: now },
        ...(actionType ? { type: actionType } : {}),
      },
    },
  })
    .sort({ "schedule.nextActionAt": 1, updatedAt: 1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();
}

async function countLeadCadence(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (typeof filters.active === "boolean") query.active = filters.active;
  if (filters.intakeSource) query.intakeSource = filters.intakeSource;
  if (filters.intakeRoute) query.intakeRoute = filters.intakeRoute;

  return LeadCadence.countDocuments(query);
}

async function countDueLeadCadenceByChannel(domain, {
  channel,
  actionType = null,
  now = new Date(),
} = {}) {
  return LeadCadence.countDocuments({
    domain: String(domain || "").toUpperCase(),
    active: true,
    "schedule.actions": {
      $elemMatch: {
        channel,
        status: { $in: ["pending", "requested"] },
        scheduledFor: { $lte: now },
        ...(actionType ? { type: actionType } : {}),
      },
    },
  });
}

async function markScheduledActionStatus(domain, caseId, actionKey, status, extra = {}) {
  const lead = await findLeadCadence(domain, caseId);
  if (!lead) return null;

  const action = (lead.schedule?.actions || []).find((entry) => entry.key === actionKey);
  if (action) {
    action.status = status;
  }

  const nextPending = (lead.schedule?.actions || [])
    .filter((entry) => entry.status === "pending" || entry.status === "requested")
    .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime())[0];

  lead.schedule = {
    ...lead.schedule,
    nextActionType: nextPending ? `${nextPending.channel}:${nextPending.type}` : null,
    nextActionAt: nextPending ? new Date(nextPending.scheduledFor) : null,
  };

  Object.entries(extra).forEach(([key, value]) => {
    lead.set(key, value);
  });

  await lead.save();
  return lead;
}

module.exports = {
  countDueLeadCadenceByChannel,
  countLeadCadence,
  findLeadCadence,
  listLeadCadence,
  listLeadCadenceByCaseIds,
  listDueLeadCadenceByChannel,
  markScheduledActionStatus,
  upsertLeadCadence,
};
