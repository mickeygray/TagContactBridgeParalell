"use strict";

// Dry-run-first payment metrics exception scanner.
//   node scripts/scan-payment-metrics-reviews.js --from 2026-07-01 --to 2026-07-24 --dry-run
// Remove --dry-run only after reviewing the aggregate preview. This creates
// review alerts; it never changes payments, sources, deal counts, or money.

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const {
  getCompanyKeys,
  getSharedConfig,
} = require("../packages/shared-config/src");
const {
  scanPaymentMetricsExceptions,
} = require("../packages/shared-services/src/paymentMetricsReviewService");

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index < process.argv.length - 1) return process.argv[index + 1];
  return fallback;
}

function pacificDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

(async () => {
  const today = pacificDate();
  const from = readFlag("from", `${today.slice(0, 7)}-01`);
  const to = readFlag("to", today);
  const domains = String(readFlag("domains", getCompanyKeys().join(",")))
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const dryRun = process.argv.includes("--dry-run");

  if (!dryRun && !process.argv.includes("--apply")) {
    throw new Error("Pass --dry-run to preview or --apply to create review alerts");
  }

  const state = await connectMongo(getSharedConfig());
  console.log("connected to db:", state?.name || "(unknown)");
  const summary = await scanPaymentMetricsExceptions({
    domains,
    from,
    to,
    dryRun,
  });
  console.log(JSON.stringify(summary, null, 2));
  await disconnectMongo();
})().catch(async (error) => {
  console.error("payment metrics review scan failed:", error.message);
  await disconnectMongo().catch(() => null);
  process.exitCode = 1;
});
