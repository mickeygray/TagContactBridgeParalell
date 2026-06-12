"use strict";

// One-off migration for the Upsellerator tenant key.
//
// Backfills clientProfiles.profileKey = DOMAIN:caseNumber, ensures domain is
// present, creates the new indexes, and then drops the old unique caseNumber
// index if it exists. Dry-run by default.
//
// Usage:
//   node scripts/resolution-backfill-profile-keys.js
//   node scripts/resolution-backfill-profile-keys.js --apply

require("dotenv").config();
const mongoose = require("mongoose");
const { ClientProfile } = require("../packages/shared-models/src");
const {
  buildClientProfileKey,
  normalizeDomain,
} = require("../packages/shared-repositories/src/clientProfileRepository");

(async () => {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  const rows = await ClientProfile.find({}, { caseNumber: 1, domain: 1, profileKey: 1 }).lean();
  const byKey = new Map();
  let wouldUpdate = 0;
  let updated = 0;
  const duplicates = [];

  for (const row of rows) {
    const domain = normalizeDomain(row.domain || "TAG");
    const profileKey = buildClientProfileKey(domain, row.caseNumber);
    if (!profileKey) continue;
    const prior = byKey.get(profileKey);
    if (prior && String(prior._id) !== String(row._id)) duplicates.push({ profileKey, ids: [prior._id, row._id] });
    else byKey.set(profileKey, row);

    if (row.domain !== domain || row.profileKey !== profileKey) {
      wouldUpdate += 1;
      if (apply) {
        await ClientProfile.updateOne(
          { _id: row._id },
          { $set: { domain, profileKey } },
        );
        updated += 1;
      }
    }
  }

  console.log(JSON.stringify({
    apply,
    scanned: rows.length,
    wouldUpdate,
    updated,
    duplicateProfileKeys: duplicates.length,
    duplicateSamples: duplicates.slice(0, 5),
  }, null, 2));

  if (duplicates.length) {
    console.error("Refusing index changes while duplicate profile keys exist.");
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  if (apply) {
    const indexes = await ClientProfile.collection.indexes();
    const old = indexes.find((idx) => idx.name === "caseNumber_1" && idx.unique);
    if (old) {
      await ClientProfile.collection.dropIndex(old.name);
      console.log(`dropped old unique index ${old.name}`);
    } else {
      console.log("old unique caseNumber index not present");
    }
    await ClientProfile.createIndexes();
    console.log("ensured clientProfile tenant-key indexes");
  } else {
    console.log("dry run only; add --apply to write profileKey/domain and update indexes");
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
