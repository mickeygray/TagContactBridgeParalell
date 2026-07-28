"use strict";

const mongoose = require("mongoose");

// A SAVED REPORT SHAPE — not a saved report.
//
// Mickey 2026-07-28: "mostly this is a report scheduler on the common things.
// so if i want to run something and email it tonight i can set that up without
// talkign to a model."
//
// This is the one thing in the report builder worth persisting: the SHAPE of a
// question (which blocks, which filters, which rolling window, who gets it).
// It is storage class (b) — a fact that originates with us and exists nowhere
// else. The ANSWER is never stored: every run re-gathers from the authoritative
// services, because a stored answer goes stale the moment a status changes and
// we are "a face plate and a tool", not an aggregator of stats.
//
// The only run STATE kept here is what is needed to avoid sending twice
// (lastRunKey) and to show the operator what happened last (lastError).

const reportDefinitionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: null },

    // ── the shape ──
    blocks: { type: [String], default: [] },        // block ids or preset names
    filters: { type: [String], default: [] },       // "cohort=2024", "minutes>10"
    domain: { type: String, default: null },        // TAG | WYNN | AMITY | null = all

    // Rolling, never absolute: a saved report means "yesterday" every night,
    // not "2026-07-27" forever.
    range: {
      type: String,
      default: "yesterday",
      enum: ["today", "yesterday", "last7", "last30", "mtd", "lastmonth", "ytd"],
    },

    // ── delivery ──
    recipients: { type: [String], default: [] },
    attachCsv: { type: Boolean, default: false },
    sendEmail: { type: Boolean, default: true },

    // ── schedule (Pacific, matching every other loop on this box) ──
    schedule: {
      enabled: { type: Boolean, default: false },
      hour: { type: Number, default: 7, min: 0, max: 23 },
      minute: { type: Number, default: 0, min: 0, max: 59 },
      // 0=Sun … 6=Sat. Empty means every day.
      daysOfWeek: { type: [Number], default: [] },
      // 1–31, or 0 for "last day of month". Empty means every day.
      daysOfMonth: { type: [Number], default: [] },
    },

    // ── run bookkeeping (state, deliberately minimal) ──
    // The date key of the last COMPLETED run. A restart mid-morning must not
    // re-send a report that already went out, so the runtime compares this
    // rather than trusting an in-memory flag.
    lastRunKey: { type: String, default: null },
    lastRunAt: { type: Date, default: null },
    lastDurationMs: { type: Number, default: null },
    lastError: { type: String, default: null },
    runCount: { type: Number, default: 0 },

    createdBy: { type: String, default: null },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

reportDefinitionSchema.index({ "schedule.enabled": 1, archivedAt: 1 });

module.exports =
  mongoose.models.ControlPlaneReportDefinition ||
  mongoose.model("ControlPlaneReportDefinition", reportDefinitionSchema);
