"use strict";

const mongoose = require("mongoose");

function nullableTrimmed(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function nullableUppercase(value) {
  const normalized = nullableTrimmed(value);
  return normalized ? normalized.toUpperCase() : null;
}

function nonNegativeIntegerField(defaultValue = 0) {
  return {
    type: Number,
    default: defaultValue,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  };
}

const leadDeliveryEventSchema = new mongoose.Schema({
  provider: { type: String, required: true, index: true, set: (value) => String(value || "").trim().toLowerCase() },
  providerEventId: { type: String, default: null, set: nullableTrimmed },
  dedupeKey: { type: String, required: true, trim: true },
  providerCallId: { type: String, default: null, index: true, set: nullableTrimmed },
  providerContactId: { type: String, default: null, index: true, set: nullableTrimmed },
  providerExternalLeadId: { type: String, default: null, index: true, set: nullableTrimmed },
  eventType: { type: String, required: true, index: true, trim: true, lowercase: true },
  receivedAt: { type: Date, required: true, default: Date.now, index: true },
  normalizedOutcome: { type: String, default: null },
  payloadDigest: { type: String, required: true, trim: true },
  safePayload: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: {
    type: String,
    enum: ["pending", "processing", "completed", "failed", "review"],
    default: "pending",
    index: true,
  },
  attempts: nonNegativeIntegerField(),
  nextAttemptAt: { type: Date, default: null, index: true },
  processingLeaseId: { type: String, default: null, index: true, set: nullableTrimmed },
  processingLeaseExpiresAt: { type: Date, default: null, index: true },
  // Canonical Logics identity is attached only after the provider callback is
  // resolved to one exact lead-delivery item. Never trust callback-supplied
  // custom fields as the event's case identity.
  domain: { type: String, default: null, index: true, set: nullableUppercase },
  caseId: { type: String, default: null, index: true, set: nullableTrimmed },
  resolvedItemId: { type: String, default: null, index: true, set: nullableTrimmed },
  resolvedAttemptNumber: nonNegativeIntegerField(),
  // Durable, provider-neutral inputs for downstream effects. This is written
  // with localAppliedAt so crash replay never has to borrow timing or cadence
  // state from a newer attempt on the same lead.
  effectContext: { type: mongoose.Schema.Types.Mixed, default: null },
  localAppliedAt: { type: Date, default: null },
  downstreamAppliedAt: { type: Date, default: null },
  processedAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  version: { ...nonNegativeIntegerField(), required: true },
}, { timestamps: true, minimize: false, versionKey: false });

leadDeliveryEventSchema.index(
  { provider: 1, dedupeKey: 1 },
  { unique: true, name: "uq_lead_delivery_provider_event" },
);
leadDeliveryEventSchema.index(
  { provider: 1, providerEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerEventId: { $type: "string" } },
    name: "uq_lead_delivery_provider_event_id",
  },
);
leadDeliveryEventSchema.index(
  { provider: 1, receivedAt: 1, _id: 1 },
  {
    name: "lead_delivery_event_pending_recovery",
    partialFilterExpression: { status: "pending" },
  },
);
leadDeliveryEventSchema.index(
  { provider: 1, nextAttemptAt: 1, receivedAt: 1, _id: 1 },
  {
    name: "lead_delivery_event_failed_recovery",
    partialFilterExpression: { status: "failed" },
  },
);
leadDeliveryEventSchema.index(
  { provider: 1, processingLeaseExpiresAt: 1, receivedAt: 1, _id: 1 },
  {
    name: "lead_delivery_event_processing_recovery",
    partialFilterExpression: { status: "processing" },
  },
);
leadDeliveryEventSchema.index({ provider: 1, providerCallId: 1, eventType: 1 });
leadDeliveryEventSchema.index({ domain: 1, caseId: 1, eventType: 1, receivedAt: -1 });

module.exports = mongoose.models.LeadDeliveryEvent
  || mongoose.model("LeadDeliveryEvent", leadDeliveryEventSchema);
