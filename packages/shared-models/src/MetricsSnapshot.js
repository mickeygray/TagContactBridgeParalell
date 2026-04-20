"use strict";

const mongoose = require("mongoose");

const recentMetricEventSchema = new mongoose.Schema(
  {
    eventType: { type: String, default: null },
    metricName: { type: String, default: null },
    sourceKey: { type: String, default: null },
    caseId: { type: Number, default: null },
    title: { type: String, default: null },
    happenedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const metricsSnapshotSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    bucketType: { type: String, enum: ["daily", "lifetime"], required: true, index: true },
    bucketKey: { type: String, required: true, index: true },
    bucketDate: { type: Date, default: null, index: true },
    counters: {
      type: Map,
      of: Number,
      default: {},
    },
    sourceCounters: {
      type: Map,
      of: Number,
      default: {},
    },
    recentEvents: {
      type: [recentMetricEventSchema],
      default: [],
    },
  },
  { timestamps: true },
);

metricsSnapshotSchema.index({ domain: 1, bucketType: 1, bucketKey: 1 }, { unique: true });

module.exports =
  mongoose.models.ControlPlaneMetricsSnapshot ||
  mongoose.model("ControlPlaneMetricsSnapshot", metricsSnapshotSchema);
