"use strict";

const mongoose = require("mongoose");

const conversationWorkflowSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    phone: { type: String, default: null, index: true },
    channel: { type: String, default: "sms", index: true },
    status: {
      type: String,
      enum: ["observed", "drafted", "manual-review", "sent", "suppressed", "closed"],
      default: "observed",
      index: true,
    },
    optOutDetected: { type: Boolean, default: false, index: true },
    optedOutAt: { type: Date, default: null },
    latestInboundText: { type: String, default: null },
    latestInboundAt: { type: Date, default: null },
    aiRecommendedAction: { type: String, default: null },
    aiDraftReply: { type: String, default: null },
    aiConfidence: { type: String, default: null },
    aiFlags: [{ type: String }],
    aiSummary: { type: String, default: null },
    sourceService: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

conversationWorkflowSchema.index({ domain: 1, phone: 1, channel: 1 }, { unique: true, sparse: true });

module.exports =
  mongoose.models.ControlPlaneConversationWorkflow ||
  mongoose.model("ControlPlaneConversationWorkflow", conversationWorkflowSchema);
