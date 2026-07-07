"use strict";

const mongoose = require("mongoose");

// CALL WRAP CARD (design: docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md). One card per
// spoke-to-a-human call (outcome "answered", terminal rows only), created exactly-once by
// the DRAIN (idemKey inherited from the terminal outbox row). The card carries the call's
// whole dossier and lives exactly 2 hours (the quarantine clock); it resolves through ONE
// pipeline — [DNC] [Appointment] [✕] or passive expiry — per the unified resolution
// protocol. The dialer's outcome wrote zero case-land; the card is the only writer.
const cxCallWrapCardSchema = new mongoose.Schema(
  {
    idemKey: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["pending", "dnc", "appointment", "dismissed", "expired"],
      default: "pending",
      index: true,
    },
    sessionId: { type: String, default: null, index: true },
    domain: { type: String, default: null, index: true },
    queueItemId: { type: String, default: null, index: true },
    uii: { type: String, default: null },
    caseId: { type: Number, default: null },
    agentEmail: { type: String, default: null, index: true },
    agentName: { type: String, default: null },
    name: { type: String, default: null },
    outcome: { type: String, default: null },
    systemDisposition: { type: String, default: null },
    calledAt: { type: Date, default: null },
    // The dossier: coach summary inline + pointers; formSnapshot arrives with WO-17.
    coachSessionId: { type: String, default: null },
    coachSummary: { type: mongoose.Schema.Types.Mixed, default: null },
    formSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    // The 2h clock — quarantine and card lifetime are the same object by design.
    expiresAt: { type: Date, default: null, index: true },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
    resolutionDetail: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

cxCallWrapCardSchema.index({ agentEmail: 1, status: 1, expiresAt: 1 });
cxCallWrapCardSchema.index({ status: 1, expiresAt: 1 });

module.exports =
  mongoose.models.ControlPlaneCxCallWrapCard ||
  mongoose.model("ControlPlaneCxCallWrapCard", cxCallWrapCardSchema);
