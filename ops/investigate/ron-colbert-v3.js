"use strict";

// Trace WYNN case 106029 (Ron Colbert) — find every record that touched
// the DNC and report what triggered it.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

const CASE_ID = 106029;
const DOMAIN = "WYNN";

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel",
  });
  console.log(`connected db=${mongoose.connection.name}`);
  const db = mongoose.connection.db;

  const masterProspectIndex = db.collection("controlplanemasterprospectindexes");
  const caseProfiles = db.collection("controlplanecaseprofiles");
  const consentRecords = db.collection("controlplaneconsentrecords");
  const conversationWorkflows = db.collection("controlplaneconversationworkflows");
  const conversationMessages = db.collection("controlplaneconversationmessages");
  const reviewQueueItems = db.collection("controlplanereviewqueueitems");
  const workflowRecords = db.collection("controlplaneworkflowrecords");

  // 1) MPI
  const mpi = await masterProspectIndex.findOne({ domain: DOMAIN, caseId: CASE_ID });
  console.log("\n=== MasterProspectIndex ===");
  console.log(mpi ? JSON.stringify(mpi, null, 2) : "  NOT FOUND");

  // 2) CaseProfile
  const cp = await caseProfiles.findOne({ domain: DOMAIN, caseId: CASE_ID });
  console.log("\n=== CaseProfile (truncated) ===");
  if (cp) {
    console.log({
      _id: String(cp._id),
      domain: cp.domain,
      caseId: cp.caseId,
      primary: cp.primary,
      conversationAi: cp.conversationAi,
      "communicationThreads.sms.length": cp.communicationThreads?.sms?.length,
      lastFourSmsTurns: (cp.communicationThreads?.sms || []).slice(-4),
    });
  } else {
    console.log("  NOT FOUND");
  }

  // Phones to trace
  const phones = new Set();
  for (const p of [mpi?.cellPhone, mpi?.homePhone, mpi?.workPhone, cp?.primary?.cellPhone, cp?.primary?.homePhone, cp?.primary?.workPhone]) {
    if (p) phones.add(String(p).replace(/\D/g, ""));
  }
  for (const arr of [mpi?.normalizedPhones, cp?.normalizedPhones]) {
    if (Array.isArray(arr)) for (const p of arr) phones.add(String(p).replace(/\D/g, ""));
  }
  const phoneList = Array.from(phones).filter(Boolean);
  console.log(`\n=== Phones traced ===\n${JSON.stringify(phoneList)}`);

  // 3) ConsentRecord
  const consents = await consentRecords
    .find({
      $or: [
        { domain: DOMAIN, caseId: CASE_ID },
        ...(phoneList.length ? [{ phone: { $in: phoneList } }, { primaryPhone: { $in: phoneList } }] : []),
      ],
    })
    .sort({ createdAt: -1 })
    .toArray();
  console.log(`\n=== ConsentRecord (${consents.length}) ===`);
  for (const c of consents) {
    console.log(JSON.stringify(c, null, 2));
  }

  // 4) ConversationWorkflow
  const workflows = await conversationWorkflows
    .find({
      $or: [
        { domain: DOMAIN, caseId: CASE_ID },
        ...(phoneList.length ? [{ phone: { $in: phoneList } }] : []),
      ],
    })
    .toArray();
  console.log(`\n=== ConversationWorkflow (${workflows.length}) ===`);
  for (const w of workflows) {
    console.log(JSON.stringify(w, null, 2));
  }

  const workflowIds = workflows.map((w) => String(w._id));

  // 5) ConversationMessage
  const messages = await conversationMessages
    .find({
      $or: [
        { workflowId: { $in: workflowIds } },
        ...(phoneList.length ? [{ phone: { $in: phoneList } }] : []),
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n=== ConversationMessage (${messages.length}) ===`);
  for (const m of messages) {
    console.log({
      _id: String(m._id),
      workflowId: m.workflowId,
      direction: m.direction,
      domain: m.domain,
      phone: m.phone,
      body: m.body,
      aiClassification: m.aiClassification,
      autoResponded: m.autoResponded,
      providerStatus: m.providerStatus,
      providerError: m.providerError,
      approvedByEmail: m.approvedByEmail,
      disposition: m.disposition,
      createdAt: m.createdAt,
    });
  }

  // 6) ReviewQueue items
  const reviews = await reviewQueueItems
    .find({
      $or: [
        { domain: DOMAIN, caseId: CASE_ID },
        ...(phoneList.length ? [{ primaryPhone: { $in: phoneList } }] : []),
      ],
    })
    .sort({ createdAt: -1 })
    .limit(40)
    .toArray();
  console.log(`\n=== ReviewQueue (${reviews.length}) ===`);
  for (const r of reviews) {
    console.log({
      _id: String(r._id),
      domain: r.domain,
      caseId: r.caseId,
      category: r.category,
      title: r.title,
      summary: (r.summary || "").slice(0, 240),
      severity: r.severity,
      status: r.status,
      "payload.classification": r.payload?.classification,
      "payload.autoResult": r.payload?.autoResult,
      "payload.reason": r.payload?.reason,
      tags: r.tags,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    });
  }

  // 7) WorkflowStage entries
  const stages = await workflowRecords
    .find({
      $or: [
        { aggregateId: { $in: workflowIds } },
        { domain: DOMAIN, caseId: CASE_ID },
      ],
    })
    .sort({ happenedAt: -1, createdAt: -1 })
    .limit(40)
    .toArray();
  console.log(`\n=== WorkflowStage (${stages.length}) ===`);
  for (const s of stages) {
    console.log({
      _id: String(s._id),
      family: s.family,
      subtype: s.subtype,
      stage: s.stage,
      aggregateId: s.aggregateId,
      caseId: s.caseId,
      summary: s.summary,
      "payload.classification": s.payload?.classification,
      "payload.autoResult": s.payload?.autoResult,
      "payload.reason": s.payload?.reason,
      happenedAt: s.happenedAt,
      sourceService: s.sourceService,
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
