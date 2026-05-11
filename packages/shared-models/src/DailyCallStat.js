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
    callsOver5: { type: Number, default: 0 },
    callsOver2: { type: Number, default: 0 },
    totalDuration: { type: Number, default: 0 },
    avgDuration: { type: Number, default: 0 },
    uniqueCallers: { type: Number, default: 0 },
    firstCallTime: { type: String, default: null },
    lastCallTime: { type: String, default: null },
    syncedAt: { type: Date, default: null },
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
