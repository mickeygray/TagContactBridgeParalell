"use strict";

const mongoose = require("mongoose");

const consentRecordSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    company: { type: String, default: null, index: true },
    source: { type: String, default: null, index: true },
    caseId: { type: Number, default: null, index: true },
    email: { type: String, default: null, index: true },
    phone: { type: String, default: null, index: true },
    trustedFormCertUrl: { type: String, default: null },
    jornayaLeadId: { type: String, default: null },
    receivedAt: { type: Date, default: Date.now, index: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    intakeRoute: { type: String, default: null, index: true },
    intakeSource: { type: String, default: null, index: true },
    payloadSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

function rejectMutableUpdate(next) {
  return next(new Error("Consent records are immutable"));
}

consentRecordSchema.pre("findOneAndUpdate", rejectMutableUpdate);
consentRecordSchema.pre("updateOne", rejectMutableUpdate);
consentRecordSchema.pre("updateMany", rejectMutableUpdate);

consentRecordSchema.index({ domain: 1, receivedAt: -1 });
consentRecordSchema.index({ domain: 1, caseId: 1, receivedAt: -1 });
consentRecordSchema.index({ domain: 1, email: 1, phone: 1, receivedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneConsentRecord ||
  mongoose.model("ControlPlaneConsentRecord", consentRecordSchema);
