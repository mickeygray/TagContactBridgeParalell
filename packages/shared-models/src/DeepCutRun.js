"use strict";

const mongoose = require("mongoose");

const deepCutRunSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    runType: { type: String, default: "daily-deep-cut", index: true },
    status: {
      type: String,
      enum: ["planned", "running", "completed", "failed"],
      default: "planned",
      index: true,
    },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null, index: true },
    summary: {
      totalCasesTouched: { type: Number, default: 0 },
      statusChanges: { type: Number, default: 0 },
      paymentsDetected: { type: Number, default: 0 },
      redlinesDetected: { type: Number, default: 0 },
      attributionUpdates: { type: Number, default: 0 },
      stopSignalsDetected: { type: Number, default: 0 },
      spendRowsSynced: { type: Number, default: 0 },
      aiCaseReviewsDue: { type: Number, default: 0 },
      aiCaseReviewsCompleted: { type: Number, default: 0 },
    },
    sections: [
      {
        key: { type: String, required: true },
        title: { type: String, required: true },
        status: { type: String, default: "planned" },
        summary: { type: String, default: null },
        metrics: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    notes: [{ type: String }],
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    reportRecipients: [{ type: String }],
  },
  { timestamps: true },
);

deepCutRunSchema.index(
  { domain: 1, runType: 1, startedAt: -1 },
  { name: "deep_cut_runs_by_domain" },
);

module.exports =
  mongoose.models.ControlPlaneDeepCutRun ||
  mongoose.model("ControlPlaneDeepCutRun", deepCutRunSchema);
