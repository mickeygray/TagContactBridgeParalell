"use strict";

// Operator tool: ingest local document files into a clientProfile through the
// SAME parse-and-delete pipeline as the panel upload (in-memory parse →
// shorthand + hash → buffer released; the source file on disk is the
// operator's to delete). Useful for backlog feeding before the panel UI, and
// for testing the pipeline end to end.
//
// Usage:
//   node scripts/resolution-ingest-local.js [--domain TAG|WYNN] <caseNumber> <docType> <file> [more files...]

require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const { ingestClientDocument } = require("../packages/shared-services/src/resolutionDocumentService");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

(async () => {
  const force = process.argv.includes("--force");
  const domain = normalizeDomain(argValue("--domain", "TAG"));
  const args = process.argv.slice(2).filter((a, index, list) => (
    a !== "--force" && a !== "--domain" && list[index - 1] !== "--domain"
  ));
  const [caseNumber, docType, ...files] = args;
  if (!caseNumber || !docType || !files.length) {
    throw new Error("usage: node scripts/resolution-ingest-local.js [--force] [--domain TAG|WYNN] <caseNumber> <docType: ths|wit|rt|lexis> <file> [files...]");
  }
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });
  for (const file of files) {
    const result = await ingestClientDocument({
      caseNumber,
      domain,
      buffer: fs.readFileSync(file),
      filename: file.split(/[\\/]/).pop(),
      docType,
      uploadedBy: "local-operator",
      force,
    });
    if (result.deduped) {
      console.log(`DEDUPED ${file} — ${result.message}`);
    } else {
      console.log(`PARSED  ${file} → ${result.docLabel}`);
      for (const [k, s] of Object.entries(result.snippets || {})) console.log(`   ${k}: ${s}`);
    }
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
