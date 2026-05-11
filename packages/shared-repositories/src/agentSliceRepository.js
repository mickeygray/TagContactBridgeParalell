"use strict";

const { AgentSlice } = require("../../shared-models/src");

async function createSlice({ sliceId, agentId, hourBucket, sliceSize, itemIds, ageMix }) {
  const doc = new AgentSlice({
    sliceId,
    agentId,
    hourBucket,
    sliceSize,
    itemIds,
    ageMix,
    state: "active",
  });
  return doc.save();
}

function findActiveByAgent(agentId) {
  return AgentSlice.findOne({ agentId, state: "active" }).lean();
}

function findBySliceId(sliceId) {
  return AgentSlice.findOne({ sliceId }).lean();
}

function listActiveSlices() {
  return AgentSlice.find({ state: "active" }).lean();
}

function listSlicesForHour(hourBucket) {
  return AgentSlice.find({ hourBucket }).lean();
}

async function markCompleted(sliceId) {
  return AgentSlice.findOneAndUpdate(
    { sliceId, state: "active" },
    { $set: { state: "completed", completedAt: new Date() } },
    { new: true, lean: true },
  );
}

async function markReleased(sliceId, { reason = "manual" } = {}) {
  return AgentSlice.findOneAndUpdate(
    { sliceId, state: "active" },
    {
      $set: {
        state: "released",
        releasedAt: new Date(),
        releasedReason: reason,
      },
    },
    { new: true, lean: true },
  );
}

async function incrementCompleted(sliceId) {
  return AgentSlice.findOneAndUpdate(
    { sliceId },
    { $inc: { completedCount: 1 } },
    { new: true, lean: true },
  );
}

module.exports = {
  createSlice,
  findActiveByAgent,
  findBySliceId,
  listActiveSlices,
  listSlicesForHour,
  markCompleted,
  markReleased,
  incrementCompleted,
};
