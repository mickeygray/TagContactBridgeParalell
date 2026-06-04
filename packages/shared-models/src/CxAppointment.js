"use strict";

const mongoose = require("mongoose");

const cxAppointmentHistorySchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    at: { type: Date, default: Date.now },
    actorEmail: { type: String, default: null },
    note: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const cxAppointmentSchema = new mongoose.Schema(
  {
    appointmentId: { type: String, required: true, unique: true, index: true },
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    leadCadenceId: { type: String, default: null, index: true },
    cxQueueRecordId: { type: String, default: null, index: true },
    queueActionKey: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ["scheduled", "due", "fired", "completed", "cancelled", "released", "blocked"],
      default: "scheduled",
      index: true,
    },

    agentExtensionId: { type: String, required: true, index: true },
    agentName: { type: String, default: null },
    agentEmail: { type: String, default: null, index: true },

    prospectName: { type: String, default: null },
    phone: { type: String, default: null },
    sourceName: { type: String, default: null },
    intakeSource: { type: String, default: null },
    intakeRoute: { type: String, default: null },

    requestedAtLocal: { type: String, default: null },
    requestedTimezone: { type: String, default: "America/Los_Angeles" },
    appointmentAt: { type: Date, required: true, index: true },
    appointmentTimezone: { type: String, default: "America/Los_Angeles" },
    legalDialAt: { type: Date, required: true, index: true },
    legalDialTimezone: { type: String, default: "America/Los_Angeles" },
    legalDialReason: { type: String, default: null },

    note: { type: String, default: null },
    createdByEmail: { type: String, default: null },
    updatedByEmail: { type: String, default: null },
    releasedAt: { type: Date, default: null },
    releasedByEmail: { type: String, default: null },
    firedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedByEmail: { type: String, default: null },
    resolvedDisposition: { type: String, default: null },
    blockedReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    history: { type: [cxAppointmentHistorySchema], default: [] },
  },
  {
    timestamps: true,
    collection: "cxappointments",
  },
);

cxAppointmentSchema.index({ domain: 1, status: 1, legalDialAt: 1 });
cxAppointmentSchema.index({ agentExtensionId: 1, status: 1, legalDialAt: 1 });
cxAppointmentSchema.index({ domain: 1, caseId: 1, status: 1 });

module.exports = mongoose.models.ControlPlaneCxAppointment
  || mongoose.model("ControlPlaneCxAppointment", cxAppointmentSchema);
