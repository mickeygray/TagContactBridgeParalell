"use strict";

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const mpi = db.collection("controlplanemasterprospectindexes");
  const cp = db.collection("controlplanecaseprofiles");
  const consents = db.collection("controlplaneconsentrecords");
  const workflows = db.collection("controlplaneconversationworkflows");
  const messages = db.collection("controlplaneconversationmessages");
  const reviewQ = db.collection("controlplanereviewqueueitems");
  const stages = db.collection("controlplaneworkflowrecords");

  // 1) WYNN-only MPI for any RON/RONALD/RONNIE COLBERT
  console.log("\n=== MPI (WYNN, Ron/Ronald/Ronnie Colbert) ===");
  const mpiHits = await mpi
    .find({
      domain: "WYNN",
      $or: [
        { firstName: /^(ron|ronald|ronnie)/i, lastName: /colbert/i },
        { name: /\b(ron|ronald|ronnie)\b.*colbert/i },
        { name: /colbert.*\b(ron|ronald|ronnie)\b/i },
      ],
    })
    .toArray();
  for (const p of mpiHits) console.log(p);

  // 2) Also dump any Colbert in WYNN (in case first-name is different)
  console.log("\n=== MPI (WYNN, any Colbert) ===");
  const allWynnColberts = await mpi.find({ domain: "WYNN", lastName: /colbert/i }).toArray();
  for (const p of allWynnColberts) {
    console.log({ caseId: p.caseId, name: p.name, firstName: p.firstName, lastName: p.lastName, cellPhone: p.cellPhone, createdAt: p.createdAt });
  }

  // 3) CaseProfile (WYNN, any Colbert)
  console.log("\n=== CaseProfile (WYNN, any Colbert) ===");
  const cpHits = await cp
    .find({
      domain: "WYNN",
      $or: [
        { "primary.lastName": /colbert/i },
        { "primary.name": /colbert/i },
      ],
    })
    .toArray();
  for (const c of cpHits) {
    console.log({
      _id: String(c._id),
      caseId: c.caseId,
      primary: c.primary,
      conversationAi: c.conversationAi,
      "communicationThreads.sms.length": c.communicationThreads?.sms?.length,
    });
  }

  // 4) ConsentRecord for any WYNN entry where customerName has Colbert
  console.log("\n=== ConsentRecord (WYNN, Colbert anywhere) ===");
  const cHits = await consents
    .find({
      domain: "WYNN",
      $or: [
        { customerName: /colbert/i },
        { reason: /colbert/i },
      ],
    })
    .toArray();
  for (const c of cHits) {
    console.log(c);
  }

  // 5) Dump every consent on WYNN created in last 21 days to scan for a Ronald by phone
  console.log("\n=== WYNN ConsentRecords last 21 days (most recent first) ===");
  const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
  const recent = await consents
    .find({ domain: "WYNN", createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(60)
    .toArray();
  for (const c of recent) {
    console.log({
      _id: String(c._id),
      caseId: c.caseId,
      phone: c.phone || c.primaryPhone,
      customerName: c.customerName,
      consentStatus: c.consentStatus,
      consentType: c.consentType,
      reason: (c.reason || "").slice(0, 140),
      source: c.source,
      sourceDetail: (c.sourceDetail || "").slice(0, 140),
      setBy: c.setBy,
      setByEmail: c.setByEmail,
      workflowId: c.workflowId,
      inboundMessageId: c.inboundMessageId,
      createdAt: c.createdAt,
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
