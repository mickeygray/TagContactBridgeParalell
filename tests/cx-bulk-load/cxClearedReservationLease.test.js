"use strict";

// M3 (FM-8c) — every clear/complete/reschedule/assign path must NULL the reservation
// lease trio. `buildClearedDialRuntimeMetadata` is the shared flat-$set those paths spread
// into (5 call sites: complete, reschedule, cancel, assigner, ...). If the trio is dropped,
// a requeued/terminal row keeps a stale `reservationSessionId`, which the M2 reaper-exclusion
// then pins forever with no live owner — and pollutes the reconciler scan and the
// `metadataReservationSessionIdNotIn` filter. This locks the trio against a tightening pass.
//
// Pure function, no Mongo. Asserts behavior (trio present & null; dotted keys so nested
// metadata is never clobbered), not call-site wiring (that is integration-verified).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClearedDialRuntimeMetadata,
} = require("../../packages/shared-services/src/cxCadenceService");

test("the reservation lease trio is present and nulled (FM-8c)", () => {
  const patch = buildClearedDialRuntimeMetadata();
  assert.equal(patch["metadata.reservationSessionId"], null);
  assert.equal(patch["metadata.reservedAt"], null);
  assert.equal(patch["metadata.reservationExpiresAt"], null);
  // the keys must EXIST (own-property), not merely be undefined-by-absence.
  assert.ok(Object.prototype.hasOwnProperty.call(patch, "metadata.reservationSessionId"));
  assert.ok(Object.prototype.hasOwnProperty.call(patch, "metadata.reservedAt"));
  assert.ok(Object.prototype.hasOwnProperty.call(patch, "metadata.reservationExpiresAt"));
});

test("also nulls the active-dial evidence the reaper keys off (servingAt / UII)", () => {
  const patch = buildClearedDialRuntimeMetadata();
  // A cleared row must not look mid-dial to the reaper after it is freed.
  assert.equal(patch["metadata.lastDialExecutionUii"], null);
});

test("every key is dotted (no top-level `metadata` that would clobber the nested object)", () => {
  const patch = buildClearedDialRuntimeMetadata({ now: new Date("2026-06-23T00:00:00Z"), reason: "complete" });
  assert.ok(!Object.prototype.hasOwnProperty.call(patch, "metadata"), "must not set a whole `metadata` object");
  for (const key of Object.keys(patch)) {
    assert.ok(key.startsWith("metadata."), `key ${key} should be a dotted metadata path`);
  }
});

test("the trio is nulled regardless of the reason/now arguments", () => {
  for (const reason of [null, "reschedule", "cancel", "assigner-clear"]) {
    const patch = buildClearedDialRuntimeMetadata({ reason });
    assert.equal(patch["metadata.reservationSessionId"], null, `reason=${reason}`);
    assert.equal(patch["metadata.reservedAt"], null, `reason=${reason}`);
    assert.equal(patch["metadata.reservationExpiresAt"], null, `reason=${reason}`);
  }
});
