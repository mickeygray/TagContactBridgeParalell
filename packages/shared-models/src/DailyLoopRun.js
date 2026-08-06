"use strict";

const mongoose = require("mongoose");

// Run-once guard for the end-of-day loop.
//
// The loop is SHEET-TRIGGERED (build-up work order F1.1): Mickey uploads
// both payment sheets ~18:00, and the moment the gate reports every required
// company present, the activities pull fires — instead of waiting for a
// clock that might run before the sheets land.
//
// The trigger therefore lives in an HTTP handler that can be called any
// number of times a day (re-uploads, corrections, a third company). This
// document is what makes "fire once per day" true across retries AND across
// process restarts — runtime state alone would re-fire after a redeploy.
//
// One doc per business day. Each stage stamps its own timestamp, so a
// partially-completed loop is legible rather than all-or-nothing.

const dailyLoopRunSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true, index: true },

    // Stage 1 — activities pulled because the sheet gate went ready.
    activitiesFiredAt: { type: Date, default: null },
    activitiesTriggeredBy: { type: String, default: null }, // domain whose upload flipped it
    activitiesResult: { type: mongoose.Schema.Types.Mixed, default: null },

    // Stage 0 — "you forgot to upload the payments sheet" reminder.
    // The tick arms early and polls, so this must be claimed exactly once
    // per day or Mickey gets nagged every 60 seconds until he uploads.
    sheetReminderSentAt: { type: Date, default: null },
    sheetReminderMissing: { type: [String], default: undefined },

    // Stage 2 — the non-sourceable alert (F1.2).
    alertSentAt: { type: Date, default: null },
    unsourcedCount: { type: Number, default: null },

    // Stage 3 — the summary email (F1.3). `heldForRectification` records
    // that we deliberately waited on Mickey rather than failing.
    summarySentAt: { type: Date, default: null },
    summaryReleasedBy: { type: String, default: null }, // "manual" | "deadline" | "no-unsourced"
    heldForRectification: { type: Boolean, default: false },

    // ── the night (pipeline contract, Part I stage 5) ────────────────────
    // Mongoose strict mode SILENTLY strips $set paths not in the schema —
    // an adversarial review proved the email-once guard would "succeed" for
    // every caller if these fields were missing. They are load-bearing.
    activityPassAt: { type: Date, default: null },
    counters: { type: mongoose.Schema.Types.Mixed, default: null },
    modelPassAt: { type: Date, default: null },     // stage-4 once-per-night claim
    modelPass: { type: mongoose.Schema.Types.Mixed, default: null },
    emailSentAt: { type: Date, default: null },     // claimed INSIDE the sender
    // The "night is computed" signal. Stamped in the same atomic write as
    // counters; the 21:30 close trusts the day-doc ONLY when this is set.
    // Also the lease anchor: a claim with no dayDocCompletedAt older than
    // LOOP_CLAIM_LEASE_MINUTES is expired and reclaimable — without this an
    // nssm restart mid-pass would silently lose the night.
    dayDocCompletedAt: { type: Date, default: null },

    // Named nightly-hygiene lease. Unlike the former process-memory flag,
    // this survives a control-plane restart and is claimed before any task
    // performs discovery reads.
    nightlyHygieneClaimedAt: { type: Date, default: null },
    nightlyHygieneCompletedAt: { type: Date, default: null },
    nightlyHygieneNextTaskIndex: { type: Number, default: 0, min: 0 },
    nightlyHygieneCounts: { type: mongoose.Schema.Types.Mixed, default: null },
    nightlyHygieneLastErrorCode: { type: String, default: null },

    // EVERY OTHER PASS'S CURSOR, keyed by pass name.
    //
    // The nightly hygiene cursor above is five flat fields. A second and third
    // pass on that pattern is ten more, and — because this schema is strict, as
    // the note at the top of this file says — a field somebody forgets to
    // declare is stripped from the $set in SILENCE. That failure mode has
    // already cost this repo twice. One Mixed subdocument keyed by pass name
    // lets a new pass add a cursor without a schema edit it can forget.
    //
    // Shape: passes.<passKey> = { claimedAt, completedAt, nextTaskIndex,
    // counts, lastErrorCode }. Mixed on purpose — this is a cursor, not
    // reportable data, and nothing queries inside it except its own claim.
    //
    // The nightly keeps its flat fields rather than migrating: a live cursor is
    // the wrong thing to move house while it is holding a claim.
    passes: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.ControlPlaneDailyLoopRun ||
  mongoose.model("ControlPlaneDailyLoopRun", dailyLoopRunSchema);
