"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { EJSON, ObjectId } = require("bson");

const {
  assertExpectedDb,
  assertFamiliarDb,
  assertBackupIntegrity,
  assertDeleteIntegrity,
  assertNoLiveTouched,
  verifyDumpFile,
} = require("../../scripts/lib/pruneSafety");

function tmpGz(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-safety-"));
  const file = path.join(dir, "dump.jsonl.gz");
  fs.writeFileSync(file, zlib.gzipSync(lines.join("\n") + (lines.length ? "\n" : "")));
  return file;
}

function ejsonDoc(extra = {}) {
  return EJSON.stringify({ _id: new ObjectId(), createdAt: new Date("2026-05-01T00:00:00Z"), ...extra });
}

// ── G1 ───────────────────────────────────────────────────────────────────────
test("assertExpectedDb passes on match, throws on mismatch", () => {
  assert.doesNotThrow(() => assertExpectedDb("tagcontactbridge_parallel", "tagcontactbridge_parallel"));
  assert.throws(() => assertExpectedDb("some_other_db", "tagcontactbridge_parallel"), /G1 refusing/);
});

test("assertFamiliarDb requires at least one sentinel, else throws", () => {
  assert.deepEqual(
    assertFamiliarDb(["controlplanecaseprofiles", "x"], ["controlplanecaseprofiles", "eventrecords"]),
    ["controlplanecaseprofiles"],
  );
  assert.throws(() => assertFamiliarDb(["random", "junk"], ["controlplanecaseprofiles"]), /does not look like/);
});

// ── G2 ───────────────────────────────────────────────────────────────────────
test("assertBackupIntegrity throws unless captured === dumpLines (refuses to delete on mismatch)", () => {
  assert.doesNotThrow(() => assertBackupIntegrity({ collection: "c", captured: 100, dumpLines: 100 }));
  assert.throws(() => assertBackupIntegrity({ collection: "c", captured: 100, dumpLines: 99 }), /backup INCOMPLETE/);
});

// ── G3 ───────────────────────────────────────────────────────────────────────
test("assertDeleteIntegrity throws unless deleted === captured", () => {
  assert.doesNotThrow(() => assertDeleteIntegrity({ collection: "c", captured: 50, deleted: 50 }));
  assert.throws(() => assertDeleteIntegrity({ collection: "c", captured: 50, deleted: 49 }), /delete MISMATCH/);
});

// ── G4 ───────────────────────────────────────────────────────────────────────
test("assertNoLiveTouched throws if the preserved count changed", () => {
  assert.doesNotThrow(() => assertNoLiveTouched({ collection: "c", preservedBefore: 970, preservedAfter: 970 }));
  assert.throws(() => assertNoLiveTouched({ collection: "c", preservedBefore: 970, preservedAfter: 969 }), /PRESERVED LIVE COUNT CHANGED/);
});

// ── verifyDumpFile (real gz I/O) ──────────────────────────────────────────────
test("verifyDumpFile counts lines and validates an EJSON sample with _id", async () => {
  const file = tmpGz([ejsonDoc(), ejsonDoc(), ejsonDoc()]);
  const r = await verifyDumpFile(file, { sampleSize: 10 });
  assert.equal(r.lines, 3);
  assert.equal(r.sampled, 3);
  assert.equal(r.sampledOk, 3);
});

test("verifyDumpFile throws on a missing file", async () => {
  await assert.rejects(verifyDumpFile(path.join(os.tmpdir(), "nope-does-not-exist.jsonl.gz")), /dump file missing/);
});

test("verifyDumpFile throws when a sampled line has no _id (corrupt/wrong shape)", async () => {
  const file = tmpGz([ejsonDoc(), JSON.stringify({ notAnId: 1 })]);
  await assert.rejects(verifyDumpFile(file, { sampleSize: 10 }), /sample parse failed/);
});

test("verifyDumpFile rejects a non-gzip file (truncated/garbage backup)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-safety-bad-"));
  const file = path.join(dir, "dump.jsonl.gz");
  fs.writeFileSync(file, "this is not gzip data");
  await assert.rejects(verifyDumpFile(file));
});

test("verifyDumpFile line count matches a large dump exactly", async () => {
  const n = 1234;
  const file = tmpGz(Array.from({ length: n }, () => ejsonDoc()));
  const r = await verifyDumpFile(file, { sampleSize: 25 });
  assert.equal(r.lines, n);
  assert.equal(r.sampledOk, 25);
});
