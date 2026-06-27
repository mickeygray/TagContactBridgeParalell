"use strict";

const mongoose = require("mongoose");

const cxSlowLaneSessionSchema = new mongoose.Schema(
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
        "selecting",
        "publishing",
        "pending_confirmation",
        "active",
        "releasing",
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
    current: { type: mongoose.Schema.Types.Mixed, default: null },
    lastOutcome: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: mongoose.Schema.Types.Mixed, default: null },
    trace: { type: mongoose.Schema.Types.Mixed, default: {} },
    events: { type: mongoose.Schema.Types.Mixed, default: [] },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null },
    killedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

cxSlowLaneSessionSchema.index({ agentEmail: 1, status: 1, updatedAt: -1 });
cxSlowLaneSessionSchema.index({ agentExtensionId: 1, status: 1, updatedAt: -1 });
cxSlowLaneSessionSchema.index({ domain: 1, status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneCxSlowLaneSession ||
  mongoose.model("ControlPlaneCxSlowLaneSession", cxSlowLaneSessionSchema);
