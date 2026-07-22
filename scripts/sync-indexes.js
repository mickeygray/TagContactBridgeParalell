"use strict";

// Walks the models we know need new indexes and runs `syncIndexes()` on
// each. Adds missing indexes, drops removed-from-schema indexes, leaves
// matching ones alone. Safe to run repeatedly.
//
// Mongoose's `autoIndex` is typically off in prod (it auto-creates on
// model load in dev, but ops disable it to avoid surprise index builds
// at startup). Running this explicitly is how we promote schema-side
// index declarations to actual Atlas indexes in prod.
//
// Mongo 4.2+ builds indexes online (no collection lock). Atlas builds
// in the background. For CallLog (~hundreds of thousands of rows) this
// should finish in seconds-to-minutes.
//
// Usage:
//   node scripts/sync-indexes.js                 # all known models
//   node scripts/sync-indexes.js CallLog         # specific model
//   node scripts/sync-indexes.js --dry-run       # show plan, don't apply

const path = require("path");

// Allowlist — keep it small so a "sync everything" run doesn't churn
// every collection's indexes. Append here when adding new model index
// declarations that need promoting.
const KNOWN_MODELS = [
  "CallLog",
  "CallLedger",
  "CaseProfile",
  // CX 0.2.0 #2: one-running-session-per-agent partial-unique index. SWEEP duplicate running
  // sessions per agent BEFORE the first sync (the unique build fails otherwise).
  "CxBulkLoadSession",
  // Wrap cards: the exactly-once dedupe lives in the unique idemKey index (fast-mint +
  // drain backstop both rely on it). Live collection verified 2026-07-08; listed here so
  // fresh environments get it promoted too.
  "CxCallWrapCard",
  "HourlyJobEvent",
  "LeadCadence",
  "LeadDeliveryAgent",
  "LeadDeliveryCheckpoint",
  "LeadDeliveryEvent",
  "LeadDeliveryItem",
  "MasterProspectIndex",
  "UserAccount",
  "WorkflowRecord",
];

function parseArgs(argv) {
  const args = { dryRun: false, only: null };
  for (const v of argv) {
    if (v === "--dry-run") args.dryRun = true;
    else if (!v.startsWith("--")) args.only = v;
  }
  return args;
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function normalizeIndexDefinition(fields, options = {}) {
  return {
    // Compound-index field order is significant, so retain entry order here.
    fields: Object.entries(fields || {}),
    options: {
      unique: options.unique === true,
      sparse: options.sparse === true,
      partialFilterExpression: options.partialFilterExpression
        ? stableJsonValue(options.partialFilterExpression)
        : null,
    },
  };
}

function indexDefinitionsMatch(declared, actual) {
  const declaredDefinition = normalizeIndexDefinition(
    declared.fields,
    declared.options,
  );
  const actualDefinition = normalizeIndexDefinition(actual.key, actual);
  return JSON.stringify(declaredDefinition) === JSON.stringify(actualDefinition);
}

function planIndexChanges(declared, actual) {
  const matchedActualIndexes = new Set();
  const toAdd = [];

  for (const declaredIndex of declared) {
    const actualIndexPosition = actual.findIndex(
      (actualIndex, index) =>
        !matchedActualIndexes.has(index) &&
        indexDefinitionsMatch(declaredIndex, actualIndex),
    );

    if (actualIndexPosition === -1) {
      toAdd.push(declaredIndex);
    } else {
      matchedActualIndexes.add(actualIndexPosition);
    }
  }

  const toDrop = actual.filter(
    (actualIndex, index) =>
      actualIndex.name !== "_id_" && !matchedActualIndexes.has(index),
  );

  return { toAdd, toDrop };
}

async function main() {
  // Keep environment/model loading behind the CLI entry point. Requiring this
  // module for pure plan tests must not read .env or initialize Mongoose.
  require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
  const mongoose = require("mongoose");
  const models = require("../packages/shared-models/src");

  const args = parseArgs(process.argv.slice(2));
  const targets = args.only ? [args.only] : KNOWN_MODELS;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`Connected to ${dbName}`);

  for (const name of targets) {
    const Model = models[name];
    if (!Model || typeof Model.syncIndexes !== "function") {
      console.log(`  [skip] ${name} — model not found or doesn't expose syncIndexes`);
      continue;
    }
    console.log(`\n=== ${name} ===`);

    // Show declared vs actual before syncing so we can see what will
    // change.
    const declared = Model.schema.indexes().map(([fields, options]) => ({
      fields,
      options,
    }));
    const actual = await Model.collection.indexes().catch(() => []);
    const { toAdd, toDrop } = planIndexChanges(declared, actual);

    console.log(`  Declared in schema: ${declared.length} index(es)`);
    console.log(`  Currently in Atlas: ${actual.length} index(es)`);
    if (toAdd.length === 0 && toDrop.length === 0) {
      console.log(`  ✓ In sync — nothing to do`);
      continue;
    }
    if (toAdd.length > 0) {
      console.log(`  Will ADD ${toAdd.length}:`);
      for (const idx of toAdd) {
        console.log(`    + ${JSON.stringify(idx.fields)} ${JSON.stringify(idx.options || {})}`);
      }
    }
    if (toDrop.length > 0) {
      console.log(`  Will DROP ${toDrop.length}:`);
      for (const idx of toDrop) {
        console.log(`    - ${idx.name} ${JSON.stringify(idx.key)}`);
      }
    }
    if (args.dryRun) {
      console.log(`  (dry-run — no changes applied)`);
      continue;
    }

    const startedAt = Date.now();
    const dropped = await Model.syncIndexes();
    const elapsed = Date.now() - startedAt;
    console.log(`  ✓ syncIndexes() completed in ${elapsed}ms`);
    if (Array.isArray(dropped) && dropped.length > 0) {
      console.log(`    dropped: ${dropped.join(", ")}`);
    }
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    try {
      const mongoose = require("mongoose");
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  KNOWN_MODELS,
  indexDefinitionsMatch,
  main,
  normalizeIndexDefinition,
  parseArgs,
  planIndexChanges,
};
