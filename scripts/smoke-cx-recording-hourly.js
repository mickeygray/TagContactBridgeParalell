"use strict";

// One-shot in-process test of the CX recording hourly pipeline.
// Runs the same logic the hourly sweeper triggers automatically, but
// outside the sweep cron so we get immediate feedback on:
//
//   • whether the RingCX token exchange succeeds
//   • whether the interaction-metadata endpoint returns data for the
//     previous :45-to-:45 window
//   • how many CX-platform CallLog rows fall in that window
//   • whether the resolver picks segments + downloads WAVs end-to-end
//
// Use this BEFORE the first scheduled hourly tick to confirm RC has
// activated recording on the account. If metadata.totalSegments=0 with
// known CX traffic in the window, the RC-side flag isn't on yet.

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const {
  runCxRecordingHourly,
  computeWindow,
} = require("../packages/shared-services/src/cxRecordingHourlyService");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: ${mongoose.connection.name}`);

  const fireTime = new Date();
  const window = computeWindow(fireTime);
  console.log("\n=== Window the hourly tick would pull ===");
  console.log(`  fireTime:   ${window.fireTime.toISOString()}`);
  console.log(`  windowStart: ${window.windowStart.toISOString()}`);
  console.log(`  windowEnd:   ${window.windowEnd.toISOString()}`);
  console.log(`  span:       ${(window.windowEnd - window.windowStart) / 60_000} min`);
  console.log(`  youngest call age at fire: ${(window.fireTime - window.windowEnd) / 60_000} min`);

  console.log("\n=== Running cxRecordingHourly (live) ===");
  const result = await runCxRecordingHourly({
    fireTime,
    domains: ["TAG", "WYNN"],
    logger: { info: (msg, ctx) => console.log("LOG:", msg, JSON.stringify(ctx)) },
  });

  console.log("\n=== Result ===");
  console.log(JSON.stringify(result, null, 2));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
