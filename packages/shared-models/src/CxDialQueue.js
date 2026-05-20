"use strict";

const mongoose = require("mongoose");

const cxDialQueueSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    leadCadenceId: { type: String, default: null, index: true },
    phone: { type: String, default: null },
    name: { type: String, default: null },
    intakeSource: { type: String, default: null, index: true },
    intakeRoute: { type: String, default: null },
    sourceName: { type: String, default: null },
    rcxAccountId: { type: String, default: null, index: true },
    rcxDialGroupId: { type: String, default: null, index: true },
    rcxCampaignId: { type: String, default: null, index: true },
    state: {
      type: String,
      enum: ["queued", "ready", "claimed", "serving", "completed", "cancelled", "paused"],
      default: "queued",
      index: true,
    },
    queueFamily: {
      type: String,
      enum: ["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged", "dead", "unassigned"],
      default: "fresh-day1",
      index: true,
    },
    queueFamilyRank: { type: Number, default: 0, index: true },
    queueTier: {
      type: String,
      enum: ["day0", "day1", "later"],
      default: "day0",
      index: true,
    },
    progressiveStageKey: { type: String, default: null, index: true },
    progressiveStageIndex: { type: Number, default: 99, index: true },
    progressiveStageLabel: { type: String, default: null },
    priorityScore: { type: Number, default: 100, index: true },
    releaseAt: { type: Date, required: true, index: true },
    claimUntil: { type: Date, default: null, index: true },
    lastClaimedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    placedCalls: { type: Number, default: 0 },
    lastPlacedAt: { type: Date, default: null },
    dailyPlacedDateKey: { type: String, default: null, index: true },
    dailyPlacedCalls: { type: Number, default: 0, index: true },
    monthlyPlacedMonthKey: { type: String, default: null, index: true },
    monthlyPlacedCalls: { type: Number, default: 0, index: true },
    hourlyPlacedHourKey: { type: String, default: null, index: true },
    hourlyPlacedCalls: { type: Number, default: 0, index: true },
    callPlan: {
      phaseIndex: { type: Number, default: 0 },
      delaysMinutes: { type: [Number], default: [0, 15, 15, 15, 15, 15] },
      activeDay: { type: Number, default: 0 },
      nextDelayMinutes: { type: Number, default: 0 },
    },
    assignment: {
      extensionId: { type: String, default: null, index: true },
      agentName: { type: String, default: null },
      assignedAt: { type: Date, default: null },
      queueFamilySnapshot: { type: String, default: null },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

cxDialQueueSchema.index({ domain: 1, caseId: 1, state: 1 });
cxDialQueueSchema.index({ domain: 1, caseId: 1, "metadata.actionKey": 1, state: 1 });
cxDialQueueSchema.index(
  { domain: 1, caseId: 1, "metadata.actionKey": 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ["queued", "ready", "claimed", "serving", "paused"] } },
    name: "uq_cxdialqueue_active_action",
  },
);
cxDialQueueSchema.index({ domain: 1, state: 1, releaseAt: 1, priorityScore: -1 });
cxDialQueueSchema.index({ domain: 1, queueFamily: 1, dailyPlacedDateKey: 1, dailyPlacedCalls: 1 });
cxDialQueueSchema.index({ domain: 1, queueFamily: 1, monthlyPlacedMonthKey: 1, monthlyPlacedCalls: 1 });
cxDialQueueSchema.index({
  domain: 1,
  state: 1,
  queueFamily: 1,
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  releaseAt: 1,
  priorityScore: -1,
});
cxDialQueueSchema.index({
  state: 1,
  queueFamily: 1,
  queueFamilyRank: 1,
  dailyPlacedCalls: 1,
  progressiveStageIndex: 1,
  lastPlacedAt: 1,
  priorityScore: -1,
  releaseAt: 1,
  createdAt: 1,
});
cxDialQueueSchema.index({
  domain: 1,
  state: 1,
  queueFamily: 1,
  "metadata.routeCampaignKey": 1,
  releaseAt: 1,
  priorityScore: -1,
});

module.exports =
  mongoose.models.ControlPlaneCxDialQueue ||
  mongoose.model("ControlPlaneCxDialQueue", cxDialQueueSchema);
