"use strict";

// One-off diagnostic: trace what the vendor nightly email would see for
// today's TAG and WYNN data. Reports:
//   • count of LeadCadence rows created today, by intakeSource
//   • count of LeadCadence rows that would be tracked by family
//   • count of CallLedger/CallLog rows today, by intakeSource
//   • count that would be tracked
//
// Usage: node scripts/inspect-vendor-pipe.js [YYYY-MM-DD]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  CallLog,
  CallLedger,
  LeadCadence,
} = require("../packages/shared-models/src");
const { classifyVendorFamily } = require("../packages/shared-services/src/vendorDailySummaryService");
const { buildTimezoneDateWindow } = require("../packages/shared-services/src/timezoneDateWindowService");

const TZ = "America/Los_Angeles";

function dateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function inspect(domain, dk) {
  const { start, end } = buildTimezoneDateWindow(dk, TZ);
  console.log(`\n=== [${domain}] window ${start.toISOString()} → ${end.toISOString()} (${dk}) ===`);

  // LeadCadence by intakeSource
  const leads = await LeadCadence.find(
    { domain, createdAt: { $gte: start, $lte: end } },
    { intakeSource: 1, intakeRoute: 1, sourceName: 1, sourceChannel: 1, partnerSource: 1, name: 1, caseId: 1, createdAt: 1 },
  ).lean();

  const bySrc = new Map();
  const trackedByFamily = new Map();
  for (const r of leads) {
    bySrc.set(r.intakeSource || "(null)", (bySrc.get(r.intakeSource || "(null)") || 0) + 1);
    const fam = classifyVendorFamily(r.sourceName, r.sourceChannel);
    const k = fam.tracked ? fam.label : `(untracked: ${fam.label})`;
    trackedByFamily.set(k, (trackedByFamily.get(k) || 0) + 1);
  }
  console.log(`LeadCadence today: ${leads.length}`);
  console.log("  by intakeSource:", Object.fromEntries([...bySrc.entries()].sort()));
  console.log("  by classified family:", Object.fromEntries([...trackedByFamily.entries()].sort()));

  // Show a few sample LD rows
  const ldSamples = leads
    .filter((r) =>
      String(r.intakeSource || "").toLowerCase().includes("ld") ||
      String(r.intakeRoute || "").toLowerCase().includes("ld"),
    )
    .slice(0, 5);
  if (ldSamples.length) {
    console.log("  LD samples:");
    for (const s of ldSamples) {
      console.log(
        `    cid=${s.caseId} src=${s.intakeSource} route=${s.intakeRoute} sourceName=${s.sourceName} channel=${s.sourceChannel} partner=${s.partnerSource}`,
      );
    }
  }

  // CallLog rows today
  const calls = await CallLog.find(
    { domain, callStartTime: { $gte: start, $lte: end } },
    { sourceName: 1, sourceChannel: 1, direction: 1, caseId: 1, agentName: 1, durationSec: 1, durationSeconds: 1 },
  )
    .limit(5000)
    .lean();
  const callsBySrc = new Map();
  const callsTracked = new Map();
  for (const r of calls) {
    callsBySrc.set(r.sourceName || "(null)", (callsBySrc.get(r.sourceName || "(null)") || 0) + 1);
    const fam = classifyVendorFamily(r.sourceName, r.sourceChannel);
    const k = fam.tracked ? fam.label : `(untracked: ${fam.label})`;
    callsTracked.set(k, (callsTracked.get(k) || 0) + 1);
  }
  console.log(`CallLog today: ${calls.length}`);
  console.log("  by sourceName:", Object.fromEntries([...callsBySrc.entries()].sort()));
  console.log("  by classified family:", Object.fromEntries([...callsTracked.entries()].sort()));

  // CallLedger rows today
  const ledger = await CallLedger.find(
    { domain, date: dk },
    { sourceName: 1, sourceChannel: 1, direction: 1, caseId: 1 },
  )
    .limit(5000)
    .lean();
  const ledgerBySrc = new Map();
  for (const r of ledger) {
    ledgerBySrc.set(r.sourceName || "(null)", (ledgerBySrc.get(r.sourceName || "(null)") || 0) + 1);
  }
  console.log(`CallLedger today: ${ledger.length}`);
  console.log("  by sourceName:", Object.fromEntries([...ledgerBySrc.entries()].sort()));
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: ${mongoose.connection.name}`);

  const dk = process.argv[2] || dateKey();
  await inspect("TAG", dk);
  await inspect("WYNN", dk);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
