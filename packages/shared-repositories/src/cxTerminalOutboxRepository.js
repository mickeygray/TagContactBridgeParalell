"use strict";

const { CxTerminalOutbox } = require("../../shared-models/src");

// M11 gate 2 — durable terminal-outbox repository. Thin Mongo I/O; the once-semantics live in
// the unique idemKey index, the drain logic lives in cxTerminalOutboxDrain (pure).

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000 || String(error?.codeName || "") === "DuplicateKey";
}

// Insert the terminal record exactly once. Returns the created row on the FIRST write, or null if
// a row with this idemKey already exists — the durable dedup that survives a process restart (an
// in-memory Set cannot). The caller treats null as "already counted; do not re-dispatch".
async function insertOnce(row = {}) {
  const idemKey = String(row.idemKey || "").trim();
  if (!idemKey) throw new Error("cxTerminalOutboxRepository.insertOnce requires an idemKey");
  try {
    const doc = await CxTerminalOutbox.create({ ...row, idemKey, status: "pending", attempts: 0 });
    return doc ? doc.toObject() : null;
  } catch (error) {
    if (isDuplicateKeyError(error)) return null;
    throw error;
  }
}

// Oldest pending/failed rows for the drain to replay.
async function listPendingForDrain(limit = 50) {
  const cap = Math.max(Number(limit) || 0, 1);
  const rows = await CxTerminalOutbox.find({ status: { $in: ["pending", "failed"] } })
    .sort({ createdAt: 1 })
    .limit(cap)
    .lean();
  return Array.isArray(rows) ? rows : [];
}

async function findByIdemKeys(idemKeys = []) {
  const keys = [...new Set(
    (Array.isArray(idemKeys) ? idemKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean),
  )];
  if (!keys.length) return [];
  const rows = await CxTerminalOutbox.find(
    { idemKey: { $in: keys } },
    {
      idemKey: 1,
      status: 1,
      queueItemId: 1,
      uii: 1,
      outcome: 1,
      source: 1,
    },
  ).lean();
  return Array.isArray(rows) ? rows : [];
}

// Most-recent outbox row for an identity in ANY status. Read-only context lookup for the DNC
// rectification lane (#4): the review path copies the original terminal row's payload shape into a
// NEW correction row rather than mutating the in-flight terminal row. Works even after the original
// drained (status is unfiltered), so a post-drain DNC correction still gets full case context.
async function findByIdentity(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const queueItemId = String(input.queueItemId || "").trim();
  const uii = String(input.uii || "").trim();
  if (!sessionId || !queueItemId || !uii) return null;
  return CxTerminalOutbox.findOne({ sessionId, queueItemId, uii })
    .sort({ createdAt: -1 })
    .lean();
}

// DEPRECATED for the bulk review path (#4): mutating the in-flight terminal row races the drain and
// can silently lose a DNC correction. The bulk rail now inserts a separate rectification row instead
// (see submitCxBulkLoadReviewOutcome). Left in place for any other caller / rollback.
async function updatePendingOutcomeByIdentity(input = {}) {
  const sessionId = String(input.sessionId || "").trim();
  const queueItemId = String(input.queueItemId || "").trim();
  const uii = String(input.uii || "").trim();
  const outcome = String(input.outcome || "").trim();
  if (!sessionId || !queueItemId || !uii || !outcome) {
    throw new Error("cxTerminalOutboxRepository.updatePendingOutcomeByIdentity requires sessionId, queueItemId, uii, and outcome");
  }
  const reviewedAt = input.reviewedAt instanceof Date ? input.reviewedAt : new Date();
  const source = String(input.source || "agent-auto-review").trim();
  return CxTerminalOutbox.findOneAndUpdate(
    {
      sessionId,
      queueItemId,
      uii,
      status: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        outcome,
        source,
        "payload.outcome": outcome,
        "payload.source": source,
        "payload.reviewedAt": reviewedAt.toISOString(),
        "payload.reviewSource": source,
        lastError: null,
      },
    },
    { new: true },
  ).lean();
}

async function markDrained(idemKey) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  return CxTerminalOutbox.findOneAndUpdate(
    { idemKey: key },
    { $set: { status: "drained", drainedAt: new Date(), lastError: null } },
    { new: true },
  ).lean();
}

async function markFailed(idemKey, error) {
  const key = String(idemKey || "").trim();
  if (!key) return null;
  return CxTerminalOutbox.findOneAndUpdate(
    { idemKey: key },
    {
      $set: { status: "failed", lastError: String(error || "drain-failed").slice(0, 500) },
      $inc: { attempts: 1 },
    },
    { new: true },
  ).lean();
}

module.exports = {
  findByIdemKeys,
  findByIdentity,
  insertOnce,
  listPendingForDrain,
  markDrained,
  markFailed,
  updatePendingOutcomeByIdentity,
};
