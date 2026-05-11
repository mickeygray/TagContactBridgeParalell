"use strict";

// Pure-function tests for the hardening additions in dialService:
//   - safeSerializeError (handles cycles, depth, function values)
//   - withTimeout (resolves on success, rejects on timeout)
//   - sanitizeUsPhone (rejects garbage, respects E.164)
//   - DIAL_ELIGIBLE_ACTIVITY_STATES (only idle/dispositioning/wrapup)
// Run via: node --test tests/queue/dialServiceHardening.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  safeSerializeError,
  withTimeout,
  sanitizeUsPhone,
  DIAL_ELIGIBLE_ACTIVITY_STATES,
} = require("../../packages/shared-services/src/dialService");

test("safeSerializeError — null/undefined returns null", () => {
  assert.equal(safeSerializeError(null), null);
  assert.equal(safeSerializeError(undefined), null);
});

test("safeSerializeError — basic Error", () => {
  const e = new Error("boom");
  const r = safeSerializeError(e);
  assert.equal(r.message, "boom");
  assert.equal(r.name, "Error");
});

test("safeSerializeError — handles circular reference", () => {
  const obj = { a: 1 };
  obj.self = obj;
  const e = new Error("circular");
  e.response = obj;
  const r = safeSerializeError(e);
  // Should not throw on JSON.stringify
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(r.response);
});

test("safeSerializeError — strips functions", () => {
  const e = new Error("with-fn");
  e.response = { method: () => "danger", name: "ok" };
  const r = safeSerializeError(e);
  assert.equal(r.response.method, undefined);
  assert.equal(r.response.name, "ok");
});

test("safeSerializeError — truncates long strings", () => {
  const e = new Error("long");
  e.response = { body: "x".repeat(5000) };
  const r = safeSerializeError(e);
  assert.ok(r.response.body.length < 5000);
  assert.match(r.response.body, /truncated/);
});

test("safeSerializeError — depth-limits deep nesting", () => {
  let deep = "leaf";
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };
  const e = new Error("deep");
  e.response = deep;
  const r = safeSerializeError(e);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("withTimeout — resolves when fast", async () => {
  const result = await withTimeout(
    () => new Promise((resolve) => setTimeout(() => resolve("ok"), 10)),
    1000,
    "fast",
  );
  assert.equal(result, "ok");
});

test("withTimeout — rejects with TIMEOUT code when slow", async () => {
  await assert.rejects(
    () => withTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 1000)),
      50,
      "slow-op",
    ),
    (err) => {
      assert.equal(err.code, "TIMEOUT");
      assert.match(err.message, /slow-op/);
      assert.match(err.message, /50ms/);
      return true;
    },
  );
});

test("withTimeout — propagates underlying rejection", async () => {
  await assert.rejects(
    () => withTimeout(
      () => Promise.reject(new Error("inner-fail")),
      1000,
      "op",
    ),
    /inner-fail/,
  );
});

test("sanitizeUsPhone — rejects garbage that's neither 10 nor 11 digits", () => {
  assert.equal(sanitizeUsPhone("123"), null);
  assert.equal(sanitizeUsPhone("12345"), null);
  assert.equal(sanitizeUsPhone("123456789012345"), null);
});

test("sanitizeUsPhone — rejects non-+1 E.164 (other countries) for now", () => {
  // We only support US — anything else returns null
  assert.equal(sanitizeUsPhone("+447911123456"), null);
});

test("sanitizeUsPhone — accepts +1NNN already-formatted", () => {
  assert.equal(sanitizeUsPhone("+13106665997"), "+13106665997");
});

test("sanitizeUsPhone — handles whitespace", () => {
  assert.equal(sanitizeUsPhone("  3106665997  "), "+13106665997");
});

test("DIAL_ELIGIBLE_ACTIVITY_STATES — only idle/dispositioning/wrapup", () => {
  assert.ok(DIAL_ELIGIBLE_ACTIVITY_STATES.has("idle"));
  assert.ok(DIAL_ELIGIBLE_ACTIVITY_STATES.has("dispositioning"));
  assert.ok(DIAL_ELIGIBLE_ACTIVITY_STATES.has("wrapup"));
  assert.equal(DIAL_ELIGIBLE_ACTIVITY_STATES.has("onCall"), false);
  assert.equal(DIAL_ELIGIBLE_ACTIVITY_STATES.has("dialing"), false);
  assert.equal(DIAL_ELIGIBLE_ACTIVITY_STATES.has("unavailable"), false);
  assert.equal(DIAL_ELIGIBLE_ACTIVITY_STATES.has("offline"), false);
});
