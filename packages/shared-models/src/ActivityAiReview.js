"use strict";

const mongoose = require("mongoose");

const activityAiReviewSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    reviewType: { type: String, default: "contact-safety", index: true },
    model: { type: String, required: true },
    provider: { type: String, default: "anthropic" },
    status: {
      type: String,
      enum: ["allow_contact", "pause_contact", "stop_contact", "manual_review"],
      required: true,
      index: true,
    },
    confidence: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    recommendedAction: { type: String, default: null },
    rationale: { type: String, default: null },
    concerns: [{ type: String }],
    positiveNotes: [{ type: String }],
    evidence: [{ type: String }],
    riskFlags: [{ type: String }],
    activityCount: { type: Number, default: 0 },
    activityWindow: {
      newestAt: { type: Date, default: null },
      oldestAt: { type: Date, default: null },
    },
    promptVersion: { type: String, default: "v1" },
    rawResponseText: { type: String, default: null },
    rawResponseJson: { type: mongoose.Schema.Types.Mixed, default: null },
    reviewedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

activityAiReviewSchema.index(
  { domain: 1, caseId: 1, reviewType: 1, reviewedAt: -1 },
  { name: "case_review_latest" },
);

module.exports =
  mongoose.models.ControlPlaneActivityAiReview ||
  mongoose.model("ControlPlaneActivityAiReview", activityAiReviewSchema);
