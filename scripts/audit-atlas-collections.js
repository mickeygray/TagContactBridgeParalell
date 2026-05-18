"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");

const DEFAULT_TOP = 40;
const DATE_FIELDS = [
  "createdAt",
  "updatedAt",
  "happenedAt",
  "receivedAt",
  "sentAt",
  "startedAt",
  "finishedAt",
  "processedAt",
  "queuedAt",
  "resolvedAt",
  "completedAt",
  "lastSeenAt",
  "firstSeenAt",
  "lastTouchedAt",
  "lastStatusCheckAt",
  "lastSourceCheckAt",
  "lastRetryAt",
  "nextAttemptAt",
  "lockedAt",
  "lockedUntil",
];

const DUPLICATE_CHECKS = [
  {
    collection: "controlplanemasterprospectindexes",
    label: "domain+caseId",
    fields: ["domain", "caseId"],
  },
  {
    collection: "controlplaneleadcadences",
    label: "domain+caseId",
    fields: ["domain", "caseId"],
  },
  {
    collection: "controlplanecaseprofiles",
    label: "domain+caseId",
    fields: ["domain", "caseId"],
  },
  {
    collection: "controlplanemailimports",
    label: "domain+caseId",
    fields: ["domain", "caseId"],
  },
  {
    collection: "controlplanecalllogs",
    label: "domain+telephonySessionId",
    fields: ["domain", "telephonySessionId"],
  },
  {
    collection: "controlplanepaymentledgers",
    label: "casePaymentId",
    fields: ["casePaymentId"],
  },
  {
    collection: "controlplanesourcecanonicals",
    label: "canonicalKey",
    fields: ["canonicalKey"],
  },
  {
    collection: "controlplaneconversationworkflows",
    label: "domain+phone+channel",
    fields: ["domain", "phone", "channel"],
  },
  {
    collection: "hourlyjobevents",
    label: "lane+dedupeKey",
    fields: ["lane", "dedupeKey"],
    match: { dedupeKey: { $type: "string", $ne: "" } },
  },
  {
    collection: "eventrecords",
    label: "sourceService+dedupeKey",
    fields: ["sourceService", "dedupeKey"],
    match: { dedupeKey: { $type: "string", $ne: "" } },
  },
  {
    collection: "queueitems",
    label: "active leadId",
    fields: ["leadId"],
    match: { state: { $in: ["queued", "leased", "assigned", "in_progress"] } },
  },
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? fallback : value;
}

function argNumber(name, fallback) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function bytes(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = number;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => {
      if (value === null || value === undefined) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (typeof value === "object" && Object.keys(value).length === 0) return false;
      return true;
    }),
  );
}

async function safe(label, fn, fallback = null) {
  try {
    return await fn();
  } catch (error) {
    return {
      error: label,
      message: error && error.message ? error.message : String(error),
    };
  }
}

async function collectionStats(db, name) {
  const stats = await safe("collStats", () => db.command({ collStats: name, scale: 1 }));
  if (!stats || stats.error) return stats;
  return {
    sizeBytes: stats.size || 0,
    storageBytes: stats.storageSize || 0,
    indexBytes: stats.totalIndexSize || 0,
    avgObjBytes: stats.avgObjSize || 0,
  };
}

async function dateWatermarks(collection) {
  const group = { _id: null };
  for (const field of DATE_FIELDS) {
    group[field] = { $max: `$${field}` };
  }
  const [row] = await collection.aggregate([{ $group: group }], { allowDiskUse: false }).toArray();
  if (!row) return {};
  const result = {};
  for (const field of DATE_FIELDS) {
    const value = iso(row[field]);
    if (value) result[field] = value;
  }
  return result;
}

async function topValues(collection, field, limit = 8) {
  const rows = await collection
    .aggregate([
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ])
    .toArray();
  const nonNullRows = rows.filter((row) => row._id !== null && row._id !== undefined);
  if (nonNullRows.length === 0) return [];
  return nonNullRows.map((row) => ({ value: row._id, count: row.count }));
}

async function duplicateSummary(db, collectionNames) {
  const checks = [];
  for (const check of DUPLICATE_CHECKS) {
    if (!collectionNames.has(check.collection)) continue;
    const collection = db.collection(check.collection);
    const groupId = Object.fromEntries(check.fields.map((field) => [field, `$${field}`]));
    const pipeline = [];
    if (check.match) pipeline.push({ $match: check.match });
    pipeline.push(
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
      {
        $group: {
          _id: null,
          duplicateGroups: { $sum: 1 },
          duplicateDocsBeyondFirst: { $sum: { $subtract: ["$count", 1] } },
          worstCount: { $max: "$count" },
          examples: { $push: { key: "$_id", count: "$count" } },
        },
      },
      {
        $project: {
          _id: 0,
          duplicateGroups: 1,
          duplicateDocsBeyondFirst: 1,
          worstCount: 1,
          examples: { $slice: ["$examples", 5] },
        },
      },
    );
    const [result] = await collection.aggregate(pipeline, { allowDiskUse: true }).toArray();
    checks.push({
      collection: check.collection,
      key: check.label,
      duplicateGroups: result ? result.duplicateGroups : 0,
      duplicateDocsBeyondFirst: result ? result.duplicateDocsBeyondFirst : 0,
      worstCount: result ? result.worstCount : 0,
      examples: result ? result.examples : [],
    });
  }
  return checks;
}

async function count(collection, query) {
  return collection.countDocuments(query);
}

async function targetedHealth(db, collectionNames) {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const health = {};

  if (collectionNames.has("hourlyjobevents")) {
    const col = db.collection("hourlyjobevents");
    health.hourlyJobEvents = {
      byStatus: await topValues(col, "status"),
      byLane: await topValues(col, "lane"),
      byTargetService: await topValues(col, "targetService"),
      actionNeeded: {
        pendingPastDue: await count(col, {
          status: "pending",
          nextAttemptAt: { $lte: now },
        }),
        processingOlderThan6h: await count(col, {
          status: "processing",
          updatedAt: { $lte: sixHoursAgo },
        }),
        failedOrDeadLetter: await count(col, {
          status: { $in: ["failed", "dead-letter"] },
        }),
      },
    };
  }

  if (collectionNames.has("eventrecords")) {
    const col = db.collection("eventrecords");
    health.eventRecords = {
      byStatus: await topValues(col, "status"),
      bySourceService: await topValues(col, "sourceService"),
      actionNeeded: {
        pendingPastDue: await count(col, {
          status: "pending",
          nextAttemptAt: { $lte: now },
        }),
        processingOlderThan6h: await count(col, {
          status: "processing",
          updatedAt: { $lte: sixHoursAgo },
        }),
        failed: await count(col, { status: "failed" }),
      },
    };
  }

  if (collectionNames.has("controlplanecalllogs")) {
    const col = db.collection("controlplanecalllogs");
    health.callLogs = {
      byStatus: await topValues(col, "status"),
      byPlatform: await topValues(col, "platform"),
      byTranscriptionStatus: await topValues(col, "transcription.status"),
      byArchiveStatus: await topValues(col, "recordingArchive.status"),
      actionNeeded: {
        pendingRetryOlderThan7d: await count(col, {
          status: "pending-retry",
          createdAt: { $lte: sevenDaysAgo },
        }),
        transcriptionProcessingOlderThan6h: await count(col, {
          "transcription.status": "processing",
          updatedAt: { $lte: sixHoursAgo },
        }),
        archiveProcessingOlderThan6h: await count(col, {
          "recordingArchive.status": "processing",
          updatedAt: { $lte: sixHoursAgo },
        }),
      },
    };
  }

  if (collectionNames.has("controlplaneleadcadences")) {
    const col = db.collection("controlplaneleadcadences");
    health.leadCadences = {
      byActive: await topValues(col, "active"),
      byMode: await topValues(col, "cadenceMode"),
      byNextActionType: await topValues(col, "schedule.nextActionType"),
      actionNeeded: {
        activeOverdueNextAction: await count(col, {
          active: true,
          "schedule.nextActionAt": { $lte: now },
        }),
        activeWithoutNextAction: await count(col, {
          active: true,
          "schedule.nextActionAt": null,
        }),
      },
    };
  }

  if (collectionNames.has("controlplanemasterprospectindexes")) {
    const col = db.collection("controlplanemasterprospectindexes");
    health.masterProspects = {
      byDomain: await topValues(col, "domain"),
      byPoolTag: await topValues(col, "pool.tag"),
      byStatusCategory: await topValues(col, "statusCategory"),
      actionNeeded: {
        needsStatusRefresh: await count(col, { needsStatusRefresh: true }),
        needsSourceRefresh: await count(col, { needsSourceRefresh: true }),
        inCurrentPools: await count(col, { "pool.tag": { $type: "string", $ne: "" } }),
      },
    };
  }

  if (collectionNames.has("controlplaneconversationmessages")) {
    const col = db.collection("controlplaneconversationmessages");
    health.conversationMessages = {
      byDirection: await topValues(col, "direction"),
      byChannel: await topValues(col, "channel"),
      byProviderStatus: await topValues(col, "providerStatus"),
      byAiTier: await topValues(col, "aiClassification.tier"),
      actionNeeded: {
        outboundFailed: await count(col, {
          direction: "outbound",
          providerStatus: { $in: ["failed", "undelivered"] },
        }),
        inboundNeedsHuman: await count(col, {
          direction: "inbound",
          "aiClassification.tier": "needs_human",
        }),
      },
    };
  }

  if (collectionNames.has("controlplanemailimports")) {
    const col = db.collection("controlplanemailimports");
    health.mailImports = {
      byImportBatch: await topValues(col, "importBatch"),
      byDomain: await topValues(col, "domain"),
    };
  }

  if (collectionNames.has("controlplanerunlocks")) {
    const col = db.collection("controlplanerunlocks");
    health.runLocks = {
      total: await count(col, {}),
      expiredButStillPresent: await count(col, { lockedUntil: { $lt: now } }),
      ttlNote: "expired rows can linger briefly until Mongo's TTL monitor runs",
    };
  }

  return health;
}

function classifyCollectionRisk(row) {
  const notes = [];
  const lower = row.name.toLowerCase();
  if (row.count >= 50000) notes.push("high row count");
  if (row.storageBytes >= 50 * 1024 * 1024) notes.push("large storage footprint");
  if (/(temp|tmp|scratch|staging|backup|clone|legacy|old)/i.test(lower)) {
    notes.push("temporary/legacy-looking name");
  }
  if (row.count > 0 && lower.includes("workflow")) notes.push("workflow/receipt collection");
  if (row.count > 1000 && row.ttlIndexes.length === 0 && /(event|record|message|log|audit|queue)/i.test(lower)) {
    notes.push("append-only-looking collection without TTL");
  }
  return notes;
}

async function main() {
  const config = getSharedConfig();
  const top = argNumber("--top", DEFAULT_TOP);
  const outPath = argValue("--out", "");
  const jsonOnly = hasFlag("--json");

  if (!config.mongoUri) throw new Error("Missing MONGO_URI");

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const db = mongoose.connection.db;
    const startedAt = new Date();
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    const collectionNames = new Set(collections.map((collection) => collection.name));
    const dbStats = await safe("dbStats", () => db.command({ dbStats: 1, scale: 1 }));

    const rows = [];
    for (const item of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      const collection = db.collection(item.name);
      const [countValue, statsValue, indexesValue, datesValue, statusTopValue, domainTopValue] =
        await Promise.all([
          safe("countDocuments", () => collection.countDocuments({}), 0),
          collectionStats(db, item.name),
          safe("indexes", () => collection.indexes(), []),
          safe("dateWatermarks", () => dateWatermarks(collection), {}),
          safe("statusTop", () => topValues(collection, "status", 5), []),
          safe("domainTop", () => topValues(collection, "domain", 5), []),
        ]);

      const indexes = Array.isArray(indexesValue) ? indexesValue : [];
      const stats = statsValue && !statsValue.error ? statsValue : {};
      const row = {
        name: item.name,
        count: Number(countValue || 0),
        sizeBytes: Number(stats.sizeBytes || 0),
        storageBytes: Number(stats.storageBytes || 0),
        indexBytes: Number(stats.indexBytes || 0),
        avgObjBytes: Number(stats.avgObjBytes || 0),
        indexCount: indexes.length,
        uniqueIndexes: indexes
          .filter((index) => index.unique)
          .map((index) => ({ name: index.name, key: index.key })),
        ttlIndexes: indexes
          .filter((index) => index.expireAfterSeconds !== undefined)
          .map((index) => ({
            name: index.name,
            key: index.key,
            expireAfterSeconds: index.expireAfterSeconds,
          })),
        latestDates: datesValue && !datesValue.error ? datesValue : {},
        statusTop: Array.isArray(statusTopValue) ? statusTopValue : [],
        domainTop: Array.isArray(domainTopValue) ? domainTopValue : [],
      };
      row.riskNotes = classifyCollectionRisk(row);
      rows.push(row);
    }

    const duplicates = await duplicateSummary(db, collectionNames);
    const health = await targetedHealth(db, collectionNames);

    const report = {
      db: mongoose.connection.name,
      generatedAt: new Date().toISOString(),
      auditedCollections: rows.length,
      dbStats:
        dbStats && !dbStats.error
          ? {
              collections: dbStats.collections,
              objects: dbStats.objects,
              dataSize: dbStats.dataSize,
              storageSize: dbStats.storageSize,
              indexSize: dbStats.indexSize,
              dataSizeHuman: bytes(dbStats.dataSize),
              storageSizeHuman: bytes(dbStats.storageSize),
              indexSizeHuman: bytes(dbStats.indexSize),
            }
          : dbStats,
      topByCount: rows
        .slice()
        .sort((a, b) => b.count - a.count)
        .slice(0, top)
        .map((row) =>
          compactObject({
            name: row.name,
            count: row.count,
            storage: bytes(row.storageBytes),
            indexes: bytes(row.indexBytes),
            riskNotes: row.riskNotes,
          }),
        ),
      topByStorage: rows
        .slice()
        .sort((a, b) => b.storageBytes - a.storageBytes)
        .slice(0, top)
        .map((row) =>
          compactObject({
            name: row.name,
            count: row.count,
            storage: bytes(row.storageBytes),
            indexes: bytes(row.indexBytes),
            avgObj: row.avgObjBytes ? bytes(row.avgObjBytes) : null,
            riskNotes: row.riskNotes,
          }),
        ),
      appendOnlyNoTtl: rows
        .filter((row) =>
          row.riskNotes.some((note) => note.includes("without TTL")),
        )
        .map((row) => ({
          name: row.name,
          count: row.count,
          storage: bytes(row.storageBytes),
          latestDates: row.latestDates,
        })),
      temporaryOrLegacyNames: rows
        .filter((row) => row.riskNotes.includes("temporary/legacy-looking name"))
        .map((row) => ({ name: row.name, count: row.count, storage: bytes(row.storageBytes) })),
      collectionsWithTtl: rows
        .filter((row) => row.ttlIndexes.length > 0)
        .map((row) => ({ name: row.name, ttlIndexes: row.ttlIndexes, count: row.count })),
      duplicateChecks: duplicates,
      targetedHealth: health,
      allCollections: rows,
      elapsedMs: Date.now() - startedAt.getTime(),
    };

    if (outPath) {
      const resolved = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
      if (!jsonOnly) console.log(`Wrote ${resolved}`);
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(error.stack || error.message || error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
