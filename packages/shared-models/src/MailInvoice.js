"use strict";

// MailInvoice — one day's mail cost, as the vendor billed it.
//
// Mickey 2026-07-31: "they have been a little lazy with the g-sheet recently
// but they send me this every day."
//
// This replaces the hand-maintained spend sheet as the SOURCE for mail cost.
// The sheet was a person retyping these numbers; this is the invoice itself,
// so the failure mode changes from "somebody forgot" to "the vendor did not
// send", which is a thing we can detect and alert on.
//
// STORED AS BILLED, NOT AS INTERPRETED. Totals come straight off the document
// and are never recomputed from the parts — if the parts disagree with the
// stated total, `reconciled` goes false and the per-piece breakdown is held
// back rather than silently used. A wrong per-piece cost lands on the By
// source table as a wrong ROAS, and a wrong ROAS is a decision about what to
// buy more of.

const mongoose = require("mongoose");

// The vendor names a piece by its tracking-number fragment; our registry names
// it by the mail piece. Keyed on the FRAGMENT because that is provable — 9263
// is the pink piece's CallRail number 800-921-9263 — where a name-similarity
// match would be a guess.
const PIECE_MAP = Object.freeze([
  { fragment: "9263", source: "3rd Day (Pink) Urgent Third State" },
  { fragment: "6356", source: "Urgent Third State" },
  { fragment: "8323", source: "Affordability Federal" },
]);

function nullableTrimmed(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

const lineItemSchema = new mongoose.Schema({
  description: { type: String, required: true, set: nullableTrimmed, maxlength: 200 },
  quantity: { type: Number, default: null, min: 0 },
  unitPrice: { type: Number, default: null, min: 0 },
  extendedPrice: { type: Number, required: true, min: 0 },
  // "postage" | "service" | "fee" — the invoice bills the same physical piece
  // twice (postage and print), so summing quantities across sections would
  // double the mail count.
  section: { type: String, enum: ["postage", "service", "fee"], required: true },
  // Whether the qty/unit split could be PROVEN against the extended price.
  // The extension is always trustworthy; the split is not.
  confident: { type: Boolean, default: false },
  // Resolved canonical source, or null when the fragment matched nothing.
  source: { type: String, default: null, set: nullableTrimmed },
}, { _id: false });

const perPieceSchema = new mongoose.Schema({
  source: { type: String, required: true },
  pieces: { type: Number, required: true, min: 0 },
  postage: { type: Number, required: true, min: 0 },
  service: { type: Number, required: true, min: 0 },
  // The card fee, allocated across pieces in proportion to POSTAGE — the
  // invoice states the fee applies to postage paid by card, so that is the
  // base it is spread over.
  feeShare: { type: Number, required: true, min: 0 },
  total: { type: Number, required: true, min: 0 },
  costPerPiece: { type: Number, required: true, min: 0 },
}, { _id: false });

const mailInvoiceSchema = new mongoose.Schema(
  {
    vendor: { type: String, required: true, default: "wizbang", trim: true },
    // The vendor's own number, and the idempotency key. Re-dropping the same
    // file is a no-op; a CHANGED file reusing a number trips the hash below,
    // which is the case worth knowing about rather than overwriting.
    invoiceNumber: { type: String, required: true, trim: true },
    fileSha256: { type: String, required: true, trim: true },

    jobName: { type: String, default: null, set: nullableTrimmed, maxlength: 120 },
    // The day the mail actually dropped, parsed from the job name. This is the
    // date spend belongs to — NOT the day the PDF happened to be uploaded.
    serviceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/, index: true },

    // Straight off the document.
    postageTotal: { type: Number, required: true, min: 0 },
    servicesTotal: { type: Number, required: true, min: 0 },
    grandTotal: { type: Number, required: true, min: 0 },
    cardFee: { type: Number, default: 0, min: 0 },

    lineItems: { type: [lineItemSchema], default: [] },
    perPiece: { type: [perPieceSchema], default: [] },

    // WHERE THE YEAR CAME FROM. "Daily Mail 7-31" carries no year, so the
    // first version used the current one — right today, wrong every January,
    // when a 12-31 invoice would file as next December. The receipt carries a
    // real year (31-Jul-2026) and the email carries another; this records
    // which was believed, so a suspect date can be traced rather than guessed
    // at after the fact.
    serviceDateSource: {
      type: String,
      enum: ["window", "subject", "receipt", "email", "assumed-current-year", null],
      default: null,
    },

    // Every gate that has to pass before this may become spend.
    reconciled: { type: Boolean, required: true, default: false },
    allPiecesMapped: { type: Boolean, required: true, default: false },
    unmapped: { type: [String], default: [] },
    state: {
      type: String,
      enum: ["parsed", "reconciled", "review", "superseded"],
      required: true,
      default: "parsed",
      index: true,
    },
    reviewReasons: { type: [String], default: [] },

    // How it arrived. Provenance, so any stored number traces back to an email.
    //
    // `attachmentCount` describes the files assigned to this invoice group.
    // A single email may contain several service days, so recording the grouped
    // names/count preserves which receipt was paired with which invoice without
    // incorrectly attaching the entire email to every stored day.
    source: {
      type: new mongoose.Schema({
        channel: { type: String, default: "gmail", trim: true },
        messageId: { type: String, default: null, trim: true, index: true },
        threadId: { type: String, default: null, trim: true },
        subject: { type: String, default: null, set: nullableTrimmed, maxlength: 300 },
        from: { type: String, default: null, set: nullableTrimmed, maxlength: 200 },
        receivedAt: { type: Date, default: null },
        attachmentCount: { type: Number, default: null, min: 0 },
        attachmentNames: { type: [String], default: [] },
      }, { _id: false }),
      default: null,
    },

    // The card receipt, when one arrived. NEVER a cost — it is the same money
    // as `grandTotal`, and treating it as a second charge would double the
    // day's mail spend. It is kept as proof of capture and as a cross-check.
    receipt: {
      type: new mongoose.Schema({
        total: { type: Number, default: null },
        capturedAt: { type: Date, default: null },
        method: { type: String, default: null, set: nullableTrimmed, maxlength: 60 },
        authCode: { type: String, default: null, set: nullableTrimmed, maxlength: 40 },
        transactionId: { type: String, default: null, set: nullableTrimmed, maxlength: 60 },
        matchesInvoice: { type: Boolean, default: null },
        fileSha256: { type: String, default: null, trim: true },
      }, { _id: false }),
      default: null,
    },

    // Set once spend has been derived, so it cannot be derived twice.
    spendDerivedAt: { type: Date, default: null },
    receivedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, minimize: false },
);

mailInvoiceSchema.index({ vendor: 1, invoiceNumber: 1 }, { unique: true });
mailInvoiceSchema.index({ serviceDate: 1, vendor: 1 });
mailInvoiceSchema.index({ reconciled: 1, spendDerivedAt: 1 });

module.exports =
  mongoose.models.ControlPlaneMailInvoice ||
  mongoose.model("ControlPlaneMailInvoice", mailInvoiceSchema);

module.exports.PIECE_MAP = PIECE_MAP;
