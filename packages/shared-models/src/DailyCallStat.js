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
  },
  { timestamps: true },
);

dailyCallStatSchema.index({ date: 1, piece: 1 }, { unique: true });
dailyCallStatSchema.index({ date: 1, channel: 1 });
dailyCallStatSchema.index({ piece: 1, date: 1 });

module.exports =
  mongoose.models.ControlPlaneDailyCallStat ||
  mongoose.model("ControlPlaneDailyCallStat", dailyCallStatSchema);
