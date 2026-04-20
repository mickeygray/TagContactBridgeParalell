"use strict";

const mongoose = require("mongoose");

const reviewQueueItemSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    sourceService: { type: String, required: true, index: true },
    workflow: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
      index: true,
    },
    status: {
      type: String,
      enum: ["open", "reviewed", "dismissed"],
      default: "open",
      index: true,
    },
    title: { type: String, required: true },
    summary: { type: String, default: null },
    customerName: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    sourceName: { type: String, default: null },
    sourceChannel: { type: String, default: null },
    happenedAt: { type: Date, default: Date.now, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    tags: [{ type: String }],
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: null },
  },
  { timestamps: true },
);

reviewQueueItemSchema.index(
  { domain: 1, status: 1, happenedAt: -1 },
  { name: "review_queue_open_by_domain" },
);

module.exports =
  mongoose.models.ControlPlaneReviewQueueItem ||
  mongoose.model("ControlPlaneReviewQueueItem", reviewQueueItemSchema);
