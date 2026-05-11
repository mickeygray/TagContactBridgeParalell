"use strict";

const { QueueItem } = require("../../shared-models/src");

const ACTIVE_QUEUE_STATES = QueueItem.ACTIVE_QUEUE_STATES || [
  "in_pool",
  "in_slice",
  "fresh_assigned",
  "pending_assignment",
  "dialing",
];

// QueueItemRepository — atomic CRUD for the Universal Call Queue (UCQ).
//
// State transitions are written through narrow, atomic functions:
// `claimToSlice`, `claimToFreshAgent`, `markDialing`, `markCompleted`,
// `recycle`, `releaseFromSlice`. Each is a single findOneAndUpdate so
// concurrent claim attempts can't double-issue the same item to two
// agents.
//
// Reads are `.lean()` by default to avoid mongoose document overhead in
// the queue-builder hot path.

function normalizeLeadId(value) {
  return String(value || "").trim();
}

function activeLeadFilter(leadId) {
  return {
    leadId: normalizeLeadId(leadId),
    state: { $in: ACTIVE_QUEUE_STATES },
  };
}

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

function stampedPayload(payload = {}) {
  const leadId = normalizeLeadId(payload.leadId || payload._id);
  if (!leadId) {
    throw new Error("leadId is required for queue item upsert");
  }
  return {
    enteredQueueAt: payload.enteredQueueAt || new Date(),
    state: payload.state || "in_pool",
    ...payload,
    leadId,
  };
}

function existingQueueItemPatch(payload = {}, options = {}) {
  const patch = {};
  for (const key of [
    "phoneNumber",
    "domain",
    "partition",
    "ageBucket",
    "cadenceDueAt",
    "sourceCadenceTaskId",
    "sourceLogicsCaseId",
    "hourBucket",
  ]) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== "") {
      patch[key] = payload[key];
    }
  }

  if (options.forceDialReady) {
    const state = payload.state || (payload.partition === "fresh" ? "fresh_assigned" : "in_slice");
    patch.state = state;
    patch.assignedTo = payload.assignedTo || null;
    patch.assignedAt = payload.assignedAt || new Date();
    patch.sliceId = payload.sliceId || null;
    patch.expiresAt = state === "fresh_assigned" ? (payload.expiresAt || null) : null;
  }

  return patch;
}

function listInPool({ partition = null, ageBucket = null, limit = 100 } = {}) {
  const filter = { state: "in_pool" };
  if (partition) filter.partition = partition;
  if (ageBucket) filter.ageBucket = ageBucket;
  return QueueItem.find(filter).sort({ enteredQueueAt: 1 }).limit(limit).lean();
}

function countInPool({ partition = null, ageBucket = null } = {}) {
  const filter = { state: "in_pool" };
  if (partition) filter.partition = partition;
  if (ageBucket) filter.ageBucket = ageBucket;
  return QueueItem.countDocuments(filter);
}

function countByAgeBucket() {
  return QueueItem.aggregate([
    { $match: { state: "in_pool" } },
    { $group: { _id: "$ageBucket", count: { $sum: 1 } } },
  ]);
}

async function upsertActiveItemForLead(payload, options = {}) {
  const stamped = stampedPayload(payload);
  const returnMetadata = Boolean(options.returnMetadata);
  const includeMetadata = returnMetadata || Boolean(options.forceDialReady);
  const filter = activeLeadFilter(stamped.leadId);

  if (options.forceDialReady) {
    const existing = await QueueItem.findOne(filter).lean();
    if (existing) {
      const requestedAgent = String(stamped.assignedTo || "").trim();
      const existingAgent = String(existing.assignedTo || "").trim();
      if (existing.state === "dialing") {
        return returnMetadata ? { item: existing, inserted: false, skipped: true } : existing;
      }
      if (
        existingAgent
        && requestedAgent
        && existingAgent !== requestedAgent
        && !options.overrideExistingAssignment
      ) {
        return returnMetadata ? { item: existing, inserted: false, skipped: true } : existing;
      }
      const patch = existingQueueItemPatch(stamped, options);
      const updated = Object.keys(patch).length > 0
        ? await QueueItem.findOneAndUpdate(
          { _id: existing._id, state: { $in: ACTIVE_QUEUE_STATES } },
          { $set: patch },
          { new: true, lean: true },
        )
        : existing;
      return returnMetadata ? { item: updated || existing, inserted: false } : (updated || existing);
    }
  }

  try {
    const result = await QueueItem.findOneAndUpdate(
      filter,
      { $setOnInsert: stamped },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        lean: true,
        includeResultMetadata: includeMetadata,
      },
    );
    if (includeMetadata) {
      let item = result?.value || null;
      const inserted = !Boolean(result?.lastErrorObject?.updatedExisting);
      if (options.forceDialReady && item && !inserted) {
        const patch = existingQueueItemPatch(stamped, options);
        item = Object.keys(patch).length > 0
          ? await QueueItem.findOneAndUpdate(
            { _id: item._id, state: { $in: ACTIVE_QUEUE_STATES } },
            { $set: patch },
            { new: true, lean: true },
          )
          : item;
      }
      if (!returnMetadata) return item;
      return {
        item,
        inserted,
      };
    }
    return result;
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await findByLeadId(stamped.leadId);
    if (returnMetadata) return { item: existing, inserted: false, skipped: true };
    return existing;
  }
}

async function insertItem(payload) {
  return upsertActiveItemForLead(payload);
}

async function bulkInsertItems(payloads = []) {
  if (!payloads.length) return [];
  const results = await Promise.all(payloads.map((payload) => upsertActiveItemForLead(payload)));
  return results.filter(Boolean);
}

function findById(id) {
  return QueueItem.findById(id).lean();
}

function findByLeadId(leadId) {
  return QueueItem.findOne(activeLeadFilter(leadId)).lean();
}

function listByAgent(agentId, { states = ["in_slice", "fresh_assigned", "dialing"] } = {}) {
  return QueueItem.find({ assignedTo: agentId, state: { $in: states } })
    .sort({ enteredQueueAt: 1 })
    .lean();
}

function listBySlice(sliceId) {
  return QueueItem.find({ sliceId }).sort({ enteredQueueAt: 1 }).lean();
}

function listExpiredFreshAssignments(asOf = new Date()) {
  return QueueItem.find({
    state: "fresh_assigned",
    expiresAt: { $lte: asOf },
  }).lean();
}

function listPendingAssignments({ partition = "fresh", limit = 50 } = {}) {
  return QueueItem.find({ state: "pending_assignment", partition })
    .sort({ enteredQueueAt: 1 })
    .limit(limit)
    .lean();
}

// ── Atomic state transitions ───────────────────────────────────────

// Claim N items into a slice. Atomic per-item via findOneAndUpdate.
// Caller (issueSlice) loops over candidates pulled from listInPool —
// we re-check `state: "in_pool"` here so two concurrent issuers can't
// both claim the same item.
async function claimToSlice(itemId, { sliceId, agentId, hourBucket }) {
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: "in_pool" },
    {
      $set: {
        state: "in_slice",
        assignedTo: agentId,
        assignedAt: new Date(),
        sliceId,
        hourBucket,
      },
    },
    { new: true, lean: true },
  );
}

async function claimToFreshAgent(itemId, { agentId, expiresAt, hourBucket }) {
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: { $in: ["in_pool", "pending_assignment"] }, partition: "fresh" },
    {
      $set: {
        state: "fresh_assigned",
        assignedTo: agentId,
        assignedAt: new Date(),
        expiresAt,
        hourBucket,
      },
    },
    { new: true, lean: true },
  );
}

async function moveToPendingAssignment(itemId) {
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: "in_pool", partition: "fresh" },
    {
      $set: {
        state: "pending_assignment",
        assignedTo: null,
        assignedAt: null,
        expiresAt: null,
      },
    },
    { new: true, lean: true },
  );
}

async function releaseFreshAssignment(itemId, { reason = "expired" } = {}) {
  // Fresh timer expired or agent went unavailable. Move back to
  // pending_assignment so the next eligible agent can pick it up.
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: "fresh_assigned" },
    {
      $set: {
        state: "pending_assignment",
        assignedTo: null,
        assignedAt: null,
        expiresAt: null,
      },
    },
    { new: true, lean: true },
  );
}

async function releaseSliceItems(sliceId, { bumpEnteredQueueAt = true } = {}) {
  // Bulk release: items still in_slice for this sliceId go back to in_pool.
  // Bump enteredQueueAt by 1ms so they sort after items currently in pool
  // (avoids immediately re-pulling to the same agent on next slice).
  const filter = { sliceId, state: "in_slice" };
  const update = bumpEnteredQueueAt
    ? [
        {
          $set: {
            state: "in_pool",
            assignedTo: null,
            assignedAt: null,
            sliceId: null,
            enteredQueueAt: { $add: [new Date(), 1] },
          },
        },
      ]
    : { $set: { state: "in_pool", assignedTo: null, assignedAt: null, sliceId: null } };

  return QueueItem.updateMany(filter, update);
}

async function markDialing(itemId) {
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: { $in: ["in_slice", "fresh_assigned"] } },
    { $set: { state: "dialing", lastDialedAt: new Date() } },
    { new: true, lean: true },
  );
}

async function markCompleted(itemId, { dispositionResult = null } = {}) {
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: { $in: ["dialing", "in_slice", "fresh_assigned"] } },
    {
      $set: {
        state: "completed",
        dispositionResult,
        dispositionAt: new Date(),
      },
    },
    { new: true, lean: true },
  );
}

async function recycle(itemId, { reason = "did_not_connect" } = {}) {
  // did_not_connect → bump to bottom of pool, increment recycleCount,
  // clear assignment fields. Keeps the item in the loop until a real
  // disposition lands.
  return QueueItem.findOneAndUpdate(
    { _id: itemId, state: { $in: ["dialing", "in_slice", "fresh_assigned"] } },
    {
      $set: {
        state: "in_pool",
        assignedTo: null,
        assignedAt: null,
        sliceId: null,
        expiresAt: null,
        enteredQueueAt: new Date(),
        dispositionResult: reason,
        dispositionAt: new Date(),
      },
      $inc: { recycleCount: 1 },
    },
    { new: true, lean: true },
  );
}

async function existsForLead(leadId) {
  return QueueItem.exists(activeLeadFilter(leadId));
}

module.exports = {
  // reads
  listInPool,
  countInPool,
  countByAgeBucket,
  findById,
  findByLeadId,
  listByAgent,
  listBySlice,
  listExpiredFreshAssignments,
  listPendingAssignments,
  existsForLead,
  // writes
  upsertActiveItemForLead,
  insertItem,
  bulkInsertItems,
  claimToSlice,
  claimToFreshAgent,
  moveToPendingAssignment,
  releaseFreshAssignment,
  releaseSliceItems,
  markDialing,
  markCompleted,
  recycle,
};
