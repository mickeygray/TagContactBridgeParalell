"use strict";

const mongoose = require("mongoose");

const SHA256_HEX = /^[a-f0-9]{64}$/;

function trimmed(value) {
  return String(value || "").trim();
}

function nullableTrimmed(value) {
  if (value == null) return null;
  return trimmed(value) || null;
}

function nonNegativeIntegerField(defaultValue = 0) {
  return {
    type: Number,
    default: defaultValue,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  };
}

function digestField({ required = false } = {}) {
  return {
    type: String,
    required,
    default: required ? undefined : null,
    set: nullableTrimmed,
    validate: {
      validator: (value) => value == null || SHA256_HEX.test(value),
      message: "{PATH} must be a lowercase SHA-256 digest",
    },
  };
}

const leadDeliveryCheckpointSchema = new mongoose.Schema({
  _id: { type: String, required: true, trim: true },
  kind: {
    type: String,
    required: true,
    enum: ["source_cutover", "source_repair"],
    default: "source_cutover",
  },
  source: { type: String, required: true, trim: true, lowercase: true },
  provider: { type: String, default: null, trim: true, lowercase: true },
  businessDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
  windowStartAt: {
    type: Date,
    default: null,
    required() { return this.kind === "source_cutover"; },
  },
  cutoffAt: {
    type: Date,
    default: null,
    index: true,
    required() { return this.kind === "source_cutover"; },
  },
  preloadPredicate: {
    type: String,
    required() { return this.kind === "source_cutover"; },
    enum: ["received_at_lt_cutoff"],
    default: null,
  },
  continuationPredicate: {
    type: String,
    required() { return this.kind === "source_cutover"; },
    enum: ["received_at_gte_cutoff"],
    default: null,
  },
  sortContract: {
    type: String,
    required() { return this.kind === "source_cutover"; },
    enum: ["received_at_desc_source_identity_asc_v1"],
    default: null,
  },
  preloadKey: {
    type: String,
    default: null,
    trim: true,
    index: true,
    required() { return this.kind === "source_cutover"; },
  },
  maxContacts: {
    type: Number,
    default: null,
    required() { return this.kind === "source_cutover"; },
    min: 1,
    max: 5000,
    validate: {
      validator: (value) => value == null || Number.isInteger(value),
      message: "{PATH} must be an integer",
    },
  },
  agentSetDigest: {
    ...digestField(),
    required() { return this.kind === "source_cutover"; },
  },
  status: {
    type: String,
    required: true,
    enum: ["scheduled", "running", "partial", "completed", "failed"],
    default: "scheduled",
    index: true,
  },
  scannedCount: nonNegativeIntegerField(),
  eligibleCount: nonNegativeIntegerField(),
  admittedCount: nonNegativeIntegerField(),
  acceptedCount: nonNegativeIntegerField(),
  pendingCount: nonNegativeIntegerField(),
  failedCount: nonNegativeIntegerField(),
  conflictCount: nonNegativeIntegerField(),
  capReached: { type: Boolean, default: false },
  admittedDigest: digestField(),
  acceptedDigest: digestField(),
  latestAdmittedReceivedAt: { type: Date, default: null },
  latestAdmittedIdentityDigest: digestField(),
  latestAcceptedReceivedAt: { type: Date, default: null },
  latestAcceptedIdentityDigest: digestField(),
  repairCursorCreatedAt: { type: Date, default: null },
  repairCursorId: { type: String, default: null, set: nullableTrimmed },
  highWaterCreatedAt: { type: Date, default: null },
  highWaterId: { type: String, default: null, set: nullableTrimmed },
  skippedCount: nonNegativeIntegerField(),
  lastRunAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, set: nullableTrimmed },
  version: { ...nonNegativeIntegerField(), required: true },
}, { timestamps: true, minimize: false, versionKey: false });

module.exports = mongoose.models.LeadDeliveryCheckpoint
  || mongoose.model("LeadDeliveryCheckpoint", leadDeliveryCheckpointSchema);
