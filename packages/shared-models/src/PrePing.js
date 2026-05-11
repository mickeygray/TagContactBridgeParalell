"use strict";

const mongoose = require("mongoose");

const prePingSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    emailHash: { type: String, required: true, index: true },
    callbackUrl: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 300 },
  },
  { timestamps: false },
);

prePingSchema.index({ domain: 1, emailHash: 1 }, { unique: true });

module.exports =
  mongoose.models.ControlPlanePrePing ||
  mongoose.model("ControlPlanePrePing", prePingSchema);
