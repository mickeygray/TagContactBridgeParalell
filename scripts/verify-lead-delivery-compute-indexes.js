"use strict";

// Read-only, count-only preflight for the 2026-08-03 lead-delivery compute
// patch. Customer identities are used only in process memory to build exact
// join shapes and are never printed or persisted.

const { getSharedConfig } = require("../packages/shared-config/src");
const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const CaseProfile = require("../packages/shared-models/src/CaseProfile");
const CxAppointment = require("../packages/shared-models/src/CxAppointment");
const LeadCadence = require("../packages/shared-models/src/LeadCadence");
const LeadDeliveryEvent = require("../packages/shared-models/src/LeadDeliveryEvent");
const { INDEXES } = require("./ensure-lead-delivery-compute-indexes");

function walkPlan(node, visitor) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => walkPlan(entry, visitor));
    else if (value && typeof value === "object") walkPlan(value, visitor);
  }
}

function summarizeExplain(explain = {}) {
  const stages = new Set();
  const indexNames = new Set();
  walkPlan(explain?.queryPlanner?.winningPlan, (node) => {
    if (typeof node.stage === "string") stages.add(node.stage);
    if (typeof node.indexName === "string") indexNames.add(node.indexName);
  });
  const stats = explain.executionStats || {};
  return {
    winningStage: explain?.queryPlanner?.winningPlan?.stage || null,
    blockingSort: stages.has("SORT"),
    collectionScan: stages.has("COLLSCAN"),
    indexNames: [...indexNames].sort(),
    keysExamined: Number(stats.totalKeysExamined || 0),
    documentsExamined: Number(stats.totalDocsExamined || 0),
    returned: Number(stats.nReturned || 0),
  };
}

function sameKey(left = {}, right = {}) {
  return JSON.stringify(Object.entries(left)) === JSON.stringify(Object.entries(right));
}

function groupExactPairs(rows = []) {
  const byDomain = new Map();
  for (const row of rows) {
    const domain = String(row?.domain || "").trim().toUpperCase();
    if (!domain || row?.caseId == null) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, new Set());
    byDomain.get(domain).add(row.caseId);
  }
  const branches = [...byDomain.entries()].map(([domain, ids]) => ({
    domain,
    caseId: { $in: [...ids] },
  }));
  return branches.length ? branches : [{ domain: "__INDEX_PROBE__", caseId: { $in: [-1] } }];
}

async function explainCursor(cursor) {
  return summarizeExplain(await cursor.explain("executionStats"));
}

async function main() {
  const config = getSharedConfig();
  await connectMongo(config);
  try {
    const requiredIndexes = [];
    for (const definition of INDEXES) {
      const indexes = await definition.collection.listIndexes().toArray();
      requiredIndexes.push({
        name: definition.options.name,
        present: indexes.some((index) => index.name === definition.options.name
          && sameKey(index.key, definition.key)),
      });
    }

    const caseProfileIndexes = await CaseProfile.collection.listIndexes().toArray();
    const appointmentIndexes = await CxAppointment.collection.listIndexes().toArray();
    const pairIndexes = {
      caseProfile: caseProfileIndexes.some((index) => sameKey(index.key, { domain: 1, caseId: 1 })),
      appointment: appointmentIndexes.some((index) => sameKey(
        index.key, { domain: 1, caseId: 1, status: 1 },
      )),
    };

    const samples = await LeadCadence.collection.find(
      { active: true },
      { projection: { domain: 1, caseId: 1, createdAt: 1 } },
    ).limit(50).toArray();
    const sampleDomain = String(samples[0]?.domain || "TAG").toUpperCase();
    const exactPairs = groupExactPairs(samples);
    const now = new Date();
    const appointmentStatuses = ["scheduled", "queued", "active", "pending"];

    const explains = {
      cadence: await explainCursor(LeadCadence.collection.find({
        domain: sampleDomain,
        active: true,
      }).sort({ createdAt: -1, _id: -1 }).limit(50)),
      caseProfile: await explainCursor(CaseProfile.collection.find({
        $or: exactPairs,
      }, { projection: { _id: 1 } }).limit(50)),
      appointment: await explainCursor(CxAppointment.collection.find({
        $or: exactPairs.map((branch) => ({ ...branch, status: { $in: appointmentStatuses } })),
      }, { projection: { _id: 1 } }).limit(50)),
      events: {
        pending: await explainCursor(LeadDeliveryEvent.collection.find({
          provider: "phoneburner", status: "pending",
        }).sort({ receivedAt: 1, _id: 1 }).limit(50)),
        failed: await explainCursor(LeadDeliveryEvent.collection.find({
          provider: "phoneburner", status: "failed", nextAttemptAt: { $lte: now },
        }).sort({ nextAttemptAt: 1, receivedAt: 1, _id: 1 }).limit(50)),
        processing: await explainCursor(LeadDeliveryEvent.collection.find({
          provider: "phoneburner", status: "processing", processingLeaseExpiresAt: { $lte: now },
        }).sort({ processingLeaseExpiresAt: 1, receivedAt: 1, _id: 1 }).limit(50)),
      },
    };
    const plans = [
      explains.cadence,
      explains.caseProfile,
      explains.appointment,
      ...Object.values(explains.events),
    ];
    const ok = requiredIndexes.every((row) => row.present)
      && Object.values(pairIndexes).every(Boolean)
      && plans.every((plan) => !plan.collectionScan && !plan.blockingSort);
    process.stdout.write(`${JSON.stringify({
      ok,
      indexes: {
        required: requiredIndexes.length,
        present: requiredIndexes.filter((row) => row.present).length,
        missing: requiredIndexes.filter((row) => !row.present).map((row) => row.name),
        pairIndexes,
      },
      explains,
    })}\n`);
    if (!ok) process.exitCode = 1;
  } finally {
    await disconnectMongo();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      reason: String(error?.code || error?.name || "index-proof-failed"),
    })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { groupExactPairs, sameKey, summarizeExplain };
