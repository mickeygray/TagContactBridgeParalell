"use strict";

const mongoose = require("mongoose");

const socialResponderStatsSchema = new mongoose.Schema(
  {
    totalWebhookEvents: { type: Number, default: 0 },
    matchedEvents: { type: Number, default: 0 },
    repliesSent: { type: Number, default: 0 },
    lastWebhookAt: { type: Date, default: null },
    lastMatchedAt: { type: Date, default: null },
    lastReplyAt: { type: Date, default: null },
    lastEventType: { type: String, default: null },
    lastKeyword: { type: String, default: null },
    lastSenderId: { type: String, default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
  },
  { _id: false },
);

const socialResponderConfigSchema = new mongoose.Schema(
  {
    domain: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    platform: {
      type: String,
      required: true,
      enum: ["facebook", "instagram"],
      lowercase: true,
      trim: true,
      index: true,
    },
    enabled: { type: Boolean, default: false },
    triggerKeywords: { type: [String], default: [] },
    commentReplyTemplate: { type: String, default: "" },
    directReplyTemplate: { type: String, default: "" },
    stats: { type: socialResponderStatsSchema, default: () => ({}) },
    updatedBy: {
      email: { type: String, default: null },
      name: { type: String, default: null },
    },
  },
  { timestamps: true },
);

socialResponderConfigSchema.index(
  { domain: 1, platform: 1 },
  { unique: true, name: "domain_platform_unique" },
);

module.exports =
  mongoose.models.SocialResponderConfig ||
  mongoose.model("SocialResponderConfig", socialResponderConfigSchema);
