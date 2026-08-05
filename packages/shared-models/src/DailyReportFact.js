"use strict";

const mongoose = require("mongoose");

// ONE COMBINE-READY DOCUMENT PER PACIFIC DAY.
//
// This is not a rendered email and it is not a second CRM. It is the additive
// fact payload the canonical nightly rollup already computed before sending.
// A week or month reads N small day documents instead of re-running N days of
// Logics, CallRail, RingCentral, and PhoneBurner work.
const dailyReportFactSchema = new mongoose.Schema(
  {
    dateKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    captureVersion: { type: Number, required: true, default: 1 },

    // Provenance names the build that produced the facts, never recipients.
    // Also relaxed: the worker creates entries that no definition produced.
    // Defaulted rather than left blank so a row always says where it came from.
    definitionName: { type: String, default: "daily entry", maxlength: 160 },
    selection: { type: [String], default: [] },
    // NO LONGER REQUIRED, as of 2026-08-04.
    //
    // This document began as "the record of a delivered email", so an accepted
    // mail timestamp was rightly mandatory. It is now THE DAY'S ENTRY, assembled
    // by a worker from several gatherers, and the entry can legitimately exist
    // before — or without — any email being sent.
    //
    // Keeping it required meant the worker could not create a day at all: a
    // fresh upsert would insert a document missing a required field. Null here
    // means "no mail accepted yet", which is a true statement about that day and
    // strictly better than refusing to record it.
    emailAcceptedAt: { type: Date, default: null },
    capturedAt: { type: Date, required: true, default: Date.now },
    revision: { type: Number, required: true, default: 0 },
    // When the daily-entry worker last assembled this day. Declared explicitly:
    // the schema is strict, so an undeclared field is dropped on write without
    // erroring, and the document would look like it saved cleanly.
    entryBuiltAt: { type: Date, default: null },

    // ── THE COMPLETE DAY ────────────────────────────────────────────────────
    //
    // Mickey 2026-08-04: "it needs to be a complete useful snapshot — needs the
    // urls, needs the case ids, because the point of all of this is if it works
    // for a day and we can record a day, it'll work for a week or a month or a
    // year once we record for that length of time."
    //
    // So this holds what `facts` deliberately strips: listen urls, case ids,
    // phones, the actionable rows. It is what makes a stored day worth opening
    // rather than merely worth counting, and it is what the email renders from.
    //
    // WHY BOTH, RATHER THAN JUST RELAXING `facts`. They are read by different
    // things for different reasons. `facts` is summed across a range — a year of
    // days aggregated for a trend — and that path should never have to carry
    // customer identifiers through it. `detail` is opened for ONE day, when
    // somebody wants the calls and cases behind a number. Keeping them apart
    // means a year-long rollup stays a rollup.
    //
    // Consequence to be deliberate about: CallRail and PhoneBurner recording
    // URLs are durable and serve unauthenticated, so a stored year of them is a
    // stored year of playable customer calls. That is a retention decision, not
    // an accident.
    detail: { type: mongoose.Schema.Types.Mixed, default: null },

    // Each member contains the BASE daily values from one rollup section. The
    // range reader must sum bases and recompute ratios; it must never average
    // daily ROI/ROAS percentages.
    facts: {
      financial: { type: mongoose.Schema.Types.Mixed, default: null },
      // The day's cost denominator by source. Declared explicitly because the
      // schema is strict — an undeclared facts.spend would be silently dropped
      // on write and the fact would look like it stored fine.
      spend: { type: mongoose.Schema.Types.Mixed, default: null },
      bySource: { type: mongoose.Schema.Types.Mixed, default: null },
      byAgent: { type: mongoose.Schema.Types.Mixed, default: null },
      statusMovement: { type: mongoose.Schema.Types.Mixed, default: null },
      // Reserved for Claude's call/dial projection. The core writer records a
      // count-only pending marker and never copies URLs, phones, or call rows.
      calls: { type: mongoose.Schema.Types.Mixed, default: null },
      // The nightly Logics activity review's own day: rows scanned, notice
      // uploads, suspended flips, DNC and post-date counts. That review has
      // always produced an accurate day and then thrown it away at the end of
      // an email. This is where it lands.
      activity: { type: mongoose.Schema.Types.Mixed, default: null },
    },

    coverage: {
      requiredSections: { type: [String], default: [] },
      capturedSections: { type: [String], default: [] },
      missingSections: { type: [String], default: [] },
      sectionErrors: { type: [String], default: [] },
      reportDegraded: { type: Boolean, default: false },
      coreComplete: { type: Boolean, default: false },
      callProjection: {
        type: String,
        enum: ["pending", "complete", "unavailable"],
        default: "pending",
      },
      complete: { type: Boolean, default: false },
    },
  },
  { timestamps: true, minimize: false },
);

dailyReportFactSchema.index(
  { dateKey: 1, captureVersion: 1 },
  { name: "ix_daily_report_fact_version" },
);

module.exports = mongoose.models.ControlPlaneDailyReportFact
  || mongoose.model("ControlPlaneDailyReportFact", dailyReportFactSchema);
