"use strict";

const mongoose = require("mongoose");

// PoolBudget — singleton snapshot of UCQ pool occupancy + per-hour stats.
//
// One document, identified by `singletonKey: "global"`. Updated on every
// refill / completion / hour rollover. Read by the admin panel for the
// hourly pacing report and live observability.
//
// inPoolCount tracks current items in `state: in_pool` across the whole
// system. hourEnteredCount / hourCompletedCount reset at hourly rollover
// (carried over to PacingReport before reset).

const poolBudgetSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: "global" },

    // Live occupancy
    inPoolCount: { type: Number, default: 0 },
    inPoolByPartition: {
      fresh: { type: Number, default: 0 },
      non_fresh: { type: Number, default: 0 },
    },
    inPoolByAgeBucket: {
      just_came_in: { type: Number, default: 0 },
      second_contact: { type: Number, default: 0 },
      third_contact: { type: Number, default: 0 },
      day2_10: { type: Number, default: 0 },
      aged: { type: Number, default: 0 },
    },

    // Per-hour rolling counters
    hourBucket: { type: String, default: null },
    hourEnteredCount: { type: Number, default: 0 },
    hourCompletedCount: { type: Number, default: 0 },
    hourRefilledCount: { type: Number, default: 0 },

    lastRefilledAt: { type: Date, default: null },
    lastRefilledFloor: { type: Number, default: null },
    lastEmptiedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "poolbudgets",
  },
);

module.exports = mongoose.models.ControlPlanePoolBudget
  || mongoose.model("ControlPlanePoolBudget", poolBudgetSchema);
