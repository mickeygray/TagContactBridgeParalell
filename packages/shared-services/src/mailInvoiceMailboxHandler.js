"use strict";

// The mail-invoice handler for `mailboxIngestService`.
//
// The vendor emails one message a day carrying TWO PDFs: the cost invoice and
// the card receipt for it. This turns that message into one MailInvoice.
//
// ── WHY IT TAKES THE WHOLE MESSAGE ─────────────────────────────────────────
//
// The receipt states the invoice's GRAND total ($1,234.11 on 2026-07-31, the
// same money, not additional). Processed one attachment at a time, a receipt
// has no way to know it is not a cost, and filing it as one would double the
// day's mail spend on the board we just fixed. Seeing both together makes the
// relationship checkable instead of assumed.
//
// It also makes the realistic failure visible. Both files ride one email, so
// the thing that actually goes wrong is a SHORT email — one attachment instead
// of two — and that is only detectable if we record how many we saw, not just
// what we managed to parse.

const S = require("./mailInvoiceParseService");

// Mickey 2026-08-03: "we wont be getting the last email but
// WBS.accounting@wizbangsolutions.com where the subject includes todays date."
//
// Two corrections in one sentence, and the second is the important one.
//
// The SENDER is exact now rather than `from:wizbang`, which would also match
// anyone else at the domain — sales, support, a person forwarding a thread.
//
// The SELECTOR is no longer recency. "The last email from the vendor" and "the
// invoice for today" are different messages the moment they send a correction,
// a statement, or anything else; picking by recency would file the wrong PDF
// against today's spend and be invisible, because the wrong invoice parses
// just as cleanly as the right one.
const DEFAULT_QUERY =
  "from:WBS.accounting@wizbangsolutions.com has:attachment filename:pdf newer_than:3d";

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Does this subject line name this day?
 *
 * The date is NOT baked into the Gmail query, deliberately. Gmail's `subject:`
 * is token-based and we do not know the vendor's exact formatting; guessing
 * wrong there returns an EMPTY LIST, which is indistinguishable from "they
 * sent nothing" — the precise confusion this reader exists to remove. Querying
 * by sender and matching the date here instead means a format surprise shows
 * up as "3 vendor emails, none for today", which names its own cause.
 *
 * So it accepts the formats a human might type, and refuses to be clever about
 * partial ones.
 */
function subjectMatchesDate(subject, dateKey) {
  const text = String(subject || "").toLowerCase();
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) return false;
  const [y, m, d] = dateKey.split("-").map(Number);

  // Numeric forms: 7-31, 07/31, 7.31, optionally followed by a year.
  // The lookarounds are load-bearing. Without the trailing one, a subject for
  // 7-31 would satisfy a search for 7-3; without the leading one, 17-31 would
  // satisfy 7-31.
  //
  // The leading class excludes `$` and `.` as well as digits, because the dot
  // separator otherwise lets a MONEY amount read as a date: "$7.31" would
  // satisfy a search for July 31. Rare, but it would file a real invoice
  // against a day it has nothing to do with.
  const num = new RegExp(
    `(?<![\\d$.])0?${m}[-/.]0?${d}(?![\\d])`,
  );
  if (num.test(text)) return true;

  // ISO, and the year-first form some tools emit.
  if (text.includes(dateKey)) return true;
  if (new RegExp(`(?<!\\d)${y}[-/.]0?${m}[-/.]0?${d}(?!\\d)`).test(text)) return true;

  // "July 31", "Jul 31st", "31 July".
  const month = MONTHS[m - 1];
  const abbr = month.slice(0, 3);
  const namePatterns = [
    new RegExp(`\\b(${month}|${abbr})\\.?\\s+0?${d}(?!\\d)`),
    new RegExp(`(?<!\\d)0?${d}(st|nd|rd|th)?\\s+(${month}|${abbr})\\b`),
  ];
  return namePatterns.some((re) => re.test(text));
}

/**
 * The year, if the subject states one. Evidence beats the calendar.
 *
 * "Daily Mail 7-31" carries no year, so the year is inferred — and the weakest
 * inference is "the current one", which is wrong every January when a 12-31
 * invoice files as next December. A year in the subject settles it.
 */
function subjectYear(subject) {
  const hit = String(subject || "").match(/(?<!\d)(20\d{2})(?!\d)/);
  return hit ? Number(hit[1]) : null;
}

/**
 * Pick the year for a job name that has none.
 *
 * "Daily Mail 7-31" carries no year, so the first version used the CURRENT
 * year — which is right today and wrong every January, when a 12-31 invoice
 * would file as next December. Prefer evidence that actually carries one.
 */
function resolveServiceDate({ jobName, receipt, receivedAt, subject }) {
  const candidates = [
    // The subject leads: it is the only one of these the vendor typed ON
    // PURPOSE to identify the invoice. The receipt's capture date and the
    // email's own date are both circumstantial by comparison.
    { year: subjectYear(subject), source: "subject" },
    { year: receipt?.capturedAt?.getUTCFullYear?.(), source: "receipt" },
    { year: receivedAt?.getUTCFullYear?.(), source: "email" },
    { year: new Date().getUTCFullYear(), source: "assumed-current-year" },
  ];
  for (const c of candidates) {
    if (!c.year) continue;
    const date = S.serviceDateFromJobName(jobName, c.year);
    if (date) return { serviceDate: date, serviceDateSource: c.source };
  }
  return { serviceDate: null, serviceDateSource: null };
}

function createMailInvoiceHandler({
  gmailQuery = process.env.MAIL_INVOICE_GMAIL_QUERY || DEFAULT_QUERY,
  MailInvoice = null,
  // The day this run is for. When set, ONLY the email whose subject names this
  // day is ingested. Left null (the manual script) any vendor invoice is taken,
  // which is what a human running it by hand means.
  targetDate = null,
} = {}) {
  const model = () => MailInvoice || require("../../shared-models/src/MailInvoice");

  return {
    key: "mail-invoice",
    gmailQuery,

    // Accept on CONTENT, never on filename. The two PDFs are named
    // "83648 Invoice - Daily Mail 7-31.pdf" and "83648_Receipt.pdf" today, but
    // a filename is the vendor's habit rather than a contract.
    accepts(attachments = []) {
      return attachments.some((a) => S.classifyMailPdf(a.buffer) === "invoice");
    },

    async process({ attachments = [], messageId, threadId, subject, from, receivedAt, apply }) {
      // THE DAY GATE. Checked here rather than in accepts() so a vendor email
      // for the WRONG day is reported as exactly that, with the subject it
      // actually had. Rejected inside accepts() it would land in the same
      // `skipped` bucket as junk, and "the invoice for today never came"
      // would look identical to "nothing from the vendor at all".
      if (targetDate && !subjectMatchesDate(subject, targetDate)) {
        return {
          written: false,
          reason: "subject-date-mismatch",
          summary: {
            attachmentsSeen: attachments.length,
            wantedDate: targetDate,
            subject,
          },
        };
      }

      const classified = attachments.map((a) => ({ ...a, kind: S.classifyMailPdf(a.buffer) }));
      const invoiceFile = classified.find((a) => a.kind === "invoice");
      const receiptFile = classified.find((a) => a.kind === "receipt");
      const unknown = classified.filter((a) => !["invoice", "receipt"].includes(a.kind));

      const summary = {
        attachmentsSeen: attachments.length,
        invoice: Boolean(invoiceFile),
        receipt: Boolean(receiptFile),
        unknown: unknown.length,
      };

      // An email with no invoice is not an empty day — it is a SHORT email, and
      // that distinction is the whole reason this counts attachments.
      if (!invoiceFile) {
        return { written: false, reason: "no-invoice-attachment", summary };
      }

      const parsed = S.parseMailInvoice(invoiceFile.buffer);
      if (!parsed.ok) return { written: false, reason: parsed.reason || "unparseable", summary };
      const derived = S.derivePerPiece(parsed);

      let receipt = null;
      if (receiptFile) {
        const r = S.parseMailReceipt(receiptFile.buffer);
        receipt = {
          total: r.total,
          capturedAt: r.capturedAt,
          method: r.method,
          authCode: r.authCode,
          transactionId: r.transactionId,
          matchesInvoice: r.total != null && Math.abs(r.total - parsed.grandTotal) <= 0.01,
          fileSha256: receiptFile.sha256,
        };
      }

      const { serviceDate, serviceDateSource } = resolveServiceDate({
        jobName: parsed.jobName, receipt, receivedAt, subject,
      });
      if (!serviceDate) return { written: false, reason: "no-service-date", summary };

      // Everything that must be true before this may ever become spend.
      const reviewReasons = [];
      if (!parsed.reconciled || !derived.allocationBalances) reviewReasons.push("totals-disagree");
      if (!derived.allPiecesMapped) reviewReasons.push("unmapped-piece");
      if (receipt && receipt.matchesInvoice === false) reviewReasons.push("receipt-total-mismatch");
      if (!receiptFile) reviewReasons.push("no-receipt");

      const doc = {
        vendor: parsed.vendor || "wizbang",
        invoiceNumber: parsed.invoiceNumber,
        fileSha256: invoiceFile.sha256,
        jobName: parsed.jobName,
        serviceDate,
        serviceDateSource,
        postageTotal: parsed.postageTotal,
        servicesTotal: parsed.servicesTotal,
        grandTotal: parsed.grandTotal,
        cardFee: derived.cardFee,
        lineItems: derived.lineItems.map((x) => ({
          description: x.description,
          quantity: x.quantity,
          unitPrice: x.unitPrice,
          extendedPrice: x.extendedPrice,
          section: x.section,
          confident: x.confident,
          source: x.source,
        })),
        perPiece: derived.perPiece,
        reconciled: Boolean(parsed.reconciled && derived.allocationBalances),
        allPiecesMapped: derived.allPiecesMapped,
        unmapped: derived.unmapped,
        state: reviewReasons.length ? "review" : "reconciled",
        reviewReasons,
        receipt,
        // Provenance, so any stored number can be traced back to an email.
        // `attachmentCount` is deliberately kept even on success — a day that
        // arrived with one PDF and parsed fine is still worth being able to see.
        source: {
          channel: "gmail",
          messageId,
          threadId,
          subject,
          from,
          receivedAt,
          attachmentCount: attachments.length,
          attachmentNames: classified.map((a) => a.filename).slice(0, 6),
        },
        receivedAt: receivedAt || new Date(),
      };

      Object.assign(summary, {
        invoiceNumber: parsed.invoiceNumber,
        serviceDate,
        grandTotal: parsed.grandTotal,
        pieces: derived.perPiece.length,
        state: doc.state,
      });

      if (!apply) return { written: false, reason: "dry-run", doc, summary };

      // An invoice with no number CANNOT be stored. The upsert keys on
      // {vendor, invoiceNumber}, so a null number matches the previous null
      // number: every unnumbered invoice would collapse onto ONE shared
      // document, each day silently overwriting the last. Refusing is the only
      // safe move — and it is loud, because the report's check will then see
      // no invoice for the day and go red.
      if (!doc.invoiceNumber) {
        return { written: false, reason: "no-invoice-number", doc, summary };
      }

      const MailInvoiceModel = model();
      const existing = await MailInvoiceModel
        .findOne({ vendor: doc.vendor, invoiceNumber: doc.invoiceNumber }).lean();
      // A re-issued invoice reusing its number changes the day's cost. Updating
      // is right; doing it silently is not.
      const reissued = Boolean(existing && existing.fileSha256 !== doc.fileSha256);
      const saved = await MailInvoiceModel.findOneAndUpdate(
        { vendor: doc.vendor, invoiceNumber: doc.invoiceNumber },
        { $set: doc },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
      ).lean();

      return {
        written: true,
        created: !existing,
        reissued,
        summary: { ...summary, reissued },
        invoiceNumber: saved.invoiceNumber,
        serviceDate: saved.serviceDate,
      };
    },
  };
}

module.exports = {
  createMailInvoiceHandler, resolveServiceDate, subjectMatchesDate, subjectYear, DEFAULT_QUERY,
};
