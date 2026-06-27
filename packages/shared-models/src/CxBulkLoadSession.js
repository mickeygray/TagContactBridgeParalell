"use strict";

const mongoose = require("mongoose");

const cxBulkLoadSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["running", "completed", "killed", "failed"],
      default: "running",
      index: true,
    },
    phase: {
      type: String,
      enum: [
        "idle",
        "waiting_offhook",
        "preloading",
        "ready",
        "watching",
        "active",
        "releasing",
        "refilling",
        "released",
        "failed",
      ],
      default: "idle",
      index: true,
    },
    agentEmail: { type: String, required: true, index: true },
    agentExtensionId: { type: String, default: null, index: true },
    cxAgentId: { type: String, default: null, index: true },
    domain: { type: String, default: "TAG", index: true },
    ringcx: { type: mongoose.Schema.Types.Mixed, default: {} },
    current: { type: mongoose.Schema.Types.Mixed, default: null },
    acceptedBuffer: { type: mongoose.Schema.Types.Mixed, default: [] },
    // M11 gate 1: the externIds RingCX reported active on the PRIOR watch poll, so the next
    // poll can diff and still count a call that appeared and released between 1s polls.
    prevActiveExternIds: { type: [String], default: [] },
    completed: { type: mongoose.Schema.Types.Mixed, default: [] },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },
    trace: { type: mongoose.Schema.Types.Mixed, default: {} },
    events: { type: mongoose.Schema.Types.Mixed, default: [] },
    lastOutcome: { type: mongoose.Schema.Types.Mixed, default: null },
    reviewHoldUntil: { type: Date, default: null },
    reviewHoldReason: { type: String, default: null },
    lastError: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null },
    killedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

cxBulkLoadSessionSchema.index({ agentEmail: 1, status: 1, updatedAt: -1 });
cxBulkLoadSessionSchema.index({ agentExtensionId: 1, status: 1, updatedAt: -1 });
cxBulkLoadSessionSchema.index({ domain: 1, status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneCxBulkLoadSession ||
  mongoose.model("ControlPlaneCxBulkLoadSession", cxBulkLoadSessionSchema);
