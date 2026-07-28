"use strict";

const mongoose = require("mongoose");

// One typed row per Logics activity the nightly pass has ever read.
// (Pipeline contract Part I stage 1; master plan §2.1.)
//
// The report feed windows on LastModifiedDate, so the same activity
// resurfaces whenever anyone edits it — `dedupeKey` (built from the
// IMMUTABLE Created timestamp, never LastModified) is what makes re-pulls
// and reruns free: duplicate inserts no-op, and counters derive from
// first-seen insert outcomes rather than raw rows.
//
// A payment-claim event is a TIP-OFF, never money: the money loop pulls
// Billing per case and writes PaymentTruth; nothing here is cash.

const activityEventSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, default: null, index: true },
    dateKey: { type: String, required: true, index: true }, // report day (detection day)

    kind: {
      type: String,
      required: true,
      enum: [
        "payment-claim",   // Payment/CaseAccount/LOAN lanes — triggers the money loop
        "status-change",
        "assignment",
        "conversion",
        "liability-change",
        "source-update",
        "credit-score",
        "doc-upload",
        "doc-sent",
        "conversation",
        "task",
        "note",            // General free text — the model residue
        "intake",          // system lane: Case received from X
        "system-echo",     // our own API writes reflected back / RuleEngine
        "unclassified",
      ],
      index: true,
    },

    subject: { type: String, default: null },   // raw, clipped to 300
    createdAt: { type: Date, default: null },   // parsed Created (Pacific)
    createdBy: { type: String, default: null },

    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    source: { type: String, enum: ["grammar", "model"], default: "grammar" },
    modelConfidence: { type: Number, default: null },

    dedupeKey: { type: String, required: true, unique: true },
    needsReview: { type: Boolean, default: false },
  },
  { timestamps: true },
);

activityEventSchema.index({ domain: 1, caseId: 1, dateKey: 1 });
activityEventSchema.index({ kind: 1, dateKey: 1 });

module.exports =
  mongoose.models.ControlPlaneActivityEvent ||
  mongoose.model("ControlPlaneActivityEvent", activityEventSchema);
