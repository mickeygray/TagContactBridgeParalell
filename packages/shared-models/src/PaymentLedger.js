"use strict";

const mongoose = require("mongoose");

// IDENTIFIER SCOPE: `casePaymentId` is globally unique because all companies
// share a single Logics billing tenant — Logics issues a monotonic payment id
// across the whole account. If a new company joins on its own Logics tenant,
// this must become `{ domain: 1, casePaymentId: 1 }` unique.
const paymentLedgerSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    casePaymentId: { type: Number, required: true, unique: true, index: true },
    paymentDate: { type: Date, required: true, index: true },
    paymentDateKey: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    paymentType: {
      type: String,
      required: true,
      enum: ["initial", "recurring", "unknown"],
      default: "unknown",
    },
    transactionStatus: { type: String, default: null, index: true },
    authoritativeSource: { type: String, default: null, index: true },
    authoritativeAt: { type: Date, default: null },
    lastObservedAt: { type: Date, default: null },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    caseProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneCaseProfile",
      default: null,
      index: true,
    },
    masterProspectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneMasterProspectIndex",
      default: null,
      index: true,
    },
    needsSourceReview: { type: Boolean, default: false, index: true },
    reviewReason: { type: String, default: null },
    recordedAt: { type: Date, default: Date.now },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

paymentLedgerSchema.index({ domain: 1, caseId: 1, paymentDate: -1 });
paymentLedgerSchema.index({ domain: 1, sourceCanonicalId: 1, paymentDate: -1 });
paymentLedgerSchema.index({ paymentDateKey: 1, domain: 1 });
paymentLedgerSchema.index(
  { domain: 1, paymentDate: 1, caseId: 1 },
  { name: "payment_ledger_domain_payment_date_case" },
);
paymentLedgerSchema.index(
  { domain: 1, updatedAt: 1, caseId: 1 },
  { name: "payment_ledger_domain_updated_case" },
);

module.exports =
  mongoose.models.ControlPlanePaymentLedger ||
  mongoose.model("ControlPlanePaymentLedger", paymentLedgerSchema);
