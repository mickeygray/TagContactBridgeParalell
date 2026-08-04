"use strict";

// THE CALL RECORDING INDEX — one row per call that HAS a recording.
//
// Mickey 2026-08-04: "that's the idea of the future of the call log ... a
// separate collection we can cut over to soon." And earlier: "the big thing I
// want is a downloadable url over pulling the recording if it exists" /
// "bloat on our service when it's living with the vendor is sorta pointless."
//
// So: metadata is ours, media stays with the vendor. This never holds audio.
// It is a SEPARATE collection, written alongside CallLog, so the cutover is a
// reader change rather than a migration.
//
// ── THE ONE THING THIS SCHEMA EXISTS TO GET RIGHT ────────────────────────────
//
// Providers are not alike, and the difference is not cosmetic:
//
//   CallRail     a durable public URL. Serves HTTP 200 audio/mpeg with no auth.
//                Safe to store and hand out.
//   PhoneBurner  a durable URL on www.phoneburner.com. Same treatment.
//   RingCentral  401s. What we hold is an IDENTIFIER. A playable URL has to be
//                signed per request through the forwarder, because a URL with a
//                token baked into it dies when that token rotates (~45 minutes).
//
// Storing an RC URL would be storing something that was never independently
// valid. So there are two distinct fields, and which one is populated is a
// property of the provider, not an accident:
//
//   playbackUrl  a URL that works on its own. Null for RingCentral, always.
//   providerRef  the id to mint from. The only thing RC rows carry.
//
// A row with neither is not "a call without a recording" — it should not exist.
// Rows are only written for calls that HAVE one.
//
// ── PLATFORM NAMING, WHICH HAS ALREADY COST TIME ─────────────────────────────
//
// RingCentral calls are stored under platform "ex", not "ringcentral" — 6,454
// of them in the 30 days to 2026-08-04. There is no "ringcentral" value in
// CallLog at all, so a search for one returns nothing and reads as "RC is dead".
// This collection stores the PROVIDER explicitly and normalized, so the next
// person does not have to know that.
//
// Separately: ~252 CallRail rows are mislabelled platform "ex" in CallLog. The
// backfill that populates this index must resolve provider from evidence, not
// by copying `platform` across.

const mongoose = require("mongoose");

const PROVIDERS = Object.freeze(["callrail", "phoneburner", "ringcentral", "ringcx"]);

const callRecordingIndexSchema = new mongoose.Schema(
  {
    // ── identity ────────────────────────────────────────────────────────────
    provider: { type: String, required: true, enum: PROVIDERS, index: true },
    // The provider's own id for the call. With `provider`, this is the natural
    // key — a call is one call, however many of our collections mention it.
    providerCallId: { type: String, required: true, trim: true, index: true },
    domain: { type: String, default: null, index: true },

    // ── when ────────────────────────────────────────────────────────────────
    // Pacific YYYY-MM-DD, matching every other daily loop on this box. Stored
    // alongside the true instant because "which day was that call on" and "when
    // exactly did it start" are different questions and a UTC timestamp answers
    // the first one wrong by up to eight hours.
    dateKey: { type: String, required: true, index: true },
    startedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },

    // ── who and what ────────────────────────────────────────────────────────
    // Denormalized deliberately: this index exists to be SEARCHED without
    // joining three collections, and an agent's name at the time of the call is
    // a fact about the call, not a foreign key that should follow later renames.
    agentName: { type: String, default: null, index: true },
    agentId: { type: String, default: null },
    caseId: { type: Number, default: null, index: true },
    phone: { type: String, default: null, index: true },
    sourceName: { type: String, default: null, index: true },
    direction: { type: String, default: null },
    outcome: { type: String, default: null },

    // ── the locator: exactly one of these two ───────────────────────────────
    // A URL that works on its own. CallRail and PhoneBurner only.
    playbackUrl: { type: String, default: null },
    // The id a signed URL is minted from at read time. RingCentral only.
    providerRef: { type: String, default: null },

    // ── exclusion, enforced HERE ────────────────────────────────────────────
    // Today an excluded agent's recording is kept out by never being
    // downloaded. Once nothing downloads, that rule has nowhere to live — so it
    // moves onto the index and the read endpoint. `excluded` rows are written
    // (so we can tell "excluded" from "missing") and never served.
    excluded: { type: Boolean, default: false, index: true },
    excludedReason: { type: String, default: null },

    capturedAt: { type: Date, default: Date.now },
    // Which writer produced this row, so a bad backfill is identifiable and
    // reversible without guessing.
    captureSource: { type: String, default: null },
  },
  { timestamps: true, collection: "callrecordingindexes" },
);

// A call is one row. Re-running a capture must update, never duplicate.
callRecordingIndexSchema.index({ provider: 1, providerCallId: 1 }, { unique: true });
// The two searches this exists for: "that day's calls" and "that agent's calls".
callRecordingIndexSchema.index({ dateKey: -1, provider: 1 });
callRecordingIndexSchema.index({ agentName: 1, dateKey: -1 });
callRecordingIndexSchema.index({ caseId: 1, dateKey: -1 });

/** True when this row can be served as-is, without minting. */
callRecordingIndexSchema.methods.isDurable = function isDurable() {
  return Boolean(this.playbackUrl) && this.provider !== "ringcentral";
};

module.exports = mongoose.models.CallRecordingIndex
  || mongoose.model("CallRecordingIndex", callRecordingIndexSchema);
module.exports.PROVIDERS = PROVIDERS;
