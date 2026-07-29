"use strict";

const mongoose = require("mongoose");

const dailyCallStatSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },
    piece: { type: String, required: true, index: true },
    tollFree: { type: String, default: null },
    trackingNumber: { type: String, default: null },
    channel: { type: String, default: "mailer", index: true },
    totalCalls: { type: Number, default: 0 },
    // Originations: CallRail first_call=true — first time this caller ever
    // hit this tracker. THE response-call metric (doctrine 2026-07-24: an
    // origination on a tracking number is a mail response, always; repeat
    // calls are activity, not response).
    firstTimeCallers: { type: Number, default: 0 },
    callsOver5: { type: Number, default: 0 },
    callsOver2: { type: Number, default: 0 },
    totalDuration: { type: Number, default: 0 },
    avgDuration: { type: Number, default: 0 },
    uniqueCallers: { type: Number, default: 0 },
    firstCallTime: { type: String, default: null },
    lastCallTime: { type: String, default: null },
    syncedAt: { type: Date, default: null },
    // "callrail-direct" = written by callrailDailyStatSyncService (the
    // declared feeder). Rows without this marker are legacy roulette-era
    // writes and are ignored by the lean marketing read.
    syncSource: { type: String, default: null, index: true },
    // Direct-source recomputes are full source images. Rows that disappear
    // from a later complete image are retained for audit but excluded from
    // reads instead of being physically deleted.
    active: { type: Boolean, default: true, index: true },
    retiredAt: { type: Date, default: null },
    retiredReason: { type: String, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// IDENTIFIER SCOPE: `piece` is intentionally cross-company. The CallRail
// account tracks a single namespace of mail pieces that the platform rolls up
// across TAG / WYNN / AMITY, so `{date, piece}` is the canonical key.
//
// If any company ever gets its own CallRail tenant, this becomes
// `{ date: 1, domain: 1, piece: 1 }` unique.
dailyCallStatSchema.index({ date: 1, piece: 1 }, { unique: true });
dailyCallStatSchema.index({ date: 1, channel: 1 });
dailyCallStatSchema.index({ piece: 1, date: 1 });

module.exports =
  mongoose.models.ControlPlaneDailyCallStat ||
  mongoose.model("ControlPlaneDailyCallStat", dailyCallStatSchema);
