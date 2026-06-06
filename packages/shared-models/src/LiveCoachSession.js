"use strict";

const mongoose = require("mongoose");

const liveCoachSessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    sessionId: { type: String, required: true },
    status: { type: String, default: "listening" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    binding: { type: mongoose.Schema.Types.Mixed, default: null },
    counters: { type: mongoose.Schema.Types.Mixed, default: {} },
    latest: { type: mongoose.Schema.Types.Mixed, default: {} },
    memory: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastEventAt: { type: Date, default: null },
    sessionCreatedAt: { type: Date, default: null },
    sessionUpdatedAt: { type: Date, default: null },
    lastPersistedReason: { type: String, default: null },
    lastPersistedAt: { type: Date, default: Date.now },
  },
  {
    collection: "livecoach_sessions",
    timestamps: true,
    autoIndex: false,
  },
);

module.exports = mongoose.models.ControlPlaneLiveCoachSession
  || mongoose.model("ControlPlaneLiveCoachSession", liveCoachSessionSchema);
