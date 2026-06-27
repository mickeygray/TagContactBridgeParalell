"use strict";

const mongoose = require("mongoose");

// M11 gate 2 — the DURABLE terminal-outcome outbox for the bulk rail.
//
// The live loop inserts one row per released call (keyed by the same idemKey the in-memory
// dedup uses: `queueItemId:uii`, or the no-UII fallback). The row is written BEFORE the
// cadence/Logics write, so a process that dies mid-write still has a durable record the drain
// can replay — that is the difference between "a lead was called" and "a lead was counted".
// Unique idemKey makes the count idempotent across process restarts (an in-memory Set cannot).
const cxTerminalOutboxSchema = new mongoose.Schema(
  {
    idemKey: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["pending", "drained", "failed"], default: "pending", index: true },
    sessionId: { type: String, default: null, index: true },
    rail: { type: String, default: "bulk_load" },
    domain: { type: String, default: null, index: true },
    queueItemId: { type: String, default: null, index: true },
    uii: { type: String, default: null },
    caseId: { type: Number, default: null },
    agentEmail: { type: String, default: null },
    agentName: { type: String, default: null },
    externId: { type: String, default: null },
    phone: { type: String, default: null },
    phoneLast4: { type: String, default: null },
    durationSec: { type: Number, default: null },
    coachSessionId: { type: String, default: null, index: true },
    outcome: { type: String, default: null },
    source: { type: String, default: null },
    // The full cadence event the drain replays into handleCxTerminalCallOutcome.
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    drainedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Drain reads oldest-pending first.
cxTerminalOutboxSchema.index({ status: 1, createdAt: 1 });

module.exports =
  mongoose.models.ControlPlaneCxTerminalOutbox ||
  mongoose.model("ControlPlaneCxTerminalOutbox", cxTerminalOutboxSchema);
