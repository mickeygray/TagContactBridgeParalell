"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");

const TARGET_DB = "tagcontactbridge_parallel";

const OLD_SAME_NAME_COLLECTIONS = Object.freeze([
  "clients",
  "dailypaymentsummaries",
  "dailyschedules",
  "dailyspends",
  "dailysummaries",
  "leadcadences",
  "mailerconfigs",
  "rb_agents",
  "rb_caseprofiles",
  "rb_contactactivities",
  "rb_dailycallstats",
  "rb_dailycasehealthsnapshots",
  "rb_eventlogs",
  "rb_paymentalerts",
  "rb_sourcecanonicals",
]);

const LEGACY_MIRROR_COLLECTIONS = Object.freeze([
  "legacy_dailypaymentsummaries",
  "legacy_dailyspends",
  "legacy_dailysummaries",
  "legacy_mailerconfigs",
  "legacy_metrics_sync_state",
  "legacy_rb_dailycallstats",
  "legacy_rb_paymentalerts",
  "legacy_rb_sourcecanonicals",
]);

function parseArgs(argv) {
  const requestedGroups = new Set();
  for (const arg of argv) {
    if (arg.startsWith("--group=")) {
      for (const group of arg.slice("--group=".length).split(",")) {
        if (group.trim()) requestedGroups.add(group.trim());
      }
    }
  }
  return {
    commit: argv.includes("--commit"),
    forceDb: argv.includes("--force-db"),
    includeParallelTestCopy: argv.includes("--include-parallel-test-copy"),
    groups: requestedGroups.size > 0 ? [...requestedGroups] : ["legacyRaw"],
  };
}

async function collectionStats(db, name) {
  const collection = db.collection(name);
  const [count, stats] = await Promise.all([
    collection.estimatedDocumentCount().catch(() => 0),
    db.command({ collStats: name }).catch(() => ({})),
  ]);
  return {
    name,
    count,
    storageBytes: Number(stats.storageSize || 0),
    indexBytes: Number(stats.totalIndexSize || 0),
    indexes: Number(stats.nindexes || 0),
  };
}

function bytesToMb(value) {
  return Number((Number(value || 0) / 1048576).toFixed(2));
}

function summarize(rows) {
  const storageBytes = rows.reduce((sum, row) => sum + row.storageBytes, 0);
  const indexBytes = rows.reduce((sum, row) => sum + row.indexBytes, 0);
  return {
    collections: rows.length,
    documents: rows.reduce((sum, row) => sum + Number(row.count || 0), 0),
    storageMB: bytesToMb(storageBytes),
    indexMB: bytesToMb(indexBytes),
    totalMB: bytesToMb(storageBytes + indexBytes),
  };
}

async function resolveCandidates(db, groups, options = {}) {
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name),
  );
  const byGroup = {
    legacyRaw: [...existing].filter((name) => name.startsWith("legacy_raw_")).sort(),
    legacyMirror: LEGACY_MIRROR_COLLECTIONS.filter((name) => existing.has(name)),
    oldSameName: OLD_SAME_NAME_COLLECTIONS.filter((name) => existing.has(name)),
  };

  const unknown = groups.filter((group) => !Object.prototype.hasOwnProperty.call(byGroup, group));
  if (unknown.length > 0) {
    throw new Error(`Unknown group(s): ${unknown.join(", ")}`);
  }
  const protectedGroups = groups.filter((group) => group !== "legacyRaw");
  if (protectedGroups.length > 0 && !options.includeParallelTestCopy) {
    throw new Error(
      [
        `Refusing to target ${protectedGroups.join(", ")}.`,
        "Those collections are the cloned test-shaped data inside Parallel.",
        "Use --include-parallel-test-copy only after confirming they are no longer needed.",
      ].join(" "),
    );
  }

  const names = [...new Set(groups.flatMap((group) => byGroup[group]))].sort();
  const rows = [];
  for (const name of names) {
    rows.push(await collectionStats(db, name));
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = getSharedConfig();

  if (!config.mongoUri) {
    throw new Error("Missing MONGO_URI");
  }
  if (String(config.parallelDbName || "") !== TARGET_DB && !args.forceDb) {
    throw new Error(
      `Refusing to run against db=${config.parallelDbName}. Expected ${TARGET_DB}. Use --force-db if intentional.`,
    );
  }

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const db = mongoose.connection.db;
    const candidates = await resolveCandidates(db, args.groups, args);
    const plan = {
      db: mongoose.connection.name,
      commit: args.commit,
      groups: args.groups,
      summary: summarize(candidates),
      collections: candidates
        .sort((a, b) => (b.storageBytes + b.indexBytes) - (a.storageBytes + a.indexBytes))
        .map((row) => ({
          name: row.name,
          count: row.count,
          totalMB: bytesToMb(row.storageBytes + row.indexBytes),
          indexes: row.indexes,
        })),
    };

    console.log(JSON.stringify(plan, null, 2));
    if (!args.commit) {
      console.log("Dry run only. Re-run with --commit to drop these collections.");
      return;
    }

    for (const row of candidates) {
      console.log(`[drop] ${row.name}`);
      await db.dropCollection(row.name);
    }
    console.log(`Dropped ${candidates.length} legacy ghost collection(s).`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
