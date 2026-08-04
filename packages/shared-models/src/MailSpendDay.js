"use strict";

// MAIL SPEND, DERIVED FROM THE VENDOR'S INVOICE.
//
// Mickey 2026-08-03: "you need to make a collection to post the results into."
//
// One row per (serviceDate, source), as billed. This is what a MailInvoice
// becomes once it has been reconciled — the shape the nightly board can read as
// mail spend.
//
// ── WHY STORING THIS DOES NOT VIOLATE THE DOCTRINE ─────────────────────────
//
// The house rule is persist EVENTS, never STATE, and gather live from the
// authoritative service rather than keeping a parallel stats DB. A derived
// total looks exactly like the thing that rule forbids, so it is worth saying
// why it is not.
//
// There is no service to gather this from. No vendor API holds the number; the
// PDF that arrived in our mailbox is its only holder, and we are the ones who
// received it. That makes it a fact that ORIGINATES WITH US, which is the
// carve-out the report-builder guide already draws. And a finished drop day's
// billed cost cannot change afterward — if the vendor corrects it, that is a
// NEW invoice, which is a new event, handled here by retiring the old rows
// rather than editing them.
//
// So: day-atomic and as-billed. No month-to-date, no ROAS, no cost-per-lead.
// Every derived figure stays the reader's job.
//
// ── WHY IT IS NOT A SpendEntry ─────────────────────────────────────────────
//
// The obvious move is to write SpendEntry rows and let the existing report read
// them unchanged. Both available sheetIds are traps:
//
//   - under the mailer sheetId, the 19:45 sheet sync RETIRES anything it did
//     not itself write, so the derived rows would vanish nightly and the board
//     would read LOW with nothing to say why.
//   - under any other sheetId, the composer SUMS it alongside the sheet's own
//     mail row, and the day's mail cost doubles while ROAS halves.
//
// A separate collection is the only shape with a third outcome, and it is what
// lets the merge be a set-partition (see reportComposerService) rather than an
// arithmetic correction after the fact.

const mongoose = require("mongoose");

const mailSpendDaySchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, default: "TAG", trim: true, uppercase: true },
    serviceDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    // An enum of one, on purpose. The composer classifies a spend row by a
    // case-sensitive `channel === "mailer"` in one place and a case-insensitive
    // test in another, so a row typed "Mailer" would raise the day's TOTAL
    // while leaving the mail line flat — a discrepancy that reads as a data
    // error rather than a typo. Make it unwritable.
    channel: { type: String, required: true, default: "mailer", enum: ["mailer"] },

    // The canonical source name, resolved the way the sheet resolves it, so it
    // folds onto the SAME By-source row rather than appearing beside it.
    // The literal "MAIL UNMAPPED" carries the remainder when a piece did not
    // resolve — see the deriver for why that is a row and not a hold.
    source: { type: String, required: true, trim: true },
    sourceResolvedBy: {
      type: String,
      required: true,
      enum: ["tracking-number", "canonical-registry", "piece-map-fallback", "unmapped"],
    },
    sourceCanonicalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ControlPlaneSourceCanonical",
      default: null,
    },

    spend: { type: Number, required: true, min: 0 },
    postage: { type: Number, default: 0, min: 0 },
    service: { type: Number, default: 0, min: 0 },
    feeShare: { type: Number, default: 0, min: 0 },

    // POSTAGE lines only. The print lines bill the SAME physical piece a second
    // time, so counting both would double the day's piece count and halve every
    // cost-per-piece computed off it.
    pieces: { type: Number, default: 0, min: 0 },

    // Provenance: every stored dollar traces back to a specific PDF.
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "ControlPlaneMailInvoice", required: true },
    invoiceNumber: { type: String, required: true, trim: true },
    fileSha256: { type: String, required: true, trim: true },
    invoiceGrandTotal: { type: Number, required: true, min: 0 },
    serviceDateSource: { type: String, default: null },

    // Soft retire, never delete — the house style for corrected money.
    active: { type: Boolean, required: true, default: true },
    retiredAt: { type: Date, default: null },
    retiredReason: { type: String, default: null, maxlength: 200 },

    factOwner: { type: String, default: "mail-invoice-derivation" },
    derivationRunId: { type: String, required: true },
    derivedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, minimize: false },
);

// THE ANTI-DOUBLE-COUNT INVARIANT, enforced by Mongo rather than by care.
//
// One active row per (domain, serviceDate, source). A second derivation of the
// same day cannot insert alongside the first — it must retire it. Reads MUST
// match `active: true` literally rather than `{$ne: false}`, or they fall out
// of this partial index and scan.
mailSpendDaySchema.index(
  { domain: 1, serviceDate: 1, source: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: "uq_mail_spend_active_day_source" },
);
mailSpendDaySchema.index({ serviceDate: 1, active: 1 }, { name: "ix_mail_spend_range_active" });
mailSpendDaySchema.index({ invoiceNumber: 1 }, { name: "ix_mail_spend_by_invoice" });

module.exports = mongoose.models.ControlPlaneMailSpendDay
  || mongoose.model("ControlPlaneMailSpendDay", mailSpendDaySchema);
