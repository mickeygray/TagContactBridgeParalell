"use strict";

// Build the MailSpendDay indexes. Additive only — no sync, no drops, no row
// inspection. Output is index names.
//
// THIS MUST RUN BEFORE THE FIRST DERIVATION.
//
// autoIndex is off in production, so declaring the index on the schema does
// not build it. The unique partial index is not a performance nicety here: it
// is what makes "one active row per (domain, serviceDate, source)" an
// invariant Mongo enforces rather than a rule the deriver merely intends. Run
// the deriver without it and two invoices for one day can both stay active,
// which is the double-count the whole design exists to prevent.
//
//   node scripts/ensure-mail-spend-day-indexes.js

// A disconnected VPN can leave Node c-ares pointed at a dead nameserver, so
// only the SRV query behind mongodb+srv:// fails — and it fails as
// ECONNREFUSED rather than anything that reads like DNS. Same opt-in override
// scripts/report.js carries; a no-op unless DNS_SERVERS is set.
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}
const { getSharedConfig } = require("../packages/shared-config/src");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const MailSpendDay = require("../packages/shared-models/src/MailSpendDay");
const MailInvoice = require("../packages/shared-models/src/MailInvoice");

const INDEXES = Object.freeze([
  {
    collection: MailSpendDay.collection,
    key: { domain: 1, serviceDate: 1, source: 1 },
    options: {
      name: "uq_mail_spend_active_day_source",
      unique: true,
      partialFilterExpression: { active: true },
    },
  },
  {
    collection: MailSpendDay.collection,
    key: { serviceDate: 1, active: 1 },
    options: { name: "ix_mail_spend_range_active" },
  },
  {
    collection: MailSpendDay.collection,
    key: { invoiceNumber: 1 },
    options: { name: "ix_mail_spend_by_invoice" },
  },
  // The report's nightly invoice-arrival check queries MailInvoice by
  // serviceDate range on every board. Cheap now, and it is the same pass.
  {
    collection: MailInvoice.collection,
    key: { serviceDate: 1, state: 1 },
    options: { name: "ix_mail_invoice_service_date_state" },
  },
]);

async function main() {
  const config = getSharedConfig();
  await connectMongo(config);
  const promoted = [];
  try {
    for (const definition of INDEXES) {
      await definition.collection.createIndex(definition.key, definition.options);
      promoted.push(definition.options.name);
    }
  } finally {
    await disconnectMongo();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, promoted })}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, reason: String(error?.code || error?.name || "index-promotion-failed") })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { INDEXES };
