"use strict";

const mongoose = require("mongoose");

const dncAuditSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    phone: { type: String, default: null, index: true },
    caseId: { type: Number, default: null, index: true },
    workflowId: { type: String, default: null, index: true },
    source: { type: String, default: "sms-opus-triage", index: true },
    inboundText: { type: String, default: null },
    threadHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
    classification: { type: mongoose.Schema.Types.Mixed, default: null },
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    logicsResult: { type: mongoose.Schema.Types.Mixed, default: null },
    happenedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

dncAuditSchema.index(
  { domain: 1, happenedAt: -1 },
  { name: "dnc_audit_by_domain_time" },
);

module.exports =
  mongoose.models.ControlPlaneDncAudit ||
  mongoose.model("ControlPlaneDncAudit", dncAuditSchema);
