"use strict";

// Operator tool: materialize LD spend (lead-cadence counts × per-family
// rates) for a date range. DRY BY DEFAULT — prints what would be written,
// including collisions with manual nudges (which always win). Run with
// --write only after eyeballing the dry output against any hand corrections
// already applied for those dates.
//
// Usage:
//   node scripts/backfill-ld-spend.js --from 2026-05-01 --to 2026-06-12            (dry)
//   node scripts/backfill-ld-spend.js --from 2026-05-01 --to 2026-06-12 --write
//   node scripts/backfill-ld-spend.js --date 2026-06-11 --domain WYNN --write

require("dotenv").config();
const mongoose = require("mongoose");
const { materializeLdSpendForDate, getLdRates } = require("../packages/shared-services/src/ldSpendService");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function* dateRange(from, to) {
  const cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

(async () => {
  const write = process.argv.includes("--write");
  const domain = String(argValue("--domain", process.env.LD_SPEND_DOMAINS || "WYNN")).split(",")[0].trim().toUpperCase();
  const single = argValue("--date");
  const from = single || argValue("--from");
  const to = single || argValue("--to");
  if (!from || !to) throw new Error("usage: --date YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD [--domain WYNN] [--write]");

  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  console.log(`rates: ${JSON.stringify(getLdRates())}  domain: ${domain}  mode: ${write ? "WRITE" : "DRY"}`);
  let grandTotal = 0;
  for (const dateKey of dateRange(from, to)) {
    const result = await materializeLdSpendForDate({ domain, dateKey, dryRun: !write });
    const parts = result.rows.map((r) =>
      `${r.family}: ${r.leads} × $${r.rate} = $${r.spend.toFixed(2)}${r.written ? "" : ` [${r.skippedReason}]`}`);
    const dayTotal = result.rows
      .filter((r) => r.written || r.skippedReason === "dry-run")
      .reduce((sum, r) => sum + r.spend, 0);
    grandTotal += dayTotal;
    console.log(`${dateKey}  $${dayTotal.toFixed(2).padStart(9)}  ${parts.join("; ")}`);
    for (const c of result.collisions) {
      console.log(`           ⚠ manual nudge present: ${c.familyKey} "${c.source}" $${c.spend} — materializer skipped this family`);
    }
  }
  console.log(`${write ? "written" : "would write"} total: $${grandTotal.toFixed(2)}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
