"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildClientProfileKey,
  normalizeClientProfileIdentity,
  normalizeDomain,
} = require("../../packages/shared-repositories/src/clientProfileRepository");

test("client profile identity uses DOMAIN:caseNumber, not bare case number", () => {
  assert.equal(normalizeDomain(" wynn "), "WYNN");
  assert.equal(buildClientProfileKey("tag", "101260"), "TAG:101260");
  assert.equal(buildClientProfileKey("wynn", "101260"), "WYNN:101260");
  assert.notEqual(
    buildClientProfileKey("tag", "101260"),
    buildClientProfileKey("wynn", "101260"),
  );
});

test("client profile identity defaults old callers to TAG but preserves explicit domain", () => {
  assert.deepEqual(normalizeClientProfileIdentity("12345"), {
    caseNumber: "12345",
    domain: "TAG",
    profileKey: "TAG:12345",
  });
  assert.deepEqual(normalizeClientProfileIdentity({ caseNumber: "12345", domain: "wynn" }), {
    caseNumber: "12345",
    domain: "WYNN",
    profileKey: "WYNN:12345",
  });
});
