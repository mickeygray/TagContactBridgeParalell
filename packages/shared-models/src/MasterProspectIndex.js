"use strict";

const mongoose = require("mongoose");

const masterProspectIndexSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    statusId: { type: Number, default: null, index: true },
    statusLabelRaw: { type: String, default: null },
    statusCategory: { type: String, default: "prospect", index: true },
    sourceId: { type: Number, default: null, index: true },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    firstName: { type: String, default: null },
    lastName: { type: String, default: null },
    name: { type: String, default: null },
    email: { type: String, default: null },
    cellPhone: { type: String, default: null },
    homePhone: { type: String, default: null },
    workPhone: { type: String, default: null },
    normalizedPhones: [{ type: String, index: true }],
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    lastStatusCheckAt: { type: Date, default: null },
    lastSourceCheckAt: { type: Date, default: null },
    lastMatchedActivityAt: { type: Date, default: null },
    needsStatusRefresh: { type: Boolean, default: true, index: true },
    needsSourceRefresh: { type: Boolean, default: true, index: true },
    convertedAt: { type: Date, default: null, index: true },
    caseProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneCaseProfile",
      default: null,
      index: true,
    },
    metadata: {
      intakeSource: { type: String, default: null },
      lastImportBatch: { type: String, default: null },
      notes: [{ type: String }],
    },
  },
  { timestamps: true },
);

masterProspectIndexSchema.index({ domain: 1, caseId: 1 }, { unique: true });
masterProspectIndexSchema.index({ domain: 1, statusId: 1 });
masterProspectIndexSchema.index({ domain: 1, statusCategory: 1 });
masterProspectIndexSchema.index({
  domain: 1,
  needsStatusRefresh: 1,
  statusCategory: 1,
});

module.exports =
  mongoose.models.ControlPlaneMasterProspectIndex ||
  mongoose.model("ControlPlaneMasterProspectIndex", masterProspectIndexSchema);
