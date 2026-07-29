"use strict";

const mongoose = require("mongoose");

// THE POOL OF RECORDING LINKS, one row per marketing call.
//
// Mickey 2026-07-29: "you have a pool of links and those are attached to the
// call. so youre grabbing and organzing the link info for marketing calls."
//
// ── why this is allowed to be stored ────────────────────────────────────
// A finished call's recording URL never changes, which is the whole test for
// what may live in Mongo. It is a cached immutable provider artifact, not a
// statistic we are shadowing.
//
// The cost of NOT storing it: CallRail hands out recording URLs one call at a
// time (`getCallRecording(id)`), so a report that wants listen links pays one
// API round-trip per call, every single time it runs. Capturing them once a
// night turns that into a Mongo read, and it means a link survives even if a
// later report never asks for that day.
//
// ── what belongs here ───────────────────────────────────────────────────
// MARKETING calls only — calls that arrived on a tracked source line. A
// servicing call to "Client Contact - TAG" is a real call but it is not
// marketing, and mixing the two is how an existing client ringing support
// starts looking like a fresh response.

const marketingCallLinkSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    // CallRail's own call id. The natural key: re-capturing a day converges
    // rather than duplicating.
    callId: { type: String, required: true },
    dateKey: { type: String, required: true, index: true },

    // Who called, and what they answered.
    phone: { type: String, default: null, index: true },
    callerName: { type: String, default: null },
    source: { type: String, default: null, index: true },
    // "mail" | "ld" | "bcd" — resolved at capture so a later rename of the
    // source cannot silently reclassify history.
    sourceChannel: { type: String, default: null, index: true },

    startedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },
    answered: { type: Boolean, default: null },

    // The artifact. Null means the call had no recording (unanswered, or too
    // short) — a fact, not a failure.
    listenUrl: { type: String, default: null },

    // Set when the call could be tied to a case at capture time. Left null
    // otherwise rather than guessed; the report layer can still match by
    // phone later.
    caseId: { type: Number, default: null, index: true },
    // Why this call was worth keeping: DEAL, LONG, POSTDATE, SOURCE.
    reasons: { type: [String], default: [] },

    capturedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// One row per call, per tenant. Re-running a night updates in place.
marketingCallLinkSchema.index({ domain: 1, callId: 1 }, { unique: true });
marketingCallLinkSchema.index({ domain: 1, dateKey: -1, sourceChannel: 1 });

module.exports =
  mongoose.models.ControlPlaneMarketingCallLink ||
  mongoose.model("ControlPlaneMarketingCallLink", marketingCallLinkSchema);
