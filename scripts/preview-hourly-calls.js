"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  previewHourlyCallLedger,
} = require("../packages/shared-services/src");

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function hasFlag(argv, ...names) {
  return names.some((name) => argv.includes(name));
}

function parseArgs(argv) {
  const domains = readFlagValue(argv, "--domains");
  return {
    domain: readFlagValue(argv, "--domain"),
    domains: domains
      ? domains.split(",").map((value) => value.trim()).filter(Boolean)
      : null,
    allDomains: hasFlag(argv, "--all-domains"),
    date: readFlagValue(argv, "--date"),
    from: readFlagValue(argv, "--from"),
    to: readFlagValue(argv, "--to"),
    sinceMs: readFlagValue(argv, "--since-ms"),
    limit: readFlagValue(argv, "--limit"),
    direction: readFlagValue(argv, "--direction"),
    includePending: hasFlag(argv, "--include-pending"),
    out: readFlagValue(argv, "--out"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();
  const state = await connectMongo(config);

  if (!state.connected) {
    throw new Error(`Mongo not connected: ${JSON.stringify(state)}`);
  }

  const result = await previewHourlyCallLedger({
    domain: args.domain,
    domains: args.domains,
    allDomains: args.allDomains,
    date: args.date,
    from: args.from,
    to: args.to,
    sinceMs: args.sinceMs != null ? Number(args.sinceMs) : null,
    limit: args.limit != null ? Number(args.limit) : null,
    direction: args.direction || "inbound",
    includePending: args.includePending,
  });

  const output = JSON.stringify(result, null, 2);
  if (args.out) {
    const outputPath = path.resolve(args.out);
    fs.writeFileSync(outputPath, output, "utf8");
    console.log(`Wrote preview to ${outputPath}`);
  } else {
    console.log(output);
  }

  await disconnectMongo();
}

main().catch(async (error) => {
  console.error("preview-hourly-calls failed:", error.message);
  try {
    await disconnectMongo();
  } catch {
    // best effort
  }
  process.exit(1);
});
