"use strict";

const mongoose = require("mongoose");

// AgentSlice — the 10-batch of non-fresh QueueItems handed to an agent.
//
// One active slice per agent at a time. State:
//   active     → agent is working through items (clicking to dial each)
//   completed  → all items dispositioned; eligible for next slice
//   released   → unfinished items returned to pool (hour rollover, idle
//                reaper, agent went unavail). Items in this slice flip
//                back to in_pool with enteredQueueAt nudged to now+1ms
//                so they don't immediately re-pull to the same agent.
//
// Indexes:
//   { agentId: 1, state: 1 }              → "does this agent have an active slice?"
//   { hourBucket: 1, state: 1 }           → hourly orchestrator sweep

const ageMixSubdoc = new mongoose.Schema(
  {
    just_came_in: { type: Number, default: 0 },
    second_contact: { type: Number, default: 0 },
    third_contact: { type: Number, default: 0 },
    day2_10: { type: Number, default: 0 },
    day16_30: { type: Number, default: 0 },
    aged: { type: Number, default: 0 },
    dead: { type: Number, default: 0 },
  },
  { _id: false },
);

const agentSliceSchema = new mongoose.Schema(
  {
    sliceId: { type: String, required: true, unique: true, index: true },
    agentId: { type: String, required: true, index: true },     // extensionId
    hourBucket: { type: String, required: true, index: true },  // "YYYY-MM-DD-HH" PT
    issuedAt: { type: Date, default: Date.now },

    sliceSize: { type: Number, required: true },
    itemIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneQueueItem" }],
    ageMix: { type: ageMixSubdoc, default: () => ({}) },

    state: {
      type: String,
      enum: ["active", "completed", "released"],
      default: "active",
      index: true,
    },

    // Counts updated as items are dispositioned
    completedCount: { type: Number, default: 0 },
    releasedAt: { type: Date, default: null },
    releasedReason: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "agentslices",
  },
);

agentSliceSchema.index({ agentId: 1, state: 1 });
agentSliceSchema.index({ hourBucket: 1, state: 1 });

module.exports = mongoose.models.ControlPlaneAgentSlice
  || mongoose.model("ControlPlaneAgentSlice", agentSliceSchema);
