"use strict";

const mongoose = require("mongoose");

const cxSimpleLoopSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["running", "paused", "completed", "killed", "failed"],
      default: "running",
      index: true,
    },
    mode: {
      type: String,
      enum: ["single", "bulk-mirror"],
      default: "single",
      index: true,
    },
    agentEmail: { type: String, required: true, index: true },
    agentExtensionId: { type: String, default: null, index: true },
    cxAgentId: { type: String, default: null, index: true },
    queue: { type: mongoose.Schema.Types.Mixed, default: [] },
    current: { type: mongoose.Schema.Types.Mixed, default: null },
    completed: { type: mongoose.Schema.Types.Mixed, default: [] },
    events: { type: mongoose.Schema.Types.Mixed, default: [] },
    stats: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastError: { type: mongoose.Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: Date.now, index: true },
    killedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

cxSimpleLoopSessionSchema.index({ agentEmail: 1, status: 1, updatedAt: -1 });
cxSimpleLoopSessionSchema.index({ agentExtensionId: 1, status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneCxSimpleLoopSession ||
  mongoose.model("ControlPlaneCxSimpleLoopSession", cxSimpleLoopSessionSchema);
