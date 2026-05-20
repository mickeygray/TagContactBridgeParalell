"use strict";

const { CxDialQueue } = require("../../shared-models/src");
const { normalizeLeadQueueFamilyList } = require("../../shared-normalizers/src");

const TOUCH_BALANCED_QUEUE_SORT = Object.freeze({
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  priorityScore: -1,
  releaseAt: 1,
  createdAt: 1,
});

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

function activeQueueFilter(domain, caseId, options = {}) {
  const filter = {
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  };
  const actionKey = String(options.actionKey || options.metadataActionKey || "").trim();
  if (actionKey) filter["metadata.actionKey"] = actionKey;
  return filter;
}

function normalizeQueueFamilies(value) {
  return normalizeLeadQueueFamilyList(value);
}

function normalizeRouteCampaigns(value) {
  if (value === null || value === undefined || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  return Array.from(
    new Set(
      raw
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function resolveQueueFamilies(options = {}) {
  return normalizeQueueFamilies([
    ...(Array.isArray(options.queueFamilies) ? options.queueFamilies : []),
    options.queueFamily || "",
  ]);
}

function buildReadyClaimQuery(domain = null, options = {}) {
  const query = { state: "ready" };
  if (domain) {
    query.domain = normalizeDomain(domain);
  }
  const families = resolveQueueFamilies(options);
  if (families.length > 0) {
    query.queueFamily = { $in: families };
  }
  const routeCampaigns = normalizeRouteCampaigns(options.routeCampaigns);
  if (routeCampaigns.length > 0) {
    query["metadata.routeCampaignKey"] = { $in: routeCampaigns };
  }
  applyCreatedAtRange(query, options);
  return query;
}

function applyCreatedAtRange(query, filters = {}) {
  const createdAt = {};
  const gte = filters.createdAtGte || filters.createdAfter || filters.windowStart || null;
  const lte = filters.createdAtLte || filters.createdBefore || filters.windowEnd || null;
  if (gte) {
    const date = new Date(gte);
    if (!Number.isNaN(date.getTime())) createdAt.$gte = date;
  }
  if (lte) {
    const date = new Date(lte);
    if (!Number.isNaN(date.getTime())) createdAt.$lte = date;
  }
  if (Object.keys(createdAt).length > 0) {
    query.createdAt = createdAt;
  }
}

function buildClaimPatch(now, claimMinutes) {
  return {
    state: "claimed",
    lastClaimedAt: now,
    claimUntil: new Date(now.getTime() + Math.max(Number(claimMinutes) || 5, 1) * 60 * 1000),
  };
}

function buildExpiredClaimRequeueQuery(now) {
  return {
    state: "claimed",
    claimUntil: { $ne: null, $lte: now },
    $and: [
      { $or: [{ "metadata.servingAt": { $exists: false } }, { "metadata.servingAt": null }] },
      { $or: [{ "metadata.lastDialExecutionUii": { $exists: false } }, { "metadata.lastDialExecutionUii": null }, { "metadata.lastDialExecutionUii": "" }] },
      { $or: [{ "metadata.lastQueueAttemptHeldForDisposition": { $ne: true } }, { "metadata.lastQueueAttemptHeldForDisposition": { $exists: false } }] },
      {
        $or: [
          { "metadata.lastDialIntentStatus": { $exists: false } },
          { "metadata.lastDialIntentStatus": null },
          { "metadata.lastDialIntentStatus": "" },
          { "metadata.lastDialIntentStatus": { $in: ["relay-failed", "error", "cancelled"] } },
        ],
      },
    ],
  };
}

async function findActiveQueueItem(domain, caseId, options = {}) {
  return CxDialQueue.findOne(activeQueueFilter(domain, caseId, options));
}

async function upsertQueueItem(domain, caseId, update = {}, options = {}) {
  const actionKey = String(options.actionKey || update?.metadata?.actionKey || "").trim();
  const filter = actionKey
    ? {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
      "metadata.actionKey": actionKey,
    }
    : {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
    };
  try {
    return await CxDialQueue.findOneAndUpdate(
      filter,
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    return findActiveQueueItem(
      domain,
      caseId,
      actionKey ? { actionKey } : {},
    );
  }
}

async function releaseDueQueueItems(now = new Date(), limit = 50) {
  const query = {
    state: "queued",
    releaseAt: { $lte: now },
  };
  const docs = await CxDialQueue.find(query)
    .sort(TOUCH_BALANCED_QUEUE_SORT)
    .limit(Math.min(Number(limit) || 50, 200));

  const released = [];
  for (const doc of docs) {
    const updated = await CxDialQueue.findOneAndUpdate(
      { _id: doc._id, ...query },
      {
        $set: {
          state: "ready",
          claimUntil: null,
        },
      },
      { new: true },
    );
    if (updated) released.push(updated.toObject());
  }

  return released;
}

async function requeueExpiredClaims(now = new Date(), limit = 50) {
  const query = buildExpiredClaimRequeueQuery(now);
  const docs = await CxDialQueue.find(query)
    .sort({ claimUntil: 1 })
    .limit(Math.min(Number(limit) || 50, 200));

  const requeued = [];
  for (const doc of docs) {
    const previousAssignment =
      doc.assignment && typeof doc.assignment.toObject === "function"
        ? doc.assignment.toObject()
        : doc.assignment
          ? { ...doc.assignment }
          : null;
    const updated = await CxDialQueue.findOneAndUpdate(
      { _id: doc._id, ...query },
      {
        $set: {
          state: "ready",
          claimUntil: null,
          assignment: {
            extensionId: null,
            agentName: null,
            assignedAt: null,
            queueFamilySnapshot: null,
          },
          "metadata.lastReleasedAt": now,
          "metadata.lastReleaseReason": "claim-expired",
          "metadata.lastReleasedExtensionId": previousAssignment?.extensionId || null,
          "metadata.lastReleasedAgentName": previousAssignment?.agentName || null,
        },
      },
      { new: true },
    );
    if (!updated) continue;
    requeued.push({
      ...(updated.toObject()),
      previousAssignment,
    });
  }

  return requeued;
}

async function claimRandomReadyQueueItem(domain = null, claimMinutes = 5, options = {}) {
  const now = new Date();
  const baseQuery = buildReadyClaimQuery(domain, options);
  const families = resolveQueueFamilies(options);
  const preferFamilyOrder = options.preferQueueFamilyOrder !== false && families.length > 1;
  const familyPasses = preferFamilyOrder ? families : [null];

  for (const family of familyPasses) {
    const query = family
      ? { ...baseQuery, queueFamily: family }
      : baseQuery;
    const [candidate] = await CxDialQueue.aggregate([
      { $match: query },
      { $sample: { size: 1 } },
      { $project: { _id: 1 } },
    ]);
    if (!candidate?._id) continue;
    const claimed = await CxDialQueue.findOneAndUpdate(
      { _id: candidate._id, state: "ready" },
      { $set: buildClaimPatch(now, claimMinutes) },
      { new: true },
    );
    if (claimed) return claimed;
  }
  return null;
}

async function claimNextReadyQueueItem(domain = null, claimMinutes = 5, options = {}) {
  if (options.randomize) {
    return claimRandomReadyQueueItem(domain, claimMinutes, options);
  }

  const now = new Date();
  const query = buildReadyClaimQuery(domain, options);

  return CxDialQueue.findOneAndUpdate(
    query,
    {
      $set: buildClaimPatch(now, claimMinutes),
    },
    {
      sort: {
        ...TOUCH_BALANCED_QUEUE_SORT,
      },
      new: true,
    },
  );
}

async function markQueueItemCompleted(id) {
  return CxDialQueue.findByIdAndUpdate(
    id,
    {
      $set: {
        state: "completed",
        claimUntil: null,
        completedAt: new Date(),
      },
    },
    { new: true },
  );
}

async function cancelActiveQueueItems(domain, caseId, reason = null) {
  const result = await CxDialQueue.updateMany(
    {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
      state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
    },
    {
      $set: {
        state: "cancelled",
        claimUntil: null,
        "metadata.cancelReason": reason || null,
        "metadata.cancelledAt": new Date(),
      },
    },
  );

  return {
    matchedCount: Number(result?.matchedCount || result?.n || 0),
    modifiedCount: Number(result?.modifiedCount || result?.nModified || 0),
  };
}

async function updateQueueItem(id, update = {}, options = {}) {
  const query = { _id: id };
  if (options.match && typeof options.match === "object") {
    for (const [key, value] of Object.entries(options.match)) {
      if (value !== undefined) query[key] = value;
    }
  }
  return CxDialQueue.findOneAndUpdate(query, { $set: update }, { new: true });
}

async function transitionQueueItemState(id, fromStates = [], update = {}, options = {}) {
  const normalizedStates = Array.from(
    new Set(
      (Array.isArray(fromStates) ? fromStates : [fromStates])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  const query = { _id: id };
  if (normalizedStates.length > 0) {
    query.state = { $in: normalizedStates };
  }
  if (options.match && typeof options.match === "object") {
    for (const [key, value] of Object.entries(options.match)) {
      if (value !== undefined) query[key] = value;
    }
  }
  return CxDialQueue.findOneAndUpdate(
    query,
    { $set: update },
    {
      new: Boolean(options.returnNew),
    },
  );
}

async function findQueueItemById(id) {
  return CxDialQueue.findById(id);
}

async function findClaimedQueueItemByRequestKey(domain, requestKey) {
  const normalizedRequestKey = String(requestKey || "").trim();
  if (!normalizedRequestKey) return null;
  const query = {
    state: "claimed",
    "metadata.assignmentRequestKey": normalizedRequestKey,
  };
  if (domain) {
    query.domain = normalizeDomain(domain);
  }
  return CxDialQueue.findOne(query);
}

async function listQueueItems(filters = {}) {
  const query = {};
  if (filters.domain) query.domain = normalizeDomain(filters.domain);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.state) query.state = filters.state;
  if (Array.isArray(filters.states) && filters.states.length > 0) {
    query.state = { $in: filters.states };
  }
  if (filters.queueFamily) {
    const families = normalizeQueueFamilies(filters.queueFamily);
    if (families.length === 1) query.queueFamily = families[0];
    if (families.length > 1) query.queueFamily = { $in: families };
  }
  if (Array.isArray(filters.queueFamilies) && filters.queueFamilies.length > 0) {
    query.queueFamily = { $in: normalizeQueueFamilies(filters.queueFamilies) };
  }
  if (filters.assignedExtensionId) query["assignment.extensionId"] = String(filters.assignedExtensionId).trim();
  if (filters.assignedOnly === true) {
    query["assignment.extensionId"] = { $nin: [null, ""] };
  }
  if (filters.metadataActionKey) query["metadata.actionKey"] = String(filters.metadataActionKey).trim();
  applyCreatedAtRange(query, filters);
  if (filters.visibleExtensionId) {
    const extensionId = String(filters.visibleExtensionId || "").trim();
    if (filters.includeUnassignedVisible === true) {
      query.$or = [
        { "assignment.extensionId": extensionId },
        { "assignment.extensionId": { $exists: false } },
        { "assignment.extensionId": null },
        { "assignment.extensionId": "" },
      ];
    } else {
      query["assignment.extensionId"] = extensionId;
    }
  }

  const cursor = CxDialQueue.find(query)
    .sort(TOUCH_BALANCED_QUEUE_SORT);

  const unbounded =
    filters.limitAll === true ||
    filters.noLimit === true ||
    String(filters.limit || "").trim().toLowerCase() === "all" ||
    Number(filters.limit) === 0;

  if (!unbounded) {
    cursor.limit(Math.min(Number(filters.limit) || 200, 1000));
  }

  return cursor.lean();
}

async function countQueueItems(filters = {}) {
  const query = {};
  if (filters.domain) query.domain = normalizeDomain(filters.domain);
  if (filters.caseId != null) query.caseId = Number(filters.caseId);
  if (filters.state) query.state = filters.state;
  if (Array.isArray(filters.states) && filters.states.length > 0) {
    query.state = { $in: filters.states };
  }
  if (filters.queueFamily) {
    const families = normalizeQueueFamilies(filters.queueFamily);
    if (families.length === 1) query.queueFamily = families[0];
    if (families.length > 1) query.queueFamily = { $in: families };
  }
  if (Array.isArray(filters.queueFamilies) && filters.queueFamilies.length > 0) {
    query.queueFamily = { $in: normalizeQueueFamilies(filters.queueFamilies) };
  }
  if (filters.assignedExtensionId) query["assignment.extensionId"] = String(filters.assignedExtensionId).trim();
  if (filters.metadataActionKey) query["metadata.actionKey"] = String(filters.metadataActionKey).trim();
  applyCreatedAtRange(query, filters);
  if (filters.visibleExtensionId) {
    const extensionId = String(filters.visibleExtensionId || "").trim();
    if (filters.includeUnassignedVisible === true) {
      query.$or = [
        { "assignment.extensionId": extensionId },
        { "assignment.extensionId": { $exists: false } },
        { "assignment.extensionId": null },
        { "assignment.extensionId": "" },
      ];
    } else {
      query["assignment.extensionId"] = extensionId;
    }
  }
  return CxDialQueue.countDocuments(query);
}

module.exports = {
  cancelActiveQueueItems,
  claimNextReadyQueueItem,
  countQueueItems,
  findActiveQueueItem,
  findClaimedQueueItemByRequestKey,
  findQueueItemById,
  listQueueItems,
  markQueueItemCompleted,
  releaseDueQueueItems,
  requeueExpiredClaims,
  transitionQueueItemState,
  updateQueueItem,
  upsertQueueItem,
};
