"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { backfillLegacyMetricsRange } = require("../packages/shared-services/src");

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function parseArgs(argv) {
  return {
    domain: readFlagValue(argv, "--domain"),
    from: readFlagValue(argv, "--from"),
    to: readFlagValue(argv, "--to"),
    out: readFlagValue(argv, "--out"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.from || !args.to) {
    throw new Error("--from and --to are required");
  }

  const state = await connectMongo(getSharedConfig());
  if (!state.connected) {
    throw new Error(`Mongo not connected: ${JSON.stringify(state)}`);
  }

  const result = await backfillLegacyMetricsRange({
    domain: args.domain || "TAG",
    from: args.from,
    to: args.to,
  });

  const output = JSON.stringify(result, null, 2);
  if (args.out) {
    const outputPath = path.resolve(args.out);
    fs.writeFileSync(outputPath, output, "utf8");
    console.log(`Wrote metrics backfill result to ${outputPath}`);
  } else {
    console.log(output);
  }

  await disconnectMongo();
}

main().catch(async (error) => {
  console.error("backfill-legacy-metrics failed:", error.message);
  try {
    await disconnectMongo();
  } catch {
    // best effort
  }
  process.exit(1);
});
