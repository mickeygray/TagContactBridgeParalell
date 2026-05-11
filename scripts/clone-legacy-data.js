"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(ROOT, "ops");

const NATURAL_KEY_FILTERS = {
  agentstates: (doc) => withKeys(doc, ["extensionId"]),
  controlplanecallledgers: (doc) => withKeys(doc, ["domain", "telephonySessionId"]),
  controlplanecalllogs: (doc) => withKeys(doc, ["domain", "telephonySessionId"]),
  controlplanecaseprofiles: (doc) => withKeys(doc, ["domain", "caseId"]),
  controlplaneconversationworkflows: (doc) => withKeys(doc, ["domain", "phone", "channel"]),
  controlplanedailycallstats: (doc) => withKeys(doc, ["date", "piece"]),
  controlplaneleadcadences: (doc) => withKeys(doc, ["domain", "caseId"]),
  controlplanemailerconfigs: (doc) => withKeys(doc, ["digits"]) || withKeys(doc, ["phone"]),
  controlplanemasterprospectindexes: (doc) => withKeys(doc, ["domain", "caseId"]),
  controlplanemetricssnapshots: (doc) => withKeys(doc, ["domain", "bucketType", "bucketKey"]),
  controlplanepaymentalerts: (doc) => withKeys(doc, ["caseId", "domain", "paymentDate"]),
  controlplanepaymentledgers: (doc) => withKeys(doc, ["casePaymentId"]),
  controlplaneprepings: (doc) => withKeys(doc, ["domain", "emailHash"]),
  controlplanesourcecanonicals: (doc) => withKeys(doc, ["canonicalKey"]),
  eventrecords: (doc) => withKeys(doc, ["sourceService", "dedupeKey"]),
  hourlyjobevents: (doc) => withKeys(doc, ["lane", "dedupeKey"]),
  socialresponderconfigs: (doc) => withKeys(doc, ["domain", "platform"]),
  useraccounts: (doc) => withKeys(doc, ["email"]),
};

function readFlagValue(argv, name) {
  const prefixed = argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1) {
    return argv[index + 1];
  }
  return null;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  return {
    sourceDb: readFlagValue(argv, "--source") ||
      process.env.LEGACY_READ_DB_NAME ||
      process.env.LEGACY_APP_DB_NAME ||
      "test",
    targetDb: readFlagValue(argv, "--target") ||
      process.env.PARALLEL_DB_NAME ||
      "tagcontactbridge_parallel",
    collections: parseList(readFlagValue(argv, "--collections")),
    batchSize: Math.max(1, Math.min(5000, Number(readFlagValue(argv, "--batch-size") || 1000))),
    dryRun: argv.includes("--dry-run"),
    rawOverlapCopies: !argv.includes("--no-raw-overlaps"),
  };
}

function cleanIndexOptions(index) {
  const ignored = new Set(["v", "key", "ns"]);
  const options = {};
  for (const [key, value] of Object.entries(index || {})) {
    if (ignored.has(key)) continue;
    options[key] = value;
  }
  return options;
}

function withKeys(doc = {}, keys = []) {
  const filter = {};
  for (const key of keys) {
    const value = doc[key];
    if (value === undefined || value === null || value === "") {
      return null;
    }
    filter[key] = value;
  }
  return filter;
}

function mirrorDoc(doc, context) {
  return {
    ...doc,
    _mirroredFromDb: context.sourceDb,
    _mirroredFromCollection: context.sourceCollection,
    _mirroredAt: context.mirroredAt,
    _mirrorRunId: context.runId,
  };
}

function upsertFilter(collectionName, doc) {
  const byNaturalKey = NATURAL_KEY_FILTERS[collectionName];
  return byNaturalKey?.(doc) || { _id: doc._id };
}

async function copyIndexes(sourceCollection, targetCollection, { dryRun }) {
  const indexes = await sourceCollection.indexes().catch(() => []);
  const results = [];
  for (const index of indexes) {
    if (index.name === "_id_") continue;
    const options = cleanIndexOptions(index);
    if (dryRun) {
      results.push({ name: index.name, dryRun: true });
      continue;
    }
    try {
      await targetCollection.createIndex(index.key, options);
      results.push({ name: index.name, ok: true });
    } catch (error) {
      results.push({ name: index.name, ok: false, error: error.message });
    }
  }
  return results;
}

async function copyCollection({
  sourceDb,
  targetDb,
  sourceName,
  targetName,
  sourceDbName,
  runId,
  batchSize,
  dryRun,
  copyIndexes,
}) {
  const sourceCollection = sourceDb.collection(sourceName);
  const targetCollection = targetDb.collection(targetName);
  const sourceCount = await sourceCollection.estimatedDocumentCount();
  const beforeCount = await targetCollection.estimatedDocumentCount().catch(() => 0);
  const mirroredAt = new Date();
  const indexResults = copyIndexes
    ? await copyIndexesFromSource(sourceCollection, targetCollection, { dryRun })
    : [];

  if (dryRun || sourceCount === 0) {
    return {
      sourceCollection: sourceName,
      targetCollection: targetName,
      sourceCount,
      beforeCount,
      afterCount: beforeCount,
      upserted: 0,
      matchedExisting: 0,
      errors: [],
      indexes: indexResults,
      dryRun,
    };
  }

  const cursor = sourceCollection.find({}, { noCursorTimeout: true });
  let batch = [];
  let upserted = 0;
  let matchedExisting = 0;
  const errors = [];

  async function flush() {
    if (batch.length === 0) return;
    const ops = batch.map((doc) => ({
      updateOne: {
        filter: upsertFilter(sourceName, doc),
        update: {
          $setOnInsert: mirrorDoc(doc, {
            sourceDb: sourceDbName,
            sourceCollection: sourceName,
            mirroredAt,
            runId,
          }),
        },
        upsert: true,
      },
    }));
    batch = [];

    try {
      const result = await targetCollection.bulkWrite(ops, { ordered: false });
      upserted += result.upsertedCount || 0;
      matchedExisting += result.matchedCount || 0;
    } catch (error) {
      const writeErrors = error?.writeErrors || [];
      upserted += error?.result?.upsertedCount || 0;
      matchedExisting += error?.result?.matchedCount || 0;
      if (writeErrors.length === 0) {
        errors.push({ message: error.message });
        return;
      }
      for (const writeError of writeErrors.slice(0, 25)) {
        errors.push({
          index: writeError.index,
          code: writeError.code,
          message: writeError.errmsg || writeError.message,
        });
      }
      if (writeErrors.length > 25) {
        errors.push({ message: `${writeErrors.length - 25} additional write errors omitted` });
      }
    }
  }

  try {
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= batchSize) {
        await flush();
      }
    }
    await flush();
  } finally {
    await cursor.close().catch(() => null);
  }

  const afterCount = await targetCollection.estimatedDocumentCount().catch(() => null);
  return {
    sourceCollection: sourceName,
    targetCollection: targetName,
    sourceCount,
    beforeCount,
    afterCount,
    upserted,
    matchedExisting,
    errors,
    indexes: indexResults,
    dryRun,
  };
}

async function copyIndexesFromSource(sourceCollection, targetCollection, options) {
  return copyIndexes(sourceCollection, targetCollection, options);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGO_URI) {
    throw new Error("Missing MONGO_URI");
  }
  if (args.sourceDb === args.targetDb) {
    throw new Error("Source and target DB names must differ");
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const conn = await mongoose.createConnection(process.env.MONGO_URI, {
    dbName: args.targetDb,
    serverSelectionTimeoutMS: 10000,
  }).asPromise();

  try {
    const sourceDb = conn.useDb(args.sourceDb, { useCache: true }).db;
    const targetDb = conn.useDb(args.targetDb, { useCache: true }).db;
    const sourceCollections = (await sourceDb.listCollections({}, { nameOnly: true }).toArray())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("system."))
      .filter((name) => args.collections.length === 0 || args.collections.includes(name))
      .sort();
    const targetCollectionSet = new Set(
      (await targetDb.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
    );

    const plan = [];
    for (const collectionName of sourceCollections) {
      const existsInTarget = targetCollectionSet.has(collectionName);
      plan.push({
        sourceName: collectionName,
        targetName: collectionName,
        copyIndexes: !existsInTarget,
        mode: existsInTarget ? "same-name-insert-missing-only" : "same-name-full-mirror",
      });
      if (existsInTarget && args.rawOverlapCopies) {
        plan.push({
          sourceName: collectionName,
          targetName: `legacy_raw_${collectionName}`,
          copyIndexes: !targetCollectionSet.has(`legacy_raw_${collectionName}`),
          mode: "raw-overlap-preservation",
        });
      }
    }

    console.log(JSON.stringify({
      dryRun: args.dryRun,
      sourceDb: args.sourceDb,
      targetDb: args.targetDb,
      collections: sourceCollections.length,
      operations: plan.length,
      rawOverlapCopies: args.rawOverlapCopies,
      runId,
    }, null, 2));

    const results = [];
    for (const entry of plan) {
      console.log(`[clone] ${entry.sourceName} -> ${entry.targetName} (${entry.mode})`);
      const result = await copyCollection({
        sourceDb,
        targetDb,
        sourceName: entry.sourceName,
        targetName: entry.targetName,
        sourceDbName: args.sourceDb,
        runId,
        batchSize: args.batchSize,
        dryRun: args.dryRun,
        copyIndexes: entry.copyIndexes,
      });
      results.push({ ...entry, ...result });
      console.log(`[clone] ${entry.targetName}: source=${result.sourceCount} inserted=${result.upserted} existing=${result.matchedExisting} errors=${result.errors.length}`);
    }

    const summary = {
      dryRun: args.dryRun,
      sourceDb: args.sourceDb,
      targetDb: args.targetDb,
      runId,
      startedAt: runId,
      finishedAt: new Date().toISOString(),
      totals: {
        sourceRows: results.reduce((sum, row) => sum + Number(row.sourceCount || 0), 0),
        insertedRows: results.reduce((sum, row) => sum + Number(row.upserted || 0), 0),
        matchedExistingRows: results.reduce((sum, row) => sum + Number(row.matchedExisting || 0), 0),
        errorCount: results.reduce((sum, row) => sum + Number(row.errors?.length || 0), 0),
      },
      results,
    };

    if (!fs.existsSync(REPORT_DIR)) {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
    }
    const reportPath = path.join(REPORT_DIR, `legacy-db-clone-report-${runId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");
    console.log(`Wrote clone report to ${reportPath}`);
    console.log(JSON.stringify(summary.totals, null, 2));
  } finally {
    await conn.close();
  }
}

main().catch((error) => {
  console.error("clone-legacy-data failed:", error);
  process.exit(1);
});
