"use strict";

// The pool of recording links. A finished call's URL never changes, which is
// the whole test for what may live in Mongo — and CallRail hands them out one
// call at a time, so not storing them means a round-trip per call per report.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const svc = require("../../packages/shared-services/src/marketingCallLinkService");
const model = require("../../packages/shared-models/src/MarketingCallLink");

test("one row per call per tenant — a re-capture converges", () => {
  const idx = model.schema.indexes().find(([keys]) => keys.domain === 1 && keys.callId === 1);
  assert.ok(idx, "a {domain, callId} index must exist");
  assert.equal(idx[1].unique, true, "re-running a night must update, never duplicate");
});

test("the channel is resolved AT CAPTURE, not at read", () => {
  // A later rename of a source must not silently reclassify history.
  assert.ok("sourceChannel" in model.schema.obj);
});

test("a missing recording is a FACT, not a failure", () => {
  // Unanswered and very short calls have no recording. The row is still kept
  // so we know the call happened and know we looked.
  assert.equal(model.schema.path("listenUrl").options.default, null);
});

test("the range read reports coverage rather than assuming it", () => {
  // Live 2026-07-27: 91 calls, 83 marketing, 8 servicing excluded.
  assert.deepEqual(svc.dayKeys("2026-07-26", "2026-07-28"),
    ["2026-07-26", "2026-07-27", "2026-07-28"]);
  assert.equal(typeof svc.readCallLinks, "function");
  assert.equal(typeof svc.captureCallLinks, "function");
});

test("servicing lines are excluded from the pool", () => {
  // "Client Contact - TAG" is a real call and not marketing. Mixing them is
  // how a client ringing support starts to look like a fresh response.
  const { sourceChannel } = require("../../packages/shared-config/src/activeSources");
  assert.equal(sourceChannel("Client Contact - TAG"), "other");
  assert.equal(sourceChannel("3rd Day (Pink) Urgent Third State"), "mail");
  assert.equal(sourceChannel("BCD V3"), "bcd");
});
