"use strict";

const mongoose = require("mongoose");

// The complete-picture money object (master plan §2.2).
//
// Keyed on the REAL Logics CasePaymentID — the CSV never had a payment id,
// which is why the old importer synthesised negative hashes and could claim
// the wrong row. Re-pulls CONVERGE onto this key: run the loop twice, get
// the same truth; run it after a correction, converge to the correction.
//
// Deleted payments VANISH from Logics history (proven, case 373763), so a
// vanished row is stamped supersededAt — restated, never hard-deleted.

const paymentTruthSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    caseId: { type: Number, required: true, index: true },
    casePaymentId: { type: Number, required: true },

    amount: { type: Number, required: true },
    // NAMED FOR THE ARBITER: simpleDealMathService reads row.paymentDateKey
    // and top-level row.paymentType. Mismatched names would silently drop
    // every row out of deal math.
    paymentDateKey: { type: String, required: true, index: true },
    paymentDate: { type: Date, default: null },
    paymentType: { type: String, default: null },        // "initial" | "recurring"
    transactionStatus: { type: String, default: null, index: true },

    detectedDateKey: { type: String, default: null },     // first pass that saw it
    keyedAt: { type: Date, default: null },               // CreatedDate
    keyedBy: { type: String, default: null },             // CreatedByUserFullName

    method: { type: mongoose.Schema.Types.Mixed, default: null },   // {id,name}
    tag: { type: mongoose.Schema.Types.Mixed, default: null },      // {id,name}
    transactionId: { type: String, default: null },
    authorizationCode: { type: String, default: null },
    merchantAccountId: { type: Number, default: null },
    accountUsed: { type: String, default: null },
    checkNumber: { type: String, default: null },
    isChargeback: { type: Boolean, default: false, index: true },

    // ── ATTRIBUTION SNAPSHOT, taken when the payment landed ──────────
    // Officer and source are stored ON the payment, not looked up at read
    // time. A case reassigned in October must not silently rewrite who
    // closed it in July, and a source corrected later must not restate a
    // month that has already been reported. These are history, not state.
    clientName: { type: String, default: null },
    officerAtSale: { type: String, default: null, index: true },
    sourceAtSale: { type: String, default: null, index: true },
    sourceVia: { type: String, default: null },   // how the source was resolved

    // The decision WITH its reasoning — never a bare enum.
    metricsTreatment: { type: mongoose.Schema.Types.Mixed, default: null },
    // AS-OF SNAPSHOT, NOT CURRENT STATE. What Logics said about this case's
    // balances at the moment we recorded the payment — kept for audit ("why
    // did we book it that way?"), never for reporting a live balance. Case
    // totals and status change underneath us; anything that needs them now
    // must re-pull. Storing them as truth is how stale data enters a system.
    billingContext: { type: mongoose.Schema.Types.Mixed, default: null },
    verification: { type: mongoose.Schema.Types.Mixed, default: null },
    // Commission notes are PRESERVED (free, inside the loop) even though
    // payout math is deferred — Mickey 2026-07-27.
    commission: { type: mongoose.Schema.Types.Mixed, default: null },

    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    supersededAt: { type: Date, default: null, index: true },
    supersededReason: { type: String, default: null },
    needsReview: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

paymentTruthSchema.index({ domain: 1, casePaymentId: 1 }, { unique: true });
paymentTruthSchema.index({ domain: 1, caseId: 1, paymentDateKey: -1 });

module.exports =
  mongoose.models.ControlPlanePaymentTruth ||
  mongoose.model("ControlPlanePaymentTruth", paymentTruthSchema);
