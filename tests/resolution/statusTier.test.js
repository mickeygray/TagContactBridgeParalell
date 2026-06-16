"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveStatusTier,
  isResoOnlyStatus,
  isAllowListGatedStatus,
} = require("../../packages/shared-config/src/statusMap");

// ── tier extraction ───────────────────────────────────────────────────────────
test("resolveStatusTier: TAG tiers map 206→1, 208→3, 212→5", () => {
  assert.equal(resolveStatusTier("TAG", 206).tier, 1);
  assert.equal(resolveStatusTier("TAG", 208).tier, 3);
  assert.equal(resolveStatusTier("TAG", 212).tier, 5);
});

test("resolveStatusTier: WYNN tiers map 216→1, 218→3, 220→5", () => {
  assert.equal(resolveStatusTier("WYNN", 216).tier, 1);
  assert.equal(resolveStatusTier("WYNN", 218).tier, 3);
  assert.equal(resolveStatusTier("WYNN", 220).tier, 5);
});

test("resolveStatusTier: non-tier status has tier null", () => {
  assert.equal(resolveStatusTier("TAG", 210).tier, null); // New Client
  assert.equal(resolveStatusTier("TAG", 999).tier, null); // unknown
});

// ── reso-only flag ────────────────────────────────────────────────────────────
test("isResoOnlyStatus: the configured reso-only statuses per tenant", () => {
  assert.equal(isResoOnlyStatus("TAG", 218), true);
  assert.equal(isResoOnlyStatus("TAG", 220), true);
  assert.equal(isResoOnlyStatus("WYNN", 224), true);
  assert.equal(isResoOnlyStatus("AMITY", 240), true);
});

test("isResoOnlyStatus: WYNN 218/220 are real tiers, NOT reso-only", () => {
  assert.equal(isResoOnlyStatus("WYNN", 218), false);
  assert.equal(isResoOnlyStatus("WYNN", 220), false);
});

test("resolveStatusTier surfaces resoOnly + label for AMITY 240", () => {
  const t = resolveStatusTier("AMITY", 240);
  assert.equal(t.resoOnly, true);
  assert.equal(t.tier, null);
  assert.equal(t.label, "Resolution Only");
});

// ── allow-list gated set (tier 5 ∪ reso-only) ────────────────────────────────
test("isAllowListGatedStatus: tier-5 statuses are gated", () => {
  assert.equal(isAllowListGatedStatus("TAG", 212), true); // TAG tier5
  assert.equal(isAllowListGatedStatus("WYNN", 220), true); // WYNN tier5
});

test("isAllowListGatedStatus: reso-only statuses are gated", () => {
  assert.equal(isAllowListGatedStatus("TAG", 218), true);
  assert.equal(isAllowListGatedStatus("WYNN", 224), true);
  assert.equal(isAllowListGatedStatus("AMITY", 240), true);
});

test("isAllowListGatedStatus: tier 1-4 and ordinary client statuses are NOT gated", () => {
  assert.equal(isAllowListGatedStatus("TAG", 206), false); // tier1
  assert.equal(isAllowListGatedStatus("TAG", 209), false); // tier4
  assert.equal(isAllowListGatedStatus("TAG", 210), false); // New Client
  assert.equal(isAllowListGatedStatus("WYNN", 218), false); // WYNN tier3
  assert.equal(isAllowListGatedStatus("TAG", 999), false); // unknown
});
