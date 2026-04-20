"use strict";

const mongoose = require("mongoose");

const qualityReviewSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    provider: { type: String, default: "anthropic" },
    reviewType: {
      type: String,
      required: true,
      enum: ["call-qc", "sms-qc", "case-review"],
      index: true,
    },
    sourceService: { type: String, default: null },
    externalId: { type: String, default: null, index: true },
    status: { type: String, default: null, index: true },
    confidence: { type: String, default: null },
    score: { type: Number, default: null },
    summary: { type: String, default: null },
    positives: [{ type: String }],
    concerns: [{ type: String }],
    flags: [{ type: String }],
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    reviewedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

qualityReviewSchema.index({ domain: 1, caseId: 1, reviewType: 1, reviewedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneQualityReview ||
  mongoose.model("ControlPlaneQualityReview", qualityReviewSchema);
