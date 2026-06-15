"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const { once } = require("events");
const mongoose = require("mongoose");
const { EJSON } = require("bson");

const {
  assertExpectedDb,
  assertFamiliarDb,
  assertBackupIntegrity,
  assertDeleteIntegrity,
  assertNoLiveTouched,
  verifyDumpFile,
} = require("./lib/pruneSafety");

const DEFAULT_DB = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
const DEFAULT_CUTOFF = "2026-06-01T07:00:00.000Z"; // June 1, 2026 at midnight Pacific.
const DEFAULT_OUT_DIR = path.join("runtime", "mongo-retention");
const DELETE_BATCH = 5000;

// At least one of these must exist or the run refuses (guards against wrong/empty cluster).
const SENTINEL_COLLECTIONS = ["controlplanecaseprofiles", "controlplanepaymentledgers", "eventrecords"];

// SAFETY: three of these collections double as LIVE work queues / open review state.
// Their consumers select by STATUS with NO date floor, so a date-only delete would
// silently drop claimable/open work regardless of age:
//   - eventrecords:      eventService.claimNextEvent picks status in {pending,failed,replayed}
//   - hourlyjobevents:   hourlyJobEventService.claimNextHourlyJobEvent picks {pending,failed}
//   - reviewqueueitems:  reviewQueueRepository.list/countReviewQueueItems surface status=open (badge counts)
// For those, `terminalStatuses` restricts deletion to rows that are DONE. The pre-June
// dry-run (2026-06-15) found 37,499 live events, 970 live hourly jobs, and 108,514 open
// review items that a date-only prune would have destroyed. Pass --include-open-review to
// additionally drop pre-June open review items (the operator-declared "noise"); events and
// hourly jobs are NEVER opened up to live-status deletion by any flag.
const TARGETS = [
  {
    name: "controlplaneworkflowrecords",
    dateField: "happenedAt",
    reason: "append-only workflow ledger; June-forward evidence is retained",
  },
  {
    name: "eventrecords",
    dateField: "createdAt",
    statusField: "status",
    terminalStatuses: ["completed", "dead-letter"],
    reason: "async event ledger; only terminal events are pruned (live retries preserved)",
  },
  {
    name: "hourlyjobevents",
    dateField: "createdAt",
    statusField: "status",
    terminalStatuses: ["completed", "dead-letter"],
    reason: "retry-job queue ledger; only terminal jobs are pruned (pending/failed preserved)",
  },
  {
    name: "controlplanereviewqueueitems",
    dateField: "happenedAt",
    statusField: "status",
    terminalStatuses: ["reviewed", "dismissed"],
    reason: "human review queue; resolved rows pruned by default, open rows only with --include-open-review",
  },
  {
    name: "livecoach_sessions",
    dateField: "createdAt",
    reason: "coach test/live session memory; not used for production call metrics",
  },
  {
    name: "legacy_raw_controlplanemasterprospectindexes",
    dateField: "updatedAt",
    reason: "legacy migration copy; current MPI/MailImport/LeadCadence are authoritative",
  },
];

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildRunId(cutoff) {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-cutoff-${cutoff
    .toISOString()
    .slice(0, 10)}`;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildDateMatch(dateField, cutoff) {
  return { [dateField]: { $type: "date", $lt: cutoff } };
}

// What we will actually delete: pre-cutoff AND (if the target is a live queue) terminal-only.
function buildDeleteMatch(target, cutoff) {
  const match = buildDateMatch(target.dateField, cutoff);
  if (Array.isArray(target.terminalStatuses) && target.terminalStatuses.length > 0) {
    match[target.statusField || "status"] = { $in: target.terminalStatuses };
  }
  return match;
}

// The complement: pre-cutoff rows we are intentionally PRESERVING (live retries / open
// review). Counted before AND after delete to PROVE we never touched live work (gate G4).
function buildPreserveMatch(target, cutoff) {
  const match = buildDateMatch(target.dateField, cutoff);
  match[target.statusField || "status"] = { $nin: target.terminalStatuses };
  return match;
}

function isGuarded(target) {
  return Array.isArray(target.terminalStatuses) && target.terminalStatuses.length > 0;
}

async function summarizeCollection({ collection, target, match }) {
  const [watermark] = await collection
    .aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          oldest: { $min: `$${target.dateField}` },
          newest: { $max: `$${target.dateField}` },
        },
      },
    ])
    .toArray();

  const topStatus = await collection
    .aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ])
    .toArray();

  return {
    count: watermark?.count || 0,
    oldest: iso(watermark?.oldest),
    newest: iso(watermark?.newest),
    topStatus,
  };
}

// Faithful EJSON dump that ALSO captures the exact _ids written. Deletion later targets
// these captured ids only, so we can never delete a row we did not back up.
async function dumpAndCaptureIds({ collection, target, match, dumpDir, runId }) {
  fs.mkdirSync(dumpDir, { recursive: true });
  const outPath = path.join(dumpDir, `${runId}.${target.name}.jsonl.gz`);
  const gzip = zlib.createGzip({ level: 6 });
  const file = fs.createWriteStream(outPath);
  gzip.pipe(file);

  const ids = [];
  const cursor = collection.find(match).sort({ [target.dateField]: 1, _id: 1 });
  for await (const doc of cursor) {
    // Canonical EJSON (relaxed:false) preserves exact BSON types ($oid/$date/$numberLong)
    // so a restore reconstructs documents byte-faithfully, not as lossy plain JSON.
    if (!gzip.write(`${EJSON.stringify(doc, { relaxed: false })}\n`)) await once(gzip, "drain");
    ids.push(doc._id);
  }
  gzip.end();
  await once(file, "finish");
  return { path: outPath, dumped: ids.length, ids };
}

async function deleteByIds(collection, ids, batchSize = DELETE_BATCH) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const result = await collection.deleteMany({ _id: { $in: chunk } });
    deleted += Number(result.deletedCount || 0);
  }
  return deleted;
}

// Process one collection with all gates enforced. Throws (fail-closed) if any invariant
// is not provably met; on dry-run it only reads.
async function processTarget({ db, target, cutoff, runId, dumpDir, apply }) {
  const exists = await db.listCollections({ name: target.name }, { nameOnly: true }).hasNext();
  if (!exists) {
    return { ...target, exists: false, matched: 0, preservedLive: 0, dumped: 0, verifiedLines: 0, deleted: 0, dump: null };
  }

  const collection = db.collection(target.name);
  const deleteMatch = buildDeleteMatch(target, cutoff);
  const guarded = isGuarded(target);

  const summary = await summarizeCollection({ collection, target, match: deleteMatch });
  const preservedBefore = guarded ? await collection.countDocuments(buildPreserveMatch(target, cutoff)) : 0;

  const row = {
    ...target,
    exists: true,
    matched: summary.count,
    preservedLive: preservedBefore,
    oldest: summary.oldest,
    newest: summary.newest,
    topStatus: summary.topStatus,
    dumped: 0,
    verifiedLines: 0,
    deleted: 0,
    dump: null,
  };

  if (!apply || summary.count === 0) return row;

  // 1) BACKUP — faithful EJSON, capturing the exact ids we will delete.
  const dump = await dumpAndCaptureIds({ collection, target, match: deleteMatch, dumpDir, runId });
  row.dump = { path: dump.path, dumped: dump.dumped };
  row.dumped = dump.dumped;

  // 2) GATE G2 — verify the backup on disk before deleting anything.
  const verified = await verifyDumpFile(dump.path);
  row.verifiedLines = verified.lines;
  assertBackupIntegrity({ collection: target.name, captured: dump.ids.length, dumpLines: verified.lines });

  // 3) DELETE — only the backed-up ids.
  const deleted = await deleteByIds(collection, dump.ids);
  row.deleted = deleted;

  // 4) GATE G3 — we deleted exactly what we backed up.
  assertDeleteIntegrity({ collection: target.name, captured: dump.ids.length, deleted });

  // 5) GATE G4 — the live/preserved population is unchanged.
  if (guarded) {
    const preservedAfter = await collection.countDocuments(buildPreserveMatch(target, cutoff));
    row.preservedAfter = preservedAfter;
    assertNoLiveTouched({ collection: target.name, preservedBefore, preservedAfter });
  }

  return row;
}

async function runPrune({ db, targets, cutoff, runId, dumpDir, apply }) {
  const report = {
    mode: apply ? "apply" : "dry-run",
    db: db.databaseName,
    cutoff: cutoff.toISOString(),
    dumpDir: apply ? dumpDir : null,
    startedAt: new Date().toISOString(),
    targets: [],
    totals: { matched: 0, preservedLive: 0, dumped: 0, verifiedLines: 0, deleted: 0 },
  };
  for (const target of targets) {
    const row = await processTarget({ db, target, cutoff, runId, dumpDir, apply });
    report.targets.push(row);
    report.totals.matched += row.matched || 0;
    report.totals.preservedLive += row.preservedLive || 0;
    report.totals.dumped += row.dumped || 0;
    report.totals.verifiedLines += row.verifiedLines || 0;
    report.totals.deleted += row.deleted || 0;
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// Restore a prior run's dumps. Idempotent: re-inserting existing _ids is skipped as a
// duplicate-key, so only genuinely missing rows come back.
async function restoreFromDump({ db, filePath, collectionName, batchSize = 1000 }) {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let read = 0;
  let inserted = 0;
  let duplicates = 0;
  let batch = [];
  async function flush() {
    if (batch.length === 0) return;
    try {
      const res = await db.collection(collectionName).insertMany(batch, { ordered: false });
      inserted += Number(res.insertedCount || 0);
    } catch (error) {
      inserted += Number(error.insertedCount || error.result?.insertedCount || 0);
      duplicates += Array.isArray(error.writeErrors) ? error.writeErrors.length : 0;
    }
    batch = [];
  }
  for await (const line of rl) {
    if (!line) continue;
    read += 1;
    batch.push(EJSON.parse(line));
    if (batch.length >= batchSize) await flush();
  }
  await flush();
  return { collection: collectionName, read, inserted, duplicates };
}

function collectionFromDumpName(fileName, runId) {
  const prefix = `${runId}.`;
  const suffix = ".jsonl.gz";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;
  return fileName.slice(prefix.length, fileName.length - suffix.length);
}

async function runRestore({ db, dumpDir, runId, only }) {
  if (!fs.existsSync(dumpDir)) throw new Error(`restore dir not found: ${dumpDir}`);
  const files = fs.readdirSync(dumpDir).filter((f) => f.endsWith(".jsonl.gz"));
  const report = { mode: "restore", db: db.databaseName, dumpDir, runId, startedAt: new Date().toISOString(), targets: [] };
  for (const file of files) {
    const collectionName = collectionFromDumpName(file, runId);
    if (!collectionName) continue;
    if (only.size > 0 && !only.has(collectionName)) continue;
    const result = await restoreFromDump({ db, filePath: path.join(dumpDir, file), collectionName });
    report.targets.push(result);
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

async function main() {
  const apply = hasFlag("--apply");
  const includeOpenReview = hasFlag("--include-open-review");
  const cutoff = new Date(argValue("--cutoff", DEFAULT_CUTOFF));
  const only = new Set(parseList(argValue("--only", "")));
  const skip = new Set(parseList(argValue("--skip", "")));
  const outDir = argValue("--out-dir", DEFAULT_OUT_DIR);
  const restoreRunId = argValue("--restore", null);
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

  if (!uri) throw new Error("MONGO_URI is required");
  if (Number.isNaN(cutoff.getTime())) throw new Error("Invalid --cutoff date");

  await mongoose.connect(uri, { dbName: DEFAULT_DB });
  const db = mongoose.connection.db;

  // GATE G1 — refuse to operate unless this is provably the intended application DB.
  assertExpectedDb(mongoose.connection.name, DEFAULT_DB);
  const presentNames = (await db.listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name);
  assertFamiliarDb(presentNames, SENTINEL_COLLECTIONS);

  let report;
  if (restoreRunId) {
    report = await runRestore({ db, dumpDir: path.resolve(outDir, restoreRunId), runId: restoreRunId, only });
  } else {
    const runId = buildRunId(cutoff);
    const dumpDir = path.resolve(outDir, runId);
    const targets = TARGETS.filter((target) => {
      if (only.size > 0 && !only.has(target.name)) return false;
      return !skip.has(target.name);
    }).map((target) => {
      // Opt-in: also delete pre-cutoff OPEN review items (operator-declared noise). Never
      // applies to eventrecords/hourlyjobevents — those stay terminal-only under all flags.
      if (includeOpenReview && target.name === "controlplanereviewqueueitems" && isGuarded(target)) {
        return { ...target, terminalStatuses: [...target.terminalStatuses, "open"] };
      }
      return target;
    });
    report = await runPrune({ db, targets, cutoff, runId, dumpDir, apply });
    report.includeOpenReview = includeOpenReview;

    fs.mkdirSync(path.resolve(outDir), { recursive: true });
    const reportPath = path.resolve(outDir, `${runId}.report.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.reportPath = reportPath;
  }

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error.stack || error.message || error);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore disconnect errors
    }
    process.exit(1);
  });
}

module.exports = {
  TARGETS,
  buildDeleteMatch,
  buildPreserveMatch,
  isGuarded,
  summarizeCollection,
  dumpAndCaptureIds,
  deleteByIds,
  processTarget,
  runPrune,
  restoreFromDump,
  runRestore,
  collectionFromDumpName,
};
