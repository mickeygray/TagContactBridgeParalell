"use strict";

const mongoose = require("mongoose");

function nullableTrimmed(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function nullableLowercase(value) {
  const normalized = nullableTrimmed(value);
  return normalized == null ? null : normalized.toLowerCase();
}

function nonNegativeIntegerField(defaultValue = 0) {
  return {
    type: Number,
    default: defaultValue,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  };
}

const providerAttemptEventSchema = new mongoose.Schema({
  attemptNumber: {
    type: Number,
    required: true,
    min: 1,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  },
  event: {
    type: String,
    required: true,
    enum: [
      "prepared",
      "accepted",
      "call_begin",
      "provider_moved",
      "provider_removed",
      "completed",
      "delivery_failed",
      "review",
    ],
  },
  provider: { type: String, required: true, set: nullableLowercase },
  providerExternalLeadId: { type: String, required: true, set: nullableTrimmed },
  providerContactId: { type: String, default: null, set: nullableTrimmed },
  providerCallId: { type: String, default: null, set: nullableTrimmed },
  deliveryAgentId: { type: String, default: null, set: nullableLowercase },
  packetId: { type: String, default: null, set: nullableTrimmed },
  occurredAt: { type: Date, required: true },
  outcome: { type: String, default: null },
  reason: { type: String, default: null },
}, { _id: false, minimize: false });

const leadDeliveryItemSchema = new mongoose.Schema({
  domain: { type: String, required: true, index: true, set: (value) => String(value || "").trim().toUpperCase() },
  caseId: { type: String, required: true, index: true, set: (value) => String(value ?? "").trim() },
  sourceIdentity: { type: String, required: true, trim: true },
  leadCadenceId: { type: String, default: null, index: true },
  normalizedPhone: { type: String, required: true },
  displayName: { type: String, default: null },

  // ── COHORT POLICY (CallRail long-call recovery, work order §15.2/§17) ────
  //
  // These exist because the schema is STRICT and every recovery gate keys on
  // them — isCallRecoveryItem, resolveLeadDeliveryContactPolicy and
  // resolveSelectionRank all read `inventoryClass` / `contactPolicyId` /
  // `expiresAt` / `eligibleFrom`. Without a home here mongoose would drop all
  // six on write, silently, and a recovery item would come back out of Mongo
  // indistinguishable from ordinary aged filler.
  //
  // The dangerous half of that is not the cap — an unrecognised item falls back
  // to the age-based policy, which is STRICTER for an old case. It is the
  // EXPIRY: with `expiresAt` gone there is no 120-day stop, so the episode
  // would never age out of the program. A recovery case is allowed to be called
  // for 120 days precisely because that limit is enforced somewhere.
  //
  // Nullable and defaulted, so an ordinary LD lead is completely unaffected —
  // `isCallRecoveryItem` keys on contactPolicyId, which stays null for them.
  inventoryClass: { type: String, default: null, index: true },
  contactPolicyId: { type: String, default: null },
  // The episode's own clock. `receivedAt` remains the lead's true age; these
  // are the PROGRAM's window and must not be conflated with it.
  eligibleFrom: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  firstQualifyingCallAt: { type: Date, default: null },
  // Back-reference to the CallRecoveryLead episode that produced this item.
  episodeId: { type: String, default: null, index: true },
  // Set when a human actually answered, so the policy can refuse a same-day
  // retry without inferring it from attempt counts.
  lastHumanAnsweredAt: { type: Date, default: null },
  sourcePool: {
    type: String,
    enum: ["new_today", "overnight", "older_available", "follow_up_due", null],
    default: null,
    index: true,
  },
  receivedAt: { type: Date, required: true, index: true },
  overnightBatchKey: { type: String, default: null, index: true },
  overnightOrder: { type: Number, default: null },
  nextContactAt: { type: Date, default: null, index: true },
  dailyAttemptDateKey: { type: String, default: null, index: true },
  dailyAttemptCount: nonNegativeIntegerField(),
  totalAttemptCount: nonNegativeIntegerField(),
  lastContactAt: { type: Date, default: null },
  lastOutcome: { type: String, default: null },
  activeAttempt: { type: Boolean, required: true, index: true },
  state: {
    type: String,
    enum: [
      "eligible",
      "reserved",
      "packetized",
      "provider_accepted",
      "in_call",
      "follow_up_wait",
      "terminal",
      "blocked",
      "delivery_failed",
      "review",
    ],
    required: true,
    index: true,
  },
  reservedAgentId: { type: String, default: null, index: true, set: nullableLowercase },
  speedOverrideAgentId: { type: String, default: null, index: true, set: nullableLowercase },
  reservedAt: { type: Date, default: null },
  reservationExpiresAt: { type: Date, default: null, index: true },
  freshDeadlineAt: { type: Date, default: null, index: true },
  reservationReason: { type: String, default: null },
  packetId: { type: String, default: null, index: true, set: nullableTrimmed },
  deliveryAgentId: { type: String, default: null, index: true, set: nullableLowercase },
  provider: { type: String, default: null, index: true, set: nullableLowercase },
  providerContactId: { type: String, default: null, index: true, set: nullableTrimmed },
  providerExternalLeadId: { type: String, default: null, set: nullableTrimmed },
  providerAcceptedAt: { type: Date, default: null },
  providerCompletedAt: { type: Date, default: null },
  providerCallId: { type: String, default: null, index: true, set: nullableTrimmed },
  lastCountedProviderCallId: { type: String, default: null, index: true, set: nullableTrimmed },
  lastCountedProviderAttemptKey: { type: String, default: null, set: nullableTrimmed },
  providerAttemptSequence: nonNegativeIntegerField(),
  providerAttemptHistory: { type: [providerAttemptEventSchema], default: [] },
  providerPostState: {
    type: String,
    enum: [null, "prepared", "posting", "reconcile_required", "accepted", "failed"],
    default: null,
    index: true,
  },
  providerPostLeaseId: { type: String, default: null, index: true, set: nullableTrimmed },
  providerPostLeaseExpiresAt: { type: Date, default: null, index: true },
  providerPostAttemptCount: nonNegativeIntegerField(),
  attemptedAt: { type: Date, default: null },
  terminalAt: { type: Date, default: null },
  version: { ...nonNegativeIntegerField(), required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false, versionKey: false });

leadDeliveryItemSchema.index(
  { sourceIdentity: 1 },
  { unique: true, name: "uq_lead_delivery_source_identity" },
);
leadDeliveryItemSchema.index(
  { domain: 1, caseId: 1 },
  {
    unique: true,
    partialFilterExpression: { activeAttempt: true },
    name: "uq_lead_delivery_active_attempt",
  },
);
leadDeliveryItemSchema.index({ state: 1, sourcePool: 1, nextContactAt: 1, receivedAt: -1 });
leadDeliveryItemSchema.index({ reservedAgentId: 1, state: 1, reservationExpiresAt: 1 });
leadDeliveryItemSchema.index({ deliveryAgentId: 1, state: 1 });
leadDeliveryItemSchema.index(
  { providerExternalLeadId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerExternalLeadId: { $type: "string" } },
    name: "uq_lead_delivery_external_id",
  },
);
leadDeliveryItemSchema.index(
  { provider: 1, providerContactId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerContactId: { $type: "string" } },
    name: "uq_lead_delivery_provider_contact_id",
  },
);
leadDeliveryItemSchema.index({ provider: 1, providerCallId: 1 });
leadDeliveryItemSchema.index({ "providerAttemptHistory.providerExternalLeadId": 1 });
leadDeliveryItemSchema.index({ "providerAttemptHistory.providerContactId": 1 });
leadDeliveryItemSchema.index({ "providerAttemptHistory.providerCallId": 1 });
leadDeliveryItemSchema.index({
  "providerAttemptHistory.deliveryAgentId": 1,
  "providerAttemptHistory.event": 1,
}, { name: "idx_lead_delivery_completed_agent_attempts" });

const LeadDeliveryItem = mongoose.models.LeadDeliveryItem
  || mongoose.model("LeadDeliveryItem", leadDeliveryItemSchema);

module.exports = LeadDeliveryItem;
