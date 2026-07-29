"use strict";

const mongoose = require("mongoose");

// Receipt for one daily Logics PaymentsReport CSV import.
//
// Why this exists (2026-07-24): the hourly API reconcile is NOT a complete
// record of revenue. Measured against Mickey's own export for TAG July, the
// ledger held $279,500.86 against Logics' $412,579.15 — 34.6% short, and
// ALL of it recurring. 29 legacy payment-plan clients had never been seen at
// all (no CaseProfile either), and 26 more had gone stale, some since
// 2025-01-21. New-business initials reconciled exactly; it is the back book
// the API loses.
//
// So the CSV is not a nice-to-have correction, it is the authority for the
// month. This receipt records that the authority arrived, which lets the
// nightly close refuse to publish money numbers built on the API alone.

const paymentsSheetImportSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    // Business day this import is meant to close out.
    dateKey: { type: String, required: true, index: true },
    // Latest paidDate present in the file. A sheet only closes a day if it
    // actually reaches that day — an export taken before the last payment
    // of the evening does not.
    coversThrough: { type: String, default: null },
    coversFrom: { type: String, default: null },
    fileName: { type: String, default: null },
    // sha256 of the raw bytes: re-uploading the same export is recognised
    // rather than counted twice.
    fileHash: { type: String, default: null, index: true },
    rowsParsed: { type: Number, default: 0 },
    rowsInserted: { type: Number, default: 0 },
    rowsUpdated: { type: Number, default: 0 },
    rowsAlreadyCorrect: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    dryRun: { type: Boolean, default: false },
    importedBy: { type: String, default: null },
    importedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

// One authoritative receipt per domain per business day. Re-importing the
// same day overwrites it, so a corrected re-upload wins.
paymentsSheetImportSchema.index({ domain: 1, dateKey: 1 }, { unique: true });

module.exports =
  mongoose.models.ControlPlanePaymentsSheetImport ||
  mongoose.model("ControlPlanePaymentsSheetImport", paymentsSheetImportSchema);
