"use strict";

// Monthly filler-pool refresh — CLI wrapper around
// `fillerPoolRefreshService.runFillerPoolRefresh`.
//
// The actual logic lives in the service so it can also be invoked
// from the hourly sweeper on the 1st-of-month-at-5am-PT boundary.
// This script exists for ad-hoc / manual triggering and one-off
// re-runs.
//
// Usage:
//   node scripts/build-monthly-filler.js                      # DRY (default)
//   node scripts/build-monthly-filler.js --commit             # actually write
//   node scripts/build-monthly-filler.js --domain WYNN        # one tenant
//   node scripts/build-monthly-filler.js --limit 100          # testing
//   node scripts/build-monthly-filler.js --tag filler-test    # custom tag
//   node scripts/build-monthly-filler.js --skip-dnc           # speed up testing
//   node scripts/build-monthly-filler.js --concurrency 25     # default 20

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  runFillerPoolRefresh,
} = require("../packages/shared-services/src/fillerPoolRefreshService");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const domain = readFlag(argv, "--domain");
  const limit = Number(readFlag(argv, "--limit")) || 0;
  const tag = readFlag(argv, "--tag") || null;
  const skipDnc = hasFlag(argv, "--skip-dnc");
  const concurrency = Number(readFlag(argv, "--concurrency")) || 20;

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Console-friendly logger that mirrors the old script's per-stage
  // output. The service logs structured events; we pretty-print them
  // here for the CLI's stdout.
  const logger = {
    info: (msg, meta = {}) => {
      const compact = Object.entries(meta)
        .filter(([k]) => !["ids"].includes(k))
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join("  ");
      console.log(`[${msg}]${compact ? "  " + compact : ""}`);
    },
    warn: (msg, meta = {}) => console.warn(`[warn] [${msg}] ${JSON.stringify(meta)}`),
  };

  console.log(`══ Monthly filler refresh (CLI) ══`);
  console.log(`  mode:        ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  domain:      ${domain || "all"}`);
  console.log(`  tag:         ${tag || "(default: filler-YYYY-MM in PT)"}`);
  if (limit > 0) console.log(`  limit:       ${limit} per domain`);
  if (skipDnc) console.log(`  DNC scrub:   SKIPPED (--skip-dnc)`);
  console.log(`  concurrency: ${concurrency}\n`);

  const result = await runFillerPoolRefresh({
    tag,
    domains: domain ? [domain] : undefined,
    dryRun: !commit,
    skipDnc,
    limit,
    concurrency,
    logger,
  });

  console.log(`\n══ Result ══`);
  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
  console.log("\n[done]");
}

main().catch((error) => {
  console.error("[filler] FATAL:", error.stack || error.message);
  process.exit(1);
});
