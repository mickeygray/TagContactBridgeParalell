"use strict";

const mongoose = require("mongoose");

function nullableAgentId(value) {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function normalizeAgentOrder(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))];
}

const leadDeliveryFairPickCursorSchema = new mongoose.Schema({
  _id: { type: String, required: true, trim: true, lowercase: true },
  agentOrder: {
    type: [String],
    required: true,
    set: normalizeAgentOrder,
    validate: {
      validator: (value) => Array.isArray(value) && value.length > 0 && new Set(value).size === value.length,
      message: "agentOrder must contain distinct agent IDs",
    },
  },
  lastPickedAgentId: { type: String, default: null, set: nullableAgentId },
  version: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true, minimize: false, versionKey: false });

module.exports = mongoose.models.LeadDeliveryFairPickCursor
  || mongoose.model("LeadDeliveryFairPickCursor", leadDeliveryFairPickCursorSchema);
