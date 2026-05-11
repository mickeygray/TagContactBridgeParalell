"use strict";

const mongoose = require("mongoose");

// PacingReport — historical hourly summary, generated at hour rollover
// before the rollover sequence resets counters. Drives the admin alert
// email and the pacing dashboard.
//
// One document per hour bucket, identified by `hourBucket` ("YYYY-MM-DD-HH" PT).
// Per-agent breakdown is embedded so the report is self-contained for
// display (no aggregation needed at read time).
//
// generatedAt = when the report was computed (immediately after the hour
// closed, e.g. 11:00:01 PT for the 10am hour).

const perAgentEntrySubdoc = new mongoose.Schema(
  {
    agentId: String,           // extensionId
    agentName: String,
    targetCount: Number,       // perAgentSliceSize at issue time
    actualDialedCount: Number, // calls actually placed in this hour
    completedCount: Number,    // dispositioned in this hour
    sliceState: String,        // active | completed | released (at hour close)
    eligibilityHours: Number,  // how much of the hour was the agent eligible
  },
  { _id: false },
);

const pacingReportSchema = new mongoose.Schema(
  {
    hourBucket: { type: String, required: true, unique: true, index: true },
    generatedAt: { type: Date, default: Date.now },

    // Top-level config snapshot (so reports stay accurate even if config changes)
    perAgentSliceSize: Number,
    teamHourlyTarget: Number,

    // Team-wide totals
    teamActualDialedCount: { type: Number, default: 0 },
    teamCompletedCount: { type: Number, default: 0 },

    // Pool state at hour close
    poolRemaining: { type: Number, default: 0 },
    poolRemainingByPartition: {
      fresh: { type: Number, default: 0 },
      non_fresh: { type: Number, default: 0 },
    },
    poolEnteredThisHour: { type: Number, default: 0 },
    poolRefilledThisHour: { type: Number, default: 0 },

    perAgent: { type: [perAgentEntrySubdoc], default: [] },

    // Operating window — was this an operating hour?
    operatingHour: { type: Boolean, default: true },
    skippedReason: { type: String, default: null },  // "outside-hours" | "no-eligible-agents" | null

    // Status flags for alerting
    underUtilized: { type: Boolean, default: false },  // poolRemaining > 0 at close during operating hour
    overTarget: { type: Boolean, default: false },     // teamActualDialedCount > teamHourlyTarget * 1.2 (20% over)

    // Free-form notes from the orchestrator
    notes: { type: [String], default: [] },
  },
  {
    timestamps: true,
    collection: "pacingreports",
  },
);

pacingReportSchema.index({ generatedAt: -1 });

module.exports = mongoose.models.ControlPlanePacingReport
  || mongoose.model("ControlPlanePacingReport", pacingReportSchema);
