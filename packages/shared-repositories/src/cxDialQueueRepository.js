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

function appendAndClauses(query, clauses = []) {
  const clean = clauses.filter(Boolean);
  if (!clean.length) return query;
  query.$and = [
    ...(Array.isArray(query.$and) ? query.$and : []),
    ...clean,
  ];
  return query;
}


function buildReadyReservationQuery(domain, family, options = {}, now = new Date()) {
  const rcxAccountId = options.rcxAccountId ? String(options.rcxAccountId).trim() : null;
  const rcxCampaignId = options.rcxCampaignId ? String(options.rcxCampaignId).trim() : null;
  const rcxDialGroupId = options.rcxDialGroupId ? String(options.rcxDialGroupId).trim() : null;
  const query = {
    state: "ready",
    releaseAt: { $lte: now },
    queueFamily: family,
    "metadata.appointmentId": { $in: [null, ""] },
    ...(domain ? { domain: normalizeDomain(domain) } : {}),
    ...(rcxAccountId ? { rcxAccountId } : {}),
    ...(rcxCampaignId ? { rcxCampaignId } : {}),
    ...(rcxDialGroupId ? { rcxDialGroupId } : {}),
  };
  return query;
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
  const excludeLastTouchedExtensionId = String(options.excludeLastTouchedExtensionId || "").trim();
  if (excludeLastTouchedExtensionId) {
    query.$and = [
      ...(Array.isArray(query.$and) ? query.$and : []),
      {
        $or: [
          { "metadata.lastTouchedExtensionId": { $exists: false } },
          { "metadata.lastTouchedExtensionId": null },
          { "metadata.lastTouchedExtensionId": "" },
          { "metadata.lastTouchedExtensionId": { $ne: excludeLastTouchedExtensionId } },
        ],
      },
      {
        $or: [
          { "metadata.lastCxDialedByExtensionId": { $exists: false } },
          { "metadata.lastCxDialedByExtensionId": null },
          { "metadata.lastCxDialedByExtensionId": "" },
          { "metadata.lastCxDialedByExtensionId": { $ne: excludeLastTouchedExtensionId } },
        ],
      },
    ];
  }
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
          { "metadata.lastDialIntentStatus": { $in: ["relay-failed", "error", "cancelled", "unconfirmed-active-call"] } },
        ],
      },
      // M2 §3.1 — HARD ownership exclusion: a session-held (reserved) row is invisible to the
      // global reaper, regardless of lease age. Only the owning session (releaseReserved) or the
      // crash reconciler frees it. $exists:false keeps current non-reserved rows reaped as before.
      {
        $or: [
          { "metadata.reservationSessionId": { $exists: false } },
          { "metadata.reservationSessionId": null },
          { "metadata.reservationSessionId": "" },
        ],
      },
      // FM-5 — appointment rows are never reaper-freed (defense-in-depth alongside the $match exclude).
      {
        $or: [
          { "metadata.appointmentId": { $exists: false } },
          { "metadata.appointmentId": null },
          { "metadata.appointmentId": "" },
        ],
      },
    ],
  };
}

async function findActiveQueueItem(domain, caseId, options = {}) {
  return CxDialQueue.findOne(activeQueueFilter(domain, caseId, options));
}

// M5: cross-pool publish interlock. Finds a DIFFERENT active (claimed/serving) sibling for this
// caseId — NOT actionKey-scoped, so it catches a concurrent claim under any actionKey, and the
// _id exclusion stops the publishing row from masking its own collision (unlike findActiveQueueItem,
// which is a self-matching single-doc lookup over any active state).
async function findActiveClaimForCase(domain, caseId, excludeId = null) {
  const query = {
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    state: { $in: ["claimed", "serving"] },
  };
  if (excludeId) query._id = { $ne: excludeId };
  return CxDialQueue.findOne(query);
}

async function upsertQueueItem(domain, caseId, update = {}, options = {}) {
  const actionKey = String(options.actionKey || update?.metadata?.actionKey || "").trim();
  const filter = actionKey
    ? {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
      "metadata.actionKey": actionKey,
      state: { $nin: ["completed", "cancelled"] },
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

// Atomic bulk claim of `ready` rows per family, in TOUCH_BALANCED_QUEUE_SORT order.
// updateMany CANNOT sort, so we find+sort+limit candidate _ids, then bulk-claim with a
// re-asserted {state:'ready'} guard (closes the select->update TOCTOU). `modifiedCount`
// is the true reserved count; one same-tick re-plan retry distinguishes "claimed
// elsewhere" (FM-10, transient) from genuine short supply (returned in `missing`).
// Reservation provenance is written as DOTTED $set keys so it never clobbers sibling
// metadata/assignment. NET-NEW (M1): not consumed by any rail until M4 ships behind M2.
async function reserveReadyRows(domain, familyTargets = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const claimMinutes = Math.max(Number(options.claimMinutes) || 5, 1); // G3a: caller passes explicit
  const sessionId = String(options.sessionId || "").trim();
  if (!sessionId) throw new Error("reserveReadyRows requires a sessionId");
  const extensionId = options.agentExtensionId ? String(options.agentExtensionId) : null;
  const rcxAccountId = options.rcxAccountId ? String(options.rcxAccountId).trim() : null;
  const rcxCampaignId = options.rcxCampaignId ? String(options.rcxCampaignId).trim() : null;
  const rcxDialGroupId = options.rcxDialGroupId ? String(options.rcxDialGroupId).trim() : null;
  // M8b §3 — rail provenance: stamp which rail reserved this row so publish can echo it and
  // a cross-rail actor can fail closed. Additive/dotted; null when the caller passes no rail.
  const reservationRail = options.metadata?.rail ? String(options.metadata.rail) : null;
  const reservedRows = [];
  const missing = {};
  // family order = rank order (green,blue,yellow,red); normalize keys through the SAME normalizer.
  for (const family of normalizeQueueFamilies(Object.keys(familyTargets))) {
    const n = Math.max(Number(familyTargets[family]) || 0, 0);
    if (n <= 0) continue;
    const familyMatch = buildReadyReservationQuery(domain, family, options, now);
    // --- one bulk claim, plus ONE same-tick re-plan retry on residual deficit ---
    let need = n;
    const attemptedIds = [];
    for (let attempt = 0; attempt < 2 && need > 0; attempt += 1) {
      const candidates = await CxDialQueue.find(familyMatch)
        .sort({ ...TOUCH_BALANCED_QUEUE_SORT })
        .limit(need)
        .select({ _id: 1 })
        .lean();
      if (candidates.length === 0) break;
      const ids = candidates.map((c) => c._id);
      attemptedIds.push(...ids);
      // Re-assert ready/released: rows claimed or cooled down between read+write won't match.
      const res = await CxDialQueue.updateMany(
        { _id: { $in: ids }, state: "ready", releaseAt: { $lte: now } },
        {
          $set: {
            ...buildClaimPatch(now, claimMinutes), // state:'claimed', lastClaimedAt, claimUntil
            "assignment.extensionId": extensionId,
            "assignment.assignedAt": now,
            "assignment.queueFamilySnapshot": family,
            "metadata.reservationSessionId": sessionId,
            "metadata.reservedAt": now,
            "metadata.reservationExpiresAt": new Date(now.getTime() + claimMinutes * 60 * 1000),
            "metadata.reservationRail": reservationRail,
            "metadata.lastRingcxPublishedAt": null,
            "metadata.lastRingcxPublishedExternId": null,
            "metadata.lastDialExecutionUii": null,
            "metadata.lastQueueAttemptUii": null,
            "metadata.lastDialIntentStatus": null,
            "metadata.servingAt": null,
            "metadata.lastRingcxActiveCall": null,
            "metadata.lastRingcxMatchReasons": [],
            "metadata.lastQueueAttemptHeldForDisposition": false,
            "metadata.wrapUpRequired": false,
            "metadata.lastReleasedAt": null,
            "metadata.lastReleaseReason": null,
            "metadata.lastReleasedExtensionId": null,
            "metadata.lastReleasedAgentName": null,
            "metadata.lastReleasedBy": null,
          },
        },
      );
      // modifiedCount is the TRUE reserved count this round (FM-10).
      const won = Number(res?.modifiedCount || res?.nModified || 0);
      need -= won;
      if (won === 0) break; // nothing left to win this tick
    }
    // Re-read exactly the attempted ids this session now owns in this family.
    // Do not key correctness on metadata.reservedAt timestamp equality: BSON
    // precision/serialization should never make a won claim disappear from the
    // caller's buffer. reservedAt remains an audit stamp only.
    if (attemptedIds.length > 0 && need < n) {
      const claimed = await CxDialQueue.find({
        _id: { $in: [...new Set(attemptedIds.map((id) => String(id)))] },
        ...(domain ? { domain: normalizeDomain(domain) } : {}),
        queueFamily: family,
        state: "claimed",
        "metadata.reservationSessionId": sessionId,
      }).sort({ ...TOUCH_BALANCED_QUEUE_SORT });
      reservedRows.push(...claimed.map((doc) => doc.toObject()));
    }
    if (need > 0) missing[family] = need; // genuine short supply, NOT elsewhere-claim
  }
  return { reserved: reservedRows, missing };
}


// renewClaim (M2 §3.2) — ONE guarded CAS per row. Re-confirms {state:'claimed',
// reservationSessionId} at write time, so it silently no-ops once the row goes 'serving'
// or another owner holds it. This is a LIVENESS heartbeat, NOT the safety mechanism (that
// is the reaper ownership-exclusion above). Returns the ids actually renewed; the caller
// drops the rest from its heartbeat set.
async function renewClaim(ids = [], claimMinutes = 5, sessionId = null) {
  const now = new Date();
  const minutes = Math.max(Number(claimMinutes) || 5, 1);
  const until = new Date(now.getTime() + minutes * 60 * 1000);
  const renewed = [];
  for (const id of ids) {
    const updated = await CxDialQueue.findOneAndUpdate(
      { _id: id, state: "claimed", "metadata.reservationSessionId": sessionId },
      { $set: { claimUntil: until, "metadata.reservationExpiresAt": until } },
      { new: true },
    );
    if (updated) renewed.push(updated._id);
  }
  return renewed;
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

async function cancelActiveQueueItems(domain, caseId, reason = null, options = {}) {
  const query = {
    domain: normalizeDomain(domain),
    caseId: Number(caseId),
    state: { $in: ["queued", "ready", "claimed", "serving", "paused"] },
  };
  if (options.includeReserved !== true) {
    query.$and = [
      ...(Array.isArray(query.$and) ? query.$and : []),
      {
        $or: [
          { "metadata.reservationSessionId": { $exists: false } },
          { "metadata.reservationSessionId": null },
          { "metadata.reservationSessionId": "" },
        ],
      },
    ];
  }
  const result = await CxDialQueue.updateMany(
    query,
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

async function listClaimedByReservationSession(input = {}) {
  const sessionId = String(
    typeof input === "string" ? input : input.sessionId || "",
  ).trim();
  if (!sessionId) return [];
  const rawStates = Array.isArray(input.states) && input.states.length > 0
    ? input.states
    : ["claimed"];
  const states = rawStates.map((state) => String(state || "").trim()).filter(Boolean);
  if (!states.length) return [];
  const cursor = CxDialQueue.find({
    state: { $in: states },
    "metadata.reservationSessionId": sessionId,
  }).sort({ claimUntil: 1, createdAt: 1, _id: 1 });
  const unbounded =
    input.limitAll === true ||
    input.noLimit === true ||
    String(input.limit || "").trim().toLowerCase() === "all" ||
    Number(input.limit) === 0;
  if (!unbounded) {
    cursor.limit(Math.min(Number(input.limit) || 1000, 5000));
  }
  return cursor.lean();
}

async function findQueueItemsByRingcxExternIds(externIds = [], filters = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(externIds) ? externIds : [externIds])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
  if (!ids.length) return [];

  const query = {
    $or: [
      { "metadata.rcxVisibilityExternId": { $in: ids } },
      { "metadata.lastRingcxPublishedExternId": { $in: ids } },
      { "metadata.lastDialExecutionRingcxPublish.externId": { $in: ids } },
    ],
  };
  if (filters.domain) query.domain = normalizeDomain(filters.domain);
  if (Array.isArray(filters.states) && filters.states.length > 0) {
    query.state = { $in: filters.states.map((value) => String(value || "").trim()).filter(Boolean) };
  }
  const campaignId = String(filters.campaignId || "").trim();
  if (campaignId) {
    query.$and = [
      ...(Array.isArray(query.$and) ? query.$and : []),
      {
        $or: [
          { rcxCampaignId: campaignId },
          { "metadata.rcxCampaignId": campaignId },
          { "metadata.lastRingcxPublishedCampaignId": campaignId },
        ],
      },
    ];
  }

  return CxDialQueue.find(query)
    .limit(Math.min(ids.length * 3, 100))
    .lean();
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
  if (Array.isArray(filters.excludeIds) && filters.excludeIds.length > 0) {
    const excluded = filters.excludeIds.map((id) => String(id || "").trim()).filter(Boolean);
    if (excluded.length > 0) {
      query._id = { $nin: excluded };
    }
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

  // M3 — reconciler filter: claimed rows whose owning session is NOT currently live. The $ne:null
  // ensures a reconcile target actually carries a (stale) sessionId, never a non-reserved row.
  if (Array.isArray(filters.metadataReservationSessionIdNotIn) && filters.metadataReservationSessionIdNotIn.length > 0) {
    query["metadata.reservationSessionId"] = {
      $nin: filters.metadataReservationSessionIdNotIn,
      $ne: null,
    };
  }

  const cursor = CxDialQueue.find(query)
    .sort(
      filters.sort && typeof filters.sort === "object" && !Array.isArray(filters.sort)
        ? filters.sort
        : TOUCH_BALANCED_QUEUE_SORT,
    );

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
  buildExpiredClaimRequeueQuery, // exported for offline reaper-exclusion tests (M2/M8); pure
  buildReadyClaimQuery,
  buildReadyReservationQuery,
  cancelActiveQueueItems,
  claimNextReadyQueueItem,
  countQueueItems,
  findActiveClaimForCase,
  findActiveQueueItem,
  findClaimedQueueItemByRequestKey,
  findQueueItemById,
  findQueueItemsByRingcxExternIds,
  listClaimedByReservationSession,
  listQueueItems,
  markQueueItemCompleted,
  releaseDueQueueItems,
  renewClaim,
  requeueExpiredClaims,
  reserveReadyRows,
  transitionQueueItemState,
  updateQueueItem,
  upsertQueueItem,
};
