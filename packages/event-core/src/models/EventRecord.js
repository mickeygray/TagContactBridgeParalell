"use strict";

const mongoose = require("mongoose");
const { EVENT_STATUS } = require("../constants");

const EventAttemptSchema = new mongoose.Schema(
  {
    worker: { type: String, required: true },
    status: { type: String, required: true },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { _id: false },
);

const EventRecordSchema = new mongoose.Schema(
  {
    eventType: { type: String, required: true, index: true },
    sourceService: { type: String, required: true, index: true },
    aggregateType: { type: String, required: true },
    aggregateId: { type: String, required: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: Object.values(EVENT_STATUS),
      default: EVENT_STATUS.PENDING,
      index: true,
    },
    attemptCount: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    processedAt: { type: Date, default: null },
    dedupeKey: { type: String, default: null, index: true },
    lastError: { type: String, default: null },
    lastWorker: { type: String, default: null },
    replayOf: { type: mongoose.Schema.Types.ObjectId, default: null },
    attempts: { type: [EventAttemptSchema], default: [] },
  },
  { timestamps: true },
);

EventRecordSchema.index(
  { sourceService: 1, dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: "string" } },
  },
);
EventRecordSchema.index(
  { eventType: 1, sourceService: 1, _id: -1 },
  { name: "event_type_source_latest" },
);

module.exports =
  mongoose.models.EventRecord || mongoose.model("EventRecord", EventRecordSchema);
