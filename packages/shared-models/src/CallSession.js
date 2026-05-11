"use strict";

const mongoose = require("mongoose");

// CallSession — the spine of the call lifecycle. ONE document per
// call (outbound click-to-dial OR inbound EX hunt-group ring). Every
// subsystem that cares about call state reads from here.
//
// Lifecycle:
//   placing       → DialService issued the RingCX placeManualCall API
//   ringing       → RC presence webhook reports Ringing on agent's ext
//   connected     → RC presence webhook reports CallConnected
//   ended         → RC presence webhook reports NoCall (call ended)
//   dispositioned → agent recorded an outcome via the SPA buttons
//
// Key invariants:
//   - At most one active CallSession (state ∈ placing/ringing/connected) per agent
//   - QueueItem.state must be `dialing` when an outbound CallSession exists
//     for it (enforced via LeadActivity lock)
//   - rcxUii is the RingCX call ID returned by placeManualCall
//   - sessionId / telephonySessionId are the RC EX call session IDs from
//     presence webhooks (set as they arrive — may be null at "placing")
//
// IMPORTANT: rcxUii is the canonical handle for RingCX termination/
// disposition API calls. Don't confuse with the EX session IDs.

const callSessionSchema = new mongoose.Schema(
  {
    direction: {
      type: String,
      enum: ["outbound", "inbound"],
      required: true,
      index: true,
    },
    state: {
      type: String,
      enum: ["placing", "ringing", "connected", "ended", "dispositioned", "failed"],
      default: "placing",
      index: true,
    },

    // Identifiers
    agentId: { type: String, required: true, index: true }, // extensionId
    agentName: { type: String, default: null },
    agentEmail: { type: String, default: null },          // for RingCX API
    leadId: { type: String, default: null, index: true },
    queueItemId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneQueueItem", default: null, index: true },
    domain: { type: String, default: "TAG", index: true },
    logicsCaseId: { type: String, default: null },

    // Phone numbers
    phoneNumber: { type: String, required: true },
    contactName: { type: String, default: null },
    callerId: { type: String, default: null },

    // RC handles
    rcxUii: { type: String, default: null, index: true },          // RingCX call id
    sessionId: { type: String, default: null, index: true },        // RC EX session id
    telephonySessionId: { type: String, default: null, index: true },

    // Timestamps
    startedAt: { type: Date, default: Date.now },
    ringingAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    dispositionedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },

    // Outcome
    dispositionResult: {
      type: String,
      enum: [
        null,
        "callback",
        "postdate",
        "deal",
        "dnc",
        "did_not_connect",
        "voicemail",
        "wrong_number",
      ],
      default: null,
    },
    rcxDispositionCode: { type: String, default: null },  // mapped value sent to RingCX
    dispositionPayload: { type: mongoose.Schema.Types.Mixed, default: null },
    dispositionedBy: { type: String, default: null },     // agent extensionId

    // Error / failure tracking
    failureReason: { type: String, default: null },
    placementError: { type: mongoose.Schema.Types.Mixed, default: null },
    rcxApiErrors: [{ at: Date, op: String, message: String }],

    // Audit / provenance
    placedVia: {
      type: String,
      enum: ["ringcx-soft", "rc-ex-ringout", "manual-test"],
      default: "ringcx-soft",
    },
    notes: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: "callsessions",
  },
);

callSessionSchema.index({ agentId: 1, state: 1 });
callSessionSchema.index({ rcxUii: 1, state: 1 });
callSessionSchema.index({ leadId: 1, startedAt: -1 });
callSessionSchema.index({ queueItemId: 1, state: 1 });

module.exports = mongoose.models.ControlPlaneCallSession
  || mongoose.model("ControlPlaneCallSession", callSessionSchema);
