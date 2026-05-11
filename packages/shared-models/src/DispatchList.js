"use strict";

const mongoose = require("mongoose");

const dispatchListItemSchema = new mongoose.Schema(
  {
    caseId: { type: Number, required: true },
    leadCadenceId: { type: String, default: null },
    masterProspectId: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    normalizedPhone: { type: String, default: null },
    priority: { type: Number, default: null },
    score: { type: Number, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const dispatchListSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    family: {
      type: String,
      required: true,
      enum: ["dispatch", "review", "qc", "dialer", "scrub"],
      default: "dispatch",
      index: true,
    },
    subtype: { type: String, default: null, index: true },
    channel: {
      type: String,
      required: true,
      enum: ["sms", "email", "rvm", "callfire", "phoneburner", "cx"],
      index: true,
    },
    mode: {
      type: String,
      required: true,
      enum: ["manual", "cadence", "auto", "one-off"],
      default: "manual",
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ["draft", "ready", "queued", "consuming", "completed", "cancelled", "failed"],
      default: "ready",
      index: true,
    },
    sourceService: { type: String, default: "control-plane" },
    consumerService: { type: String, default: null, index: true },
    title: { type: String, default: null },
    description: { type: String, default: null },
    actionType: { type: String, default: null },
    templateKey: { type: String, default: null },
    priorityRule: { type: String, default: null },
    ratePerMinute: { type: Number, default: null },
    maxCount: { type: Number, default: null },
    pulseSize: { type: Number, default: null },
    pulseDelayMs: { type: Number, default: null },
    builtAt: { type: Date, default: Date.now, index: true },
    queuedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    eventId: { type: String, default: null },
    selectors: { type: mongoose.Schema.Types.Mixed, default: {} },
    instructions: { type: mongoose.Schema.Types.Mixed, default: {} },
    items: { type: [dispatchListItemSchema], default: [] },
    stats: {
      selectedCount: { type: Number, default: 0 },
      attemptedCount: { type: Number, default: 0 },
      successCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
    },
    lastResult: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: true,
    collection: "dispatchlists",
  },
);

dispatchListSchema.index({ domain: 1, family: 1, channel: 1, status: 1, builtAt: -1 });

module.exports = mongoose.models.ControlPlaneDispatchList
  || mongoose.model("ControlPlaneDispatchList", dispatchListSchema);
