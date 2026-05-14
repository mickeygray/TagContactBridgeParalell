"use strict";

// Trace why Ron Colbert was DNC'd. Walks:
//   1. MasterProspectIndex / CaseProfile → find his caseId(s) + phones
//   2. ConsentRecord → DNC entries (reason, source, timestamp)
//   3. ConversationWorkflow → SMS thread state per phone
//   4. ConversationMessage → the inbound that triggered the DNC
//   5. ReviewQueue items + WorkflowStage entries for audit
//
// Read-only. Safe to run live.

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

const NAME_QUERY = "ron colbert";

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const masterProspectIndex = db.collection("controlplanemasterprospectindexes");
  const caseProfiles = db.collection("controlplanecaseprofiles");
  const consentRecords = db.collection("controlplaneconsentrecords");
  const conversationWorkflows = db.collection("controlplaneconversationworkflows");
  const conversationMessages = db.collection("controlplaneconversationmessages");
  const reviewQueueItems = db.collection("controlplanereviewqueueitems");
  const workflowRecords = db.collection("controlplaneworkflowrecords");

  // 1) Find by name in MasterProspectIndex
  const nameRegex = new RegExp(NAME_QUERY, "i");
  const prospects = await masterProspectIndex
    .find({
      $or: [
        { name: nameRegex },
        { firstName: /ron/i, lastName: /colbert/i },
      ],
    })
    .toArray();

  console.log(`\n=== MasterProspectIndex (${prospects.length} matches) ===`);
  for (const p of prospects) {
    console.log({
      _id: String(p._id),
      domain: p.domain,
      caseId: p.caseId,
      name: p.name || `${p.firstName} ${p.lastName}`,
      cellPhone: p.cellPhone,
      homePhone: p.homePhone,
      workPhone: p.workPhone,
      statusLabelRaw: p.statusLabelRaw,
      statusCategory: p.statusCategory,
      sourceName: p.metadata?.sourceName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }

  const caseIds = prospects.map((p) => p.caseId).filter((x) => x != null);
  const phones = new Set();
  for (const p of prospects) {
    if (p.cellPhone) phones.add(String(p.cellPhone).replace(/\D/g, ""));
    if (p.homePhone) phones.add(String(p.homePhone).replace(/\D/g, ""));
    if (p.workPhone) phones.add(String(p.workPhone).replace(/\D/g, ""));
    if (Array.isArray(p.normalizedPhones)) {
      for (const ph of p.normalizedPhones) phones.add(String(ph).replace(/\D/g, ""));
    }
  }

  // 2) CaseProfile lookup (some leads only land here, not MasterProspectIndex)
  const profiles = await caseProfiles
    .find({
      $or: [
        { caseId: { $in: caseIds } },
        { "primary.name": nameRegex },
        { "primary.firstName": /ron/i, "primary.lastName": /colbert/i },
      ],
    })
    .toArray();
  console.log(`\n=== CaseProfile (${profiles.length} matches) ===`);
  for (const cp of profiles) {
    console.log({
      _id: String(cp._id),
      domain: cp.domain,
      caseId: cp.caseId,
      name: cp.primary?.name || `${cp.primary?.firstName} ${cp.primary?.lastName}`,
      cellPhone: cp.primary?.cellPhone,
      conversationAi: cp.conversationAi
        ? {
            workflowId: cp.conversationAi.workflowId,
            optOutDetected: cp.conversationAi.optOutDetected,
            status: cp.conversationAi.status,
            aiRecommendedAction: cp.conversationAi.aiRecommendedAction,
            aiSummary: cp.conversationAi.aiSummary,
            latestInboundText: cp.conversationAi.latestInboundText,
          }
        : null,
    });
    if (cp.primary?.cellPhone) phones.add(String(cp.primary.cellPhone).replace(/\D/g, ""));
    if (cp.primary?.homePhone) phones.add(String(cp.primary.homePhone).replace(/\D/g, ""));
    if (cp.primary?.workPhone) phones.add(String(cp.primary.workPhone).replace(/\D/g, ""));
  }

  const phoneList = Array.from(phones).filter(Boolean);
  console.log(`\n=== Phones being traced ===\n${JSON.stringify(phoneList)}`);

  // 3) ConsentRecord — the actual DNC entries
  const consents = await consentRecords
    .find({
      $or: [
        { caseId: { $in: caseIds } },
        { phone: { $in: phoneList } },
        { primaryPhone: { $in: phoneList } },
      ],
    })
    .sort({ createdAt: -1 })
    .toArray();
  console.log(`\n=== ConsentRecord (${consents.length} matches) ===`);
  for (const c of consents) {
    console.log({
      _id: String(c._id),
      domain: c.domain,
      caseId: c.caseId,
      phone: c.phone || c.primaryPhone,
      consentType: c.consentType,
      consentStatus: c.consentStatus,
      reason: c.reason,
      source: c.source,
      sourceDetail: c.sourceDetail,
      setBy: c.setBy,
      setByEmail: c.setByEmail,
      scope: c.scope,
      channel: c.channel,
      inboundMessageId: c.inboundMessageId,
      workflowId: c.workflowId,
      createdAt: c.createdAt,
    });
  }

  // 4) ConversationWorkflow per phone
  const workflows = await conversationWorkflows
    .find({ phone: { $in: phoneList } })
    .toArray();
  console.log(`\n=== ConversationWorkflow (${workflows.length} matches) ===`);
  for (const w of workflows) {
    console.log({
      _id: String(w._id),
      domain: w.domain,
      caseId: w.caseId,
      phone: w.phone,
      channel: w.channel,
      status: w.status,
      optOutDetected: w.optOutDetected,
      optedOutAt: w.optedOutAt,
      aiRecommendedAction: w.aiRecommendedAction,
      aiSummary: w.aiSummary,
      aiHotIntent: w.aiHotIntent,
      latestInboundText: w.latestInboundText,
      latestInboundAt: w.latestInboundAt,
      "metadata.suppressionReason": w.metadata?.suppressionReason,
      updatedAt: w.updatedAt,
    });
  }

  // 5) ConversationMessage — the inbound + auto-responder outbound
  const workflowIds = workflows.map((w) => String(w._id));
  const messages = await conversationMessages
    .find({
      $or: [
        { workflowId: { $in: workflowIds } },
        { phone: { $in: phoneList } },
      ],
    })
    .sort({ createdAt: 1 })
    .toArray();
  console.log(`\n=== ConversationMessage (${messages.length} matches) ===`);
  for (const m of messages) {
    console.log({
      _id: String(m._id),
      workflowId: m.workflowId,
      direction: m.direction,
      domain: m.domain,
      phone: m.phone,
      body: (m.body || "").slice(0, 240),
      aiClassification: m.aiClassification
        ? {
            intent: m.aiClassification.intent,
            tier: m.aiClassification.tier,
            confidence: m.aiClassification.confidence,
            rationale: m.aiClassification.rationale,
            model: m.aiClassification.model,
          }
        : null,
      autoResponded: m.autoResponded,
      providerStatus: m.providerStatus,
      approvedByEmail: m.approvedByEmail,
      disposition: m.disposition,
      createdAt: m.createdAt,
    });
  }

  // 6) ReviewQueue items
  const reviews = await reviewQueueItems
    .find({
      $or: [
        { caseId: { $in: caseIds } },
        { primaryPhone: { $in: phoneList } },
      ],
    })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  console.log(`\n=== ReviewQueue (${reviews.length} matches) ===`);
  for (const r of reviews) {
    console.log({
      _id: String(r._id),
      domain: r.domain,
      caseId: r.caseId,
      category: r.category,
      title: r.title,
      summary: (r.summary || "").slice(0, 200),
      severity: r.severity,
      status: r.status,
      resolvedAt: r.resolvedAt,
      createdAt: r.createdAt,
      tags: r.tags,
    });
  }

  // 7) WorkflowStage entries
  const stages = await workflowRecords
    .find({
      $or: [
        { aggregateId: { $in: workflowIds } },
        { caseId: { $in: caseIds } },
      ],
    })
    .sort({ happenedAt: -1, createdAt: -1 })
    .limit(40)
    .toArray();
  console.log(`\n=== WorkflowStage (${stages.length} matches) ===`);
  for (const s of stages) {
    console.log({
      _id: String(s._id),
      family: s.family,
      subtype: s.subtype,
      stage: s.stage,
      aggregateId: s.aggregateId,
      caseId: s.caseId,
      summary: (s.summary || "").slice(0, 200),
      happenedAt: s.happenedAt,
      sourceService: s.sourceService,
    });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
