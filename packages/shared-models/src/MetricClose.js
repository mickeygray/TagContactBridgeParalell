"use strict";

const mongoose = require("mongoose");

// MetricClose — the anti-drift "frozen close" layer (Stab 1 of the permanent
// architecture in docs/CALL_TOTALS_RECONCILIATION_PLAN.md).
//
// Every existing metrics store is upsert-by-key recompute, so late facts
// (attribution cleanup, status change, active-flip, late payment) silently
// rewrite closed days. A MetricClose row is an IMMUTABLE snapshot of the
// reconciliation totals as of one date — write-once per (scope, grain,
// periodKey, asOfDateKey). The live-month rows form an audit trail of the
// drift; once a month ends, its `final` row is the as-reported number, frozen
// forever. Corrections never edit a row — they become new facts downstream.
//
// scope is "all" today (the reconciliation doc is cross-tenant); it becomes a
// domain when the architecture goes per-tenant. snapshot/totals are Mixed so we
// freeze the reconciliation payload verbatim without coupling to its shape.
const metricCloseSchema = new mongoose.Schema(
  {
    scope: { type: String, default: "all", index: true },
    grain: { type: String, default: "month", index: true }, // "month" | "day"
    periodKey: { type: String, required: true, index: true }, // "2026-06"
    asOfDateKey: { type: String, required: true }, // "2026-06-16" — the data watermark
    status: { type: String, enum: ["live", "final"], default: "live", index: true },
    kind: { type: String, default: "monthly-call-honesty" },
    sourceVersion: { type: Number, default: 1 },
    range: { type: mongoose.Schema.Types.Mixed, default: null },
    // Bitemporal: recordedAt = when we froze this view; the period (effective)
    // lives in periodKey/range.
    recordedAt: { type: Date, default: null, index: true },
    // Headline numbers (quick read); the full reconciliation payload is snapshot.
    totals: { type: mongoose.Schema.Types.Mixed, default: null },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// Write-once key: one immutable snapshot per as-of date per period.
metricCloseSchema.index(
  { scope: 1, grain: 1, periodKey: 1, asOfDateKey: 1 },
  { unique: true, name: "metric_close_period_asof" },
);
metricCloseSchema.index({ scope: 1, grain: 1, periodKey: 1, status: 1 });

module.exports =
  mongoose.models.ControlPlaneMetricClose ||
  mongoose.model("ControlPlaneMetricClose", metricCloseSchema);
