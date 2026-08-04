"use strict";

// MailInvoice -> MailSpendDay.
//
// The step that turns a parsed invoice into money the nightly board can report.
// It is deliberately separate from the ingest: reading the mailbox and
// believing the number are different decisions, and only the second one moves
// what gets reported.
//
// ── WHAT IT REFUSES TO DERIVE ──────────────────────────────────────────────
//
// A held invoice is not a failure — it is the system declining to report a
// number it cannot stand behind. Every hold carries a reason, and the caller
// prints them, because a silent hold is indistinguishable from a day the
// vendor never billed.

const crypto = require("crypto");

const { MailInvoice, MailSpendDay } = require("../../shared-models/src");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The parser's own arithmetic tolerance. Demanding exact equality here would
// hold a day over a rounded cent that the parser already accepted.
const TIE_OUT_TOLERANCE = 0.02;

// A job name carries no year, so the year is inferred. When the inference had
// to fall back to "the current year", a date far from the email's own date is
// evidence the guess was wrong — most sharply every January, when a 12-31
// invoice would file as next December.
const ASSUMED_YEAR_MAX_DRIFT_DAYS = 45;

const UNMAPPED_SOURCE = "MAIL UNMAPPED";

const dayDrift = (dateKey, receivedAt) => {
  if (!dateKey || !receivedAt) return null;
  const a = Date.parse(`${dateKey}T00:00:00Z`);
  const b = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / 86400000;
};

/**
 * Decide whether one invoice may become spend.
 *
 * Returns null when it may, or a reason string when it may not.
 */
function holdReason(invoice) {
  if (invoice.state !== "reconciled") return `state-${invoice.state || "unknown"}`;
  if (!Array.isArray(invoice.perPiece) || !invoice.perPiece.length) return "no-per-piece";
  if (!(Number(invoice.grandTotal) > 0)) return "no-grand-total";

  // The year was guessed AND the guess lands far from the email that carried
  // it. Either alone is fine; together they are the January bug.
  if (invoice.serviceDateSource === "assumed-current-year") {
    const drift = dayDrift(invoice.serviceDate, invoice.receivedAt);
    if (drift == null || drift > ASSUMED_YEAR_MAX_DRIFT_DAYS) return "assumed-year-unsafe";
  }

  // The allocation must add back up to the bill. If it does not, the pieces
  // are not a partition of the invoice and reporting them would report a
  // different number than the vendor charged.
  const allocated = invoice.perPiece.reduce((s, p) => s + (Number(p.total) || 0), 0);
  if (Math.abs(allocated - Number(invoice.grandTotal)) > TIE_OUT_TOLERANCE) {
    return `tie-out-off-by-${round2(Math.abs(allocated - Number(invoice.grandTotal)))}`;
  }
  return null;
}

/**
 * Turn one invoice into the rows it should produce.
 *
 * `allPiecesMapped === false` does NOT hold the day. An unresolved piece
 * becomes a row under MAIL UNMAPPED carrying the remainder, so the day still
 * sums to the bill. Holding instead would show $0 mail cost against live
 * pieces, which is a worse lie than an unattributed bucket.
 */
function rowsForInvoice(invoice, runId) {
  const rows = invoice.perPiece.map((p) => ({
    domain: "TAG",
    serviceDate: invoice.serviceDate,
    channel: "mailer",
    source: p.source,
    sourceResolvedBy: "piece-map-fallback",
    spend: round2(p.total),
    postage: round2(p.postage),
    service: round2(p.service),
    feeShare: round2(p.feeShare),
    // POSTAGE lines only — the print lines bill the same physical piece again.
    pieces: Number(p.pieces) || 0,
    invoiceId: invoice._id,
    invoiceNumber: invoice.invoiceNumber,
    fileSha256: invoice.fileSha256,
    invoiceGrandTotal: round2(invoice.grandTotal),
    serviceDateSource: invoice.serviceDateSource || null,
    derivationRunId: runId,
    derivedAt: new Date(),
  }));

  const allocated = rows.reduce((s, r) => s + r.spend, 0);
  const remainder = round2(Number(invoice.grandTotal) - allocated);
  if (Math.abs(remainder) >= 0.01) {
    rows.push({
      domain: "TAG",
      serviceDate: invoice.serviceDate,
      channel: "mailer",
      source: UNMAPPED_SOURCE,
      sourceResolvedBy: "unmapped",
      spend: remainder,
      postage: 0, service: 0, feeShare: 0, pieces: 0,
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      fileSha256: invoice.fileSha256,
      invoiceGrandTotal: round2(invoice.grandTotal),
      serviceDateSource: invoice.serviceDateSource || null,
      derivationRunId: runId,
      derivedAt: new Date(),
    });
  }

  // Two perPiece entries can name the SAME source (a postage line and a print
  // line for one mailer). The unique index is on (day, source), so they must be
  // folded here rather than colliding at write time.
  const folded = new Map();
  for (const r of rows) {
    const prior = folded.get(r.source);
    if (!prior) { folded.set(r.source, r); continue; }
    prior.spend = round2(prior.spend + r.spend);
    prior.postage = round2(prior.postage + r.postage);
    prior.service = round2(prior.service + r.service);
    prior.feeShare = round2(prior.feeShare + r.feeShare);
    prior.pieces += r.pieces;
  }
  return [...folded.values()];
}

/**
 * Derive mail spend for a date range.
 *
 * Idempotent by construction: an invoice whose file hash already backs the
 * day's active rows is skipped, and a CHANGED file retires the old rows before
 * writing new ones rather than editing them in place. A corrected invoice is a
 * new event, not an amendment.
 */
async function deriveMailSpend({
  from,
  to,
  apply = false,
  runId = crypto.randomBytes(8).toString("hex"),
  logger = null,
  models = null,
} = {}) {
  const Invoice = models?.MailInvoice || MailInvoice;
  const SpendDay = models?.MailSpendDay || MailSpendDay;

  const invoices = await Invoice.find({
    serviceDate: { $gte: from, $lte: to },
    state: { $ne: "superseded" },
  }).lean();

  const out = {
    runId, apply, considered: invoices.length,
    derived: 0, skipped: 0, retired: 0, rows: [], held: [],
  };

  for (const invoice of invoices) {
    const reason = holdReason(invoice);
    if (reason) {
      out.held.push({
        invoiceNumber: invoice.invoiceNumber, serviceDate: invoice.serviceDate, reason,
      });
      continue;
    }

    const existing = await SpendDay.find({
      domain: "TAG", serviceDate: invoice.serviceDate, active: true,
    }).select({ fileSha256: 1 }).lean();

    // Already derived from this exact file. Not a hold — a no-op.
    if (existing.length && existing.every((r) => r.fileSha256 === invoice.fileSha256)) {
      out.skipped += 1;
      continue;
    }

    const rows = rowsForInvoice(invoice, runId);
    out.rows.push(...rows);

    if (!apply) { out.derived += 1; continue; }

    // Retire THEN insert. The unique partial index makes the reverse order
    // fail, which is the point: it is not possible to end up with two active
    // row sets for one day.
    if (existing.length) {
      const res = await SpendDay.updateMany(
        { domain: "TAG", serviceDate: invoice.serviceDate, active: true },
        {
          $set: {
            active: false,
            retiredAt: new Date(),
            retiredReason: `superseded-by-${invoice.invoiceNumber}`.slice(0, 200),
          },
        },
      );
      out.retired += res.modifiedCount || 0;
    }

    await SpendDay.insertMany(rows, { ordered: true });
    await Invoice.updateOne({ _id: invoice._id }, { $set: { spendDerivedAt: new Date() } });
    out.derived += 1;

    logger?.info?.("mail_spend.derived", {
      invoiceNumber: invoice.invoiceNumber,
      serviceDate: invoice.serviceDate,
      rows: rows.length,
      total: round2(rows.reduce((s, r) => s + r.spend, 0)),
    });
  }

  return out;
}

module.exports = {
  deriveMailSpend,
  holdReason,
  rowsForInvoice,
  UNMAPPED_SOURCE,
  TIE_OUT_TOLERANCE,
  ASSUMED_YEAR_MAX_DRIFT_DAYS,
};
