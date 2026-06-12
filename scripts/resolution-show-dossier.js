"use strict";

// Operator tool: print a clientProfile's baked shorthand (full values) and
// run a sensitive-pattern audit over everything stored. Read-only.
//
// Usage: node scripts/resolution-show-dossier.js [--domain TAG|WYNN] <caseNumber>

require("dotenv").config();
const mongoose = require("mongoose");
const { getClientProfileByCaseNumber } = require("../packages/shared-repositories/src/clientProfileRepository");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function normalizeDomain(value) {
  return String(value || "TAG").trim().toUpperCase() || "TAG";
}

const SSN_RE = /(?<!\d)\d{3}[-\s]\d{2}[-\s]\d{4}(?!\d)/g;
const LONG_DIGITS_RE = /\b\d{9,}\b/g;

(async () => {
  const domain = normalizeDomain(argValue("--domain", "TAG"));
  const [caseNumber] = process.argv.slice(2).filter((a, index, list) => (
    a !== "--domain" && list[index - 1] !== "--domain"
  ));
  if (!caseNumber) throw new Error("usage: node scripts/resolution-show-dossier.js [--domain TAG|WYNN] <caseNumber>");
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });
  const profile = await getClientProfileByCaseNumber(caseNumber, domain);
  if (!profile) throw new Error(`no profile for ${domain}:${caseNumber}`);

  console.log(`=== shorthand for case ${domain}:${caseNumber} (${Object.keys(profile.shorthand || {}).length} fields) ===`);
  for (const [key, entry] of Object.entries(profile.shorthand || {})) {
    console.log(`\n[${key}]  asOf ${entry.asOf ? new Date(entry.asOf).toISOString().slice(0, 10) : "?"}  source ${entry.source}`);
    console.log(`  value: ${JSON.stringify(entry.value).slice(0, 500)}`);
  }

  console.log("\n=== sensitivity audit ===");
  const blob = JSON.stringify(profile.shorthand || {});
  const ssns = blob.match(SSN_RE) || [];
  const longDigits = (blob.match(LONG_DIGITS_RE) || []).filter((d) => d.length >= 9);
  console.log("SSN-pattern hits:", ssns.length, ssns.slice(0, 3));
  console.log("9+ digit runs:", longDigits.length, longDigits.slice(0, 5));
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
