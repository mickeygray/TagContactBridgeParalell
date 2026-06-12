"use strict";

const mongoose = require("mongoose");
const { LeadCadence } = require("../../shared-models/src");
const { legacyReadDb } = require("./legacyReadDb");

// ── Legacy-collection read path ──────────────────────────────────────
//
// Legacy fallback for the pre-cutover `leadcadences` collection. Runtime
// reads now default to ControlPlaneLeadCadence after the raw legacy
// migration. Set LEAD_CADENCE_LEGACY_READS_ENABLED=true only for an
// emergency comparison against the old app database.
//
// The old collection uses different field names:
//   • tenant key:   `company` (legacy)  vs  `domain` (parallel)
//   • phone:        `phone`              vs  `primaryPhone` + `normalizedPhone`
//   • name:         single `name`        vs  `firstName` + `lastName`
//   • no schedule.actions[] structure on legacy — orchestration queries
//     stay on the parallel collection because legacy can't satisfy them.
//
// Simple finders/listers read ControlPlane first. Writes and
// schedule-driven orchestration stay on the parallel model.
function legacyLeadCadenceCollection() {
  return legacyReadDb(mongoose).collection("leadcadences");
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacyLeadCadenceReadsEnabled() {
  return boolFromEnv(process.env.LEAD_CADENCE_LEGACY_READS_ENABLED, false);
}

const AGED_DNC_FIRST_CHECK_MS = 30 * 24 * 60 * 60 * 1000;

function buildAgedDncCheckpointOnInsert(update = {}) {
  const hasExplicitDncCheckpoint = Object.keys(update).some((key) => (
    key === "dncCheckpoints" || key.startsWith("dncCheckpoints.")
  ));
  if (hasExplicitDncCheckpoint || update.active !== true) return {};
  return {
    "dncCheckpoints.count": 0,
    "dncCheckpoints.nextAt": new Date(Date.now() + AGED_DNC_FIRST_CHECK_MS),
    "dncCheckpoints.cleared": false,
    "dncCheckpoints.hit": false,
    "dncCheckpoints.source": "intake",
  };
}

function normalizeLegacyLeadCadence(doc) {
  if (!doc) return null;
  const company = doc.company || doc.domain || null;
  const phone = doc.phone || doc.primaryPhone || null;
  const digits = phone ? String(phone).replace(/\D/g, "") : "";
  const normalized = digits.length >= 10 ? digits.slice(-10) : null;
  // Try to back-fill firstName/lastName from `name` if the parallel
  // shape's consumers rely on the split.
  let firstName = doc.firstName || null;
  let lastName = doc.lastName || null;
  if (!firstName && !lastName && doc.name) {
    const parts = String(doc.name).trim().split(/\s+/);
    firstName = parts[0] || null;
    lastName = parts.slice(1).join(" ") || null;
  }
  return {
    ...doc,
    domain: company ? String(company).toUpperCase() : null,
    primaryPhone: doc.primaryPhone || phone || null,
    normalizedPhone: doc.normalizedPhone || normalized,
    firstName,
    lastName,
  };
}

async function findLeadCadence(domain, caseId) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  const currentDoc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: numericCaseId,
  }).lean();
  if (currentDoc || !legacyLeadCadenceReadsEnabled()) {
    return normalizeLegacyLeadCadence(currentDoc);
  }

  const doc = await legacyLeadCadenceCollection().findOne({
    company: normalizedDomain,
    caseId: numericCaseId,
  });
  return normalizeLegacyLeadCadence(doc);
}

async function upsertLeadCadence(domain, caseId, update = {}) {
  const setOnInsert = buildAgedDncCheckpointOnInsert(update);
  const updateDoc = Object.keys(setOnInsert).length
    ? { $set: update, $setOnInsert: setOnInsert }
    : { $set: update };
  return LeadCadence.findOneAndUpdate(
    {
      domain: String(domain || "").toUpperCase(),
      caseId: Number(caseId),
    },
    updateDoc,
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function saveLeadCadenceInterviewSnapshot(domain, caseId, interviewSnapshot = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  const result = await LeadCadence.updateOne(
    {
      domain: normalizedDomain,
      caseId: numericCaseId,
    },
    {
      $set: {
        interviewSnapshot,
      },
    },
  );
  return {
    matchedCount: result.matchedCount ?? result.n ?? 0,
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
  };
}

// Best-effort date-range coercion. Accepts:
//   - Date instances              → returned as-is
//   - ISO datetime strings        → parsed via `new Date()`
//   - "YYYY-MM-DD" date strings   → resolved to PT-day bounds
//                                   (`endOfDay=true` → 23:59:59.999 PT,
//                                    otherwise       → 00:00:00.000 PT)
// Returns null for unparseable / empty input so callers can skip the
// clause without branching on multiple types.
function coerceDateBoundary(value, { endOfDay = false } = {}) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (dateOnly) {
    // Anchor to America/Los_Angeles (operator-time) so a date-only
    // input from the UI maps to the day everyone in the room means by
    // it, not the UTC day. We compute the offset for the target wall
    // time so DST transitions land on the correct UTC moment.
    const [year, month, day] = raw.split("-").map((part) => Number(part));
    const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
    const naiveUtcMs = Date.parse(`${raw}T${time}Z`);
    const wallClockSampler = new Date(naiveUtcMs);
    const tzString = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "shortOffset",
    })
      .formatToParts(wallClockSampler)
      .find((part) => part.type === "timeZoneName")?.value || "GMT-08:00";
    const offsetMatch = String(tzString).match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    let offsetMinutes = 0;
    if (offsetMatch) {
      const sign = offsetMatch[1] === "-" ? -1 : 1;
      const hours = Number(offsetMatch[2] || 0);
      const minutes = Number(offsetMatch[3] || 0);
      offsetMinutes = sign * (hours * 60 + minutes);
    }
    // wallTime - offset = UTC. PT is UTC-8/-7, so offsetMinutes is
    // negative; subtracting it adds time, which is correct.
    const utcMs = naiveUtcMs - offsetMinutes * 60 * 1000;
    return new Date(utcMs);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function listLeadCadence(domain, filters = {}) {
  const query = {
    domain: String(domain || "").toUpperCase(),
  };

  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (typeof filters.active === "boolean") query.active = filters.active;
  if (filters.intakeSource) query.intakeSource = filters.intakeSource;
  if (filters.intakeRoute) query.intakeRoute = filters.intakeRoute;
  if (filters.statusId != null) query.statusId = Number(filters.statusId);

  // Date-range scoping — additive with everything else above. Both
  // bounds optional and independent. The legacy `leadcadences`
  // collection writes `createdAt` automatically (Mongoose timestamps),
  // so this is the natural "leads added in window X" axis.
  const createdAfter = coerceDateBoundary(filters.createdAtAfter, { endOfDay: false });
  const createdBefore = coerceDateBoundary(filters.createdAtBefore, { endOfDay: true });
  if (createdAfter || createdBefore) {
    query.createdAt = {};
    if (createdAfter) query.createdAt.$gte = createdAfter;
    if (createdBefore) query.createdAt.$lte = createdBefore;
  }

  if (filters.search) {
    const value = String(filters.search).trim();
    if (value) {
      const regex = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const digits = value.replace(/\D/g, "");
      // Legacy stores phone as a single field; no firstName/lastName split.
      query.$or = [
        { name: regex },
        { firstName: regex },
        { lastName: regex },
        { phone: regex },
        { primaryPhone: regex },
        { email: regex },
      ];
      if (digits) {
        query.$or.push({ phone: new RegExp(digits) });
        query.$or.push({ normalizedPhone: digits.length >= 10 ? digits.slice(-10) : digits });
      }
    }
  }

  const limit = Math.min(Number(filters.limit) || 50, 20000);
  if (legacyLeadCadenceReadsEnabled()) {
    const legacyQuery = { ...query, company: query.domain };
    delete legacyQuery.domain;
    const cursor = await legacyLeadCadenceCollection().find(legacyQuery);
    const docs = await cursor
      .sort({ updatedAt: -1, caseId: -1 })
      .limit(limit)
      .toArray();
    return docs.map(normalizeLegacyLeadCadence);
  }

  const docs = await LeadCadence.find(query)
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(limit)
    .lean();
  return docs.map(normalizeLegacyLeadCadence);
}

async function listLeadCadenceByCaseIds(domain, caseIds = []) {
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];

  if (legacyLeadCadenceReadsEnabled()) {
    const cursor = await legacyLeadCadenceCollection().find({
      company: String(domain || "").toUpperCase(),
      caseId: { $in: normalizedIds },
    });
    const docs = await cursor
      .sort({ updatedAt: -1, caseId: -1 })
      .toArray();
    return docs.map(normalizeLegacyLeadCadence);
  }

  const docs = await LeadCadence.find({
    domain: String(domain || "").toUpperCase(),
    caseId: { $in: normalizedIds },
  })
    .sort({ updatedAt: -1, caseId: -1 })
    .lean();
  return docs.map(normalizeLegacyLeadCadence);
}

async function listControlPlaneLeadCadenceByCaseIds(domain, caseIds = []) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return [];

  return LeadCadence.find({
    domain: normalizedDomain,
    caseId: { $in: normalizedIds },
  })
    .sort({ updatedAt: -1, caseId: -1 })
    .lean();
}

async function findLeadCadenceByEmail(domain, email) {
  const normalizedEmail = String(email || "").trim();
  if (!normalizedEmail) return null;

  const normalizedDomain = String(domain || "").toUpperCase();
  const emailRegex = new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const currentDoc = await LeadCadence.findOne({
    domain: normalizedDomain,
    email: emailRegex,
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  if (currentDoc || !legacyLeadCadenceReadsEnabled()) {
    return normalizeLegacyLeadCadence(currentDoc);
  }

  const doc = await legacyLeadCadenceCollection().findOne({
    company: normalizedDomain,
    email: emailRegex,
  });
  return normalizeLegacyLeadCadence(doc);
}

async function findLeadCadenceByEmailHash(domain, emailHash) {
  const normalizedHash = String(emailHash || "").trim().toLowerCase();
  if (!normalizedHash) return null;

  return LeadCadence.findOne({
    domain: String(domain || "").toUpperCase(),
    emailHash: normalizedHash,
  }).lean();
}

async function listDueLeadCadenceByChannel(domain, {
  channel,
  actionType = null,
  now = new Date(),
  limit = 100,
  statuses = ["pending", "requested"],
} = {}) {
  return LeadCadence.find({
    domain: String(domain || "").toUpperCase(),
    active: true,
    "schedule.actions": {
      $elemMatch: {
        channel,
        status: { $in: statuses },
        scheduledFor: { $lte: now },
        ...(actionType ? { type: actionType } : {}),
      },
    },
  })
    .sort({ "schedule.nextActionAt": 1, updatedAt: 1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();
}

async function listCxRequestedActionsForReconcile({
  domain = null,
  now = new Date(),
  olderThanMs = 2 * 60 * 1000,
  limit = 100,
} = {}) {
  const normalizedDomain = domain ? String(domain || "").toUpperCase() : null;
  const cutoff = new Date(new Date(now).getTime() - Math.max(Number(olderThanMs) || 0, 0));
  const query = {
    active: true,
    "schedule.actions": {
      $elemMatch: {
        channel: "cx",
        status: "requested",
        scheduledFor: { $lte: cutoff },
      },
    },
  };
  if (normalizedDomain) {
    query.domain = normalizedDomain;
  }

  return LeadCadence.find(query)
    .sort({ "schedule.nextActionAt": 1, updatedAt: 1, caseId: 1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 1000))
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
  statuses = ["pending", "requested"],
} = {}) {
  return LeadCadence.countDocuments({
    domain: String(domain || "").toUpperCase(),
    active: true,
    "schedule.actions": {
      $elemMatch: {
        channel,
        status: { $in: statuses },
        scheduledFor: { $lte: now },
        ...(actionType ? { type: actionType } : {}),
      },
    },
  });
}

async function listLeadCadenceForEnforcement({
  domain = null,
  now = new Date(),
  minStaleMs = 55 * 60 * 1000,
  limit = 250,
} = {}) {
  const cutoff = new Date(new Date(now).getTime() - Math.max(Number(minStaleMs) || 0, 0));
  const query = {
    active: true,
    $or: [
      { "cadenceState.lastEvaluatedAt": { $exists: false } },
      { "cadenceState.lastEvaluatedAt": null },
      { "cadenceState.lastEvaluatedAt": { $lt: cutoff } },
    ],
  };

  if (domain) {
    query.domain = String(domain || "").toUpperCase();
  }

  return LeadCadence.find(query)
    .sort({
      "cadenceState.lastEvaluatedAt": 1,
      "schedule.nextActionAt": 1,
      updatedAt: 1,
      caseId: 1,
    })
    .limit(Math.min(Math.max(Number(limit) || 250, 1), 5000))
    .lean();
}

async function markLeadCadenceEvaluated(domain, caseId, extra = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const safeExtra = {};

  for (const [key, value] of Object.entries(extra || {})) {
    if (!key || key.startsWith("schedule.actions")) continue;
    safeExtra[key] = value;
  }

  return LeadCadence.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
    },
    {
      $set: {
        ...safeExtra,
        "cadenceState.lastEvaluatedAt": new Date(),
      },
    },
    { new: true },
  );
}

async function claimScheduledAction(domain, caseId, actionKey, extra = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const safeExtra = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (!key || key.startsWith("schedule.actions")) continue;
    safeExtra[key] = value;
  }

  return LeadCadence.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      "schedule.actions": {
        $elemMatch: {
          key: actionKey,
          status: "pending",
        },
      },
    },
    {
      $set: {
        "schedule.actions.$.status": "requested",
        ...safeExtra,
      },
    },
    { new: true },
  );
}

async function rescheduleScheduledAction(domain, caseId, actionKey, scheduledFor, extra = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const safeExtra = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (!key || key.startsWith("schedule.actions")) continue;
    safeExtra[key] = value;
  }

  const pendingStatuses = ["pending", "requested"];
  return LeadCadence.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      "schedule.actions.key": actionKey,
    },
    [
      {
        $set: {
          "schedule.actions": {
            $map: {
              input: { $ifNull: ["$schedule.actions", []] },
              as: "a",
              in: {
                $cond: [
                  { $eq: ["$$a.key", actionKey] },
                  {
                    $mergeObjects: [
                      "$$a",
                      {
                        status: "pending",
                        scheduledFor,
                      },
                    ],
                  },
                  "$$a",
                ],
              },
            },
          },
          ...safeExtra,
        },
      },
      {
        $set: {
          "schedule.nextActionType": {
            $let: {
              vars: {
                next: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$schedule.actions",
                        as: "a",
                        cond: { $in: ["$$a.status", pendingStatuses] },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$$value", null] },
                            { $lt: ["$$this.scheduledFor", "$$value.scheduledFor"] },
                          ],
                        },
                        "$$this",
                        "$$value",
                      ],
                    },
                  },
                },
              },
              in: {
                $cond: [
                  { $ne: ["$$next", null] },
                  {
                    $concat: [
                      { $ifNull: ["$$next.channel", ""] },
                      ":",
                      { $ifNull: ["$$next.type", ""] },
                    ],
                  },
                  null,
                ],
              },
            },
          },
          "schedule.nextActionAt": {
            $let: {
              vars: {
                next: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$schedule.actions",
                        as: "a",
                        cond: { $in: ["$$a.status", pendingStatuses] },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$$value", null] },
                            { $lt: ["$$this.scheduledFor", "$$value.scheduledFor"] },
                          ],
                        },
                        "$$this",
                        "$$value",
                      ],
                    },
                  },
                },
              },
              in: "$$next.scheduledFor",
            },
          },
        },
      },
    ],
    { new: true },
  );
}

/**
 * Atomically mark a specific scheduled action's status AND recompute the
 * cadence-wide summary fields (`schedule.nextActionType`, `schedule.nextActionAt`).
 *
 * Uses a single aggregation-pipeline update so concurrent workers processing
 * different actions on the same cadence cannot race on the summary. All three
 * mutations — update the action, apply any top-level `extra` fields, and
 * recompute the summary from the updated array — run as one document op.
 *
 * Requires MongoDB 4.2+ for aggregation pipeline updates.
 */
async function markScheduledActionStatus(domain, caseId, actionKey, status, extra = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);

  // Sanitize top-level `extra` fields. These are document-level sets such as
  // `currentStage: "sms-sent"`. They must not target the action array
  // directly — that's handled by the pipeline's $map stage.
  // The reserved `actionPatch` key is pulled out separately and merged
  // INTO the matching action object alongside `status` (used today to
  // stamp providerDelivery tracking onto rvm actions).
  const safeExtra = {};
  let actionPatch = null;
  for (const [key, value] of Object.entries(extra || {})) {
    if (!key) continue;
    if (key === "actionPatch") {
      actionPatch = value && typeof value === "object" ? value : null;
      continue;
    }
    if (key.startsWith("schedule.actions")) continue;
    safeExtra[key] = value;
  }

  const pendingStatuses = ["pending", "requested"];

  // Build the per-action merge object. `status` always wins over any
  // `actionPatch.status` so callers can't accidentally bypass the
  // status-machine via the patch.
  const actionMerge = actionPatch ? { ...actionPatch, status } : { status };

  return LeadCadence.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      "schedule.actions.key": actionKey,
    },
    [
      // 1. Update the target action's status inside schedule.actions[] via $map.
      {
        $set: {
          "schedule.actions": {
            $map: {
              input: { $ifNull: ["$schedule.actions", []] },
              as: "a",
              in: {
                $cond: [
                  { $eq: ["$$a.key", actionKey] },
                  { $mergeObjects: ["$$a", actionMerge] },
                  "$$a",
                ],
              },
            },
          },
          ...safeExtra,
        },
      },
      // 2. Recompute the summary from the now-updated actions array using
      //    $reduce to find the earliest pending/requested entry. No
      //    $sortArray used, so this works on MongoDB 4.2+.
      {
        $set: {
          "schedule.nextActionType": {
            $let: {
              vars: {
                next: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$schedule.actions",
                        as: "a",
                        cond: { $in: ["$$a.status", pendingStatuses] },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$$value", null] },
                            {
                              $lt: [
                                "$$this.scheduledFor",
                                "$$value.scheduledFor",
                              ],
                            },
                          ],
                        },
                        "$$this",
                        "$$value",
                      ],
                    },
                  },
                },
              },
              in: {
                $cond: [
                  { $ne: ["$$next", null] },
                  {
                    $concat: [
                      { $ifNull: ["$$next.channel", ""] },
                      ":",
                      { $ifNull: ["$$next.type", ""] },
                    ],
                  },
                  null,
                ],
              },
            },
          },
          "schedule.nextActionAt": {
            $let: {
              vars: {
                next: {
                  $reduce: {
                    input: {
                      $filter: {
                        input: "$schedule.actions",
                        as: "a",
                        cond: { $in: ["$$a.status", pendingStatuses] },
                      },
                    },
                    initialValue: null,
                    in: {
                      $cond: [
                        {
                          $or: [
                            { $eq: ["$$value", null] },
                            {
                              $lt: [
                                "$$this.scheduledFor",
                                "$$value.scheduledFor",
                              ],
                            },
                          ],
                        },
                        "$$this",
                        "$$value",
                      ],
                    },
                  },
                },
              },
              in: "$$next.scheduledFor",
            },
          },
        },
      },
    ],
    { new: true },
  );
}

function buildCadenceStateFromActions(actions = [], existingCaps = {}, existingChannelDnc = {}) {
  const channels = ["sms", "email", "rvm", "cx"];
  const completedByChannel = {};
  const failedByChannel = {};
  const pendingByChannel = {};
  const lastCompletedAtByChannel = {};
  // Per-channel "scheduled actions in this lead" (used by the
  // exhausted-channel logic below). NOT a rate-limit cap — a cap of N
  // here would self-trap every dispatch since pendingByChannel + the
  // about-to-fire action == cap. The actual rate-limit caps live in
  // `existingCaps`, set by the schedule builder / rules engine, and
  // are preserved across syncs.
  const scheduledByChannel = {};

  for (const channel of channels) {
    const channelActions = actions.filter((entry) => entry.channel === channel);
    scheduledByChannel[channel] = channelActions.length;
    completedByChannel[channel] = channelActions.filter((entry) => entry.status === "completed").length;
    failedByChannel[channel] = channelActions.filter((entry) => entry.status === "failed" || entry.status === "cancelled").length;
    pendingByChannel[channel] = channelActions.filter((entry) => entry.status === "pending" || entry.status === "requested").length;
    const completed = channelActions
      .filter((entry) => entry.status === "completed" && entry.scheduledFor)
      .sort((left, right) => new Date(right.scheduledFor).getTime() - new Date(left.scheduledFor).getTime())[0];
    lastCompletedAtByChannel[channel] = completed?.scheduledFor || null;
  }

  const exhaustedChannels = channels.filter((channel) => scheduledByChannel[channel] > 0 && pendingByChannel[channel] === 0);
  const engagementChannels = ["sms", "email", "rvm"];
  const engagementChannelsExhausted = engagementChannels.every((channel) => scheduledByChannel[channel] === 0 || pendingByChannel[channel] === 0);
  const nextPending = actions
    .filter((entry) => entry.status === "pending" || entry.status === "requested")
    .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime())[0];

  return {
    caps: existingCaps || {},
    completedByChannel,
    failedByChannel,
    pendingByChannel,
    exhaustedChannels,
    engagementChannelsExhausted,
    nextChannel: nextPending?.channel || null,
    lastCompletedAtByChannel,
    lastEvaluatedAt: new Date(),
    // Per-channel DNC flags are durable state set by provider-failure
    // classifiers (markChannelDnc). Preserve through every recompute —
    // never derive from actions.
    channelDnc: existingChannelDnc || {},
  };
}

async function syncLeadCadenceState(domain, caseId) {
  const doc = await LeadCadence.findOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
  if (!doc) return null;

  // Legacy-time-count mode runs cadence on counters + lastTouched
  // timestamps, NOT on schedule.actions. For those leads we still
  // refresh cadenceState (channelDnc bookkeeping etc.) but we do NOT
  // recompute currentStage / active from action presence — an empty
  // actions array isn't "complete" in this mode, it's just the normal
  // state. Other code paths (cadence engine ticks, manual deactivation,
  // status sync) own currentStage / active for legacy-time-count leads.
  if (doc.cadenceMode === "legacy-time-count") {
    const cadenceState = buildCadenceStateFromActions(
      doc.schedule?.actions || [],
      doc.cadenceState?.caps || {},
      doc.cadenceState?.channelDnc || {},
    );
    doc.cadenceState = cadenceState;
    await doc.save();
    return doc.toObject();
  }

  const cadenceState = buildCadenceStateFromActions(
    doc.schedule?.actions || [],
    doc.cadenceState?.caps || {},
    doc.cadenceState?.channelDnc || {},
  );
  let currentStage = doc.currentStage || "new";
  const nextActionType = doc.schedule?.nextActionType || null;

  if (nextActionType) {
    currentStage = `cadence-${String(nextActionType).replace(/:/g, "-")}`;
  } else if (cadenceState.engagementChannelsExhausted && cadenceState.pendingByChannel.cx > 0) {
    currentStage = "awaiting-cx-cadence";
  } else if (
    Object.values(cadenceState.pendingByChannel).reduce((sum, value) => sum + Number(value || 0), 0) === 0
  ) {
    currentStage = "cadence-complete";
  }

  doc.cadenceState = cadenceState;
  doc.currentStage = currentStage;
  doc.active = Boolean(nextActionType);
  await doc.save();
  return doc.toObject();
}

/**
 * Cancel scheduled actions that have been sitting in pending/requested
 * state past their due date for `olderThanMs`. The cadence scheduler
 * occasionally loses claims (worker died mid-run, DB blip, payload
 * rejected by the dispatcher) leaving actions stuck. Without a cleanup
 * sweep, they accumulate and either re-fire wildly when the scheduler
 * catches up, or linger forever.
 *
 * Returns `{ matched, modified }` counts. Safe to run on a nightly
 * cadence.
 *
 * @param {Object} args
 * @param {number} [args.olderThanMs=172800000] - default 48h grace. An
 *   action scheduled for T is safe to cancel if now > T + olderThanMs.
 * @param {number} [args.limit=500] - per-run cap; higher caps pound the
 *   cluster with aggregation. Scheduler typically sweeps a few hundred
 *   stale rows at a time.
 */
async function cancelStaleScheduledActions({
  olderThanMs = 48 * 60 * 60 * 1000,
  limit = 500,
  reason = "stale-sweep",
} = {}) {
  const cutoff = new Date(Date.now() - Number(olderThanMs));
  // Find candidate rows — any lead cadence with at least one action
  // that's stale AND in a non-terminal state. The aggregation is bounded
  // by `limit` to keep the sweep predictable.
  const candidates = await LeadCadence.find(
    {
      "schedule.actions": {
        $elemMatch: {
          status: { $in: ["pending", "requested"] },
          scheduledFor: { $lt: cutoff },
        },
      },
    },
    { _id: 1, domain: 1, caseId: 1 },
  )
    .limit(Math.min(Number(limit) || 500, 2000))
    .lean();

  let modified = 0;
  for (const candidate of candidates) {
    const doc = await LeadCadence.findById(candidate._id);
    if (!doc) continue;
    const actions = Array.isArray(doc.schedule?.actions) ? doc.schedule.actions : [];
    let changed = false;
    doc.schedule.actions = actions.map((entry) => {
      const stale =
        (entry.status === "pending" || entry.status === "requested") &&
        entry.scheduledFor &&
        new Date(entry.scheduledFor) < cutoff;
      if (!stale) return entry;
      changed = true;
      return {
        ...(entry.toObject ? entry.toObject() : entry),
        status: "cancelled",
      };
    });
    if (changed) {
      doc.cadenceState = {
        ...(doc.cadenceState?.toObject
          ? doc.cadenceState.toObject()
          : doc.cadenceState || {}),
        lastEvaluatedAt: new Date(),
        lastStaleSweepAt: new Date(),
        lastStaleSweepReason: reason,
      };
      await doc.save();
      modified += 1;
    }
  }
  return { matched: candidates.length, modified };
}

/**
 * Find every active Parallel LeadCadence row matching this phone,
 * across all domains. Used by the inbound CallRail SMS handler — when
 * a recipient texts STOP we want to mark the DNC on every cadence
 * that owns that number, not just one company. Returns an array
 * (possibly empty); does NOT touch legacy.
 */
async function findActiveControlPlaneLeadCadencesByPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const tenDigit = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
  if (!tenDigit) return [];
  const docs = await LeadCadence.find({
    active: true,
    $or: [
      { normalizedPhone: tenDigit },
      { primaryPhone: { $regex: tenDigit } },
    ],
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  return docs;
}

async function findLeadCadenceByPhone(domain, phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  const tenDigit = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
  const normalizedDomain = String(domain || "").toUpperCase();
  const currentDoc = await LeadCadence.find({
    domain: normalizedDomain,
    $or: [
      { normalizedPhone: tenDigit },
      { primaryPhone: new RegExp(tenDigit) },
    ],
  })
    .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
    .limit(1)
    .lean()
    .then((rows) => rows[0] || null);
  if (currentDoc || !legacyLeadCadenceReadsEnabled()) {
    return normalizeLegacyLeadCadence(currentDoc);
  }

  const cursor = await legacyLeadCadenceCollection().find({
    company: normalizedDomain,
    $or: [
      { normalizedPhone: tenDigit },
      { phone: new RegExp(tenDigit) },
    ],
  });
  const doc = await cursor
    .sort({ createdAt: -1, updatedAt: -1, _id: -1 })
    .limit(1)
    .next();
  return normalizeLegacyLeadCadence(doc);
}

/**
 * Mark one or more cadence channels as opted-out for a given lead.
 *
 * Behavior:
 *  - Adds each channel to `cadenceState.exhaustedChannels` (union, dedup).
 *  - Cancels any pending/requested actions on those channels so the
 *    scheduler stops trying — prevents wasted CallRail API calls when
 *    the carrier has already blocked the channel (STOP keyword) or the
 *    lead explicitly opted out.
 *  - Does NOT flip `active=false` by itself — that's reserved for full
 *    DNC (all engagement channels exhausted). The caller decides.
 *  - Stamps `cadenceState.optedOutChannels` with the reason + timestamp
 *    so downstream audits can see why a channel went dark.
 *
 * @param {Object} args
 * @param {string} args.domain
 * @param {string} args.phone - digits only
 * @param {string[]} args.channels - subset of ["sms","email","rvm","call"]
 * @param {string} [args.reason] - freeform, e.g. "carrier-stop" or "dnc-confirm"
 * @returns {Object|null} updated cadence (lean) or null if not found
 */
async function markCadenceChannelsOptedOut({
  domain,
  phone,
  channels,
  reason = null,
} = {}) {
  const digits = String(phone || "").replace(/\D/g, "");
  const channelList = Array.isArray(channels)
    ? channels.map((c) => String(c || "").toLowerCase()).filter(Boolean)
    : [];
  if (!digits || channelList.length === 0) return null;
  const tenDigit = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.length >= 10
      ? digits.slice(-10)
      : digits;

  const normalizedDomain = String(domain || "").toUpperCase();
  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    $or: [
      { normalizedPhone: digits },
      { normalizedPhone: tenDigit },
      { primaryPhone: { $regex: tenDigit } },
    ],
  });
  if (!doc) return null;

  const existing = Array.isArray(doc.cadenceState?.exhaustedChannels)
    ? doc.cadenceState.exhaustedChannels
    : [];
  const union = Array.from(new Set([...existing, ...channelList]));

  // Cancel pending/requested actions on the specified channels.
  const actions = Array.isArray(doc.schedule?.actions) ? doc.schedule.actions : [];
  const channelSet = new Set(channelList);
  doc.schedule.actions = actions.map((entry) => {
    const isTargetChannel = channelSet.has(String(entry.channel || "").toLowerCase());
    const isOpen = entry.status === "pending" || entry.status === "requested";
    if (isTargetChannel && isOpen) {
      return {
        ...(entry.toObject ? entry.toObject() : entry),
        status: "cancelled",
      };
    }
    return entry;
  });

  doc.cadenceState = {
    ...(doc.cadenceState?.toObject ? doc.cadenceState.toObject() : doc.cadenceState || {}),
    exhaustedChannels: union,
    optedOutChannels: {
      ...(doc.cadenceState?.optedOutChannels || {}),
      ...Object.fromEntries(
        channelList.map((channel) => [
          channel,
          { reason: reason || null, at: new Date() },
        ]),
      ),
    },
    lastEvaluatedAt: new Date(),
  };

  // If every engagement channel is now opted out, flag it on the row
  // so the scheduler won't even consider waking this lead. Doesn't
  // toggle `active=false` — that stays with the cadence sweeper so it
  // can still process DNC-consent reconciliation runs.
  const engagement = ["sms", "email", "rvm"];
  if (engagement.every((c) => union.includes(c))) {
    doc.cadenceState.engagementChannelsExhausted = true;
  }

  await doc.save();
  return doc.toObject();
}

async function cancelPendingActions(domain, caseId, extra = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  });
  if (!doc) return null;

  const actions = Array.isArray(doc.schedule?.actions) ? doc.schedule.actions : [];
  let changed = false;
  doc.schedule.actions = actions.map((entry) => {
    if (entry.status === "pending" || entry.status === "requested") {
      changed = true;
      return {
        ...(entry.toObject ? entry.toObject() : entry),
        status: "cancelled",
      };
    }
    return entry;
  });

  for (const [key, value] of Object.entries(extra || {})) {
    if (!key || key.startsWith("schedule.actions")) continue;
    doc.set(key, value);
  }

  doc.active = false;
  if (changed || Object.keys(extra || {}).length > 0 || doc.isModified()) {
    await doc.save();
  }
  return syncLeadCadenceState(normalizedDomain, normalizedCaseId);
}

async function saveLiveCoachCloseoutSummary(domain, caseId, summary = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(normalizedCaseId)) return null;
  const payload = {
    ...(summary && typeof summary === "object" ? summary : {}),
    updatedAt: new Date(),
    source: "live-coach-closeout",
  };
  return LeadCadence.updateOne(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
    },
    {
      $set: {
        liveCoachCloseout: payload,
      },
    },
  );
}

async function deleteLeadCadence(domain, caseId) {
  return LeadCadence.deleteOne({
    domain: String(domain || "").toUpperCase(),
    caseId: Number(caseId),
  });
}

/**
 * Find rvm actions whose Drop.co disposition is still unknown. Used
 * by the async disposition poller. We look for completed rvm actions
 * with `providerDelivery.activityToken` set and either no terminal
 * disposition recorded OR a non-terminal one — bounded by:
 *   - postedAt within `maxAgeMs` (give up polling stale tokens)
 *   - lastPolledAt older than `minIntervalMs` (don't hammer Drop)
 *   - pollAttempts under `maxAttempts` (give up after N tries)
 */
async function listRvmActionsAwaitingDisposition({
  now = new Date(),
  maxAgeMs = 24 * 60 * 60 * 1000,    // 24h cap on polling lifetime
  minIntervalMs = 5 * 60 * 1000,     // 5m between poll attempts per token
  maxAttempts = 24,                  // 24 attempts × 5m = 2h coverage
  limit = 25,
} = {}) {
  const ageCutoff = new Date(now.getTime() - maxAgeMs);
  const intervalCutoff = new Date(now.getTime() - minIntervalMs);
  const docs = await LeadCadence.find({
    "schedule.actions": {
      $elemMatch: {
        channel: "rvm",
        status: "completed",
        "providerDelivery.activityToken": { $exists: true, $ne: null },
        "providerDelivery.postedAt": { $gte: ageCutoff },
        "providerDelivery.pollAttempts": { $lt: maxAttempts },
        $or: [
          { "providerDelivery.disposition": null },
          { "providerDelivery.disposition.terminal": false },
        ],
        $and: [
          {
            $or: [
              { "providerDelivery.lastPolledAt": null },
              { "providerDelivery.lastPolledAt": { $lt: intervalCutoff } },
            ],
          },
        ],
      },
    },
  })
    .limit(Math.min(Number(limit) || 25, 200))
    .lean();

  // Flatten to a list of actions-with-context the caller can iterate
  // without needing to reach back into the doc array.
  const out = [];
  for (const doc of docs) {
    for (const action of doc.schedule?.actions || []) {
      if (action.channel !== "rvm") continue;
      if (action.status !== "completed") continue;
      const pd = action.providerDelivery;
      if (!pd?.activityToken) continue;
      if (pd?.disposition?.terminal) continue;
      if (pd?.postedAt && new Date(pd.postedAt) < ageCutoff) continue;
      if (pd?.pollAttempts != null && pd.pollAttempts >= maxAttempts) continue;
      if (pd?.lastPolledAt && new Date(pd.lastPolledAt) > intervalCutoff) continue;
      out.push({
        domain: doc.domain,
        caseId: doc.caseId,
        actionKey: action.key,
        providerDelivery: pd,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Record a Drop disposition poll outcome on the action's
 * providerDelivery field. Increments pollAttempts and stamps
 * lastPolledAt regardless of whether disposition went terminal.
 */
async function recordRvmDispositionPoll(domain, caseId, actionKey, disposition) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const now = new Date();

  return LeadCadence.findOneAndUpdate(
    {
      domain: normalizedDomain,
      caseId: normalizedCaseId,
      "schedule.actions.key": actionKey,
    },
    [
      {
        $set: {
          "schedule.actions": {
            $map: {
              input: { $ifNull: ["$schedule.actions", []] },
              as: "a",
              in: {
                $cond: [
                  { $eq: ["$$a.key", actionKey] },
                  {
                    $mergeObjects: [
                      "$$a",
                      {
                        providerDelivery: {
                          $mergeObjects: [
                            { $ifNull: ["$$a.providerDelivery", {}] },
                            {
                              lastPolledAt: now,
                              pollAttempts: {
                                $add: [
                                  { $ifNull: ["$$a.providerDelivery.pollAttempts", 0] },
                                  1,
                                ],
                              },
                              disposition: disposition,
                            },
                          ],
                        },
                      },
                    ],
                  },
                  "$$a",
                ],
              },
            },
          },
        },
      },
    ],
    { new: true },
  );
}

/**
 * Find leads whose federal-DNC recheck is due. Used by the bimonthly
 * sweep — finds active leads where `cadenceState.dncCheck.nextCheckAt`
 * has passed. Returns up to `limit` rows; sweep can re-run on
 * subsequent ticks to drain a large backlog.
 *
 * Skips leads where:
 *   - active is false (already deactivated)
 *   - cadenceState.channelDnc.cx is already blocked (already DNC'd
 *     via this or another path; re-check would be redundant)
 *   - normalizedPhone missing (can't query RealValidation without one)
 */
async function listLeadsDueForDncRecheck({ now = new Date(), limit = 100 } = {}) {
  return LeadCadence.find({
    active: true,
    normalizedPhone: { $exists: true, $nin: [null, ""] },
    "cadenceState.dncCheck.nextCheckAt": { $lte: now },
    "cadenceState.channelDnc.cx.blocked": { $ne: true },
  })
    .sort({ "cadenceState.dncCheck.nextCheckAt": 1, updatedAt: 1 })
    .limit(Math.min(Number(limit) || 100, 500))
    .lean();
}

/**
 * Stamp the result of a federal-DNC recheck on the lead's
 * `cadenceState.dncCheck`. Sets `lastCheckedAt`, `lastResult`, and
 * `nextCheckAt`. Does NOT mark channelDnc — caller decides that
 * separately based on whether result.onDnc + past-grace conditions
 * are met.
 */
async function recordDncRecheck(domain, caseId, { result, nextCheckAt }) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const now = new Date();
  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  });
  if (!doc) return null;
  if (!doc.cadenceState) doc.cadenceState = {};
  doc.cadenceState.dncCheck = {
    ...(doc.cadenceState.dncCheck || {}),
    lastCheckedAt: now,
    lastResult: { ...(result || {}), checkedAt: now },
    nextCheckAt: nextCheckAt instanceof Date ? nextCheckAt : new Date(nextCheckAt),
  };
  doc.markModified("cadenceState.dncCheck");
  await doc.save();
  return doc.toObject();
}

/**
 * Stamp the initial DNC check result captured at intake. Same as
 * `recordDncRecheck` but writes `initialResult` instead of overwriting
 * `lastResult`. Sets `nextCheckAt` to 30 days from creation.
 */
async function recordInitialDncCheck(domain, caseId, { result, nextCheckAt }) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const now = new Date();
  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  });
  if (!doc) return null;
  if (!doc.cadenceState) doc.cadenceState = {};
  doc.cadenceState.dncCheck = {
    ...(doc.cadenceState.dncCheck || {}),
    initialResult: { ...(result || {}), checkedAt: now },
    nextCheckAt: nextCheckAt instanceof Date ? nextCheckAt : new Date(nextCheckAt),
  };
  doc.markModified("cadenceState.dncCheck");
  await doc.save();
  return doc.toObject();
}

/**
 * Per-channel "stop trying" mark. Sets cadenceState.channelDnc[channel]
 * to a blocked record AND cancels every pending/requested action on
 * that channel — but does NOT deactivate the lead. Other channels keep
 * firing per their own schedules.
 *
 * Called from provider failure paths after a classifier decides the
 * rejection is permanent (CallRail opted-out, SendGrid hard bounce,
 * Drop.co national-DNC, etc.). Idempotent — re-marking an already-
 * blocked channel just refreshes `at` and keeps any later reason.
 */
async function markChannelDnc(domain, caseId, channel, reason, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedCaseId = Number(caseId);
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!normalizedChannel) {
    throw new Error("markChannelDnc: channel is required");
  }
  const at = options.at instanceof Date ? options.at : new Date();

  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  });
  if (!doc) return null;

  // Stamp the dnc flag.
  if (!doc.cadenceState) doc.cadenceState = {};
  if (!doc.cadenceState.channelDnc) doc.cadenceState.channelDnc = {};
  doc.cadenceState.channelDnc = {
    ...doc.cadenceState.channelDnc,
    [normalizedChannel]: {
      blocked: true,
      reason: String(reason || "permanent-failure"),
      at,
    },
  };
  doc.markModified("cadenceState.channelDnc");

  // Cancel only this channel's pending/requested actions. Leave other
  // channels intact.
  const actions = Array.isArray(doc.schedule?.actions) ? doc.schedule.actions : [];
  let changed = false;
  doc.schedule.actions = actions.map((entry) => {
    if (
      entry.channel === normalizedChannel &&
      (entry.status === "pending" || entry.status === "requested")
    ) {
      changed = true;
      return {
        ...(entry.toObject ? entry.toObject() : entry),
        status: "cancelled",
      };
    }
    return entry;
  });

  // Critical: do NOT touch doc.active. The lead lives on; only the
  // channel is gone.
  if (changed || doc.isModified()) {
    await doc.save();
  }
  return syncLeadCadenceState(normalizedDomain, normalizedCaseId);
}

/**
 * Pure read: is this channel currently DNC-blocked for this lead's
 * cadence state? Returns the block record or null. Safe to call on
 * any cadenceState shape (handles legacy docs without channelDnc).
 */
function evaluateChannelDnc(cadenceState, channel) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const block = cadenceState?.channelDnc?.[normalizedChannel];
  if (block && block.blocked) {
    return { blocked: true, reason: block.reason || null, at: block.at || null };
  }
  return { blocked: false, reason: null, at: null };
}

module.exports = {
  buildCadenceStateFromActions,
  cancelPendingActions,
  cancelStaleScheduledActions,
  claimScheduledAction,
  countDueLeadCadenceByChannel,
  countLeadCadence,
  deleteLeadCadence,
  evaluateChannelDnc,
  findActiveControlPlaneLeadCadencesByPhone,
  findLeadCadenceByEmail,
  markChannelDnc,
  findLeadCadenceByEmailHash,
  findLeadCadenceByPhone,
  findLeadCadence,
  listCxRequestedActionsForReconcile,
  listLeadCadenceForEnforcement,
  listLeadsDueForDncRecheck,
  listRvmActionsAwaitingDisposition,
  markCadenceChannelsOptedOut,
  listLeadCadence,
  listLeadCadenceByCaseIds,
  listControlPlaneLeadCadenceByCaseIds,
  listDueLeadCadenceByChannel,
  markLeadCadenceEvaluated,
  markScheduledActionStatus,
  recordDncRecheck,
  recordInitialDncCheck,
  recordRvmDispositionPoll,
  rescheduleScheduledAction,
  saveLiveCoachCloseoutSummary,
  saveLeadCadenceInterviewSnapshot,
  syncLeadCadenceState,
  upsertLeadCadence,
};
