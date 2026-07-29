"use strict";

const mongoose = require("mongoose");

const trainingFreeCallTurnSchema = new mongoose.Schema({
  eventId: { type: String, required: true, trim: true },
  turn: { type: Number, required: true, min: 1 },
  inputFingerprint: { type: String, required: true, trim: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  occurredAt: { type: Date, required: true },
}, { _id: false });

const trainingFreeCallSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, trim: true },
  attemptId: { type: String, required: true, unique: true, trim: true, index: true },
  status: { type: String, enum: ["ready", "in_progress", "completed", "invalidated"], required: true },
  version: { type: Number, default: 0, min: 0 },
  nextTurn: { type: Number, default: 1, min: 1 },
  manifestDate: { type: String, required: true, trim: true },
  profileId: { type: String, required: true, trim: true },
  voiceProfileId: { type: String, required: true, trim: true },
  direction: { type: String, enum: ["inbound", "outbound"], required: true },
  sealed: { type: mongoose.Schema.Types.Mixed, required: true, select: false },
  eventIds: { type: [String], default: undefined },
  turns: { type: [trainingFreeCallTurnSchema], default: undefined },
}, { timestamps: true });

trainingFreeCallSessionSchema.index(
  { sessionId: 1, "turns.eventId": 1 },
  { unique: true, sparse: true, name: "training_free_call_event_idempotency" },
);

module.exports =
  mongoose.models.ControlPlaneTrainingFreeCallSession ||
  mongoose.model("ControlPlaneTrainingFreeCallSession", trainingFreeCallSessionSchema);
