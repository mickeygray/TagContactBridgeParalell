"use strict";

const mongoose = require("mongoose");

const workflowRecordSchema = new mongoose.Schema(
  {
    domain: { type: String, default: null, index: true },
    family: { type: String, required: true, index: true },
    subtype: { type: String, default: null, index: true },
    stage: {
      type: String,
      required: true,
      enum: ["observed", "requested", "built", "consuming", "completed", "failed"],
      index: true,
    },
    aggregateType: { type: String, required: true, index: true },
    aggregateId: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    sourceService: { type: String, default: null, index: true },
    workerName: { type: String, default: null },
    status: { type: String, default: "ok", index: true },
    title: { type: String, default: null },
    summary: { type: String, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    happenedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

workflowRecordSchema.index({ family: 1, subtype: 1, stage: 1, happenedAt: -1 });
workflowRecordSchema.index({ aggregateType: 1, aggregateId: 1, happenedAt: -1 });

module.exports =
  mongoose.models.ControlPlaneWorkflowRecord ||
  mongoose.model("ControlPlaneWorkflowRecord", workflowRecordSchema);
