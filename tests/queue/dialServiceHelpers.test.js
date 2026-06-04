"use strict";

// Pure-function helper tests for dialService — phone normalization,
// Logics URL builder, RingCX uii extraction. No Mongo, no async.
// Run via: node --test tests/queue/dialServiceHelpers.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeUsPhone,
  buildLogicsCaseUrl,
  extractRcxUii,
} = require("../../packages/shared-services/src/dialService");

test("sanitizeUsPhone — 10 digits → +1NNN", () => {
  assert.equal(sanitizeUsPhone("3106665997"), "+13106665997");
});

test("sanitizeUsPhone — 11 digits with 1 → +1NNN", () => {
  assert.equal(sanitizeUsPhone("13106665997"), "+13106665997");
});

test("sanitizeUsPhone — formatted number → +1NNN", () => {
  assert.equal(sanitizeUsPhone("(310) 666-5997"), "+13106665997");
});

test("sanitizeUsPhone — already E.164 passes through", () => {
  assert.equal(sanitizeUsPhone("+13106665997"), "+13106665997");
});

test("sanitizeUsPhone — empty/null returns null", () => {
  assert.equal(sanitizeUsPhone(""), null);
  assert.equal(sanitizeUsPhone(null), null);
  assert.equal(sanitizeUsPhone(undefined), null);
});

test("buildLogicsCaseUrl — TAG", () => {
  const url = buildLogicsCaseUrl("TAG", "12345");
  assert.match(url, /taxag\.logiqsapi\.com/);
  assert.match(url, /caseid=12345/);
});

test("buildLogicsCaseUrl — WYNN", () => {
  const url = buildLogicsCaseUrl("WYNN", "67890");
  assert.match(url, /wynntax\.logiqsapi\.com/);
  assert.match(url, /caseid=67890/);
});

test("buildLogicsCaseUrl — null caseId returns null", () => {
  assert.equal(buildLogicsCaseUrl("TAG", null), null);
  assert.equal(buildLogicsCaseUrl("TAG", ""), null);
});

test("buildLogicsCaseUrl — unknown domain returns null", () => {
  assert.equal(buildLogicsCaseUrl("UNKNOWN", "12345"), null);
});

test("extractRcxUii — top-level uii", () => {
  assert.equal(extractRcxUii({ uii: "abc123" }), "abc123");
});

test("extractRcxUii — top-level callId", () => {
  assert.equal(extractRcxUii({ callId: "xyz789" }), "xyz789");
});

test("extractRcxUii — nested under data", () => {
  assert.equal(extractRcxUii({ data: { uii: "deep1" } }), "deep1");
});

test("extractRcxUii — null/empty returns null", () => {
  assert.equal(extractRcxUii(null), null);
  assert.equal(extractRcxUii({}), null);
  assert.equal(extractRcxUii({ irrelevant: "x" }), null);
});

test("extractRcxUii — uppercase UII variant", () => {
  assert.equal(extractRcxUii({ UII: "upper" }), "upper");
});
