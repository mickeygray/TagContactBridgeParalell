"use strict";

const mongoose = require("mongoose");

const assignmentSchema = new mongoose.Schema(
  {
    mailHouseName: { type: String, required: true },
    internalName: { type: String, default: null },
    form: { type: String, default: null },
    stream: { type: String, default: null },
    color: { type: String, default: null },
    from: { type: String, required: true },
    to: { type: String, default: null },
    active: { type: Boolean, default: false },
    drops: { type: Number, default: 0 },
    totalPieces: { type: Number, default: 0 },
    crTrackerName: { type: String, default: null },
    crTrackingNumber: { type: String, default: null },
    rcQueueName: { type: String, default: null },
    rcExt: { type: String, default: null },
  },
  { _id: false },
);

const mailerConfigSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    digits: { type: String, required: true, unique: true, index: true },
    assignments: [assignmentSchema],
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

mailerConfigSchema.virtual("current").get(function getCurrent() {
  return (
    this.assignments.find((assignment) => assignment.active) ||
    this.assignments[this.assignments.length - 1] ||
    null
  );
});

mailerConfigSchema.virtual("isActive").get(function getIsActive() {
  return this.assignments.some((assignment) => assignment.active);
});

module.exports =
  mongoose.models.ControlPlaneMailerConfig ||
  mongoose.model("ControlPlaneMailerConfig", mailerConfigSchema);
