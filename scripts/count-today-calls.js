"use strict";

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CallLog, CxDialQueue } = require("../packages/shared-models/src");

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

function pacificDateKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT }).format(new Date(d));
}

(async () => {
  const config = getSharedConfig();
  if (!config.mongoUri) {
    console.error("Missing MONGO_URI in .env");
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const dayStart = startOfPacificDay();
  const todayKey = pacificDateKey();

  console.log("\n=== TODAY ===");
  console.log("PT date key:    ", todayKey);
  console.log("UTC dayStart:   ", dayStart.toISOString());
  console.log("DB:             ", mongoose.connection.name);

  const callLogTotal = await CallLog.countDocuments({ callStartTime: { $gte: dayStart } });
  const callLogByPlatform = await CallLog.aggregate([
    { $match: { callStartTime: { $gte: dayStart } } },
    { $group: { _id: { platform: "$platform", direction: "$direction" }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const callLogByDomain = await CallLog.aggregate([
    { $match: { callStartTime: { $gte: dayStart } } },
    { $group: { _id: "$domain", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  const ringcxStamped = await CallLog.countDocuments({
    callStartTime: { $gte: dayStart },
    "ringcx.agentId": { $ne: null },
  });
  const withDriveRecording = await CallLog.countDocuments({
    callStartTime: { $gte: dayStart },
    "recordingArchive.driveFileId": { $ne: null },
  });

  console.log("\n--- CallLog ---");
  console.log("Total today:                       ", callLogTotal);
  console.log("With ringcx.agentId stamped:       ", ringcxStamped);
  console.log("With recordingArchive.driveFileId: ", withDriveRecording);
  console.log("\nBy (platform, direction):");
  for (const row of callLogByPlatform) {
    const p = row._id.platform || "(null)";
    const d = row._id.direction || "(null)";
    console.log(`  ${p.padEnd(8)} ${d.padEnd(10)} ${row.count}`);
  }
  console.log("\nBy domain:");
  for (const row of callLogByDomain) {
    console.log(`  ${String(row._id || "(null)").padEnd(8)} ${row.count}`);
  }

  const queueTouched = await CxDialQueue.countDocuments({
    "metadata.dailyAgentTouchDateKey": todayKey,
  });
  const placedAgg = await CxDialQueue.aggregate([
    { $match: { "metadata.dailyAgentTouchDateKey": todayKey } },
    { $group: {
      _id: null,
      leadsTouched: { $sum: 1 },
      placedCalls: { $sum: { $ifNull: ["$dailyPlacedCalls", 0] } },
    } },
  ]);
  console.log("\n--- CxDialQueue (touch metadata, what today-dials reads) ---");
  console.log("Queue items touched today:         ", queueTouched);
  if (placedAgg[0]) {
    console.log("Sum dailyPlacedCalls:              ", placedAgg[0].placedCalls);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
