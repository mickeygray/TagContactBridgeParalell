"use strict";

// Integration proof for the prune's fail-closed pipeline + restore, against an ISOLATED
// throwaway database on the same Mongo server (never prod data). Skips when MONGO_URI is
// unset so the rest of the suite stays offline-runnable.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { ObjectId } = require("bson");

const { processTarget, runRestore } = require("../../scripts/prune-pre-june-operational-bloat");

const URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
const TEST_DB = "tagcontactbridge_prune_safety_test";
const CUTOFF = new Date("2026-06-01T07:00:00.000Z");
const RUN_ID = "itest-runid-cutoff-2026-06-01"; // dot-free, like buildRunId output
const COLL = "itest_eventqueue";

const TARGET = {
  name: COLL,
  dateField: "createdAt",
  statusField: "status",
  terminalStatuses: ["completed", "dead-letter"],
};

function doc(status, when) {
  return { _id: new ObjectId(), status, createdAt: when, payload: { note: `${status}@${when.toISOString()}` } };
}

test("prune pipeline: verified backup, terminal-only delete, live preserved, faithful restore", { skip: !URI }, async () => {
  const conn = await mongoose.createConnection(URI, { dbName: TEST_DB }).asPromise();
  const db = conn.db;
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-itest-"));
  try {
    const before = new Date("2026-05-20T00:00:00.000Z");
    const after = new Date("2026-06-10T00:00:00.000Z");
    await db.collection(COLL).deleteMany({});
    await db.collection(COLL).insertMany([
      ...Array.from({ length: 7 }, () => doc("completed", before)), // terminal, pre-cutoff -> delete
      ...Array.from({ length: 3 }, () => doc("dead-letter", before)), // terminal, pre-cutoff -> delete
      ...Array.from({ length: 4 }, () => doc("pending", before)), // LIVE, pre-cutoff -> preserve
      ...Array.from({ length: 2 }, () => doc("completed", after)), // terminal but POST-cutoff -> untouched
    ]);

    // APPLY with all gates.
    const row = await processTarget({ db, target: TARGET, cutoff: CUTOFF, runId: RUN_ID, dumpDir, apply: true });

    assert.equal(row.matched, 10, "10 terminal pre-cutoff rows matched");
    assert.equal(row.dumped, 10, "all 10 captured to backup");
    assert.equal(row.verifiedLines, 10, "backup file verified to contain exactly 10 lines");
    assert.equal(row.deleted, 10, "deleted exactly the 10 backed-up rows");
    assert.equal(row.preservedLive, 4, "4 live rows counted before");
    assert.equal(row.preservedAfter, 4, "4 live rows still present after (G4)");

    const remaining = await db.collection(COLL).countDocuments({});
    assert.equal(remaining, 6, "6 rows remain (4 live + 2 post-cutoff terminal)");
    assert.equal(await db.collection(COLL).countDocuments({ status: "pending" }), 4, "live pending untouched");
    assert.equal(await db.collection(COLL).countDocuments({ createdAt: after }), 2, "post-cutoff untouched");

    // RESTORE from the dump.
    const restore = await runRestore({ db, dumpDir, runId: RUN_ID, only: new Set() });
    const restored = restore.targets.find((t) => t.collection === COLL);
    assert.equal(restored.read, 10, "restore read all 10 backed-up rows");
    assert.equal(restored.inserted, 10, "restore re-inserted all 10");
    assert.equal(await db.collection(COLL).countDocuments({}), 16, "collection fully restored to 16");

    // RESTORE is idempotent (re-run inserts nothing, all duplicates).
    const restore2 = await runRestore({ db, dumpDir, runId: RUN_ID, only: new Set() });
    const restored2 = restore2.targets.find((t) => t.collection === COLL);
    assert.equal(restored2.inserted, 0, "second restore inserts nothing");
    assert.equal(restored2.duplicates, 10, "second restore reports 10 duplicates");
    assert.equal(await db.collection(COLL).countDocuments({}), 16, "still 16 (no double-insert)");
  } finally {
    await conn.dropDatabase();
    await conn.close();
    fs.rmSync(dumpDir, { recursive: true, force: true });
  }
});
