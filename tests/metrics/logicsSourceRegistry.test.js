"use strict";

// The registry maps CallRail source names to Logics SourceIDs, EXACTLY.
//
// 2026-07-28: a " 800-921-9263" suffix was edited out of the CallRail source
// library, and because the lookup is exact the biggest mail piece (389 calls
// in 45 days) silently resolved to "unmapped-piece". No error, no log, no
// failed report — attribution just stopped for that piece. These tests pin
// the live names so the next rename fails here instead of in production.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LOGICS_SOURCE_REGISTRY, resolveLogicsSourceId,
} = require("../../packages/shared-services/src/logicsSourceWriterService");

// Observed in the live CallRail source library over 2026-06-09 → 2026-07-28.
const LIVE_REGISTERED = [
  ["Urgent Third State", 73, 446],
  ["3rd Day (Pink) Urgent Third State", 74, 389],
  ["Affordability Federal", 75, 194],
];

// Also live, also pink/urgent-shaped, and DELIBERATELY not mapped — these are
// different pieces. Any fuzzy matcher would mis-attribute live client cases.
const LIVE_NEAR_MISSES = [
  "URGENT THIRD PINK DAY 1",
  "8006435890 Federal Urgent 3rd 3 Day Pink",
  "Affordability Pink State",
  "Urgent Third Postcard State",
  "Urgent Third Postcard Federal",
  "Urgent Third Federal",
];

test("every registered piece resolves under its CURRENT CallRail name", () => {
  for (const [name, expected] of LIVE_REGISTERED) {
    assert.equal(resolveLogicsSourceId("TAG", name), expected, `"${name}" must map to ${expected}`);
  }
});

test("near-miss piece names stay unmapped rather than being guessed", () => {
  for (const name of LIVE_NEAR_MISSES) {
    assert.equal(resolveLogicsSourceId("TAG", name), null,
      `"${name}" is a DIFFERENT piece — mapping it would write a wrong SourceID to a live case`);
  }
});

test("the pre-rename pink name still resolves, for historical rows", () => {
  assert.equal(resolveLogicsSourceId("TAG", "3rd Day (Pink) Urgent Third State 800-921-9263"), 74);
});

test("no registry key carries a phone-number suffix as its ONLY form", () => {
  // The failure mode: a key that exists only in its phone-suffixed form can
  // never match a live CallRail name once marketing tidies the label.
  const byId = new Map();
  for (const [name, id] of Object.entries(LOGICS_SOURCE_REGISTRY.TAG)) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(name);
  }
  const hasPhone = (s) => /\d{3}[-. )]?\s?\d{3}[-. ]?\d{4}/.test(s);
  for (const [id, names] of byId) {
    assert.ok(names.some((n) => !hasPhone(n)),
      `SourceID ${id} is only reachable via a phone-suffixed name (${names.join(", ")})`);
  }
});

test("unknown tenants and blank pieces resolve to null, never a default", () => {
  assert.equal(resolveLogicsSourceId("WYNN", "Urgent Third State"), null, "WYNN has no registry yet");
  assert.equal(resolveLogicsSourceId("TAG", ""), null);
  assert.equal(resolveLogicsSourceId("TAG", null), null);
  assert.equal(resolveLogicsSourceId(null, "Urgent Third State"), null);
});

const {
  labelForSourceId, SOURCE_CAMPAIGN_LABELS,
} = require("../../packages/shared-services/src/logicsSourceWriterService");

test("confirmed campaign ids identify, catch-alls stay catch-alls", () => {
  // Identified 2026-07-28 from intake lines and confirmed by Mickey.
  // 57/64 are TAG ids; 45-49 are WYNN ids — separate id spaces per tenant.
  assert.deepEqual(labelForSourceId("TAG", 57), { label: "ABC", catchAll: true });
  assert.deepEqual(labelForSourceId("TAG", 64), { label: "BCD", catchAll: false });
  assert.deepEqual(labelForSourceId("WYNN", 45), { label: "LD CUSTOM", catchAll: false });
  assert.deepEqual(labelForSourceId("WYNN", 46), { label: "LD GENERAL", catchAll: false });
  assert.deepEqual(labelForSourceId("WYNN", 47), { label: "LD CUSTOM 2", catchAll: false });
  assert.deepEqual(labelForSourceId("WYNN", 48), { label: "LD CUSTOM 3", catchAll: false });
  assert.deepEqual(labelForSourceId("WYNN", 49), { label: "ABC", catchAll: true });
  // The id spaces must not bleed across tenants.
  assert.equal(labelForSourceId("WYNN", 57), null);
  assert.equal(labelForSourceId("TAG", 45), null);
  // Unconfirmed ids identify as nothing, never guessed.
  assert.equal(labelForSourceId("TAG", 99), null);
});

test("identifying an id never makes it WRITABLE", () => {
  // The labels map is read-only knowledge. The write registry stays exactly
  // the three active pieces — "for now its just those 3".
  const writableIds = new Set(Object.values(LOGICS_SOURCE_REGISTRY.TAG));
  assert.deepEqual([...writableIds].sort((a, b) => a - b), [73, 74, 75]);
  for (const table of Object.values(SOURCE_CAMPAIGN_LABELS)) {
    for (const id of Object.keys(table)) {
      assert.ok(!writableIds.has(Number(id)),
        `labelled id ${id} must not be a write target`);
    }
  }
});

test("LD/BCD labels match the spend-sheet keys exactly", () => {
  // The whole point of attributing on these labels is that an LD deal and LD
  // spend fold onto the SAME report row. A case difference would quietly
  // split them again.
  const spendKeys = ["LD CUSTOM", "LD GENERAL", "LD CUSTOM 2", "LD CUSTOM 3", "BCD"];
  const labels = Object.values(SOURCE_CAMPAIGN_LABELS)
    .flatMap((t) => Object.values(t))
    .filter((l) => !l.catchAll)
    .map((l) => l.label);
  for (const label of labels) {
    assert.ok(spendKeys.includes(label), `label "${label}" does not match a spend key`);
  }
});
