"use strict";

// gRPC bridge segment cleanup — the 75GB lesson (2026-06-12). Streams that
// died ungracefully stranded per-chunk WAVs in runtime/.../segments forever.
// The fix is two layers: finalize-time removal of the stream's segment dirs,
// and a startup+interval TTL sweep for anything finalize missed. These tests
// lock the sweep's semantics: stale pruned, fresh kept, ACTIVE kept even
// when stale, nothing outside the root ever touched.
// Run: node --test tests/live-coach/grpcSegmentCleanup.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  pruneGrpcSegmentDirs,
  removeGrpcSegmentDir,
} = require("../../scripts/ringcx-grpc-live-coach-bridge");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grpc-seg-test-"));
}

function makeSegmentDir(root, name, ageMs) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chunk-0001.wav"), Buffer.alloc(64));
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, stamp, stamp);
  return dir;
}

test("sweep prunes stale dirs, keeps fresh dirs, keeps ACTIVE dirs even when stale", () => {
  const root = makeRoot();
  try {
    const stale = makeSegmentDir(root, "stream-old-prospect", 8 * 60 * 60 * 1000);
    const fresh = makeSegmentDir(root, "stream-new-prospect", 5 * 60 * 1000);
    const activeButStale = makeSegmentDir(root, "stream-live-prospect", 8 * 60 * 60 * 1000);

    const result = pruneGrpcSegmentDirs({
      segmentsRoot: root,
      maxAgeMs: 4 * 60 * 60 * 1000,
      activeSegmentDirs: new Set([path.resolve(activeButStale)]),
      apply: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.prunedCount, 1);
    assert.equal(result.activeCount, 1);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(fs.existsSync(activeButStale), true); // live call survives the sweep
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweep disabled when retention is 0/invalid; missing root is a quiet no-op", () => {
  const root = makeRoot();
  try {
    makeSegmentDir(root, "stream-old", 9e9);
    assert.equal(pruneGrpcSegmentDirs({ segmentsRoot: root, maxAgeMs: 0 }).skipped, true);
    assert.equal(pruneGrpcSegmentDirs({ segmentsRoot: root, maxAgeMs: -5 }).skipped, true);
    assert.equal(fs.readdirSync(root).length, 1); // nothing deleted
    const missing = pruneGrpcSegmentDirs({
      segmentsRoot: path.join(root, "does-not-exist"),
      maxAgeMs: 1000,
    });
    assert.equal(missing.skipped, true);
    assert.equal(missing.reason, "missing-root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removeGrpcSegmentDir refuses anything outside the segments root", () => {
  const root = makeRoot();
  const outside = makeRoot();
  try {
    const inside = makeSegmentDir(root, "stream-x", 0);

    const escape = removeGrpcSegmentDir(outside, { segmentsRoot: root });
    assert.equal(escape.ok, false);
    assert.equal(escape.error, "segment-dir-outside-root");
    assert.equal(fs.existsSync(outside), true);

    const traversal = removeGrpcSegmentDir(path.join(root, "..", path.basename(outside)), { segmentsRoot: root });
    assert.equal(traversal.ok, false);
    assert.equal(fs.existsSync(outside), true);

    // The root itself is not a valid target either.
    const rootItself = removeGrpcSegmentDir(root, { segmentsRoot: root });
    assert.equal(rootItself.ok, false);
    assert.equal(fs.existsSync(root), true);

    const legit = removeGrpcSegmentDir(inside, { segmentsRoot: root });
    assert.equal(legit.ok, true);
    assert.equal(fs.existsSync(inside), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
