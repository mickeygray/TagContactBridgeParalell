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
    // Failed-attempt counter, so a broken definition stops re-gathering every
    // poll all night. `lastRunKey` records a run that SUCCEEDED and is what
    // isDue uses to say "already went out"; these two record tries that did
    // not, and cap them at three per day. Separate keys on purpose — a failed
    // attempt must never look like a delivered report.
    lastAttemptKey: { type: String, default: null },
    attemptsToday: { type: Number, default: 0 },

    // WHERE THE NUMBERS COME FROM. null (the default) means compose live, which
    // is what every definition has always done. "record" means render from the
    // stored DailyReportFact for the day instead — the side-by-side that proves
    // the stored day can stand in for a live gather.
    //
    // DECLARED BEFORE ANY WRITER SETS IT, deliberately. This schema is strict
    // (mongoose's default; the options below are timestamps only), so an
    // updateOne setting a field the schema does not declare is dropped in
    // silence — and reports modifiedCount: 1 anyway if any other field in the
    // same $set did change. The failure that produces is worse than a crash:
    // renderSource never lands, both definitions keep composing, the two emails
    // come out identical, and a parity check reports 100% agreement for a
    // renderer that never ran once. The verification would certify the bug.
    //
    // Anything that flips this must read the value back and assert it, not
    // trust modifiedCount.
    renderSource: { type: String, enum: ["record", null], default: null },

    createdBy: { type: String, default: null },
    archivedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

reportDefinitionSchema.index({ "schedule.enabled": 1, archivedAt: 1 });

module.exports =
  mongoose.models.ControlPlaneReportDefinition ||
  mongoose.model("ControlPlaneReportDefinition", reportDefinitionSchema);
