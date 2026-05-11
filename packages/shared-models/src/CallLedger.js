"use strict";

const mongoose = require("mongoose");

const callLedgerSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    telephonySessionId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },

    callStartTime: { type: Date, default: null, index: true },
    callEndTime: { type: Date, default: null },
    durationSec: { type: Number, default: null },
    missed: { type: Boolean, default: false },
    direction: {
      type: String,
      enum: ["inbound", "outbound", "unknown"],
      default: "unknown",
      index: true,
    },

    phone: { type: String, default: null, index: true },
    normalizedPhone: { type: String, default: null, index: true },
    contactName: { type: String, default: null },
    extensionId: { type: String, default: null, index: true },
    agentName: { type: String, default: null },

    caseId: { type: Number, default: null, index: true },
    caseDomain: { type: String, default: null, index: true },
    caseProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneCaseProfile",
      default: null,
      index: true,
    },

    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    sourceName: { type: String, default: null, index: true },
    sourceChannel: { type: String, default: null, index: true },
    mailPieceKey: { type: String, default: null, index: true },

    strategy: { type: String, default: null },
    confidence: { type: String, default: null, index: true },
    status: { type: String, default: null, index: true },
    resolvedAt: { type: Date, default: null },

    transcriptionStatus: { type: String, default: null, index: true },
    transcriptAvailable: { type: Boolean, default: false },
    recordingAvailable: { type: Boolean, default: false },
    transcribedAt: { type: Date, default: null },
    recordingArchiveStatus: { type: String, default: null },

    scoreOverall: { type: Number, default: null },
    scoreVerdict: { type: String, default: null, index: true },
    scoreSummary: { type: String, default: null },
    scoredAt: { type: Date, default: null },

    callLogUpdatedAt: { type: Date, default: null },
    syncedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

callLedgerSchema.index({ domain: 1, telephonySessionId: 1 }, { unique: true });
callLedgerSchema.index({ domain: 1, caseId: 1, callStartTime: -1 });
callLedgerSchema.index({ domain: 1, date: 1, sourceName: 1, sourceChannel: 1 });
callLedgerSchema.index({ date: 1, sourceChannel: 1, sourceName: 1 });

module.exports =
  mongoose.models.ControlPlaneCallLedger ||
  mongoose.model("ControlPlaneCallLedger", callLedgerSchema);
