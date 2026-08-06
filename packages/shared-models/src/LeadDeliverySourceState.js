"use strict";

const mongoose = require("mongoose");

function nullableTrimmed(value) {
  if (value == null) return null;
  return String(value).trim() || null;
}

function nonNegativeInteger(defaultValue = 0) {
  return {
    type: Number,
    default: defaultValue,
    min: 0,
    validate: { validator: Number.isInteger, message: "{PATH} must be an integer" },
  };
}

const leadDeliverySourceStateSchema = new mongoose.Schema({
  _id: { type: String, required: true, trim: true },
  provider: { type: String, required: true, trim: true, lowercase: true },
  source: { type: String, required: true, trim: true, lowercase: true },
  businessDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  repairStatus: {
    type: String,
    required: true,
    enum: ["scheduled", "running", "completed", "failed"],
    default: "scheduled",
  },
  repairCursorCreatedAt: { type: Date, default: null },
  repairCursorId: { type: String, default: null, set: nullableTrimmed },
  highWaterCreatedAt: { type: Date, default: null },
  highWaterId: { type: String, default: null, set: nullableTrimmed },
  scannedCount: nonNegativeInteger(),
  admittedCount: nonNegativeInteger(),
  skippedCount: nonNegativeInteger(),
  completedAt: { type: Date, default: null },
  lastRunAt: { type: Date, default: null },
  lastErrorCode: { type: String, default: null, set: nullableTrimmed },
  version: { ...nonNegativeInteger(), required: true },
}, { timestamps: true, minimize: false, versionKey: false });

leadDeliverySourceStateSchema.index(
  { provider: 1, source: 1, businessDate: 1 },
  { name: "lead_delivery_source_state_daily", unique: true },
);

module.exports = mongoose.models.LeadDeliverySourceState
  || mongoose.model("LeadDeliverySourceState", leadDeliverySourceStateSchema);
