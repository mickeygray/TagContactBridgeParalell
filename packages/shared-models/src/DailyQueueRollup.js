"use strict";

const mongoose = require("mongoose");

// ONE DAY OF QUEUE ACTIVITY, frozen.
//
// Mickey 2026-07-28: "that might be something i dont mind building and storing
// is that agent calls taken via rc."
//
// ── why this one is allowed to be stored ────────────────────────────────
// The doctrine is gather live, persist nothing. This earns an exception on
// the same grounds as the attribution snapshot: it cannot be re-derived
// cheaply, and it stops changing.
//
//   · RingCentral answers per DAY, not per range, so a month costs ~28 paged
//     reads against an API that rate-limits hard. That is the whole reason
//     the work log refused ranges over 7 days.
//   · CallLog cannot substitute: on INBOUND legs `extensionId` is the QUEUE
//     that rang, not the agent who answered (measured 2026-07-27: only 5 of
//     44 inbound legs mapped to a user account, and CallLog held 44 legs for
//     a day the queue reported 73 connected).
//   · Once a day is over, who answered what is a FACT about a finished day.
//     It never changes, so a stored copy can never go stale — unlike a
//     status or a balance, which is what the doctrine actually forbids.
//
// Outbound is stored too, purely so a range needs one read instead of two
// sources; it IS re-derivable from CallLog (99% of outbound legs map to a
// user), which makes it a useful cross-check rather than a single point of
// truth.
//
// One document per day. A range is `find({dateKey: {$gte, $lte}})` and a
// merge — the same shape the live day-loop produces, minus the API calls.

const agentSchema = new mongoose.Schema(
  {
    agent: { type: String, required: true },
    // Inbound calls CONNECTED to this agent, split by paid stream.
    taken: { type: Number, default: 0 },
    // Outbound dials (PhoneBurner LD today).
    made: { type: Number, default: 0 },
    // The per-stream breakdown, e.g. { MAILER: 25, BCD: 1, LD: 26 }.
    byStream: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const streamSchema = new mongoose.Schema(
  {
    stream: { type: String, required: true },
    // `calls` is what RANG, `connected` is what was ANSWERED. A missed call
    // has no agent, so it can only ever live at this level — never on a row
    // with someone's name against it.
    calls: { type: Number, default: 0 },
    connected: { type: Number, default: 0 },
    missed: { type: Number, default: 0 },
  },
  { _id: false },
);

const dailyQueueRollupSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true, index: true },
    agents: { type: [agentSchema], default: [] },
    streams: { type: [streamSchema], default: [] },

    // Provenance, so a thin day is explicable rather than merely suspicious.
    capturedAt: { type: Date, default: Date.now },
    // True when the queue read came back rate-limited or truncated: the
    // numbers are a FLOOR, not a total, and any range containing this day
    // must say so.
    partial: { type: Boolean, default: false },
    partialReason: { type: String, default: null },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.ControlPlaneDailyQueueRollup ||
  mongoose.model("ControlPlaneDailyQueueRollup", dailyQueueRollupSchema);
