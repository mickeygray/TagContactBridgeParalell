"use strict";

// The DNC id list must come from the status catalog, per tenant.
//
// Before 2026-07-24 the delivery gate carried a hardcoded [173] and the
// control-plane composed ONE policy for every tenant (policyForDomain
// ignored its domain argument, and LOGICS_DNC_STATUS_IDS is unset). Status
// ids are tenant-scoped and collide, so that shape is wrong twice over.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  dncStatusIdsForDomain,
  resolveStatus,
  STATUS_TABLES,
} = require("../../packages/shared-config/src/statusMap");

test("TAG marks both 39 and 173 DNC — a hardcoded [173] misses one", () => {
  const tag = dncStatusIdsForDomain("TAG");
  assert.ok(tag.includes(173), "TAG 173 must be DNC");
  assert.ok(tag.includes(39), "TAG 39 is DNC and was missed by the hardcoded list");
});

test("the same id means different things per tenant", () => {
  // 39 is DNC in TAG but an ordinary "Wrong Number" in WYNN, so a shared
  // DNC list would either miss TAG's or over-block WYNN's.
  assert.equal(resolveStatus("TAG", 39).category, "dnc");
  assert.notEqual(resolveStatus("WYNN", 39).category, "dnc");
  assert.ok(!dncStatusIdsForDomain("WYNN").includes(39));
});

test("every catalog entry categorised dnc is returned, and nothing else", () => {
  for (const domain of Object.keys(STATUS_TABLES)) {
    const expected = Object.entries(STATUS_TABLES[domain])
      .filter(([, entry]) => entry?.category === "dnc")
      .map(([id]) => Number(id))
      .sort((a, b) => a - b);
    assert.deepEqual(
      [...dncStatusIdsForDomain(domain)].sort((a, b) => a - b),
      expected,
      `${domain} DNC set drifted from the catalog`,
    );
  }
});

test("an unknown domain yields no ids rather than throwing", () => {
  assert.deepEqual(dncStatusIdsForDomain("NOPE"), []);
  assert.deepEqual(dncStatusIdsForDomain(null), []);
  assert.deepEqual(dncStatusIdsForDomain(undefined), []);
});

test("domain matching is case-insensitive", () => {
  assert.deepEqual(dncStatusIdsForDomain("tag"), dncStatusIdsForDomain("TAG"));
});
