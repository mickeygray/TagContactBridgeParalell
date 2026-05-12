"use strict";

// One-off: run the new call-log source backfill against today's TAG +
// WYNN windows and report before/after counts. Safe to run repeatedly
// — the backfill only stamps rows that are still missing sourceName.
//
// Usage: node scripts/test-source-backfill.js [YYYY-MM-DD]

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  backfillCallLogSourceFromLeadCadence,
} = require("../packages/shared-services/src/callLogSourceBackfillService");
const { CallLog } = require("../packages/shared-models/src");
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

async function counts(domain, dk) {
  const { start, end } = buildTimezoneDateWindow(dk, TZ);
  const total = await CallLog.countDocuments({
    domain,
    callStartTime: { $gte: start, $lte: end },
  });
  const withCaseNoSource = await CallLog.countDocuments({
    domain,
    callStartTime: { $gte: start, $lte: end },
    caseId: { $ne: null },
    $or: [{ sourceName: null }, { sourceName: { $exists: false } }, { sourceName: "" }],
  });
  const withSource = await CallLog.countDocuments({
    domain,
    callStartTime: { $gte: start, $lte: end },
    sourceName: { $nin: [null, ""] },
  });
  return { total, withCaseNoSource, withSource };
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: ${mongoose.connection.name}`);

  const dk = process.argv[2] || dateKey();
  for (const domain of ["TAG", "WYNN"]) {
    const before = await counts(domain, dk);
    console.log(`\n=== ${domain} ${dk} — before ===`);
    console.log(before);

    const result = await backfillCallLogSourceFromLeadCadence({
      domain,
      date: dk,
      timezone: TZ,
    });
    console.log(`\n=== ${domain} ${dk} — backfill result ===`);
    console.log(JSON.stringify(result, null, 2));

    const after = await counts(domain, dk);
    console.log(`\n=== ${domain} ${dk} — after ===`);
    console.log(after);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
