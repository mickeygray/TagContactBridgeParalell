"use strict";
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CallLog } = require("../packages/shared-models/src");
const { UserAccount } = require("../packages/shared-models/src");

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

  // 1. Find Sean(s)
  const seans = await UserAccount.find(
    { $or: [
      { name: /sean/i },
      { email: /sean/i },
      { firstName: /sean/i },
    ] },
    { name: 1, email: 1, extensionId: 1, extensionNumber: 1, agentName: 1, "metadata.additionalExtensionIds": 1 },
  ).lean();

  console.log("\n=== Sean accounts ===");
  for (const acct of seans) {
    console.log(`  ${acct.name || "?"} <${acct.email || "?"}>`);
    console.log(`    extensionId=${acct.extensionId || "?"}  extensionNumber=${acct.extensionNumber || "?"}`);
    if (acct.metadata?.additionalExtensionIds?.length) {
      console.log(`    additional=[${acct.metadata.additionalExtensionIds.join(", ")}]`);
    }
  }

  // 2. Collect all his extensionIds
  const allExts = new Set();
  const allAgentNames = new Set();
  for (const acct of seans) {
    if (acct.extensionId) allExts.add(String(acct.extensionId));
    if (acct.agentName) allAgentNames.add(acct.agentName);
    if (acct.name) allAgentNames.add(acct.name);
    if (Array.isArray(acct.metadata?.additionalExtensionIds)) {
      for (const e of acct.metadata.additionalExtensionIds) if (e) allExts.add(String(e));
    }
  }
  console.log("\nExtensions to query:", [...allExts].join(", ") || "(none)");
  console.log("Agent name filters: ", [...allAgentNames].join(" | "));

  // 3. Search CallLog today for ANY of his extensions OR any agentName matching Sean
  const orClauses = [];
  if (allExts.size > 0) orClauses.push({ extensionId: { $in: [...allExts] } });
  if (allAgentNames.size > 0) orClauses.push({ agentName: { $in: [...allAgentNames] } });
  // Also catch by name regex in case stored differently
  orClauses.push({ agentName: /sean/i });

  const match = { callStartTime: { $gte: dayStart }, $or: orClauses };

  const total = await CallLog.countDocuments(match);
  console.log(`\n=== Sean's calls today (PT) ===`);
  console.log("Total CallLog rows: ", total);

  const breakdown = await CallLog.aggregate([
    { $match: match },
    { $group: {
      _id: { platform: "$platform", direction: "$direction" },
      count: { $sum: 1 },
    } },
    { $sort: { count: -1 } },
  ]);
  console.log("\nBy (platform, direction):");
  for (const r of breakdown) {
    console.log(`  ${String(r._id.platform || "(null)").padEnd(8)} ${String(r._id.direction || "(null)").padEnd(10)} ${r.count}`);
  }

  const byExt = await CallLog.aggregate([
    { $match: match },
    { $group: { _id: "$extensionId", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log("\nBy extensionId stamped on the row:");
  for (const r of byExt) {
    console.log(`  ${String(r._id || "(null)").padEnd(20)} ${r.count}`);
  }

  const byAgentName = await CallLog.aggregate([
    { $match: match },
    { $group: { _id: "$agentName", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  console.log("\nBy agentName stamped on the row:");
  for (const r of byAgentName) {
    console.log(`  ${String(r._id || "(null)").padEnd(40)} ${r.count}`);
  }

  // Sample a few raw rows to see what shape they're in
  const samples = await CallLog.find(match, {
    telephonySessionId: 1, callStartTime: 1, direction: 1, platform: 1,
    extensionId: 1, agentName: 1, phone: 1, caseId: 1, durationSec: 1,
  }).sort({ callStartTime: -1 }).limit(5).lean();
  console.log("\nMost recent 5 rows:");
  for (const r of samples) {
    console.log(`  ${new Date(r.callStartTime).toISOString()}  ${String(r.platform||"-").padEnd(3)} ${String(r.direction||"-").padEnd(8)} ext=${r.extensionId||"-"} name="${r.agentName||"-"}" dur=${r.durationSec||0}s phone=${r.phone||"-"}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
