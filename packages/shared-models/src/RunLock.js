"use strict";

const mongoose = require("mongoose");

const runLockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    token: { type: String, required: true },
    lockedBy: { type: String, default: "process" },
    lockedAt: { type: Date, default: Date.now },
    lockedUntil: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 },
    },
  },
  {
    versionKey: false,
  },
);

module.exports =
  mongoose.models.ControlPlaneRunLock ||
  mongoose.model("ControlPlaneRunLock", runLockSchema);
