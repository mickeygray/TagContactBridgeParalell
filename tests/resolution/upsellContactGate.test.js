"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveUpsellContactEligibility,
  getUpsellContactAllowList,
} = require("../../packages/shared-services/src/contactEligibilityService");

// ── not gated: ordinary client / low tier — always eligible ───────────────────
test("ungated status (TAG tier1 206) is eligible regardless of allow-list", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 206, caseId: 1, allowList: [] });
  assert.equal(r.ok, true);
});

// ── gated (tier-5 / reso-only): fail-closed without allow-listing ─────────────
test("gated tier-5 (TAG 212) is blocked when not allow-listed", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 212, caseId: 99, allowList: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "allowlist-required");
});

test("gated reso-only (TAG 218) is blocked when not allow-listed", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 218, caseId: 99, allowList: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "allowlist-required");
});

test("gated status becomes eligible once the caseId is on the allow-list", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 212, caseId: 12345, allowList: [12345] });
  assert.equal(r.ok, true);
});

// ── DNC / opt-out always block, even for ungated statuses ─────────────────────
test("DNC blocks even an ungated status", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 206, caseId: 1, dnc: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "dnc");
});

test("opt-out blocks even an ungated status", () => {
  const r = resolveUpsellContactEligibility({ domain: "TAG", statusId: 206, caseId: 1, optOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "opt-out");
});

// ── allow-list config parsing (fail-closed defaults) ──────────────────────────
test("getUpsellContactAllowList: empty when env unset, per-domain when set", () => {
  const saved = process.env.UPSELL_CONTACT_ALLOWLIST;
  delete process.env.UPSELL_CONTACT_ALLOWLIST;
  assert.deepEqual(getUpsellContactAllowList("TAG"), []);

  process.env.UPSELL_CONTACT_ALLOWLIST = JSON.stringify({ TAG: [1, 2, 3], WYNN: [9] });
  assert.deepEqual(getUpsellContactAllowList("TAG"), [1, 2, 3]);
  assert.deepEqual(getUpsellContactAllowList("WYNN"), [9]);
  assert.deepEqual(getUpsellContactAllowList("AMITY"), []);

  process.env.UPSELL_CONTACT_ALLOWLIST = "{bad json";
  assert.deepEqual(getUpsellContactAllowList("TAG"), []); // malformed → fail-closed empty

  if (saved === undefined) delete process.env.UPSELL_CONTACT_ALLOWLIST;
  else process.env.UPSELL_CONTACT_ALLOWLIST = saved;
});
