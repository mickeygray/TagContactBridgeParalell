"use strict";

const mongoose = require("mongoose");

const scheduledActionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    type: { type: String, required: true },
    channel: { type: String, default: "sms" },
    templateKey: { type: String, default: null },
    scheduledFor: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "requested", "completed", "cancelled", "failed"],
      default: "pending",
    },
  },
  { _id: false },
);

const leadCadenceSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    externalLeadId: { type: String, default: null, index: true },
    intakeRoute: { type: String, default: null, index: true },
    intakeSource: { type: String, default: null, index: true },
    partnerSource: { type: String, default: null },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    normalizedPhone: { type: String, default: null, index: true },
    city: { type: String, default: null },
    state: { type: String, default: null },
    sourceName: { type: String, default: null },
    sourceChannel: { type: String, default: null },
    statusId: { type: Number, default: null },
    active: { type: Boolean, default: true, index: true },
    currentStage: { type: String, default: "new" },
    firstContactRequestedAt: { type: Date, default: null },
    firstContactEventId: { type: String, default: null },
    schedule: {
      planVersion: { type: String, default: "v1" },
      timezone: { type: String, default: "America/Los_Angeles" },
      nextActionType: { type: String, default: null },
      nextActionAt: { type: Date, default: null, index: true },
      actions: { type: [scheduledActionSchema], default: [] },
    },
    attributionContext: { type: mongoose.Schema.Types.Mixed, default: {} },
    payloadSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

leadCadenceSchema.index({ domain: 1, caseId: 1 }, { unique: true });
leadCadenceSchema.index({ domain: 1, active: 1, "schedule.nextActionAt": 1 });

module.exports =
  mongoose.models.ControlPlaneLeadCadence ||
  mongoose.model("ControlPlaneLeadCadence", leadCadenceSchema);
