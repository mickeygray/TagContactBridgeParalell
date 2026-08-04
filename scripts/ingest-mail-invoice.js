"use strict";

// MAIL INVOICE INGEST — read the vendor's daily PDFs, store one costed entry.
//
//   node scripts/ingest-mail-invoice.js <file> [<file> ...]            (dry)
//   node scripts/ingest-mail-invoice.js <invoice.pdf> <receipt.pdf> --apply
//   node scripts/ingest-mail-invoice.js --list
//
// Mickey 2026-07-31: "produce 7-31 with correct costs for mail using a pdf
// scraper to create the entry first and then we will back load the gmail
// reader for it."
//
// So this is the ingest half, driven by hand. The Gmail reader that will
// eventually feed it is a DIFFERENT concern — it only has to find the
// attachments and hand them here, and keeping that seam explicit means the
// costing logic gets proved against real files before any mailbox is involved.
//
// DRY BY DEFAULT. Classification, parsing and costing all run either way;
// `--apply` is the only thing that writes.

require("dotenv").config();
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const fs = require("fs");
const crypto = require("crypto");
const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const S = require("../packages/shared-services/src/mailInvoiceParseService");

const NL = String.fromCharCode(10);
const has = (n) => process.argv.includes(`--${n}`);
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

async function list() {
  const MailInvoice = require("../packages/shared-models/src/MailInvoice");
  const rows = await MailInvoice.find({}).sort({ serviceDate: -1 }).limit(20).lean();
  console.log(`${NL}  MAIL INVOICES — ${rows.length} most recent${NL}`);
  for (const r of rows) {
    console.log(`    ${r.serviceDate}  #${String(r.invoiceNumber).padEnd(7)} ${usd(r.grandTotal).padStart(10)}`
      + `  ${String(r.perPiece.length)} piece(s)`
      + `  ${r.reconciled ? "reconciled" : "NOT RECONCILED"}`
      + `${r.receipt ? "  receipt✓" : ""}`
      + `${r.spendDerivedAt ? "  spend✓" : ""}`);
  }
  if (!rows.length) console.log("    (none yet)");
  console.log("");
}

async function main() {
  await connectMongo(getSharedConfig());
  if (has("list")) { await list(); process.exit(0); }

  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("usage: ingest-mail-invoice.js <file.pdf> [...] [--apply]"); process.exit(1); }
  const apply = has("apply");

  // 1. CLASSIFY every file before parsing any of them. The receipt states the
  //    invoice's GRAND total, so misfiling it as an invoice would post a second
  //    full charge and double the day's mail spend.
  console.log(`${NL}  MAIL INVOICE INGEST — ${apply ? "APPLY (writes)" : "DRY RUN (no writes)"}${NL}`);
  const classified = files.map((path) => {
    const buffer = fs.readFileSync(path);
    return { path, buffer, kind: S.classifyMailPdf(buffer), sha: sha256(buffer) };
  });
  for (const c of classified) {
    console.log(`    ${c.kind.padEnd(10)} ${c.path.split(/[\\/]/).pop()}`);
  }

  const invoiceFile = classified.find((c) => c.kind === "invoice");
  const receiptFile = classified.find((c) => c.kind === "receipt");
  const unknown = classified.filter((c) => c.kind !== "invoice" && c.kind !== "receipt");
  for (const u of unknown) {
    console.log(`${NL}    !! ${u.path} is neither an invoice nor a receipt — NOT ingested.`);
  }
  if (!invoiceFile) {
    // A receipt on its own is not a cost. Say so rather than reporting nothing,
    // because "they sent only the receipt" and "they sent nothing" are
    // different problems with different fixes.
    console.log(`${NL}  No invoice among these files — nothing to cost.`
      + (receiptFile ? " (a receipt was present, but a receipt is not a cost)" : ""));
    process.exit(0);
  }

  // 2. PARSE + COST.
  const parsed = S.parseMailInvoice(invoiceFile.buffer);
  const derived = S.derivePerPiece(parsed);
  const serviceDate = S.serviceDateFromJobName(parsed.jobName, new Date().getUTCFullYear());

  console.log(`${NL}  invoice #${parsed.invoiceNumber}   job "${parsed.jobName}"   service date ${serviceDate}`);
  console.log(`  postage ${usd(parsed.postageTotal)} + services ${usd(parsed.servicesTotal)} = ${usd(parsed.grandTotal)}`);
  console.log(`  line items reconcile: ${parsed.reconciled}    allocation balances: ${derived.allocationBalances}`
    + `    every piece mapped: ${derived.allPiecesMapped}`);
  if (derived.unmapped.length) {
    console.log(`  UNMAPPED: ${derived.unmapped.join(" | ")}`);
  }

  console.log(`${NL}  COST PER PIECE${NL}`);
  for (const p of derived.perPiece) {
    console.log(`    ${p.source.padEnd(36)} ${String(p.pieces).padStart(5)} pc`
      + `   postage ${usd(p.postage).padStart(9)}`
      + `   print ${usd(p.service).padStart(8)}`
      + `   fee ${usd(p.feeShare).padStart(7)}`
      + `   = ${usd(p.total).padStart(9)}   ${usd(p.costPerPiece)}/pc`);
  }
  const pieces = derived.perPiece.reduce((s, p) => s + p.pieces, 0);
  console.log(`${NL}    ${pieces} pieces mailed, ${usd(derived.allocated)} allocated of ${usd(parsed.grandTotal)}`);

  // 3. THE RECEIPT — a cross-check, never a cost.
  let receipt = null;
  if (receiptFile) {
    const r = S.parseMailReceipt(receiptFile.buffer);
    const matches = r.total != null && Math.abs(r.total - parsed.grandTotal) <= 0.01;
    receipt = {
      total: r.total,
      capturedAt: r.capturedAt,
      method: r.method,
      authCode: r.authCode,
      transactionId: r.transactionId,
      matchesInvoice: matches,
      fileSha256: receiptFile.sha,
    };
    console.log(`${NL}  RECEIPT  ${usd(r.total)}  ${r.method || "?"}  auth ${r.authCode || "?"}`
      + `   matches invoice: ${matches ? "yes" : "NO — investigate before trusting either number"}`);
  } else {
    console.log(`${NL}  (no receipt supplied — the invoice stands on its own)`);
  }

  // 4. WRITE.
  if (!apply) {
    console.log(`${NL}  re-run with --apply to store this entry.${NL}`);
    process.exit(0);
  }

  const MailInvoice = require("../packages/shared-models/src/MailInvoice");
  const doc = {
    vendor: parsed.vendor || "wizbang",
    invoiceNumber: parsed.invoiceNumber,
    fileSha256: invoiceFile.sha,
    jobName: parsed.jobName,
    serviceDate,
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
    receipt,
    receivedAt: new Date(),
  };

  // Idempotent on the vendor's own invoice number. A re-drop updates in place;
  // it never creates a second cost for the same day.
  const existing = await MailInvoice.findOne({ vendor: doc.vendor, invoiceNumber: doc.invoiceNumber }).lean();
  if (existing && existing.fileSha256 !== doc.fileSha256) {
    console.log(`${NL}  !! invoice #${doc.invoiceNumber} already stored with DIFFERENT content.`);
    console.log("     Re-issued invoices change the day's cost — updating, and flagging it here.");
  }
  const saved = await MailInvoice.findOneAndUpdate(
    { vendor: doc.vendor, invoiceNumber: doc.invoiceNumber },
    { $set: doc },
    { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
  ).lean();

  console.log(`${NL}  ${existing ? "updated" : "created"} MailInvoice ${saved.serviceDate} #${saved.invoiceNumber}`);
  console.log("  NO SpendEntry written — deriving spend is a separate, gated step.");
  await list();
  process.exit(0);
}

main().catch((error) => {
  console.error(`ingest-mail-invoice failed: ${error.message}`);
  process.exit(1);
});
