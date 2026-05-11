"use strict";

/**
 * Seeds `SourceCanonical.ringCentralExtensions` from the RC queues CSV in
 * `ops/ringcentral-reference/rc-queues.csv`.
 *
 * Usage:
 *   node scripts/seed-rc-extension-map.js           # apply
 *   node scripts/seed-rc-extension-map.js --dry     # preview only
 */

require("dotenv").config();

const path = require("path");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  seedRingcentralExtensionsFromCsv,
} = require("../packages/shared-services/src");

async function main() {
  const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");

  const config = getSharedConfig();
  const state = await connectMongo(config);
  if (!state.connected) {
    throw new Error(`Mongo not connected (state: ${JSON.stringify(state)})`);
  }

  const csvPath = path.resolve(
    __dirname,
    "../ops/ringcentral-reference/rc-queues.csv",
  );

  const result = await seedRingcentralExtensionsFromCsv({ csvPath, dryRun });

  console.log(
    `RC queue map ${dryRun ? "(dry run) " : ""}— scanned ${result.scannedQueues} queues against ${result.scannedCanonicals} canonicals`,
  );
  console.log(
    `  matched: ${result.matchedQueues}, unmatched: ${result.unmatchedQueues}`,
  );

  if (result.matches.length > 0) {
    console.log("\nMatched queues:");
    for (const match of result.matches) {
      const addedLabel = match.added.length > 0
        ? `+[${match.added.join(", ")}]`
        : "(already present)";
      console.log(
        `  ${match.queueName} [${match.extension}] → ${match.canonicalKey} (${match.canonicalName}) via ${match.matchedNumber} ${addedLabel}`,
      );
    }
  }

  if (result.unmatched.length > 0) {
    console.log("\nUnmatched queues with phone candidates:");
    for (const entry of result.unmatched) {
      console.log(
        `  ${entry.queueName} [${entry.extension}] candidates=${entry.candidates.join(",")}`,
      );
    }
  }

  await disconnectMongo();
}

main().catch((error) => {
  console.error("seed-rc-extension-map failed:", error.message);
  process.exit(1);
});
