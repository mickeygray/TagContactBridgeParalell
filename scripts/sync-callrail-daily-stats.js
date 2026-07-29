"use strict";

// CLI for the CallRail → DailyCallStat feeder.
//   node scripts/sync-callrail-daily-stats.js --from 2026-07-01 --to 2026-07-24 [--dry-run]
// Defaults to yesterday..today (LA). Idempotent full-day recompute.

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { syncCallrailDailyStats } = require("../packages/shared-services/src/callrailDailyStatSyncService");

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index < process.argv.length - 1) return process.argv[index + 1];
  return fallback;
}

function laDate(daysBack = 0) {
  const date = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

(async () => {
  const from = readFlag("from", laDate(1));
  const to = readFlag("to", laDate(0));
  const dryRun = process.argv.includes("--dry-run");
  // Connect exactly like the app (event-core) so writes land in
  // PARALLEL_DB_NAME — a raw mongoose.connect(MONGO_URI) would silently
  // target the URI's default db instead.
  const state = await connectMongo(getSharedConfig());
  console.log("connected to db:", state?.name || "(unknown)");
  const summary = await syncCallrailDailyStats({ from, to, dryRun });
  console.log(JSON.stringify(summary, null, 2));
  await disconnectMongo();
  process.exit(0);
})().catch((error) => {
  console.error("sync failed:", error.message);
  process.exit(1);
});
