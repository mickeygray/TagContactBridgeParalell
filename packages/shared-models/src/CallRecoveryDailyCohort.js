"use strict";

const mongoose = require("mongoose");

const callRecoveryDailyCohortSchema = new mongoose.Schema({
  dateKey: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  programKey: { type: String, required: true, trim: true },
  captureVersion: { type: Number, required: true, default: 1, min: 1 },
  cadencePolicyId: { type: String, required: true, trim: true },
  dncPolicyId: { type: String, required: true, trim: true },
  logicsPolicyId: { type: String, required: true, trim: true },
  status: { type: String, required: true, enum: ["complete", "incomplete"] },
  candidateEpisodeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneCallRecoveryLead" }],
  candidateCount: { type: Number, required: true, min: 0, default: 0 },
  factsRead: { type: Number, required: true, min: 0, default: 0 },
  qualifiedCalls: { type: Number, required: true, min: 0, default: 0 },
  errorCount: { type: Number, required: true, min: 0, default: 0 },
  rejectedByReason: { type: Map, of: Number, default: {} },
  sourceDigest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  capturedAt: { type: Date, required: true },
  revision: { type: Number, required: true, min: 1, default: 1 },
}, { timestamps: true, minimize: false, versionKey: false });

module.exports = mongoose.models.ControlPlaneCallRecoveryDailyCohort
  || mongoose.model("ControlPlaneCallRecoveryDailyCohort", callRecoveryDailyCohortSchema);
