"use strict";

// Operator tool: remove named shorthand fields from a clientProfile. Needed
// when a parser upgrade renames fields — ingest merges are additive, so the
// superseded keys linger until pruned (stale keys would mislead the agent).
//
// Usage: node scripts/resolution-prune-shorthand.js [--domain TAG|WYNN] <caseNumber> <field> [fields...]

require("dotenv").config();
const mongoose = require("mongoose");
require("../packages/shared-models/src");
const {
  buildClientProfileKey,
  normalizeDomain,
} = require("../packages/shared-repositories/src/clientProfileRepository");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

(async () => {
  const domain = normalizeDomain(argValue("--domain", "TAG"));
  const [caseNumber, ...fields] = process.argv.slice(2).filter((a, index, list) => (
    a !== "--domain" && list[index - 1] !== "--domain"
  ));
  if (!caseNumber || !fields.length) {
    throw new Error("usage: node scripts/resolution-prune-shorthand.js [--domain TAG|WYNN] <caseNumber> <field> [fields...]");
  }
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });
  const ClientProfile = mongoose.model("ClientProfile");
  const unset = Object.fromEntries(fields.map((f) => [`shorthand.${f}`, ""]));
  const profileKey = buildClientProfileKey(domain, caseNumber);
  const result = await ClientProfile.updateOne({ profileKey }, { $unset: unset });
  console.log(`case ${profileKey}: matched ${result.matchedCount}, pruned ${fields.join(", ")}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
