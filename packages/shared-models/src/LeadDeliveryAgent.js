"use strict";

const mongoose = require("mongoose");

function nonNegativeIntegerField(defaultValue = 0) {
  return {
    type: Number,
    default: defaultValue,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  };
}

const leadDeliveryAgentSchema = new mongoose.Schema({
  agentId: { type: String, required: true, unique: true, index: true, set: (value) => String(value || "").trim().toLowerCase() },
  displayName: { type: String, default: null },
  enabled: { type: Boolean, default: false, index: true },
  operatorPaused: { type: Boolean, default: false, index: true },
  operatorChangedAt: { type: Date, default: null },
  shiftEnabled: { type: Boolean, default: false, index: true },
  activeUntil: { type: Date, default: null, index: true },
  lastProviderEvidenceAt: { type: Date, default: null },
  providerAcceptedCount: nonNegativeIntegerField(),
  providerCompletedCount: nonNegativeIntegerField(),
  estimatedOutstanding: nonNegativeIntegerField(),
  openRefillRequest: { type: Boolean, default: false, index: true },
  refillRequestId: { type: String, default: null, index: true },
  refillLeaseExpiresAt: { type: Date, default: null, index: true },
  lastRefillRequestedAt: { type: Date, default: null },
  lastPacketAt: { type: Date, default: null },
  fairnessHourKey: { type: String, default: null, index: true },
  fairnessTieBreaker: { type: String, default: null },
  freshReservedThisHour: nonNegativeIntegerField(),
  lastFreshReservedAt: { type: Date, default: null },
  pendingFreshCount: nonNegativeIntegerField(),
  poolOperationId: { type: String, default: null, index: true },
  poolOperationKind: {
    type: String,
    enum: [
      null,
      "ordinary_refill",
      "immediate_fresh",
      "productivity",
      "day_start",
      "day_close",
    ],
    default: null,
    index: true,
  },
  poolOperationLeaseExpiresAt: { type: Date, default: null, index: true },
  poolOperationStartedAt: { type: Date, default: null },
  version: { ...nonNegativeIntegerField(), required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false, versionKey: false });

leadDeliveryAgentSchema.index({ enabled: 1, shiftEnabled: 1, activeUntil: 1 });
leadDeliveryAgentSchema.index({ openRefillRequest: 1, lastRefillRequestedAt: 1 });
leadDeliveryAgentSchema.index({ poolOperationId: 1, poolOperationLeaseExpiresAt: 1 });

module.exports = mongoose.models.LeadDeliveryAgent
  || mongoose.model("LeadDeliveryAgent", leadDeliveryAgentSchema);
