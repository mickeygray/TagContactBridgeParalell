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
    enum: ["source_cutover"],
    default: "source_cutover",
  },
  source: { type: String, required: true, trim: true, lowercase: true },
  windowStartAt: { type: Date, required: true },
  cutoffAt: { type: Date, required: true, index: true },
  preloadPredicate: {
    type: String,
    required: true,
    enum: ["received_at_lt_cutoff"],
    default: "received_at_lt_cutoff",
  },
  continuationPredicate: {
    type: String,
    required: true,
    enum: ["received_at_gte_cutoff"],
    default: "received_at_gte_cutoff",
  },
  sortContract: {
    type: String,
    required: true,
    enum: ["received_at_desc_source_identity_asc_v1"],
    default: "received_at_desc_source_identity_asc_v1",
  },
  preloadKey: { type: String, required: true, trim: true, index: true },
  maxContacts: {
    type: Number,
    required: true,
    min: 1,
    max: 5000,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  },
  agentSetDigest: digestField({ required: true }),
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
  completedAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, set: nullableTrimmed },
  version: { ...nonNegativeIntegerField(), required: true },
}, { timestamps: true, minimize: false, versionKey: false });

module.exports = mongoose.models.LeadDeliveryCheckpoint
  || mongoose.model("LeadDeliveryCheckpoint", leadDeliveryCheckpointSchema);
