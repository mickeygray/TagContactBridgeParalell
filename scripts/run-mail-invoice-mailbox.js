"use strict";

// Run the mail-invoice MAILBOX reader by hand.
//
// scripts/ingest-mail-invoice.js takes local PDF files. This takes the same
// path the 19:50 hygiene task takes — open the mailbox, list, classify,
// parse, store — so the wiring itself can be exercised before it is armed.
//
//   node scripts/run-mail-invoice-mailbox.js --date 2026-07-31
//   node scripts/run-mail-invoice-mailbox.js --date 2026-07-31 --apply
//   node scripts/run-mail-invoice-mailbox.js --date 2026-07-31 --from me@example.com
//   node scripts/run-mail-invoice-mailbox.js --date 2026-07-31 --query "..." --apply
//
// DRY BY DEFAULT. `--apply` is the only thing that writes.
//
// ── --from, AND WHY IT EXISTS ──────────────────────────────────────────────
//
// The real query pins the sender to the vendor's accounting address. A
// FORWARDED copy of a vendor email does not match that — it comes from
// whoever forwarded it — so testing the loop with a forward would list zero
// messages and prove nothing. `--from` swaps the sender for one run.
//
// It is a test affordance, deliberately not an env var and not a config key:
// leaving a relaxed sender switched on in the runtime is how a reader ends up
// ingesting a PDF that merely looks like an invoice. The nightly task builds
// its own query and cannot see this flag.

require("dotenv").config();
// A disconnected VPN can leave Node's c-ares resolver pointed at a dead
// nameserver. Ordinary lookups still work off the OS cache, so only the SRV
// query behind mongodb+srv:// fails, and it fails as "ECONNREFUSED" rather
// than anything that reads like DNS. Same opt-in override scripts/report.js
// carries, unset by default.
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  runMailboxIngest,
} = require("../packages/shared-services/src/mailboxIngestService");
const {
  createMailInvoiceHandler, DEFAULT_QUERY,
} = require("../packages/shared-services/src/mailInvoiceMailboxHandler");

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const date = arg("date");
  const fromOverride = arg("from");
  const explicitQuery = arg("query");

  if (!date) {
    console.error("usage: run-mail-invoice-mailbox.js --date YYYY-MM-DD [--from addr] [--apply]");
    process.exit(1);
  }

  const gmailQuery = explicitQuery
    || (fromOverride
      ? DEFAULT_QUERY.replace(/from:\S+/, `from:${fromOverride}`)
      : DEFAULT_QUERY);

  const config = getSharedConfig();
  const ncoaMailbox = config.ncoaMailbox || {};

  console.log(`\n  MAIL INVOICE MAILBOX · ${date} · ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`  query: ${gmailQuery}`);
  if (fromOverride) console.log("  NOTE: sender overridden for this run only — the nightly task still pins the vendor.\n");

  await connectMongo(config);

  const logger = {
    info: (m, d) => console.log(`  ${m} ${JSON.stringify(d || {}).slice(0, 200)}`),
    warn: (m, d) => console.log(`  WARN ${m} ${JSON.stringify(d || {}).slice(0, 200)}`),
  };

  try {
    const result = await runMailboxIngest({
      apply,
      logger,
      maxMessages: 25,
      maxPages: 3,
      // Same mailbox as NCOA, auth only — see nightlyHygieneRuntime.
      config: { user: ncoaMailbox.user, gmail: ncoaMailbox.gmail },
      handlers: [createMailInvoiceHandler({ targetDate: date, gmailQuery })],
    });

    const stat = result.handlers["mail-invoice"] || {};
    console.log("\n  ── funnel ──");
    if (stat.listFailed) console.log(`  COULD NOT READ THE MAILBOX — ${stat.listFailed}`);
    console.log(`  listed ............ ${stat.listed || 0}`);
    console.log(`  already ingested .. ${stat.alreadyHandled || 0}`);
    console.log(`  accepted .......... ${stat.accepted || 0}`);
    console.log(`  skipped ........... ${stat.skipped || 0}`);
    console.log(`  written ........... ${stat.processed || 0}`);
    console.log(`  errors ............ ${stat.errors || 0}`);

    for (const r of stat.results || []) {
      const s = r.summary || {};
      if (r.reason === "subject-date-mismatch") {
        console.log(`\n  SKIPPED (not ${s.wantedDate}): ${JSON.stringify(s.subject || "")}`);
        continue;
      }
      // A dry run parsed everything; it simply did not store it. Printing only
      // "not written" would hide the numbers the dry run exists to show, which
      // is the whole point of looking before writing.
      if (r.reason === "dry-run") {
        console.log(`\n  WOULD STORE · #${s.invoiceNumber} ${s.serviceDate} $${s.grandTotal} · ${s.state}`);
        console.log(`  attachments seen .. ${s.attachmentsSeen} (invoice=${s.invoice} receipt=${s.receipt} unknown=${s.unknown})`);
        const d = r.doc || {};
        console.log(`  postage/services .. $${d.postageTotal} + $${d.servicesTotal} = $${d.grandTotal}`);
        console.log(`  card fee .......... $${d.cardFee}`);
        console.log(`  serviceDate from .. ${d.serviceDateSource}`);
        console.log(`  reconciled ........ ${d.reconciled} · allPiecesMapped ${d.allPiecesMapped}`);
        if (d.receipt) {
          console.log(`  receipt ........... $${d.receipt.total} · matches invoice: ${d.receipt.matchesInvoice}`);
        }
        if ((d.reviewReasons || []).length) console.log(`  REVIEW ............ ${d.reviewReasons.join(", ")}`);
        for (const p of d.perPiece || []) {
          console.log(`    ${String(p.source).padEnd(38)} ${String(p.pieces).padStart(6)} pc  $${p.total.toFixed(2)}`);
        }
        if ((d.unmapped || []).length) console.log(`  UNMAPPED .......... ${JSON.stringify(d.unmapped).slice(0, 200)}`);
        continue;
      }
      if (!r.written && r.reason) {
        console.log(`\n  NOT WRITTEN (${r.reason}) — ${s.attachmentsSeen ?? 0} attachment(s)`);
        continue;
      }
      console.log(`\n  #${s.invoiceNumber} ${s.serviceDate} $${s.grandTotal} · ${s.pieces} piece row(s) · ${s.state}`);
      if (s.reissued) console.log("  RE-ISSUED — this invoice number was already stored with different content.");
    }
    if (!apply) console.log("\n  re-run with --apply to store.\n");
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  console.error(`\n  FAILED — ${error.message}\n`);
  process.exitCode = 1;
});
