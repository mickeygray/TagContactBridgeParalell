"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  previewHourlyFinancialSync,
} = require("../packages/shared-services/src/hourlyFinancialPreviewService");

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
  const sheetIds = readFlagValue(argv, "--sheet");
  return {
    domain: readFlagValue(argv, "--domain"),
    domains: domains
      ? domains.split(",").map((value) => value.trim()).filter(Boolean)
      : null,
    allDomains: hasFlag(argv, "--all-domains"),
    date: readFlagValue(argv, "--date"),
    caseId: readFlagValue(argv, "--case-id"),
    maxCasesPerDomain: readFlagValue(argv, "--max-cases"),
    staleAfterMs: readFlagValue(argv, "--stale-after-ms"),
    sheetIds: sheetIds
      ? sheetIds.split(",").map((value) => value.trim()).filter(Boolean)
      : null,
    includeAllSheetRows: hasFlag(argv, "--all-sheet-rows"),
    includePayments: !hasFlag(argv, "--skip-payments"),
    includeSheetSpend: !hasFlag(argv, "--skip-sheet-spend"),
    includeDerivedSpend: !hasFlag(argv, "--skip-derived-spend"),
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

  const result = await previewHourlyFinancialSync({
    domain: args.domain,
    domains: args.domains,
    allDomains: args.allDomains,
    date: args.date,
    caseId: args.caseId != null ? Number(args.caseId) : null,
    maxCasesPerDomain: args.maxCasesPerDomain != null ? Number(args.maxCasesPerDomain) : null,
    staleAfterMs: args.staleAfterMs != null ? Number(args.staleAfterMs) : null,
    sheetIds: args.sheetIds,
    includeAllSheetRows: args.includeAllSheetRows,
    includePayments: args.includePayments,
    includeSheetSpend: args.includeSheetSpend,
    includeDerivedSpend: args.includeDerivedSpend,
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
  console.error("preview-hourly-finance failed:", error.message);
  try {
    await disconnectMongo();
  } catch {
    // best effort
  }
  process.exit(1);
});
