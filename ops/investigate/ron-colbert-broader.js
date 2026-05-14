"use strict";

// Broader search — try various name spellings + consent records that
// reference "colbert" anywhere.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const masterProspectIndex = db.collection("controlplanemasterprospectindexes");
  const caseProfiles = db.collection("controlplanecaseprofiles");
  const consentRecords = db.collection("controlplaneconsentrecords");

  // Try Colbert anywhere
  const rx = /colbert/i;

  const mpiHits = await masterProspectIndex
    .find({
      $or: [
        { name: rx },
        { firstName: rx },
        { lastName: rx },
        { email: rx },
        { "metadata.sourceName": rx },
      ],
    })
    .limit(20)
    .toArray();
  console.log(`\nMasterProspectIndex with "colbert" anywhere: ${mpiHits.length}`);
  for (const p of mpiHits) {
    console.log({
      _id: String(p._id),
      domain: p.domain,
      caseId: p.caseId,
      name: p.name,
      firstName: p.firstName,
      lastName: p.lastName,
      cellPhone: p.cellPhone,
      email: p.email,
      createdAt: p.createdAt,
    });
  }

  const cpHits = await caseProfiles
    .find({
      $or: [
        { "primary.name": rx },
        { "primary.firstName": rx },
        { "primary.lastName": rx },
        { "primary.email": rx },
      ],
    })
    .limit(20)
    .toArray();
  console.log(`\nCaseProfile with "colbert" anywhere: ${cpHits.length}`);
  for (const cp of cpHits) {
    console.log({
      _id: String(cp._id),
      domain: cp.domain,
      caseId: cp.caseId,
      primary: cp.primary,
      "conversationAi.optOutDetected": cp.conversationAi?.optOutDetected,
      "conversationAi.status": cp.conversationAi?.status,
      "conversationAi.aiSummary": cp.conversationAi?.aiSummary,
      "conversationAi.latestInboundText": cp.conversationAi?.latestInboundText,
    });
  }

  // ConsentRecord with "colbert" in reason / notes / customerName
  const cHits = await consentRecords
    .find({
      $or: [
        { customerName: rx },
        { reason: rx },
        { sourceDetail: rx },
        { notes: rx },
      ],
    })
    .limit(20)
    .toArray();
  console.log(`\nConsentRecord with "colbert" anywhere: ${cHits.length}`);
  for (const c of cHits) {
    console.log(c);
  }

  // Maybe by phone? Ask the user if zero hits.
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
