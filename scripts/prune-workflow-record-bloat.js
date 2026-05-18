"use strict";

require("dotenv").config();

const mongoose = require("mongoose");

const DEFAULT_DB = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
const TRANSIENT_OK_STAGES = [
  "observed",
  "requested",
  "built",
  "queued",
  "scheduled",
  "armed",
  "consuming",
  "attempting",
  "skipped",
  "deferred",
  "cancelled",
  "completed",
];

function hasFlag(name) {
  return process.argv.includes(name);
}

function readNumberFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function deleteIds(collection, ids, commit) {
  if (!commit || ids.length === 0) return 0;
  let deleted = 0;
  for (let offset = 0; offset < ids.length; offset += 1000) {
    const batch = ids.slice(offset, offset + 1000);
    const result = await collection.deleteMany({ _id: { $in: batch } });
    deleted += Number(result.deletedCount || 0);
  }
  return deleted;
}

async function findDuplicateNcoaStaleSweep(collection) {
  const groups = await collection
    .aggregate([
      {
        $match: {
          family: "lexis",
          subtype: "ncoa-upload-batch",
          stage: "failed",
          sourceService: "ncoa-stale-sweep",
        },
      },
      { $sort: { happenedAt: -1, _id: -1 } },
      {
        $group: {
          _id: { $ifNull: ["$result.importBatch", "$payload.importBatch"] },
          count: { $sum: 1 },
          keepId: { $first: "$_id" },
          ids: { $push: "$_id" },
          newest: { $max: "$happenedAt" },
          oldest: { $min: "$happenedAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();

  const duplicateIds = groups.flatMap((group) => group.ids.slice(1));
  return {
    groups: groups.length,
    duplicateIds,
    duplicateCount: duplicateIds.length,
    keepRows: groups.map((group) => ({
      importBatch: group._id,
      keepId: group.keepId,
    })),
    topGroups: groups.slice(0, 12).map((group) => ({
      importBatch: group._id,
      count: group.count,
      keepId: String(group.keepId),
      oldest: group.oldest,
      newest: group.newest,
    })),
  };
}

async function repairKeptNcoaStaleSweepRows(collection, keepRows, commit) {
  if (!commit || keepRows.length === 0) return 0;
  const repairedAt = new Date();
  let repaired = 0;
  for (const row of keepRows) {
    if (!row.importBatch || !row.keepId) continue;
    const result = await collection.updateOne(
      { _id: row.keepId },
      {
        $set: {
          aggregateId: `${row.importBatch}-stale-sweep`,
          dedupeKey: `ncoa-stale-sweep:${row.importBatch}`,
          status: "warning",
          payload: {
            importBatch: row.importBatch,
            reason: "stale-no-activity",
            repairedAt,
          },
        },
      },
    );
    repaired += Number(result.modifiedCount || 0);
  }
  return repaired;
}

function transientOkQuery(cutoff) {
  return {
    happenedAt: { $lt: cutoff },
    status: "ok",
    stage: { $in: TRANSIENT_OK_STAGES },
    family: {
      $in: [
        "attribution-reconcile",
        "conversation",
        "cx",
        "demo-ringout",
        "dispatch",
        "lead",
        "lead-import",
        "metric",
        "metrics",
        "outbound",
        "qc",
        "review",
        "ringcentral",
      ],
    },
  };
}

function retryWorkflowQuery(cutoff) {
  return {
    happenedAt: { $lt: cutoff },
    family: "retry-job",
    subtype: { $in: ["hourly", "nightly"] },
    stage: "requested",
    status: "warning",
  };
}

async function main() {
  const commit = hasFlag("--commit");
  const dropAll = hasFlag("--drop-all");
  const includeTransient = hasFlag("--include-transient-ok");
  const includeRetryWorkflow = hasFlag("--include-retry-workflow");
  const olderThanDays = readNumberFlag("--older-than-days", 14);
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is required");

  await mongoose.connect(uri, { dbName: DEFAULT_DB });
  const db = mongoose.connection.db;
  const collection = db.collection("controlplaneworkflowrecords");
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

  const before = await collection.countDocuments();
  if (dropAll) {
    const report = {
      mode: commit ? "commit" : "dry-run",
      action: "drop-all-workflow-record-documents",
      db: mongoose.connection.name,
      before,
      note: "Deletes documents only; keeps the collection and indexes intact.",
      deleted: 0,
    };
    if (commit) {
      const result = await collection.deleteMany({});
      report.deleted = Number(result.deletedCount || 0);
      report.after = await collection.countDocuments();
    }
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    return;
  }

  const duplicateNcoa = await findDuplicateNcoaStaleSweep(collection);
  const transientOkCount = await collection.countDocuments(transientOkQuery(cutoff));
  const retryWorkflowCount = await collection.countDocuments(retryWorkflowQuery(cutoff));

  const report = {
    mode: commit ? "commit" : "dry-run",
    db: mongoose.connection.name,
    before,
    cutoff: cutoff.toISOString(),
    duplicateNcoaStaleSweep: {
      groups: duplicateNcoa.groups,
      duplicateCount: duplicateNcoa.duplicateCount,
      topGroups: duplicateNcoa.topGroups,
      action: "safe to prune; keeps newest terminal envelope per importBatch",
    },
    transientOkOlderThanCutoff: {
      count: transientOkCount,
      includedForDelete: includeTransient,
    },
    retryWorkflowOlderThanCutoff: {
      count: retryWorkflowCount,
      includedForDelete: includeRetryWorkflow,
    },
    deleted: {
      duplicateNcoaStaleSweep: 0,
      transientOk: 0,
      retryWorkflow: 0,
    },
    repaired: {
      keptNcoaStaleSweepRows: 0,
    },
  };

  if (commit) {
    report.deleted.duplicateNcoaStaleSweep = await deleteIds(
      collection,
      duplicateNcoa.duplicateIds,
      true,
    );
    report.repaired.keptNcoaStaleSweepRows = await repairKeptNcoaStaleSweepRows(
      collection,
      duplicateNcoa.keepRows,
      true,
    );
    if (includeTransient) {
      const result = await collection.deleteMany(transientOkQuery(cutoff));
      report.deleted.transientOk = Number(result.deletedCount || 0);
    }
    if (includeRetryWorkflow) {
      const result = await collection.deleteMany(retryWorkflowQuery(cutoff));
      report.deleted.retryWorkflow = Number(result.deletedCount || 0);
    }
    report.after = await collection.countDocuments();
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore shutdown errors
  }
  process.exit(1);
});
