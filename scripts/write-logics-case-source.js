"use strict";

// Spot-write a piece's Logics SourceID onto a case (pillar-2 tool).
//   node scripts/write-logics-case-source.js --domain TAG --case 414272 --piece pink
//   node scripts/write-logics-case-source.js --domain TAG --case 414272 --piece "Urgent Third State" --dry
// Piece shortcuts: white | pink | afford (or any exact registry label).

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  writeLogicsCaseSource,
  resolveLogicsSourceId,
} = require("../packages/shared-services/src/logicsSourceWriterService");

const SHORTCUTS = {
  white: "Urgent Third State",
  pink: "3rd Day (Pink) Urgent Third State 800-921-9263",
  afford: "Affordability Federal",
};

function readFlag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && index < process.argv.length - 1) return process.argv[index + 1];
  return fallback;
}

(async () => {
  const domain = String(readFlag("domain", "TAG")).toUpperCase();
  const caseId = Number(readFlag("case"));
  const pieceInput = readFlag("piece", "");
  const dry = process.argv.includes("--dry");
  const piece = SHORTCUTS[pieceInput.toLowerCase()] || pieceInput;
  if (!Number.isFinite(caseId) || !piece) {
    console.error("usage: --domain TAG --case <id> --piece white|pink|afford|<label> [--dry]");
    process.exit(1);
  }
  const sourceId = resolveLogicsSourceId(domain, piece);
  console.log(JSON.stringify({ domain, caseId, piece, logicsSourceId: sourceId, dry }));
  if (!sourceId) {
    console.error("piece not in LOGICS_SOURCE_REGISTRY — nothing to write");
    process.exit(1);
  }
  if (dry) process.exit(0);
  await connectMongo(getSharedConfig());
  const result = await writeLogicsCaseSource({ domain, caseId, piece, logger: console });
  console.log(JSON.stringify(result));
  await disconnectMongo();
  process.exit(0);
})().catch((error) => {
  console.error("write failed:", error.message);
  process.exit(1);
});
