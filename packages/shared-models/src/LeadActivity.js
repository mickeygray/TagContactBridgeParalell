"use strict";

const mongoose = require("mongoose");

// LeadActivity — lead-level lock preventing two systems from working
// the same lead simultaneously. ONE doc per leadId.
//
// Lock types (mutually exclusive):
//   queue_active     - lead is in the UCQ (in_pool / in_slice / fresh_assigned / pending_assignment)
//   in_call          - lead has an active CallSession (placing/ringing/connected)
//   dispositioning   - call ended, agent must record outcome before lead is free
//
// Acquired atomically via findOneAndUpdate({ leadId, lockType: null/expired }, ...).
// Released by the holder (call session end, queue item completion, etc.).
//
// expiresAt provides safety: if a holder crashes mid-flow, the lock
// auto-expires and another claim can acquire it. Default TTL: 30 min
// for queue locks, 60 min for call/dispo (longer because phones might
// be on hold).

const leadActivitySchema = new mongoose.Schema(
  {
    leadId: { type: String, required: true, unique: true, index: true },

    lockType: {
      type: String,
      enum: ["queue_active", "in_call", "dispositioning", null],
      default: null,
      index: true,
    },

    ownerAgentId: { type: String, default: null, index: true },
    callSessionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    queueItemId: { type: mongoose.Schema.Types.ObjectId, default: null },

    lockedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    lastTouchedAt: { type: Date, default: Date.now },

    // Audit trail of recent activity for this lead (rolling, capped)
    history: [
      {
        at: Date,
        op: String,         // "lock-acquired" | "lock-released" | "lock-expired" | "lock-rejected"
        lockType: String,
        ownerAgentId: String,
        meta: mongoose.Schema.Types.Mixed,
      },
    ],
  },
  {
    timestamps: true,
    collection: "leadactivities",
  },
);

leadActivitySchema.index({ lockType: 1, expiresAt: 1 });

module.exports = mongoose.models.ControlPlaneLeadActivity
  || mongoose.model("ControlPlaneLeadActivity", leadActivitySchema);
