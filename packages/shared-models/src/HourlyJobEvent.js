"use strict";

const mongoose = require("mongoose");

const HourlyJobAttemptSchema = new mongoose.Schema(
  {
    worker: { type: String, required: true },
    status: {
      type: String,
      enum: ["processing", "completed", "failed", "dead-letter", "cancelled"],
      required: true,
    },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const hourlyJobEventSchema = new mongoose.Schema(
  {
    lane: {
      type: String,
      enum: ["hourly", "nightly"],
      default: "hourly",
      index: true,
    },
    eventType: { type: String, required: true, index: true },
    targetService: { type: String, required: true, index: true },
    handlerKey: { type: String, required: true, index: true },
    domain: { type: String, default: null, index: true },
    aggregateType: { type: String, required: true, index: true },
    aggregateId: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    resolutionCheckKey: { type: String, default: null, index: true },
    resolutionContext: { type: mongoose.Schema.Types.Mixed, default: null },
    dedupeKey: { type: String, default: null, index: true },
    sourceEventId: { type: String, default: null, index: true },
    sourceWorkflowId: { type: String, default: null, index: true },
    emittedBy: { type: String, default: null, index: true },
    priority: { type: Number, default: 50, index: true },
    immediateRetryAttempts: { type: Number, default: 0 },
    immediateRetryDelayMs: { type: Number, default: 0 },
    immediateRetryUsed: { type: Number, default: 0 },
    provideSummary: { type: Boolean, default: false, index: true },
    summaryLabel: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "dead-letter", "cancelled"],
      default: "pending",
      index: true,
    },
    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 12 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    claimedBy: { type: String, default: null },
    claimedAt: { type: Date, default: null },
    firstError: { type: String, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    notes: { type: String, default: null },
    completedAt: { type: Date, default: null },
    attempts: { type: [HourlyJobAttemptSchema], default: [] },
  },
  { timestamps: true },
);

hourlyJobEventSchema.index(
  { lane: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
    name: "hourly_job_event_dedupe",
  },
);

hourlyJobEventSchema.index(
  { lane: 1, status: 1, nextAttemptAt: 1, priority: -1, createdAt: 1 },
  { name: "hourly_job_event_claim" },
);

// Resolution-email sweep — runs every hourly tick scanning for newly-
// completed jobs whose payload requested a resolution notification.
// Partial filter is the key: we only ever index the rows that will
// actually be queried, keeping the index tiny and writes cheap.
hourlyJobEventSchema.index(
  { status: 1, completedAt: -1 },
  {
    name: "hourly_job_event_resolution_email",
    partialFilterExpression: { "payload.notifyOnResolution": true },
  },
);

// Runtime snapshot "most recent hourly job" read.
hourlyJobEventSchema.index({ createdAt: -1 }, { name: "hourly_job_event_created_at_desc" });

module.exports =
  mongoose.models.HourlyJobEvent ||
  mongoose.model("HourlyJobEvent", hourlyJobEventSchema);
