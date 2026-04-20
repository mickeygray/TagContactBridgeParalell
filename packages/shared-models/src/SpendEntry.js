"use strict";

const mongoose = require("mongoose");

const spendEntrySchema = new mongoose.Schema(
  {
    date: { type: String, required: true, index: true },
    domain: { type: String, required: true, index: true },
    channel: { type: String, required: true, index: true },
    source: { type: String, required: true, index: true },
    sheetId: { type: String, default: null, index: true },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
      index: true,
    },
    spend: { type: Number, default: 0 },
    postage: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    pieces: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    leadsReported: { type: Number, default: 0 },
    jobNumber: { type: String, default: null },
    jobName: { type: String, default: null },
    phone: { type: String, default: null },
    form: { type: String, default: null },
    stream: { type: String, default: null },
    reach: { type: Number, default: 0 },
    allClicks: { type: Number, default: 0 },
    resultType: { type: String, default: null },
    landingPageViews: { type: Number, default: 0 },
    campaign: { type: String, default: null },
    platform: { type: String, default: null },
    adSet: { type: String, default: null },
    adName: { type: String, default: null },
    leadsAccepted: { type: Number, default: 0 },
    costPerLead: { type: Number, default: 0 },
    metaCampaignId: { type: String, default: null },
    metaAdsetId: { type: String, default: null },
    metaAdId: { type: String, default: null },
    broadcastId: { type: String, default: null },
    broadcastName: { type: String, default: null },
    syncedAt: { type: Date, default: Date.now },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

spendEntrySchema.index({ date: 1, domain: 1, channel: 1, source: 1, sheetId: 1 });
spendEntrySchema.index({ domain: 1, channel: 1, date: -1 });

module.exports =
  mongoose.models.ControlPlaneSpendEntry ||
  mongoose.model("ControlPlaneSpendEntry", spendEntrySchema);
