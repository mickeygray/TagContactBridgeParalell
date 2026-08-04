"use strict";

/**
 * ensure-call-recording-index-indexes — create CallRecordingIndex's indexes.
 *
 * `autoIndex` is OFF in production, so a model's declared indexes do NOT appear
 * just because the collection is written to. For this collection that is not a
 * performance footnote: the unique index on (provider, providerCallId) is what
 * makes the capture idempotent. Without it, every re-run of a day inserts a
 * second copy of every call instead of updating it.
 *
 * Safe to re-run. Creating an index that already exists is a no-op.
 *
 *   node scripts/ensure-call-recording-index-indexes.js
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const CallRecordingIndex = require("../packages/shared-models/src/CallRecordingIndex");

async function main() {
  await connectMongo(getSharedConfig());

  const before = await CallRecordingIndex.collection.indexes().catch(() => []);
  console.log(`  existing indexes: ${before.length}`);
  for (const i of before) console.log(`    ${i.name}`);

  console.log("\n  creating declared indexes…");
  await CallRecordingIndex.createIndexes();

  const after = await CallRecordingIndex.collection.indexes();
  console.log(`\n  now ${after.length} index(es):`);
  for (const i of after) {
    console.log(`    ${String(i.name).padEnd(42)}${i.unique ? "UNIQUE" : ""}`);
  }

  const unique = after.find((i) => i.unique && i.key?.provider === 1 && i.key?.providerCallId === 1);
  console.log(unique
    ? "\n  OK — the idempotency index is present."
    : "\n  WARNING — no unique (provider, providerCallId) index. Re-running a capture WILL duplicate.");

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
