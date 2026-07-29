"use strict";

const mongoose = require("mongoose");

const dailyDialAttemptSchema = new mongoose.Schema({
  attemptKey: { type: String, required: true, trim: true },
  provider: { type: String, required: true, trim: true, lowercase: true, default: "phoneburner" },
  providerCallId: { type: String, required: true, trim: true },
  agentId: { type: String, default: null, trim: true, lowercase: true },
  outcome: { type: String, required: true, trim: true },
  connected: { type: Boolean, default: null },
  callStartedAt: { type: Date, default: null },
  callEndedAt: { type: Date, required: true },
  durationSeconds: { type: Number, default: null, min: 0 },
  recordingUrl: { type: String, default: null, trim: true },
  originPool: { type: String, required: true, trim: true },
  dailyAttemptCount: { type: Number, required: true, min: 1 },
  totalAttemptCount: { type: Number, required: true, min: 1 },
}, { _id: false, minimize: false });

const dailyDialSchema = new mongoose.Schema({
  domain: { type: String, required: true, trim: true, lowercase: true },
  caseId: { type: String, required: true, trim: true },
  dateKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  leadCreatedAt: { type: Date, required: true },
  leadAgeDays: { type: Number, required: true, min: 0 },
  allowedToday: { type: Number, required: true, min: 1 },
  contactedToday: { type: Number, required: true, min: 0, default: 0 },
  capped: { type: Boolean, required: true, default: false, index: true },
  leadReceivedAt: { type: Date, default: null },
  lastOffloadAt: { type: Date, default: null, index: true },
  // Compatibility alias for pre-cutover readers. New code must use
  // leadReceivedAt for intake time and lastOffloadAt for call completion.
  receivedAt: { type: Date, required: true },
  nextEligibleAt: { type: Date, default: null, index: true },
  callStartedAt: { type: Date, default: null },
  callEndedAt: { type: Date, default: null },
  durationSeconds: { type: Number, default: null, min: 0 },
  recordingUrl: { type: String, default: null, trim: true },
  originPool: { type: String, required: true, trim: true },
  lastAgentId: { type: String, default: null, trim: true, lowercase: true },
  lastOutcome: { type: String, default: null, trim: true },
  terminal: { type: Boolean, required: true, default: false, index: true },
  countedAttemptKeys: { type: [String], default: [] },
  attempts: { type: [dailyDialAttemptSchema], default: [] },
  cadencePersistedAt: { type: Date, default: null, index: true },
  leadSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true, minimize: false });

dailyDialSchema.index(
  { domain: 1, caseId: 1, dateKey: 1 },
  { unique: true, name: "uq_daily_dial_lead_date" },
);
dailyDialSchema.index({ dateKey: 1, nextEligibleAt: 1, contactedToday: 1 });
dailyDialSchema.index({ dateKey: 1, lastAgentId: 1, callEndedAt: 1 });

module.exports = mongoose.models.DailyDial
  || mongoose.model("DailyDial", dailyDialSchema);
