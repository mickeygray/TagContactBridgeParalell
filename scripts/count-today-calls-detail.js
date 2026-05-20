"use strict";
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CallLog } = require("../packages/shared-models/src");

const PT = "America/Los_Angeles";
function startOfPacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PT, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const utcGuess = new Date(`${lookup.year}-${lookup.month}-${lookup.day}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: PT, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const zoned = Object.fromEntries(fmt.formatToParts(utcGuess).map((p) => [p.type, p.value]));
  const zonedAsUtc = Date.UTC(
    Number(zoned.year), Number(zoned.month) - 1, Number(zoned.day),
    Number(zoned.hour), Number(zoned.minute), Number(zoned.second),
  );
  return new Date(utcGuess.getTime() - (zonedAsUtc - utcGuess.getTime()));
}

(async () => {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const dayStart = startOfPacificDay();

  const match = {
    callStartTime: { $gte: dayStart },
    platform: "cx",
    direction: "outbound",
  };

  const totalRows = await CallLog.countDocuments(match);
  const distinctSessions = await CallLog.distinct("telephonySessionId", match);
  const distinctCases = await CallLog.distinct("caseId", { ...match, caseId: { $ne: null } });
  const distinctPhones = await CallLog.distinct("normalizedPhone", { ...match, normalizedPhone: { $ne: null } });
  const distinctAgents = await CallLog.distinct("extensionId", { ...match, extensionId: { $ne: null } });

  const dedupeCaseId = await CallLog.aggregate([
    { $match: { ...match, caseId: { $ne: null } } },
    { $group: { _id: "$caseId", count: { $sum: 1 } } },
    { $bucket: {
        groupBy: "$count",
        boundaries: [1, 2, 3, 4, 5, 6, 10, 100],
        default: "many",
        output: { leads: { $sum: 1 }, calls: { $sum: "$count" } },
    } },
  ]);

  console.log("\n=== TODAY'S OUTBOUND CX (PT) ===");
  console.log("Raw rows (= raw call attempts):  ", totalRows);
  console.log("Distinct telephony sessions:     ", distinctSessions.length);
  console.log("Distinct cases (= unique leads): ", distinctCases.length);
  console.log("Distinct phone numbers:          ", distinctPhones.length);
  console.log("Distinct agents (extensionId):   ", distinctAgents.length);

  console.log("\nCalls per lead (case) distribution:");
  console.log("  attempts | leads | calls");
  for (const row of dedupeCaseId) {
    const label = row._id === "many" ? "10+" : `${row._id}`;
    console.log(`  ${String(label).padStart(8)} | ${String(row.leads).padStart(5)} | ${row.calls}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
