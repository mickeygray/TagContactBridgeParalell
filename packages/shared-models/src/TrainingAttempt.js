"use strict";

const mongoose = require("mongoose");

const attemptEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    type: {
      type: String,
      enum: ["answer_submitted", "attempt_completed", "reflection_added", "gauntlet_initialized", "gauntlet_turn_accepted", "gauntlet_turn_rejected", "gauntlet_hint_revealed", "gauntlet_run_failed", "gauntlet_retry_started", "gauntlet_invalidated"],
      required: true,
    },
    occurredAt: { type: Date, required: true },
    expectedPriorVersion: { type: Number, required: true, min: 0 },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    provenance: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const trainingAttemptSchema = new mongoose.Schema(
  {
    attemptId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    requestId: { type: String, required: true, trim: true },
    enrollmentId: { type: String, required: true, trim: true, index: true },
    learnerEmailNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    companySnapshot: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    courseId: { type: String, required: true, trim: true },
    courseVersion: { type: String, required: true, trim: true },
    itemId: { type: String, required: true, trim: true, index: true },
    itemVersion: { type: String, required: true, trim: true },
    itemType: { type: String, required: true, trim: true },
    rulePackVersion: { type: String, required: true, trim: true },
    ruleIds: { type: [String], default: undefined },
    blueprintId: { type: String, default: null, trim: true },
    blueprintVersion: { type: String, default: null, trim: true },
    variantId: { type: String, default: null, trim: true },
    recordingManifestRef: { type: String, default: null, trim: true },
    gauntletState: { type: mongoose.Schema.Types.Mixed, default: null },
    contentSnapshot: {
      title: { type: String, default: null },
      required: { type: Boolean, default: true },
      gradingVersion: { type: String, default: null },
      promptVersion: { type: String, default: null },
    },
    eventIds: { type: [String], default: undefined },
    events: { type: [attemptEventSchema], default: undefined },
    version: { type: Number, default: 0, min: 0 },
    terminalSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

trainingAttemptSchema.index(
  { learnerEmailNormalized: 1, requestId: 1 },
  {
    unique: true,
    name: "training_attempt_learner_request",
  },
);
trainingAttemptSchema.index(
  { attemptId: 1, "events.eventId": 1 },
  {
    unique: true,
    sparse: true,
    name: "training_attempt_event_idempotency",
  },
);
trainingAttemptSchema.index(
  { enrollmentId: 1, itemId: 1 },
  {
    unique: true,
    name: "training_attempt_enrollment_item",
  },
);
trainingAttemptSchema.index(
  { learnerEmailNormalized: 1, createdAt: -1 },
  { name: "training_attempt_learner_history" },
);

module.exports =
  mongoose.models.ControlPlaneTrainingAttempt ||
  mongoose.model("ControlPlaneTrainingAttempt", trainingAttemptSchema);
