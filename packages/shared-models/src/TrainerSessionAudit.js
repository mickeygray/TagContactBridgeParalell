"use strict";

const mongoose = require("mongoose");

const trainerTurnSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 0 },
    kind: {
      type: String,
      enum: ["conversation", "answer", "reflection", "lesson", "system"],
      default: "conversation",
    },
    learnerText: { type: String, default: null },
    prospectText: { type: String, default: null },
    outcome: { type: String, default: null, trim: true },
    latencyMs: { type: Number, default: null, min: 0 },
    occurredAt: { type: Date, required: true },
  },
  { _id: false },
);

const trainerSessionAuditSchema = new mongoose.Schema(
  {
    sessionKey: { type: String, required: true, unique: true, trim: true, index: true },
    sourceId: { type: String, required: true, trim: true, index: true },
    learnerEmailNormalized: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    companySnapshot: { type: String, default: null, trim: true, uppercase: true },
    kind: {
      type: String,
      enum: ["free_conversation", "trainer_section"],
      required: true,
      index: true,
    },
    title: { type: String, default: null, trim: true },
    courseId: { type: String, default: null, trim: true },
    itemId: { type: String, default: null, trim: true },
    itemType: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: ["active", "report_pending", "reporting", "reported", "report_failed"],
      default: "active",
      index: true,
    },
    startedAt: { type: Date, required: true },
    lastActivityAt: { type: Date, required: true, index: true },
    endedAt: { type: Date, default: null },
    endReason: { type: String, default: null, trim: true },
    activeMs: { type: Number, default: 0, min: 0 },
    eventIds: { type: [String], default: undefined },
    turns: { type: [trainerTurnSchema], default: undefined },
    metrics: {
      turns: { type: Number, default: 0, min: 0 },
      learnerWords: { type: Number, default: 0, min: 0 },
      prospectWords: { type: Number, default: 0, min: 0 },
      answers: { type: Number, default: 0, min: 0 },
      failedAnswers: { type: Number, default: 0, min: 0 },
      retries: { type: Number, default: 0, min: 0 },
      errors: { type: Number, default: 0, min: 0 },
      conflicts: { type: Number, default: 0, min: 0 },
      noSpeech: { type: Number, default: 0, min: 0 },
      sttFailures: { type: Number, default: 0, min: 0 },
      ttsFailures: { type: Number, default: 0, min: 0 },
      slowTurns: { type: Number, default: 0, min: 0 },
      totalTurnLatencyMs: { type: Number, default: 0, min: 0 },
      maxTurnLatencyMs: { type: Number, default: 0, min: 0 },
      errorCodes: { type: [String], default: undefined },
    },
    report: { type: mongoose.Schema.Types.Mixed, default: null },
    reportAttempts: { type: Number, default: 0, min: 0 },
    reportGeneration: { type: Number, default: 0, min: 0 },
    reportClaimedAt: { type: Date, default: null },
    nextReportAttemptAt: { type: Date, default: null, index: true },
    reportedAt: { type: Date, default: null },
    reportErrorCode: { type: String, default: null, trim: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

trainerSessionAuditSchema.index(
  { status: 1, nextReportAttemptAt: 1, lastActivityAt: 1 },
  { name: "trainer_session_report_queue" },
);
trainerSessionAuditSchema.index(
  { learnerEmailNormalized: 1, startedAt: -1 },
  { name: "trainer_session_learner_history" },
);
trainerSessionAuditSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "trainer_session_retention_ttl" },
);

module.exports =
  mongoose.models.ControlPlaneTrainerSessionAudit ||
  mongoose.model("ControlPlaneTrainerSessionAudit", trainerSessionAuditSchema);
