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
      enum: [
        "observed",
        "requested",
        "built",
        "queued",
        "scheduled",
        // "armed" means the cadence schedule has been built and at least
        // one channel is deliverable — emitted at the end of LD intake's
        // writeProspectAndCadence (see inboundIntakeService.js). Sibling
        // to "blocked" (no deliverable channel).
        "armed",
        "blocked",
        "consuming",
        "attempting",
        "selected",
        "checking-suppression",
        "verifying",
        "verified",
        "dispatching",
        "skipped",
        "deferred",
        "cancelled",
        "completed",
        "failed",
      ],
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
    dedupeKey: { type: String, default: null },
    notifiedAt: { type: Date, default: null, index: true },
    happenedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

workflowRecordSchema.index({ family: 1, subtype: 1, stage: 1, happenedAt: -1 });
workflowRecordSchema.index({ aggregateType: 1, aggregateId: 1, happenedAt: -1 });
// Runtime inbound snapshot queries filter by family + happenedAt, and
// the failure slice adds stage but not subtype. Keep both forms bounded.
workflowRecordSchema.index({ family: 1, happenedAt: -1 }, { name: "workflow_family_happened_at" });
workflowRecordSchema.index({ family: 1, stage: 1, happenedAt: -1 }, { name: "workflow_family_stage_happened_at" });
// Hot path: buildCxWorkspace + buildRingBridgeWorkspace both fire
// `{ domain, family, ... }` queries every render. Keep both the legacy
// happenedAt-only index and the exact repository sort so a live index
// sync only adds the tighter path instead of dropping the existing one.
workflowRecordSchema.index({ domain: 1, family: 1, happenedAt: -1 });
workflowRecordSchema.index(
  { domain: 1, family: 1, happenedAt: -1, createdAt: -1 },
  { name: "workflow_domain_family_happened_created" },
);
workflowRecordSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      dedupeKey: { $type: "string" },
    },
  },
);

module.exports =
  mongoose.models.ControlPlaneWorkflowRecord ||
  mongoose.model("ControlPlaneWorkflowRecord", workflowRecordSchema);
