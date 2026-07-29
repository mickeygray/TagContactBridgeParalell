"use strict";

const mongoose = require("mongoose");

const transcriptSegmentSchema = new mongoose.Schema(
  {
    segmentId: { type: String, required: true },
    startMs: { type: Number, required: true, min: 0 },
    endMs: { type: Number, required: true, min: 0 },
    text: { type: String, required: true },
    speaker: {
      type: String,
      enum: ["agent", "prospect", "unknown"],
      default: "unknown",
    },
    speakerConfidence: { type: Number, min: 0, max: 1, default: null },
  },
  { _id: false },
);

const evidenceCitationSchema = new mongoose.Schema(
  {
    segmentId: { type: String, required: true },
    startMs: { type: Number, required: true, min: 0 },
    endMs: { type: Number, required: true, min: 0 },
    quote: { type: String, required: true },
  },
  { _id: false },
);

const scriptFindingSchema = new mongoose.Schema(
  {
    findingId: { type: String, required: true },
    sectionId: { type: String, required: true },
    beatId: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "observed",
        "partial",
        "missed",
        "not_applicable",
        "uncertain",
      ],
      required: true,
    },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: null },
    citations: { type: [evidenceCitationSchema], default: undefined },
  },
  { _id: false },
);

const considerationSchema = new mongoose.Schema(
  {
    findingId: { type: String, required: true },
    authority: {
      type: String,
      enum: ["model_generated_advisory"],
      default: "model_generated_advisory",
    },
    title: { type: String, required: true },
    summary: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: null },
    citations: { type: [evidenceCitationSchema], default: undefined },
  },
  { _id: false },
);

const trainingCallReviewSchema = new mongoose.Schema(
  {
    learnerKey: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    callFingerprint: { type: String, required: true, trim: true, index: true },
    recordingFingerprint: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    recordingSourceId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },
    domain: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    caseId: { type: Number, required: true, index: true },
    source: {
      provider: {
        type: String,
        enum: ["ex", "phoneburner", "callrail"],
        required: true,
      },
      startedAt: { type: Date, default: null },
      durationSec: { type: Number, default: null },
      direction: { type: String, default: "unknown" },
      agentName: { type: String, default: null },
      outcome: { type: String, default: null },
    },
    versions: {
      scriptVersion: { type: String, required: true },
      transcriptVersion: { type: String, required: true },
      graderVersion: { type: String, required: true },
    },
    requestId: { type: String, default: null },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed"],
      default: "pending",
      index: true,
    },
    generation: { type: Number, default: 0, min: 0 },
    transcript: {
      status: {
        type: String,
        enum: ["pending", "completed"],
        default: "pending",
      },
      version: { type: String, default: null },
      recordingFingerprint: { type: String, default: null },
      text: { type: String, default: null },
      segments: { type: [transcriptSegmentSchema], default: undefined },
      provider: { type: String, default: null },
      model: { type: String, default: null },
      reused: { type: Boolean, default: false },
      reusedFromReviewId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ControlPlaneTrainingCallReview",
        default: null,
      },
      completedAt: { type: Date, default: null },
    },
    analysis: {
      authorityType: {
        type: String,
        enum: ["tax_group_script"],
        default: "tax_group_script",
      },
      scriptVersion: { type: String, default: null },
      graderVersion: { type: String, default: null },
      provider: { type: String, default: null },
      model: { type: String, default: null },
      scriptFindings: { type: [scriptFindingSchema], default: undefined },
      thingsToConsider: { type: [considerationSchema], default: undefined },
    },
    error: {
      code: { type: String, default: null },
      at: { type: Date, default: null },
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

trainingCallReviewSchema.index(
  {
    learnerKey: 1,
    callFingerprint: 1,
    recordingFingerprint: 1,
    "versions.scriptVersion": 1,
    "versions.transcriptVersion": 1,
    "versions.graderVersion": 1,
  },
  { unique: true, name: "learner_call_recording_analysis_version" },
);

trainingCallReviewSchema.index(
  {
    recordingFingerprint: 1,
    "versions.transcriptVersion": 1,
    "transcript.status": 1,
    updatedAt: -1,
  },
  { name: "recording_transcript_reuse" },
);

trainingCallReviewSchema.index(
  { domain: 1, caseId: 1, learnerKey: 1, createdAt: -1 },
  { name: "learner_case_review_history" },
);

module.exports =
  mongoose.models.ControlPlaneTrainingCallReview ||
  mongoose.model("ControlPlaneTrainingCallReview", trainingCallReviewSchema);
