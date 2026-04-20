"use strict";

const mongoose = require("mongoose");

const authOtpChallengeSchema = new mongoose.Schema(
  {
    accountId: { type: String, required: true, index: true },
    email: { type: String, required: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    attemptsRemaining: { type: Number, default: 5 },
    status: {
      type: String,
      enum: ["pending", "used", "expired", "failed"],
      default: "pending",
      index: true,
    },
    delivery: {
      channel: { type: String, default: "email" },
      previewEnabled: { type: Boolean, default: true },
      deliveredAt: { type: Date, default: null },
    },
    metadata: {
      audience: String,
      role: String,
      workspace: String,
      requestedByIp: String,
    },
  },
  {
    timestamps: true,
    collection: "authotpchallenges",
  },
);

module.exports = mongoose.models.ControlPlaneAuthOtpChallenge
  || mongoose.model("ControlPlaneAuthOtpChallenge", authOtpChallengeSchema);
