"use strict";

const mongoose = require("mongoose");

function collections() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Mongo is not connected");
  return {
    memory: db.collection("cx_boring_call_memory"),
    actions: db.collection("cx_boring_webhook_actions"),
  };
}

let indexesReady = null;
function ensureIndexes() {
  if (!indexesReady) {
    const { memory, actions } = collections();
    indexesReady = Promise.all([
      memory.createIndex({ agentEmail: 1, status: 1, observedAt: -1 }),
      memory.createIndex({ domain: 1, caseId: 1, observedAt: -1 }),
      actions.createIndex({ status: 1, nextAttemptAt: 1, createdAt: 1 }),
    ]).catch((error) => {
      indexesReady = null;
      throw error;
    });
  }
  return indexesReady;
}

async function upsertCallMemory(memory = {}) {
  await ensureIndexes();
  const uii = String(memory.uii || "").trim();
  if (!uii) throw new Error("upsertCallMemory requires uii");
  const now = memory.observedAt instanceof Date ? memory.observedAt : new Date();
  const update = {
    $set: { ...memory, _id: uii, updatedAt: now },
    $setOnInsert: { createdAt: now, firstObservedAt: now },
  };
  if (memory.status === "completed") {
    await collections().memory.updateOne({ _id: uii }, update, { upsert: true });
  } else {
    // A delayed ACTIVE hook can arrive after COMPLETE. Never resurrect a retired UII.
    const result = await collections().memory.updateOne(
      { _id: uii, status: { $ne: "completed" } },
      update,
    );
    if (!result.matchedCount) {
      try {
        await collections().memory.insertOne({
          ...memory,
          _id: uii,
          createdAt: now,
          firstObservedAt: now,
          updatedAt: now,
        });
      } catch (error) {
        if (Number(error?.code) !== 11000) throw error;
      }
    }
  }
  return true;
}

async function enqueueAction(action = {}) {
  await ensureIndexes();
  const id = String(action.id || "").trim();
  if (!id) throw new Error("enqueueAction requires id");
  try {
    await collections().actions.insertOne({
      ...action,
      _id: id,
      id,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(0),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return true;
  } catch (error) {
    if (Number(error?.code) === 11000) return false;
    throw error;
  }
}

async function listPendingActions(limit = 50) {
  await ensureIndexes();
  return collections().actions.find({
    status: { $in: ["pending", "failed"] },
    nextAttemptAt: { $lte: new Date() },
  }).sort({ createdAt: 1 }).limit(Math.min(Math.max(Number(limit) || 50, 1), 200)).toArray();
}

async function markActionCompleted(id, result = null) {
  return collections().actions.findOneAndUpdate(
    { _id: String(id), status: { $in: ["pending", "failed"] } },
    { $set: { status: "completed", completedAt: new Date(), updatedAt: new Date(), result, lastError: null } },
    { returnDocument: "after" },
  );
}

async function markActionFailed(id, error) {
  const row = await collections().actions.findOneAndUpdate(
    { _id: String(id), status: { $in: ["pending", "failed"] } },
    { $set: { status: "failed", updatedAt: new Date(), lastError: String(error || "failed").slice(0, 500) }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!row) return null;
  const delay = Math.min(Math.max(Number(row.attempts) || 1, 1) * 15_000, 15 * 60 * 1000);
  await collections().actions.updateOne({ _id: String(id), status: "failed" }, { $set: { nextAttemptAt: new Date(Date.now() + delay) } });
  return row;
}

async function getCurrentForAgent(agentEmail) {
  await ensureIndexes();
  const email = String(agentEmail || "").trim().toLowerCase();
  if (!email) return null;
  return collections().memory.findOne(
    { agentEmail: email, status: "active" },
    { sort: { observedAt: -1 } },
  );
}

async function countCompletedForAgentToday(agentEmail, now = new Date()) {
  const email = String(agentEmail || "").trim().toLowerCase();
  if (!email) return 0;
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  return collections().memory.countDocuments({ agentEmail: email, status: "completed", completedAt: { $gte: start, $lte: now } });
}

async function retireMissingActive(activeUiis = [], { now = new Date(), graceMs = 3_000 } = {}) {
  await ensureIndexes();
  const uiis = [...new Set((Array.isArray(activeUiis) ? activeUiis : []).map((value) => String(value || "").trim()).filter(Boolean))];
  const cutoff = new Date(now.getTime() - Math.max(Number(graceMs) || 0, 0));
  return collections().memory.updateMany(
    {
      status: "active",
      observedAt: { $lte: cutoff },
      ...(uiis.length ? { _id: { $nin: uiis } } : {}),
    },
    {
      $set: {
        status: "released",
        releasedAt: now,
        updatedAt: now,
        releaseReason: "absent-from-confirmed-ringcx-active-read",
      },
    },
  );
}

module.exports = {
  countCompletedForAgentToday,
  enqueueAction,
  ensureIndexes,
  getCurrentForAgent,
  listPendingActions,
  markActionCompleted,
  markActionFailed,
  retireMissingActive,
  upsertCallMemory,
};
