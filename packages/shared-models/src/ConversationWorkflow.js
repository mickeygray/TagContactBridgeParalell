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

    // ── AI-driven hot-intent routing ───────────────────────────────────
    // Set by the SMS classifier when the inbound shows buying intent
    // (tax questions, "I need to do something", interest in service,
    // anything that warrants immediate human follow-up). When this flips
    // true, hotIntentRouterService rounds-robin assigns the thread to an
    // available rep and stamps routedTo* below.
    aiHotIntent: { type: Boolean, default: false, index: true },
    aiHotIntentReason: { type: String, default: null },
    aiHotIntentDetectedAt: { type: Date, default: null },

    // Auto-routed assignment (set by hotIntentRouterService, not by the
    // rep). The assigned rep sees "Routed to you" in their inbox; other
    // reps still see the thread but can see it's already been routed.
    routedToAgentId: { type: String, default: null, index: true },
    routedToAgentName: { type: String, default: null },
    routedAt: { type: Date, default: null },
    // Pointer to the universal-queue item created/boosted for this
    // routing. Null until phone→case lookup lands and the actual queue
    // insert wires up; the stamped routedToAgentId is the source of
    // truth for who owns the thread in the meantime.
    routedQueueItemId: { type: String, default: null },

    // ── Soft-lock on SMS authoring ─────────────────────────────────────
    // Stamped on every rep-initiated outbound (approveInboxWorkflow /
    // editSendInboxWorkflow). Other reps' inbox UI shows "Sean is
    // replying" and disables Approve/Edit-Send with an override
    // confirm. Clears automatically when the next inbound arrives —
    // each turn-of-conversation re-opens the race.
    smsLockedByAgentId: { type: String, default: null, index: true },
    smsLockedByAgentName: { type: String, default: null },
    smsLockedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationWorkflowSchema.index({ domain: 1, phone: 1, channel: 1 }, { unique: true, sparse: true });

module.exports =
  mongoose.models.ControlPlaneConversationWorkflow ||
  mongoose.model("ControlPlaneConversationWorkflow", conversationWorkflowSchema);
