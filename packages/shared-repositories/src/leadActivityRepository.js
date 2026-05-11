"use strict";

const { LeadActivity } = require("../../shared-models/src");

const DEFAULT_TTL_MS = {
  queue_active: 30 * 60 * 1000,    // 30 min
  in_call: 60 * 60 * 1000,         // 60 min (calls can be long)
  dispositioning: 15 * 60 * 1000,  // 15 min wrap-up
};

function findByLead(leadId) {
  return LeadActivity.findOne({ leadId }).lean();
}

// ── Atomic acquire ─────────────────────────────────────────────────
//
// Tries to acquire a lock on `leadId` with the given lockType. Succeeds
// IFF: (a) no existing lock OR (b) existing lock is null/expired.
// Returns { acquired: bool, doc, reason }.

async function acquireLock(leadId, lockType, {
  ownerAgentId,
  callSessionId = null,
  queueItemId = null,
  ttlMs = null,
  meta = null,
} = {}) {
  if (!leadId || !lockType) {
    return { acquired: false, reason: "invalid-args" };
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (ttlMs || DEFAULT_TTL_MS[lockType] || 30 * 60 * 1000));

  const filter = {
    leadId,
    $or: [
      { lockType: null },
      { lockType: { $exists: false } },
      { expiresAt: { $lte: now } },
    ],
  };
  const update = {
    $set: {
      leadId,
      lockType,
      ownerAgentId,
      callSessionId,
      queueItemId,
      lockedAt: now,
      expiresAt,
      lastTouchedAt: now,
    },
    $push: {
      history: {
        $each: [
          { at: now, op: "lock-acquired", lockType, ownerAgentId, meta: meta || null },
        ],
        $slice: -20,  // keep last 20 events
      },
    },
  };
  const opts = { new: true, upsert: true, lean: true };

  let result;
  try {
    result = await LeadActivity.findOneAndUpdate(filter, update, opts);
  } catch (error) {
    // Duplicate key on upsert means another process owns the lock.
    if (error.code === 11000) {
      const existing = await LeadActivity.findOne({ leadId }).lean();
      return {
        acquired: false,
        reason: "lock-held",
        existing,
      };
    }
    throw error;
  }

  // findOneAndUpdate with filter that excludes existing held-non-expired
  // locks: if it returns AND lockType matches, we acquired. Verify by
  // re-checking ownership.
  if (result?.lockType === lockType && String(result.ownerAgentId || "") === String(ownerAgentId || "")) {
    return { acquired: true, doc: result };
  }
  // Fallback: someone else acquired between filter and update
  const existing = await LeadActivity.findOne({ leadId }).lean();
  return {
    acquired: false,
    reason: "lock-held",
    existing,
  };
}

async function releaseLock(leadId, { ownerAgentId, expectedLockType = null } = {}) {
  const filter = { leadId };
  if (ownerAgentId) filter.ownerAgentId = ownerAgentId;
  if (expectedLockType) filter.lockType = expectedLockType;

  const now = new Date();
  return LeadActivity.findOneAndUpdate(
    filter,
    {
      $set: {
        lockType: null,
        ownerAgentId: null,
        callSessionId: null,
        queueItemId: null,
        expiresAt: null,
        lastTouchedAt: now,
      },
      $push: {
        history: {
          $each: [
            { at: now, op: "lock-released", lockType: expectedLockType, ownerAgentId, meta: null },
          ],
          $slice: -20,
        },
      },
    },
    { new: true, lean: true },
  );
}

async function transitionLock(leadId, fromLockType, toLockType, {
  ownerAgentId,
  callSessionId = null,
  queueItemId = null,
  ttlMs = null,
} = {}) {
  // Atomic: only succeeds if currently held by ownerAgentId in fromLockType
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (ttlMs || DEFAULT_TTL_MS[toLockType] || 30 * 60 * 1000));
  return LeadActivity.findOneAndUpdate(
    { leadId, lockType: fromLockType, ownerAgentId },
    {
      $set: {
        lockType: toLockType,
        callSessionId,
        queueItemId,
        lockedAt: now,
        expiresAt,
        lastTouchedAt: now,
      },
      $push: {
        history: {
          $each: [
            { at: now, op: "lock-transitioned", lockType: toLockType, ownerAgentId, meta: { from: fromLockType } },
          ],
          $slice: -20,
        },
      },
    },
    { new: true, lean: true },
  );
}

async function listExpiredLocks({ asOf = new Date(), limit = 50 } = {}) {
  return LeadActivity.find({
    lockType: { $ne: null },
    expiresAt: { $lte: asOf },
  })
    .limit(limit)
    .lean();
}

async function cleanupExpired({ asOf = new Date() } = {}) {
  const expired = await listExpiredLocks({ asOf });
  if (!expired.length) return { reapedCount: 0 };
  const now = new Date();
  const ids = expired.map((d) => d._id);
  await LeadActivity.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        lockType: null,
        ownerAgentId: null,
        callSessionId: null,
        queueItemId: null,
        expiresAt: null,
        lastTouchedAt: now,
      },
      $push: {
        history: {
          $each: [{ at: now, op: "lock-expired", lockType: null, ownerAgentId: null, meta: null }],
          $slice: -20,
        },
      },
    },
  );
  return { reapedCount: expired.length, leadIds: expired.map((d) => d.leadId) };
}

module.exports = {
  findByLead,
  acquireLock,
  releaseLock,
  transitionLock,
  listExpiredLocks,
  cleanupExpired,
};
