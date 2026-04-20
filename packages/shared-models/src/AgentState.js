"use strict";

const mongoose = require("mongoose");

const agentStateSchema = new mongoose.Schema(
  {
    extensionId: { type: String, required: true, unique: true, index: true },
    cxAgentId: { type: String, default: null, index: true },
    cxProfileId: { type: String, default: null },
    name: { type: String, required: true },
    company: { type: String, enum: ["TAG", "WYNN"], default: "TAG" },
    pin: { type: String, default: null },
    status: {
      type: String,
      enum: ["available", "onCall", "ringing", "disposition", "away", "offline"],
      default: "offline",
    },
    exTelephonyStatus: { type: String, default: "NoCall" },
    exPresenceStatus: { type: String, default: "Offline" },
    currentCall: {
      sessionId: String,
      telephonySessionId: String,
      direction: String,
      from: String,
      fromName: String,
      to: String,
      startTime: Date,
    },
    activePlatform: { type: String, enum: ["EX", "CX", "none"], default: "none" },
    lastStatusChange: { type: Date, default: Date.now },
    lastEventReceived: { type: Date, default: null },
    dailyStats: {
      date: String,
      hot: Number,
      day1: Number,
      day10: Number,
      aged: Number,
      totalCalls: Number,
      goodCalls: Number,
      badCalls: Number,
    },
    cxRouting: {
      enabled: { type: Boolean, default: false },
      desiredAvailability: {
        type: String,
        enum: ["available", "unavailable"],
        default: "available",
      },
      reason: { type: String, default: "not-synced" },
      syncedAt: { type: Date, default: null },
      lastSource: { type: String, default: null },
    },
    upstream: {
      source: { type: String, default: "ringbridge" },
      mirroredAt: { type: Date, default: Date.now },
    },
  },
  {
    timestamps: true,
    collection: "agentstates",
  },
);

module.exports = mongoose.models.ControlPlaneAgentState
  || mongoose.model("ControlPlaneAgentState", agentStateSchema);
