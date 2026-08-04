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
    definitionName: { type: String, required: true, maxlength: 160 },
    selection: { type: [String], default: [] },
    emailAcceptedAt: { type: Date, required: true },
    capturedAt: { type: Date, required: true, default: Date.now },
    revision: { type: Number, required: true, default: 0 },

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
