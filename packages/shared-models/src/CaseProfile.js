"use strict";

const mongoose = require("mongoose");

const caseProfileSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    masterProspectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneMasterProspectIndex",
      default: null,
      index: true,
    },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    normalizedPhones: [{ type: String }],
    statusId: { type: Number, default: null, index: true },
    statusCategory: { type: String, default: "client", index: true },
    convertedAt: { type: Date, default: null, index: true },
    firstPaymentDate: { type: Date, default: null },
    initialPayment: { type: Number, default: 0 },
    totalPaid: { type: Number, default: 0 },
    paymentsCount: { type: Number, default: 0 },
    lastPaymentDate: { type: Date, default: null },
    lastPaymentAmount: { type: Number, default: 0 },
    paymentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ControlPlanePaymentLedger",
      },
    ],
    contactActivityIds: [{ type: mongoose.Schema.Types.ObjectId }],
    attribution: {
      matchedBy: { type: String, default: null },
      confidence: { type: String, default: null },
      lockedManual: { type: Boolean, default: false },
      needsReview: { type: Boolean, default: false },
      reviewReason: { type: String, default: null },
      lastResolvedAt: { type: Date, default: null },
    },
    aiActivityReview: {
      reviewId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ControlPlaneActivityAiReview",
        default: null,
      },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      recommendedAction: { type: String, default: null },
      rationale: { type: String, default: null },
      concerns: [{ type: String }],
      positiveNotes: [{ type: String }],
      riskFlags: [{ type: String }],
      reviewedAt: { type: Date, default: null },
      activityCount: { type: Number, default: 0 },
    },
    aiCaseReview: {
      reviewId: { type: mongoose.Schema.Types.ObjectId, default: null },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      summary: { type: String, default: null },
      reviewedAt: { type: Date, default: null, index: true },
      nextEligibleAt: { type: Date, default: null, index: true },
    },
    qcSummary: {
      reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneQualityReview", default: null },
      status: { type: String, default: null, index: true },
      confidence: { type: String, default: null },
      score: { type: Number, default: null },
      summary: { type: String, default: null },
      positives: [{ type: String }],
      concerns: [{ type: String }],
      flags: [{ type: String }],
      reviewedAt: { type: Date, default: null },
      reviewType: { type: String, default: null },
    },
    conversationAi: {
      workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneConversationWorkflow", default: null },
      status: { type: String, default: null, index: true },
      optOutDetected: { type: Boolean, default: false, index: true },
      latestInboundAt: { type: Date, default: null },
      latestInboundText: { type: String, default: null },
      aiRecommendedAction: { type: String, default: null },
      aiConfidence: { type: String, default: null },
      aiFlags: [{ type: String }],
      aiSummary: { type: String, default: null },
    },
  },
  { timestamps: true },
);

caseProfileSchema.index({ domain: 1, caseId: 1 }, { unique: true });
caseProfileSchema.index({ domain: 1, sourceCanonicalId: 1, convertedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneCaseProfile ||
  mongoose.model("ControlPlaneCaseProfile", caseProfileSchema);
