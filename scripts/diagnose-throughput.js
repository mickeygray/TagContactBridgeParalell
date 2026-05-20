"use strict";
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { LeadCadence, CxDialQueue, UserAccount, CallLog } = require("../packages/shared-models/src");

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

  console.log("\n=== LeadCadence inventory (active) ===");
  const cadenceByFamily = await LeadCadence.aggregate([
    { $match: { active: true } },
    { $group: { _id: { domain: "$domain", family: "$routeCampaignKey" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  for (const r of cadenceByFamily) {
    console.log(`  ${String(r._id.domain || "?").padEnd(6)} ${String(r._id.family || "(null)").padEnd(20)} ${r.count}`);
  }

  console.log("\n=== CxDialQueue current state ===");
  const queueByState = await CxDialQueue.aggregate([
    { $group: { _id: { state: "$state", family: "$queueFamily", domain: "$domain" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  for (const r of queueByState) {
    console.log(`  ${String(r._id.domain).padEnd(6)} ${String(r._id.family || "?").padEnd(20)} ${String(r._id.state).padEnd(12)} ${r.count}`);
  }

  console.log("\n=== CX agent queue policies (configured caps) ===");
  const agents = await UserAccount.find(
    { extensionId: { $ne: null }, status: { $ne: "disabled" }, "cxQueuePolicy.enabled": true },
    { name: 1, email: 1, extensionId: 1, cxQueuePolicy: 1 },
  ).lean();
  console.log(`Agents w/ extension + enabled cxQueuePolicy: ${agents.length}`);
  for (const a of agents) {
    const p = a.cxQueuePolicy || {};
    console.log(`  ${(a.name || a.email).padEnd(28)} ext=${a.extensionId}`);
    const routes = Array.isArray(p.routeCampaigns) && p.routeCampaigns.length > 0
      ? p.routeCampaigns.join(",")
      : "all";
    console.log(`    totalOpen=${p.totalOpen ?? "-"} routes=${routes} fresh.targetOpen=${p.fresh?.targetOpen ?? "-"} day2to15.targetOpen=${p.day2to15?.targetOpen ?? "-"} aged.targetOpen=${p.aged?.targetOpen ?? "-"}`);
  }

  console.log("\n=== Today's outbound CX — coverage of inventory ===");
  const cxOutToday = { callStartTime: { $gte: dayStart }, platform: "cx", direction: "outbound" };
  const totalCalls = await CallLog.countDocuments(cxOutToday);
  const uniqueLeads = (await CallLog.distinct("caseId", { ...cxOutToday, caseId: { $ne: null } })).length;
  const totalActiveCadence = await LeadCadence.countDocuments({ active: true });
  console.log(`  Calls placed:            ${totalCalls}`);
  console.log(`  Unique leads touched:    ${uniqueLeads}`);
  console.log(`  Active LeadCadence rows: ${totalActiveCadence}`);
  console.log(`  → Daily coverage:        ${((uniqueLeads / totalActiveCadence) * 100).toFixed(2)}%`);
  console.log(`  → Days to cycle pool:    ${(totalActiveCadence / Math.max(uniqueLeads, 1)).toFixed(0)} days at today's rate`);

  console.log("\n=== Lead age distribution in active cadence ===");
  const now = new Date();
  const ageBuckets = await LeadCadence.aggregate([
    { $match: { active: true } },
    { $project: {
      ageDays: { $divide: [ { $subtract: [now, "$createdAt"] }, 1000 * 60 * 60 * 24 ] },
    } },
    { $bucket: {
      groupBy: "$ageDays",
      boundaries: [0, 1, 2, 10, 30, 60, 90, 365],
      default: "older",
      output: { count: { $sum: 1 } },
    } },
  ]);
  for (const b of ageBuckets) {
    const label = b._id === "older" ? "365+" : `${b._id}+ days`;
    console.log(`  ${String(label).padEnd(12)} ${b.count}`);
  }

  console.log("\n=== Recent 5-day call attempts per day ===");
  const fiveDaysAgo = new Date(dayStart.getTime() - 5 * 24 * 60 * 60 * 1000);
  const recentDays = await CallLog.aggregate([
    { $match: { callStartTime: { $gte: fiveDaysAgo }, platform: "cx", direction: "outbound" } },
    { $group: {
      _id: { $dateToString: { format: "%Y-%m-%d", date: "$callStartTime", timezone: "America/Los_Angeles" } },
      calls: { $sum: 1 },
      uniqueLeads: { $addToSet: "$caseId" },
      uniqueAgents: { $addToSet: "$extensionId" },
    } },
    { $project: {
      _id: 1, calls: 1,
      uniqueLeads: { $size: "$uniqueLeads" },
      uniqueAgents: { $size: "$uniqueAgents" },
    } },
    { $sort: { _id: -1 } },
  ]);
  console.log("  date         calls  uniqueLeads  agents");
  for (const r of recentDays) {
    console.log(`  ${r._id}   ${String(r.calls).padStart(5)}   ${String(r.uniqueLeads).padStart(10)}   ${String(r.uniqueAgents).padStart(6)}`);
  }

  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
