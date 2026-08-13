"use strict";

const mongoose = require("mongoose");

const itemStateSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true, trim: true },
    itemVersion: { type: String, required: true, trim: true },
    itemType: { type: String, required: true, trim: true },
    required: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["locked", "available", "in_progress", "completed"],
      required: true,
    },
    attemptId: { type: String, default: null, trim: true },
    completionOutcome: {
      type: String,
      enum: ["passed", "failed"],
      default: null,
    },
    completedAt: { type: Date, default: null },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const masteryDimensionSchema = new mongoose.Schema(
  {
    knowledge: { type: Number, min: 0, max: 1, default: 0 },
    guidedExecution: { type: Number, min: 0, max: 1, default: 0 },
    transfer: { type: Number, min: 0, max: 1, default: 0 },
    realCallEvidence: { type: Number, min: 0, max: 1, default: 0 },
  },
  { _id: false },
);

const remediationSchema = new mongoose.Schema(
  {
    remediationId: { type: String, required: true, trim: true },
    ruleId: { type: String, required: true, trim: true },
    itemId: { type: String, required: true, trim: true },
    reasonCode: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
    },
    assignedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const trainingEnrollmentSchema = new mongoose.Schema(
  {
    enrollmentId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    requestId: { type: String, required: true, trim: true },
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
    courseId: { type: String, required: true, trim: true, index: true },
    courseVersion: { type: String, required: true, trim: true },
    rulePackVersion: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["active", "completed", "withdrawn"],
      default: "active",
      index: true,
    },
    resumeItemId: { type: String, default: null, trim: true },
    itemStates: { type: [itemStateSchema], default: undefined },
    masteryByRule: {
      type: Map,
      of: masteryDimensionSchema,
      default: undefined,
    },
    activeRemediation: { type: [remediationSchema], default: undefined },
    version: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

trainingEnrollmentSchema.index(
  {
    learnerEmailNormalized: 1,
    courseId: 1,
    courseVersion: 1,
  },
  {
    unique: true,
    name: "training_enrollment_learner_course_version",
  },
);
trainingEnrollmentSchema.index(
  { learnerEmailNormalized: 1, requestId: 1 },
  {
    unique: true,
    name: "training_enrollment_learner_request",
  },
);
trainingEnrollmentSchema.index(
  {
    learnerEmailNormalized: 1,
    status: 1,
    updatedAt: -1,
  },
  { name: "training_enrollment_learner_status" },
);
trainingEnrollmentSchema.index(
  {
    companySnapshot: 1,
    courseId: 1,
    courseVersion: 1,
  },
  { name: "training_enrollment_company_course_version" },
);

module.exports =
  mongoose.models.ControlPlaneTrainingEnrollment ||
  mongoose.model("ControlPlaneTrainingEnrollment", trainingEnrollmentSchema);
