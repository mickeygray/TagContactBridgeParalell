"use strict";

const mongoose = require("mongoose");

/**
 * One row per inbound or outbound SMS/email turn. Sits beside
 * ConversationWorkflow (which is the thread-level summary) and lets the
 * admin UI render a full history instead of just "latest inbound + latest
 * draft." Every classifier run, auto-response, and manual disposition
 * writes a row here.
 *
 * Keying:
 *  - `workflowId` ties the message to its thread summary.
 *  - `domain` + `phone` are duplicated for easy filtering without a join.
 *  - No unique index on providerMessageId — CallRail can recycle ids over
 *    long windows; we dedupe at the webhook layer via the event ledger.
 */
const conversationMessageSchema = new mongoose.Schema(
  {
    workflowId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneConversationWorkflow",
      required: true,
      index: true,
    },
    domain: { type: String, required: true, index: true },
    phone: { type: String, default: null, index: true },
    caseId: { type: Number, default: null, index: true },
    channel: { type: String, enum: ["sms", "email"], default: "sms", index: true },
    direction: {
      type: String,
      enum: ["inbound", "outbound"],
      required: true,
      index: true,
    },
    body: { type: String, default: "" },

    // Provider / send tracking (outbound only). Inbound rows have these null.
    provider: { type: String, default: null },
    providerMessageId: { type: String, default: null, index: true, sparse: true },
    providerStatus: {
      type: String,
      // sent = API accepted; delivered = carrier ack via webhook;
      // failed = API non-2xx; undelivered = carrier reject.
      enum: [null, "queued", "sent", "delivered", "failed", "undelivered"],
      default: null,
    },
    providerError: { type: String, default: null },

    // Classifier output (inbound only). Kept on the message so we can
    // audit what the bot decided at the moment the message arrived —
    // even if the prompt/model changes later.
    aiClassification: {
      intent: { type: String, default: null },
      tier: {
        type: String,
        enum: [null, "hard_stop", "dnc_confirm", "soft_defer", "callback_prompt", "needs_human"],
        default: null,
      },
      prospectState: {
        type: String,
        enum: [
          null,
          "scared",
          "shopping",
          "skeptical",
          "resigned",
          "ready",
          "in_progress",
          "defer",
          "partial_clear",
          "investigating",
          "closing",
          "hostile",
          "unclear",
        ],
        default: null,
      },
      suggestedReply: { type: String, default: null },
      callbackWindow: { type: String, default: null },
      confidence: { type: Number, default: null },
      rationale: { type: String, default: null },
      model: { type: String, default: null },
      validationError: { type: String, default: null },
    },

    // Outbound provenance: was this auto-sent, or human-approved?
    autoResponded: { type: Boolean, default: false },
    approvedByEmail: { type: String, default: null },
    approvedAt: { type: Date, default: null },

    // Per-message disposition set from the UI — independent of the
    // workflow-level status. Lets the admin tag a specific turn as
    // "hostile" without changing the thread state.
    disposition: {
      label: {
        type: String,
        enum: [
          null,
          "approve",
          "send_as_is",
          "regenerate",
          "dnc_hard",
          "dnc_soft",
          "hostile",
          "spam",
          "already_client",
          "wrong_number",
        ],
        default: null,
      },
      setByEmail: { type: String, default: null },
      setAt: { type: Date, default: null },
      note: { type: String, default: null },
    },

    // Upstream webhook payload snapshot for forensics.
    rawPayload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

conversationMessageSchema.index({ workflowId: 1, createdAt: 1 });
conversationMessageSchema.index({ domain: 1, phone: 1, createdAt: -1 });

module.exports =
  mongoose.models.ControlPlaneConversationMessage ||
  mongoose.model("ControlPlaneConversationMessage", conversationMessageSchema);
