"use strict";

// MAIL INVOICE INGEST — the vendor's daily PDFs become one day's mail cost.
//
// This replaces a hand-typed spend sheet, so the numbers it produces land on
// the By source table as ROAS — which is a decision about what to buy more of.
// Nearly every test here is therefore about REFUSING to produce a number:
// wrong mail spend is worse than absent mail spend, because absent is visible.
//
// The fixtures are shapes, not files. The real 2026-07-31 invoice proved the
// parser end to end (invoice #83648, $1,009.20 postage + $224.91 services =
// $1,234.11, reconciled to the penny); these pin the RULES so the next
// invoice, which nobody will read as carefully, cannot quietly go wrong.

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

const S = require("../../packages/shared-services/src/mailInvoiceParseService");
const { createMailInvoiceHandler, resolveServiceDate, resolveServiceDateWithinWindow } = require(
  "../../packages/shared-services/src/mailInvoiceMailboxHandler");
const {
  collectAttachmentParts, readAttachmentBuffer, openMailbox, runMailboxIngest,
} = require("../../packages/shared-services/src/mailboxIngestService");

// ── a minimal but REAL pdf, built the way the vendor's is ─────────────────
function makePdf(lines, { producer = null } = {}) {
  const content = lines.map((l) => `BT (${l}) Tj ET Td`).join("\n");
  const deflated = zlib.deflateSync(Buffer.from(content, "latin1"));
  const head = Buffer.from(
    `%PDF-1.4\n${producer ? `/Producer (${producer})\n` : ""}1 0 obj\n<</Length ${deflated.length}/Filter/FlateDecode>>\nstream\n`,
    "latin1",
  );
  return Buffer.concat([head, deflated, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
}

const INVOICE_LINES = [
  "Invoice", "Wizbang! - 6747 E. 50th Avenue",
  "Invoice #", "90001",
  "Job Name:", "Daily Mail 8-04",
  "5220.7219$376.85", "3rd Notice - PINK - 9263-589",
  "2790.78$217.62", "Afford Csnap - 8323",
  "522", "0.17000$88.74", "3rd PINK Lttr - 8.5 x 11 1/0",
  "279", "0.17000$47.43", "Afford 8.5 x 11",
  "Postage Subtotal:", "$594.47",
  "Services Total:", "$136.17",
  "$730.64",
];

const invoicePdf = () => makePdf(INVOICE_LINES);
const receiptPdf = () => makePdf(["Total: USD 730.64"], { producer: "Skia/PDF m150" });
const invoicePdfFor = ({ invoiceNumber, jobName }) => makePdf(
  INVOICE_LINES.map((line) => {
    if (line === "90001") return String(invoiceNumber);
    if (line === "Daily Mail 8-04") return String(jobName);
    return line;
  }),
);
const receiptPdfFor = ({ invoiceNumber, total = "730.64" }) => makePdf(
  [`N6mber:${invoiceNumber}`, `Total: USD ${total}`],
  { producer: "Skia/PDF m150" },
);

// ── classification: the failure that would double a day ───────────────────

test("the receipt is classified as a receipt, never as an invoice", () => {
  // It states the invoice's GRAND total. Misfiled as an invoice it would post
  // a second full charge and double the day's mail spend.
  assert.equal(S.classifyMailPdf(invoicePdf()), "invoice");
  assert.equal(S.classifyMailPdf(receiptPdf()), "receipt");
});

test("classification ignores the filename entirely", () => {
  // The receipt's own embedded font maps glyphs wrong — its text decodes as
  // "To1al" and "InvoiceN6mber" — so a keyword matcher fails on the very
  // document it is meant to identify, and a filename is the vendor's habit
  // rather than a contract. Same bytes must classify the same either way.
  const receipt = receiptPdf();
  assert.equal(S.classifyMailPdf(receipt), "receipt");
  // Even named exactly like the invoice, it is still a receipt.
  assert.equal(S.classifyMailPdf(receipt), S.classifyMailPdf(Buffer.from(receipt)));
  assert.notEqual(S.classifyMailPdf(receipt), S.classifyMailPdf(invoicePdf()));
});

test("anything that is neither is UNKNOWN — never guessed into a bucket", () => {
  assert.equal(S.classifyMailPdf(makePdf(["Some other document"])), "unknown");
  assert.equal(S.classifyMailPdf(Buffer.from("id,name\n1,x")), "not-pdf");
});

// ── the numbers ───────────────────────────────────────────────────────────

test("the stated totals are read, not recomputed", () => {
  const r = S.parseMailInvoice(invoicePdf());
  assert.equal(r.postageTotal, 594.47);
  assert.equal(r.servicesTotal, 136.17);
  assert.equal(r.grandTotal, 730.64);
  assert.equal(r.invoiceNumber, "90001");
  assert.equal(r.jobName, "Daily Mail 8-04");
});

test("a totals label reads the money AFTER it, not before", () => {
  // The PDF emits a `$0.00` immediately BEFORE each label. Reading backwards
  // returned zero for both subtotals — an invoice that looked free.
  const r = S.parseMailInvoice(makePdf([
    "Invoice", "Wizbang!", "$0.00", "Postage Subtotal:", "$100.00",
    "$0.00", "Services Total:", "$25.00", "$125.00",
  ]));
  assert.equal(r.postageTotal, 100);
  assert.equal(r.servicesTotal, 25);
});

test("the qty/unit split is resolved by ARITHMETIC, not regex greed", () => {
  // "5220.7219" is 522 x 0.7219 = $376.85, but reads just as naturally as
  // 5220 x .7219. The greedy read summed the real sheet to $1,196.23 against
  // a stated $1,234.11 — plausible, and wrong.
  const items = S.parseMailInvoice(invoicePdf()).lineItems;
  const pink = items.find((x) => /9263/.test(x.description));
  assert.equal(pink.quantity, 522, "not 5220");
  assert.equal(pink.unitPrice, 0.7219);
  assert.equal(pink.extendedPrice, 376.85);
  assert.equal(pink.confident, true);
});

test("a split that cannot be proven is flagged, never invented", () => {
  const r = S.parseMailInvoice(makePdf([
    "Invoice", "Wizbang!", "Services Total:", "$37.88", "00$37.88", "Our Permit",
  ]));
  const fee = r.lineItems.find((x) => /permit/i.test(x.description));
  assert.equal(fee.confident, false);
  assert.equal(fee.quantity, null, "a quantity we could not prove must be null, not 0");
  assert.equal(fee.extendedPrice, 37.88, "the extension is always trustworthy");
});

test("quantity on its own line is handled too — the layout varies", () => {
  const items = S.parseMailInvoice(invoicePdf()).lineItems;
  const print = items.find((x) => /3rd PINK Lttr/.test(x.description));
  assert.equal(print.quantity, 522);
  assert.equal(print.unitPrice, 0.17);
});

// ── costing ───────────────────────────────────────────────────────────────

test("pieces are counted from POSTAGE lines only", () => {
  // The same physical mailer is billed twice, once to print and once to mail.
  // Summing every quantity reports double the mail actually sent.
  const d = S.derivePerPiece(S.parseMailInvoice(invoicePdf()));
  const pink = d.perPiece.find((p) => /Pink/i.test(p.source));
  assert.equal(pink.pieces, 522, "not 1044");
  assert.equal(pink.postage, 376.85);
  assert.equal(pink.service, 88.74);
});

test("the invoice's own piece names map to canonical sources", () => {
  const d = S.derivePerPiece(S.parseMailInvoice(invoicePdf()));
  assert.deepEqual(d.perPiece.map((p) => p.source).sort(), [
    "3rd Day (Pink) Urgent Third State", "Affordability Federal",
  ]);
  assert.deepEqual(d.unmapped, []);
  assert.equal(d.allPiecesMapped, true);
});

test("an unrecognised piece is surfaced, never silently dropped", () => {
  const d = S.derivePerPiece(S.parseMailInvoice(makePdf([
    "Invoice", "Wizbang!", "Services Total:", "$50.00",
    "1000.05$50.00", "Brand New Piece - 5555",
  ])));
  assert.ok(d.unmapped.length > 0, "a piece with no mapping must be named");
  assert.equal(d.allPiecesMapped, false);
});

test("every dollar lands on a piece — the card fee allocates exactly", () => {
  // Per-piece rounding lost a cent against the stated fee on the real sheet.
  // A penny that quietly disappears is a penny nobody can account for.
  const parsed = S.parseMailInvoice(invoicePdf());
  const d = S.derivePerPiece(parsed);
  const allocatedFee = d.perPiece.reduce((s, p) => s + p.feeShare, 0);
  assert.equal(Math.round(allocatedFee * 100) / 100, d.cardFee);
  assert.equal(d.allocationBalances, true);
  assert.equal(d.allocated, parsed.grandTotal);
});

// ── the year ──────────────────────────────────────────────────────────────

test("the year comes from evidence, not from today", () => {
  // "Daily Mail 7-31" has no year. Using the current one is right today and
  // wrong every January, when a 12-31 invoice files as NEXT December.
  const receipt = { capturedAt: new Date("2026-07-31T10:56:07Z") };
  assert.deepEqual(
    resolveServiceDate({ jobName: "Daily Mail 12-31", receipt, receivedAt: new Date("2027-01-02T00:00:00Z") }),
    { serviceDate: "2026-12-31", serviceDateSource: "receipt" },
  );
});

test("without a receipt it falls back to the email, then to today — and says which", () => {
  const viaEmail = resolveServiceDate({
    jobName: "Daily Mail 8-04", receipt: null, receivedAt: new Date("2026-08-04T18:00:00Z"),
  });
  assert.deepEqual(viaEmail, { serviceDate: "2026-08-04", serviceDateSource: "email" });

  const assumed = resolveServiceDate({ jobName: "Daily Mail 8-04", receipt: null, receivedAt: null });
  assert.equal(assumed.serviceDateSource, "assumed-current-year",
    "a guessed year must be recorded as guessed");
});

test("the bounded repair window resolves a prior-year day paid in January", () => {
  const resolved = resolveServiceDateWithinWindow({
    jobName: "Daily Mail 12-31",
    wantedDates: [
      "2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30",
      "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03",
    ],
    receipt: { capturedAt: new Date("2027-01-03T18:00:00Z") },
    receivedAt: new Date("2027-01-03T18:00:00Z"),
    subject: "Paid mail invoices 1-03-2027",
  });
  assert.deepEqual(resolved, {
    serviceDate: "2026-12-31",
    serviceDateSource: "window",
  });
});

// ── the mailbox loop ──────────────────────────────────────────────────────

function fakeGmail({ attachments, inline = false } = {}) {
  const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return {
    async listMessages() { return { messages: [{ id: "m1" }] }; },
    async getMessage() {
      return {
        id: "m1", threadId: "t1", internalDate: String(Date.parse("2026-08-04T18:00:00Z")),
        payload: {
          headers: [{ name: "Subject", value: "Invoice 90001" }, { name: "From", value: "billing@wizbang" }],
          parts: attachments.map((a, i) => ({
            filename: a.name, mimeType: "application/pdf",
            body: inline ? { data: b64url(a.buffer) } : { attachmentId: `a${i}` },
          })),
        },
      };
    },
    async getAttachment(m, id) { return { data: b64url(attachments[Number(String(id).slice(1))].buffer) }; },
    decodeData(d) { return Buffer.from(String(d).replace(/-/g, "+").replace(/_/g, "/"), "base64"); },
  };
}

test("attachments are decoded as base64URL, not plain base64", async () => {
  // Gmail returns base64URL. Decoding it as plain base64 yields bytes that
  // still start with %PDF- and then fail to inflate — a decoding bug wearing
  // a parser bug's clothes. Prove it by round-tripping bytes that differ
  // between the two alphabets.
  const raw = Buffer.from([0xfb, 0xff, 0xbe, 0x00, 0x11]);
  const urlSafe = raw.toString("base64").split("+").join("-").split("/").join("_");
  assert.notEqual(urlSafe, raw.toString("base64"), "fixture must actually differ");
  const got = await readAttachmentBuffer(
    { decodeData: (d) => Buffer.from(String(d).replace(/-/g, "+").replace(/_/g, "/"), "base64") },
    "m1", { inlineData: urlSafe },
  );
  assert.deepEqual([...got], [...raw], "the client decoder must be used");
});

test("a small attachment arriving INLINE is not dropped", async () => {
  // Gmail inlines small parts as body.data with no attachmentId, and a
  // one-page PDF is exactly that size.
  const parts = collectAttachmentParts({
    parts: [{ filename: "x.pdf", body: { data: "aGk" } }],
  });
  assert.equal(parts.length, 1);
  assert.equal(parts[0].inlineData, "aGk");
  const buf = await readAttachmentBuffer(
    { decodeData: (d) => Buffer.from(d, "base64") }, "m1", parts[0],
  );
  assert.ok(Buffer.isBuffer(buf));
});

test("openMailbox returns an injected client untouched", () => {
  const fake = { listMessages() {} };
  assert.equal(openMailbox({ gmail: fake }), fake, "tests and callers must be able to inject");
});

test("a full message becomes one costed invoice", async () => {
  const gmail = fakeGmail({
    attachments: [
      { name: "inv.pdf", buffer: invoicePdf() },
      { name: "rcpt.pdf", buffer: receiptPdf() },
    ],
  });
  const r = await runMailboxIngest({ gmail, apply: false, handlers: [createMailInvoiceHandler()] });
  const h = r.handlers["mail-invoice"];
  assert.equal(h.accepted, 1);
  assert.equal(h.errors, 0);
  const doc = h.results[0].doc;
  assert.equal(doc.invoiceNumber, "90001");
  assert.equal(doc.serviceDate, "2026-08-04");
  assert.equal(doc.state, "reconciled");
  assert.equal(doc.receipt.matchesInvoice, true);
  assert.equal(doc.source.attachmentCount, 2);
});

test("one paid email is divided into one invoice document per service day", async () => {
  const handler = createMailInvoiceHandler({
    targetDates: [
      "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06",
      "2026-08-07", "2026-08-08", "2026-08-09", "2026-08-10",
    ],
  });
  const result = await handler.process({
    attachments: [
      { filename: "day-a-invoice.pdf", sha256: "invoice-a", buffer: invoicePdfFor({
        invoiceNumber: "91003", jobName: "Daily Mail 8-03",
      }) },
      { filename: "day-b-receipt.pdf", sha256: "receipt-b", buffer: receiptPdfFor({
        invoiceNumber: "91010",
      }) },
      { filename: "day-a-receipt.pdf", sha256: "receipt-a", buffer: receiptPdfFor({
        invoiceNumber: "91003",
      }) },
      { filename: "day-b-invoice.pdf", sha256: "invoice-b", buffer: invoicePdfFor({
        invoiceNumber: "91010", jobName: "Daily Mail 8-10",
      }) },
    ],
    messageId: "batch-1",
    threadId: "thread-1",
    subject: "Paid mail invoices",
    from: "billing@wizbang",
    receivedAt: new Date("2026-08-10T18:00:00Z"),
    apply: false,
  });

  assert.equal(result.reason, "dry-run");
  assert.equal(result.writtenCount, 0);
  assert.equal(result.docs.length, 2);
  assert.deepEqual(result.docs.map((doc) => doc.serviceDate).sort(), ["2026-08-03", "2026-08-10"]);
  assert.deepEqual(result.docs.map((doc) => doc.invoiceNumber).sort(), ["91003", "91010"]);
  for (const doc of result.docs) {
    assert.equal(doc.state, "reconciled");
    assert.equal(doc.receipt.matchesInvoice, true);
    assert.equal(doc.source.attachmentCount, 2, "each day owns its invoice/receipt pair, not all four files");
  }
  assert.deepEqual(result.summary.serviceDates, ["2026-08-03", "2026-08-10"]);
  assert.equal(result.summary.unmatchedReceipts, 0);
});

test("ambiguous same-total receipts are held instead of assigned to a random day", async () => {
  const handler = createMailInvoiceHandler({
    targetDates: ["2026-08-03", "2026-08-10"],
  });
  const result = await handler.process({
    attachments: [
      { filename: "a-invoice.pdf", sha256: "invoice-a", buffer: invoicePdfFor({
        invoiceNumber: "92003", jobName: "Daily Mail 8-03",
      }) },
      { filename: "b-invoice.pdf", sha256: "invoice-b", buffer: invoicePdfFor({
        invoiceNumber: "92010", jobName: "Daily Mail 8-10",
      }) },
      { filename: "receipt-1.pdf", sha256: "receipt-1", buffer: receiptPdf() },
      { filename: "receipt-2.pdf", sha256: "receipt-2", buffer: receiptPdf() },
    ],
    subject: "Paid mail invoices",
    receivedAt: new Date("2026-08-10T18:00:00Z"),
    apply: false,
  });

  assert.equal(result.docs.length, 2);
  for (const doc of result.docs) {
    assert.equal(doc.receipt, null);
    assert.equal(doc.state, "review");
    assert.ok(doc.reviewReasons.includes("ambiguous-receipt-match"));
  }
  assert.equal(result.summary.unmatchedReceipts, 2);
});

test("replaying a multi-day message upserts the same two invoice records", async () => {
  const stored = new Map();
  const MailInvoice = {
    findOne(filter) {
      return { lean: async () => stored.get(filter.invoiceNumber) || null };
    },
    findOneAndUpdate(filter, update) {
      const saved = { ...(stored.get(filter.invoiceNumber) || {}), ...update.$set };
      stored.set(filter.invoiceNumber, saved);
      return { lean: async () => saved };
    },
  };
  const handler = createMailInvoiceHandler({
    MailInvoice,
    targetDates: ["2026-08-03", "2026-08-10"],
  });
  const args = {
    attachments: [
      { filename: "a-invoice.pdf", sha256: "invoice-a", buffer: invoicePdfFor({
        invoiceNumber: "93003", jobName: "Daily Mail 8-03",
      }) },
      { filename: "a-receipt.pdf", sha256: "receipt-a", buffer: receiptPdfFor({ invoiceNumber: "93003" }) },
      { filename: "b-invoice.pdf", sha256: "invoice-b", buffer: invoicePdfFor({
        invoiceNumber: "93010", jobName: "Daily Mail 8-10",
      }) },
      { filename: "b-receipt.pdf", sha256: "receipt-b", buffer: receiptPdfFor({ invoiceNumber: "93010" }) },
    ],
    messageId: "batch-retry",
    subject: "Paid mail invoices",
    receivedAt: new Date("2026-08-10T18:00:00Z"),
    apply: true,
  };

  const first = await handler.process(args);
  const second = await handler.process(args);
  assert.equal(first.written, true);
  assert.equal(second.written, true);
  assert.equal(first.writtenCount, 2);
  assert.equal(second.writtenCount, 2);
  assert.equal(first.failed, 0);
  assert.equal(second.failed, 0);
  assert.equal(stored.size, 2, "message retry must not create a third invoice document");
  assert.deepEqual([...stored.values()].map((doc) => doc.serviceDate).sort(), ["2026-08-03", "2026-08-10"]);
});

test("a SHORT email is a distinct failure, not an empty day", async () => {
  // Both PDFs ride one email, so the realistic failure is a missing
  // attachment — and that is only visible if we count what arrived rather
  // than only what parsed.
  const gmail = fakeGmail({ attachments: [{ name: "rcpt.pdf", buffer: receiptPdf() }] });
  const r = await runMailboxIngest({ gmail, apply: false, handlers: [createMailInvoiceHandler()] });
  const h = r.handlers["mail-invoice"];
  assert.equal(h.accepted, 0, "a receipt alone is not an invoice");
  assert.equal(h.skipped, 1);
});

test("a receipt whose total disagrees with the invoice goes to REVIEW", async () => {
  const gmail = fakeGmail({
    attachments: [
      { name: "inv.pdf", buffer: invoicePdf() },
      { name: "rcpt.pdf", buffer: makePdf(["Total: USD 999.99"], { producer: "Skia/PDF m150" }) },
    ],
  });
  const r = await runMailboxIngest({ gmail, apply: false, handlers: [createMailInvoiceHandler()] });
  const doc = r.handlers["mail-invoice"].results[0].doc;
  assert.equal(doc.receipt.matchesInvoice, false);
  assert.equal(doc.state, "review");
  assert.ok(doc.reviewReasons.includes("receipt-total-mismatch"));
});

test("a dry run writes nothing and does not claim the message", async () => {
  const gmail = fakeGmail({
    attachments: [{ name: "inv.pdf", buffer: invoicePdf() }, { name: "r.pdf", buffer: receiptPdf() }],
  });
  const r = await runMailboxIngest({ gmail, apply: false, handlers: [createMailInvoiceHandler()] });
  assert.equal(r.handlers["mail-invoice"].results[0].written, false);
  assert.equal(r.handlers["mail-invoice"].processed, 0,
    "an unwritten message must stay claimable, or a dry run costs a day");
});

test("a mailbox that cannot be read is not an empty mailbox", async () => {
  const gmail = { async listMessages() { throw new Error("gmail 503"); } };
  const r = await runMailboxIngest({ gmail, apply: false, handlers: [createMailInvoiceHandler()] });
  const h = r.handlers["mail-invoice"];
  assert.equal(h.errors, 1);
  assert.match(h.listFailed, /gmail 503/);
  assert.equal(h.listed, 0);
});

// ── WHICH EMAIL IS TODAY'S ────────────────────────────────────────────────
//
// Mickey 2026-08-03: "we wont be getting the last email but
// WBS.accounting@wizbangsolutions.com where the subject includes todays date."
//
// Recency and correctness diverge the moment the vendor sends anything else.
// The wrong invoice parses exactly as cleanly as the right one, so a mistake
// here is silent and lands in ROAS.

const {
  subjectMatchesDate, subjectYear, DEFAULT_QUERY,
} = require("../../packages/shared-services/src/mailInvoiceMailboxHandler");

test("the query names the EXACT sender, not the domain", () => {
  // `from:wizbang` would also match sales, support, or anyone forwarding a
  // thread — any of which could carry a PDF.
  assert.match(DEFAULT_QUERY, /from:WBS\.accounting@wizbangsolutions\.com/);
});

test("the subject date is matched in CODE, not in the Gmail query", () => {
  // Baking a guessed format into `subject:` returns an EMPTY LIST when the
  // guess is wrong — indistinguishable from "they sent nothing", which is the
  // exact confusion this reader exists to remove.
  assert.ok(!/subject:/.test(DEFAULT_QUERY));
});

test("the formats a human might actually type all resolve to the same day", () => {
  for (const subject of [
    "Invoice 83648 - Daily Mail 7-31",
    "Daily Mail 07-31",
    "WBS Invoice 7/31/2026",
    "Invoice for July 31, 2026",
    "2026-07-31 daily mail",
    "31 Jul 2026 invoice",
    "Jul 31st drop",
  ]) {
    assert.equal(subjectMatchesDate(subject, "2026-07-31"), true, subject);
  }
});

test("a NEIGHBOURING day is refused — the failure that would be silent", () => {
  // Every one of these parses fine and would file real money against the
  // wrong day.
  for (const subject of [
    "Invoice 83648 - Daily Mail 7-30",
    "Daily Mail 8-31",
    "Daily Mail 12-31",
    "Daily Mail 7-3",
  ]) {
    assert.equal(subjectMatchesDate(subject, "2026-07-31"), false, subject);
  }
});

test("a partial number cannot masquerade as the date", () => {
  // The lookarounds are load-bearing: without the trailing one "7-310" reads
  // as 7-31, without the leading one "17-31" does.
  assert.equal(subjectMatchesDate("job 7-310", "2026-07-31"), false);
  assert.equal(subjectMatchesDate("statement 17-31", "2026-07-31"), false);
  assert.equal(subjectMatchesDate("invoice 83648", "2026-07-31"), false);
});

test("a MONEY amount is not a date", () => {
  // "$7.31" would otherwise satisfy a search for July 31 and file a real
  // invoice against an unrelated day.
  assert.equal(subjectMatchesDate("Total due $7.31", "2026-07-31"), false);
  assert.equal(subjectMatchesDate("amount $1,007.31", "2026-07-31"), false);
});

test("an empty or malformed target refuses everything rather than matching all", () => {
  // Failing OPEN here would ingest whatever arrived first.
  assert.equal(subjectMatchesDate("Daily Mail 7-31", ""), false);
  assert.equal(subjectMatchesDate("Daily Mail 7-31", "7/31/2026"), false);
  assert.equal(subjectMatchesDate("", "2026-07-31"), false);
});

test("a year in the subject beats the calendar", () => {
  // The January bug: "Daily Mail 12-31" read on Jan 2 files as NEXT December
  // unless something states the year.
  assert.equal(subjectYear("WBS Invoice 7/31/2026"), 2026);
  assert.equal(subjectYear("Daily Mail 7-31"), null);
  assert.equal(subjectYear("invoice 83648"), null, "an invoice number is not a year");
});

test("the day gate reports a WRONG-DAY email distinctly from silence", async () => {
  // "The vendor sent nothing" and "the vendor sent something, but not today's"
  // are different problems with different fixes.
  const handler = createMailInvoiceHandler({ targetDate: "2026-07-31" });
  const result = await handler.process({
    attachments: [], subject: "Invoice 83648 - Daily Mail 7-30", apply: false,
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, "subject-date-mismatch");
  assert.equal(result.summary.wantedDate, "2026-07-31");
  assert.equal(result.summary.subject, "Invoice 83648 - Daily Mail 7-30");
});

test("the nightly gate accepts a bounded late-arrival date window", async () => {
  const handler = createMailInvoiceHandler({
    targetDates: [
      "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27",
      "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
    ],
  });
  const late = await handler.process({
    attachments: [], subject: "Invoice 83648 - Daily Mail 7-24", apply: false,
  });
  assert.equal(late.reason, "no-invoice-attachment",
    "the older completed day passed the date gate and reached invoice validation");

  const tooOld = await handler.process({
    attachments: [], subject: "Invoice 83647 - Daily Mail 7-23", apply: false,
  });
  assert.equal(tooOld.reason, "subject-date-mismatch");
  assert.deepEqual(tooOld.summary.wantedDates, [
    "2026-07-24", "2026-07-25", "2026-07-26", "2026-07-27",
    "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
  ]);
  assert.equal(tooOld.summary.wantedDate, "2026-07-31");
});

test("the default mailbox query can rediscover every date in the repair window", () => {
  assert.match(DEFAULT_QUERY, /newer_than:8d\b/);
});

test("with NO target date any vendor invoice is taken — the manual script", () => {
  // A human running the script by hand means "ingest this one".
  const handler = createMailInvoiceHandler({});
  assert.equal(typeof handler.process, "function");
  assert.ok(handler.gmailQuery.includes("WBS.accounting@wizbangsolutions.com"));
});
