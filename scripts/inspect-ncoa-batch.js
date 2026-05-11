"use strict";

// Diagnose where the last NCOA upload actually landed. Cross-reference:
//   - workflow stages (completed / failed per row)
//   - MasterProspectIndex rows tagged with this batch
//   - LeadCadence rows tagged with this batch
// Usage: node scripts/inspect-ncoa-batch.js "<importBatch>"
//        node scripts/inspect-ncoa-batch.js  # picks the most recent

const path = require("path");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  MasterProspectIndex,
  WorkflowRecord,
  LeadCadence,
} = require("../packages/shared-models/src");

(async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  let importBatch = process.argv[2] || null;

  // If none provided, find the most recent ncoa-upload-batch envelope.
  if (!importBatch) {
    const recent = await WorkflowRecord.findOne({
      family: "lexis",
      subtype: "ncoa-upload-batch",
      stage: "requested",
    })
      .sort({ happenedAt: -1 })
      .lean();
    if (recent?.payload?.importBatch) {
      importBatch = String(recent.payload.importBatch);
    }
  }

  if (!importBatch) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ error: "No importBatch found. Pass one as argv." }, null, 2));
    await mongoose.disconnect();
    return;
  }

  // 1. Workflow envelope (the batch's `requested`/`completed` rows)
  const envelopes = await WorkflowRecord.find(
    { family: "lexis", subtype: "ncoa-upload-batch", "payload.importBatch": importBatch },
    { stage: 1, happenedAt: 1, payload: 1, result: 1 },
  ).sort({ happenedAt: 1 }).lean();

  // 2. Per-row stages
  const completedRows = await WorkflowRecord.countDocuments({
    family: "lexis",
    subtype: "ncoa-upload",
    stage: "completed",
    "payload.importBatch": importBatch,
  });
  const failedRows = await WorkflowRecord.countDocuments({
    family: "lexis",
    subtype: "ncoa-upload",
    stage: "failed",
    "payload.importBatch": importBatch,
  });

  // 3. MasterProspectIndex tagged with this batch
  const masterProspects = await MasterProspectIndex.countDocuments({
    "metadata.lastImportBatch": importBatch,
  });

  // 4. LeadCadence (parallel collection) tagged via payloadSnapshot or
  //    intakeRoute. The cadence repo doesn't stamp importBatch
  //    directly, so phone/lastName won't help here — we use the
  //    intakeRoute-and-recent heuristic to ballpark.
  const cadenceTagged = await LeadCadence.countDocuments({
    intakeRoute: "ncoa-upload",
    intakeSource: { $regex: "NCOA", $options: "i" },
    createdAt: { $gte: envelopes[0]?.happenedAt || new Date(0) },
  });

  // 5. Sample 5 master prospects + 5 completed-stage rows so we can
  //    eyeball whether they line up by caseId.
  const masterSample = await MasterProspectIndex.find(
    { "metadata.lastImportBatch": importBatch },
    { caseId: 1, name: 1, firstName: 1, lastName: 1, cellPhone: 1, createdAt: 1 },
  ).sort({ createdAt: 1 }).limit(5).lean();
  const stageSample = await WorkflowRecord.find(
    {
      family: "lexis",
      subtype: "ncoa-upload",
      stage: "completed",
      "payload.importBatch": importBatch,
    },
    { aggregateId: 1, caseId: 1, summary: 1, happenedAt: 1, "result.caseId": 1 },
  ).sort({ happenedAt: 1 }).limit(5).lean();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    importBatch,
    envelopes: envelopes.map((e) => ({
      stage: e.stage,
      happenedAt: e.happenedAt,
      payload: e.payload,
      resultSucceeded: e.result?.succeeded,
      resultFailed: e.result?.failed,
      resultTotal: e.result?.total,
    })),
    counts: {
      completedRowStages: completedRows,
      failedRowStages: failedRows,
      masterProspectsWithThisBatch: masterProspects,
      ncoaCadenceRowsAfterBatchStart: cadenceTagged,
    },
    masterSample,
    stageSample,
  }, null, 2));

  await mongoose.disconnect();
})().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
