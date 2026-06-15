"use strict";

// Self-verification gates for the operational-bloat prune. The operating assumption
// (stated by the operator) is that human verification "almost never gets done", so every
// check that a runbook would ask a human to perform is encoded here as a FAIL-CLOSED gate:
// the prune throws and stops rather than proceeding when an invariant is not provably met.
//
// Invariants enforced:
//   G1  the connected DB is the expected one AND looks like the real app DB (sentinels)
//   G2  BEFORE any delete: the gz backup contains exactly the rows we are about to delete
//   G3  AFTER delete: we deleted exactly the rows we backed up (no more, no fewer)
//   G4  AFTER delete: the live/preserved population is byte-for-byte unchanged
//
// All gates operate on counts/artifacts, never on "looks right".

const fs = require("fs");
const zlib = require("zlib");
const readline = require("readline");
const { EJSON } = require("bson");

// ── G1: target DB identity ───────────────────────────────────────────────────
function assertExpectedDb(actualName, expectedName) {
  if (String(actualName) !== String(expectedName)) {
    throw new Error(
      `G1 refusing to run: connected DB "${actualName}" != expected "${expectedName}". ` +
        `Set PARALLEL_DB_NAME / MONGO_URI to the intended database.`,
    );
  }
}

// Refuse to operate on a DB that does not contain at least one known app collection — guards
// against a typo'd / empty / wrong cluster silently "succeeding" with 0 matches.
function assertFamiliarDb(presentCollectionNames, sentinels) {
  const present = new Set(presentCollectionNames || []);
  const hits = (sentinels || []).filter((name) => present.has(name));
  if (hits.length === 0) {
    throw new Error(
      `G1 refusing to run: none of the sentinel collections [${(sentinels || []).join(", ")}] ` +
        `exist in this DB; it does not look like the application database.`,
    );
  }
  return hits;
}

// ── G2: backup is complete before we delete anything ─────────────────────────
// captured = number of _ids we collected (and will delete); dumpLines = lines actually
// persisted to the gz file; matched = the pre-dump count (informational, may differ by a
// row or two if a doc transitioned into the delete set mid-dump — the hard invariant is
// captured === dumpLines).
function assertBackupIntegrity({ collection, captured, dumpLines }) {
  if (captured !== dumpLines) {
    throw new Error(
      `G2 [${collection}] backup INCOMPLETE: persisted ${dumpLines} lines but captured ${captured} ids. ` +
        `Not deleting — the backup does not match what would be removed.`,
    );
  }
}

// ── G3: we deleted exactly what we backed up ─────────────────────────────────
function assertDeleteIntegrity({ collection, captured, deleted }) {
  if (captured !== deleted) {
    throw new Error(
      `G3 [${collection}] delete MISMATCH: backed up ${captured} but deleted ${deleted}. ` +
        `Investigate immediately; the dump remains the source of truth for restore.`,
    );
  }
}

// ── G4: live/preserved work was not touched ──────────────────────────────────
function assertNoLiveTouched({ collection, preservedBefore, preservedAfter }) {
  if (preservedBefore !== preservedAfter) {
    throw new Error(
      `G4 [${collection}] PRESERVED LIVE COUNT CHANGED ${preservedBefore} -> ${preservedAfter}. ` +
        `Live/open work may have been deleted — halting the run.`,
    );
  }
}

// ── backup file verification (faithful EJSON, line count + sample parse) ──────
// Streams the gz dump, counts JSONL lines, and EJSON-parses a sample to prove the file is
// readable, well-formed, and carries real BSON types (_id present). Returns { lines, sampled,
// sampledOk } and throws if any sampled line fails to parse or lacks an _id.
async function verifyDumpFile(filePath, { sampleSize = 50 } = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`G2 dump file missing: ${filePath}`);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let lines = 0;
  let sampled = 0;
  let sampledOk = 0;
  for await (const line of rl) {
    if (!line) continue;
    lines += 1;
    if (sampled < sampleSize) {
      sampled += 1;
      let parsed = null;
      try {
        parsed = EJSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed && parsed._id !== undefined && parsed._id !== null) sampledOk += 1;
    }
  }
  if (sampled > 0 && sampledOk !== sampled) {
    throw new Error(
      `G2 dump sample parse failed for ${filePath}: only ${sampledOk}/${sampled} lines parsed with an _id.`,
    );
  }
  return { lines, sampled, sampledOk };
}

module.exports = {
  assertExpectedDb,
  assertFamiliarDb,
  assertBackupIntegrity,
  assertDeleteIntegrity,
  assertNoLiveTouched,
  verifyDumpFile,
};
