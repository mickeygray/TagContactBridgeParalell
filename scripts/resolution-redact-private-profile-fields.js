"use strict";

// Removes private contact identity from the resolution case bank.
//
// The Upsellerator stores financial/tax case intelligence by DOMAIN:caseNumber.
// Contact identity belongs in Logics and should be fetched live only when an
// explicit contact action needs it.
//
// Usage:
//   node scripts/resolution-redact-private-profile-fields.js
//   node scripts/resolution-redact-private-profile-fields.js --apply

require("dotenv").config();
const mongoose = require("mongoose");
const { ClientProfile } = require("../packages/shared-models/src");
const { scrubDeep } = require("../packages/shared-services/src/resolutionDocumentService");

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function main() {
  const apply = hasFlag("--apply");
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME || "tagcontactbridge_parallel";
  if (!mongoUri) throw new Error("MONGODB_URI or MONGO_URI is required");

  await mongoose.connect(mongoUri, { dbName });

  const contactIdentityFilter = {
    $or: [
      { clientName: { $exists: true, $nin: ["", null] } },
      { clientKey: { $exists: true, $nin: ["", null] } },
      { "shorthand.lexis_phones": { $exists: true } },
      { "shorthand.lexis_emails": { $exists: true } },
    ],
  };

  const [total, clientName, clientKey, lexisPhones, lexisEmails] = await Promise.all([
    ClientProfile.countDocuments(contactIdentityFilter),
    ClientProfile.countDocuments({ clientName: { $exists: true, $nin: ["", null] } }),
    ClientProfile.countDocuments({ clientKey: { $exists: true, $nin: ["", null] } }),
    ClientProfile.countDocuments({ "shorthand.lexis_phones": { $exists: true } }),
    ClientProfile.countDocuments({ "shorthand.lexis_emails": { $exists: true } }),
  ]);

  const shorthandRows = await ClientProfile.find(
    { shorthand: { $exists: true, $ne: null } },
    { profileKey: 1, shorthand: 1 },
  ).lean();
  const shorthandScrubUpdates = [];
  for (const row of shorthandRows) {
    const scrubbed = scrubDeep(row.shorthand);
    if (JSON.stringify(scrubbed) !== JSON.stringify(row.shorthand)) {
      shorthandScrubUpdates.push({ profileKey: row.profileKey, shorthand: scrubbed });
    }
  }

  console.log(JSON.stringify({
    apply,
    totalMatchingProfiles: total,
    clientName,
    clientKey,
    lexisPhones,
    lexisEmails,
    shorthandScrubCandidates: shorthandScrubUpdates.length,
  }, null, 2));

  if (!apply) {
    console.log("dry run only; add --apply to unset contact identity fields");
    return;
  }

  const result = await ClientProfile.updateMany(
    contactIdentityFilter,
    {
      $unset: {
        clientName: "",
        clientKey: "",
        "shorthand.lexis_phones": "",
        "shorthand.lexis_emails": "",
      },
    },
  );
  console.log(JSON.stringify({
    matched: result.matchedCount,
    modified: result.modifiedCount,
  }, null, 2));

  let shorthandModified = 0;
  for (const row of shorthandScrubUpdates) {
    const update = await ClientProfile.updateOne(
      { profileKey: row.profileKey },
      { $set: { shorthand: row.shorthand } },
    );
    shorthandModified += update.modifiedCount || 0;
  }
  console.log(JSON.stringify({ shorthandModified }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
