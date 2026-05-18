"use strict";

const mongoose = require("mongoose");

const postDateHoldHistorySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true },
    actorEmail: { type: String, default: null },
    note: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const postDateHoldSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: ["active", "released", "payment_verified", "review", "release_failed"],
      default: "active",
      index: true,
    },
    postDatedAt: { type: Date, required: true, default: Date.now, index: true },
    postDatedDateKey: { type: String, required: true, index: true },
    postDatedByEmail: { type: String, default: null, index: true },
    postDatedByName: { type: String, default: null },
    caseName: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, default: null },
    sourceName: { type: String, default: null },
    intakeSource: { type: String, default: null },
    intakeRoute: { type: String, default: null },
    queueFamily: { type: String, default: null, index: true },
    queueItemId: { type: String, default: null },
    queueActionKey: { type: String, default: null },
    logicsStatusId: { type: Number, default: null },
    logicsStatusLabel: { type: String, default: null },
    settlementOfficerId: { type: Number, default: null },
    statusWorkflowId: { type: String, default: null },
    firstPaymentDate: { type: Date, default: null, index: true },
    firstPaymentDateKey: { type: String, default: null, index: true },
    paymentScheduleStatus: { type: String, default: null, index: true },
    paymentScheduleSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    paymentCheck: {
      lastCheckedAt: { type: Date, default: null, index: true },
      lastResult: { type: String, default: null },
      successfulCasePaymentId: { type: Number, default: null },
      successfulAmount: { type: Number, default: null },
      successfulPaymentDateKey: { type: String, default: null },
      error: { type: String, default: null },
    },
    releasedAt: { type: Date, default: null, index: true },
    releasedByEmail: { type: String, default: null },
    releaseReason: { type: String, default: null },
    releaseWorkflowId: { type: String, default: null },
    releaseStatusId: { type: Number, default: null },
    releaseStatusLabel: { type: String, default: null },
    releaseQueueResult: { type: mongoose.Schema.Types.Mixed, default: null },
    history: { type: [postDateHoldHistorySchema], default: [] },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

postDateHoldSchema.index(
  { domain: 1, caseId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
  },
);
postDateHoldSchema.index({ domain: 1, status: 1, firstPaymentDateKey: 1 });
postDateHoldSchema.index({ domain: 1, postDatedDateKey: 1, status: 1 });

module.exports =
  mongoose.models.ControlPlanePostDateHold ||
  mongoose.model("ControlPlanePostDateHold", postDateHoldSchema);
