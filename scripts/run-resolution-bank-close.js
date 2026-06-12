"use strict";

// Operator tool: run the resolution bank close by hand — elevation
// (caseProfiles→clientProfiles) + the tier-weighted Logics appendage
// refresh. Same code path the nightly PM close runs; useful for the
// initial backlog and for catching up after a Logics outage.
//
// Usage:
//   node scripts/run-resolution-bank-close.js                 (default caps)
//   node scripts/run-resolution-bank-close.js --max 50        (small test run)
//   node scripts/run-resolution-bank-close.js --pace 500      (gentler pacing)
//   node scripts/run-resolution-bank-close.js --elevate-only  (no Logics calls)

require("dotenv").config();
const mongoose = require("mongoose");
const {
  elevateCaseProfiles,
  runResolutionBankClose,
} = require("../packages/shared-services/src/resolutionBankService");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const logger = {
  info: (msg, meta) => console.log(msg, JSON.stringify(meta || {})),
  warn: (msg, meta) => console.warn(msg, JSON.stringify(meta || {})),
};

(async () => {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  if (process.argv.includes("--elevate-only")) {
    const result = await elevateCaseProfiles({ logger });
    console.log("elevation:", JSON.stringify(result));
  } else {
    const result = await runResolutionBankClose({
      logger,
      ...(argValue("--max") ? { maxCases: Number(argValue("--max")) } : {}),
      ...(argValue("--pace") ? { paceMs: Number(argValue("--pace")) } : {}),
    });
    console.log("close:", JSON.stringify(result, null, 2));
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
