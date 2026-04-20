"use strict";

const mongoose = require("mongoose");

const paymentAlertSchema = new mongoose.Schema(
  {
    caseId: { type: Number, required: true, index: true },
    domain: { type: String, required: true, index: true },
    name: { type: String, default: null },
    firstName: { type: String, default: null },
    phone: { type: String, default: null },
    phoneFormatted: { type: String, default: null },
    email: { type: String, default: null },
    paymentDate: { type: String, required: true, index: true },
    declinedAmount: { type: Number, default: 0 },
    attempts: { type: Number, default: 1 },
    lastTransactionStatus: { type: String, default: null },
    lastTransactionComment: { type: String, default: null },
    textSentAt: { type: Date, default: null, index: true },
    textResult: { type: String, default: null },
    textMessage: { type: String, default: null },
    detectedAt: { type: Date, default: Date.now },
    statusId: { type: Number, default: null },
  },
  { timestamps: true },
);

paymentAlertSchema.index({ caseId: 1, domain: 1, paymentDate: 1 }, { unique: true });
paymentAlertSchema.index({ domain: 1, paymentDate: -1, textSentAt: 1 });

module.exports =
  mongoose.models.ControlPlanePaymentAlert ||
  mongoose.model("ControlPlanePaymentAlert", paymentAlertSchema);
