"use strict";

// M6.1 — ingestion family enum conformance (orphan-safety).
//
// The reservation rails fan a per-family `familyTargets` map over exactly four
// buckets: fresh-day1, fresh-day2to10, fresh-day16to30, aged. A row stored with a
// family OUTSIDE that set (a garbage string, or the sentinel `unassigned`) is an
// ORPHAN — no target ever addresses it, so it never gets reserved or dialed (FM-3b).
//
// M6.1 verified that the single ingestion funnel (`queueCxDialRequest` ->
// `resolveQueueFamilyForPayload` -> `buildQueueProgressionState` -> `deriveQueueFamily`)
// already collapses every garbage/sentinel input to a real bucket, so no code change
// was needed. THIS test locks that invariant against future drift: if anyone makes
// `deriveQueueFamily` able to emit `unassigned` (or a non-enum value) again, it fails.
//
// Pure functions only — no Mongo. The Mongo-coupled appointment-create guard (M6.2)
// is integration-test-deferred to M8 (no local mongodb-memory-server).

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { deriveQueueFamily } = require("../../packages/shared-services/src/cxLoadBalancerService");
const { normalizeQueueFamily } = require("../../packages/shared-services/src/cxQueuePolicyService");

// The four families a `familyTargets` map can address — the reservable set.
const RESERVABLE_FAMILIES = new Set(["fresh-day1", "fresh-day2to10", "fresh-day16to30", "aged"]);
// The full stored enum: reservable + the intentional do-not-dial terminal.
const ENUM_FAMILIES = new Set([...RESERVABLE_FAMILIES, "dead"]);

test("normalizeQueueFamily collapses garbage and the empty value to `unassigned`", () => {
  assert.equal(normalizeQueueFamily("banana"), "unassigned");
  assert.equal(normalizeQueueFamily(""), "unassigned");
  assert.equal(normalizeQueueFamily(null), "unassigned");
  assert.equal(normalizeQueueFamily(undefined), "unassigned");
  assert.equal(normalizeQueueFamily("   "), "unassigned");
});

test("normalizeQueueFamily maps known aliases to the canonical enum", () => {
  assert.equal(normalizeQueueFamily("green"), "fresh-day1");
  assert.equal(normalizeQueueFamily("blue"), "fresh-day2to10");
  assert.equal(normalizeQueueFamily("day2to15"), "fresh-day2to10"); // empirical family->bucket alias
  assert.equal(normalizeQueueFamily("yellow"), "fresh-day16to30");
  assert.equal(normalizeQueueFamily("red"), "aged");
  assert.equal(normalizeQueueFamily("expired"), "dead");
});

test("deriveQueueFamily NEVER stores `unassigned` — garbage and the sentinel land in a real bucket", () => {
  // The stored value is whatever deriveQueueFamily returns; it must always be an enum member.
  assert.ok(ENUM_FAMILIES.has(deriveQueueFamily({ queueFamily: "banana" })));
  assert.ok(ENUM_FAMILIES.has(deriveQueueFamily({ queueFamily: "unassigned" })));
  assert.ok(ENUM_FAMILIES.has(deriveQueueFamily({})));
  // Specifically: garbage/sentinel without age signal default into the reservable set,
  // not into `dead` and never into `unassigned`.
  assert.ok(RESERVABLE_FAMILIES.has(deriveQueueFamily({ queueFamily: "banana" })));
  assert.ok(RESERVABLE_FAMILIES.has(deriveQueueFamily({ queueFamily: "unassigned" })));
  assert.notEqual(deriveQueueFamily({ queueFamily: "banana" }), "unassigned");
  assert.notEqual(deriveQueueFamily({ queueFamily: "banana" }), "banana");
});

test("deriveQueueFamily preserves a real explicit bucket when no age signal overrides it", () => {
  assert.equal(deriveQueueFamily({ queueFamily: "fresh-day16to30" }), "fresh-day16to30");
  assert.equal(deriveQueueFamily({ queueFamily: "aged" }), "aged");
});

test("deriveQueueFamily keeps `dead` (intentional do-not-dial terminal, structurally never reserved)", () => {
  assert.equal(deriveQueueFamily({ queueFamily: "dead" }), "dead");
  // `dead` is an enum member but NOT in the reservable set: reserveReadyRows only
  // claims state:'ready' rows and dead rows are never targeted -> no orphan, by design.
  assert.ok(ENUM_FAMILIES.has("dead"));
  assert.ok(!RESERVABLE_FAMILIES.has("dead"));
});

test("activeDay-driven derivation maps every age band into the enum (no orphan band)", () => {
  // Exercise the activeDay fallback ladder in resolveQueueFamilyForPayload's mirror
  // (deriveQueueFamily's callPlan ladder): each band must land in the enum.
  for (const activeDay of [1, 2, 3, 16, 31, 121]) {
    const family = deriveQueueFamily({ callPlan: { activeDay } });
    assert.ok(ENUM_FAMILIES.has(family), `activeDay=${activeDay} produced non-enum family ${family}`);
  }
});
