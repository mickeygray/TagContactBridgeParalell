"use strict";

// One-off migration: re-scrub every stored clientProfile shorthand entry +
// documentHashes labels through the sensitivity scrub (SSNs leaked into the
// `source` field via Logics filenames before the scrub layer existed).
//
// Usage: node scripts/resolution-scrub-shorthand.js [--dry]

require("dotenv").config();
const mongoose = require("mongoose");
const { ClientProfile } = require("../packages/shared-models/src");
const { scrubText, scrubDeep } = require("../packages/shared-services/src/resolutionDocumentService");
const { buildClientProfileKey, normalizeDomain } = require("../packages/shared-repositories/src/clientProfileRepository");

(async () => {
  const dry = process.argv.includes("--dry");
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  const profiles = await ClientProfile.find({ shorthand: { $ne: null } }).lean();
  console.log(`profiles with shorthand: ${profiles.length}`);
  let changed = 0;

  for (const profile of profiles) {
    const before = JSON.stringify({ s: profile.shorthand, d: profile.documentHashes });
    const shorthand = {};
    for (const [key, entry] of Object.entries(profile.shorthand || {})) {
      shorthand[key] = {
        ...entry,
        value: scrubDeep(entry.value),
        snippet: scrubText(entry.snippet || ""),
        source: scrubText(entry.source || ""),
      };
    }
    const documentHashes = (profile.documentHashes || []).map((d) => ({
      ...d,
      label: scrubText(d.label || ""),
    }));
    const after = JSON.stringify({ s: shorthand, d: documentHashes });
    if (before === after) continue;
    changed += 1;
    const domain = normalizeDomain(profile.domain || "TAG");
    const profileKey = profile.profileKey || buildClientProfileKey(domain, profile.caseNumber);
    console.log(`${dry ? "WOULD SCRUB" : "SCRUBBED"} case ${profileKey}`);
    if (!dry) {
      await ClientProfile.updateOne(
        { _id: profile._id },
        { $set: { domain, profileKey, shorthand, documentHashes } },
      );
    }
  }
  console.log(`${dry ? "would change" : "changed"}: ${changed}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
