"use strict";

// Pure-function tests for dispositionMapService.
// Run via: node --test tests/queue/dispositionMap.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  DISPOSITION_MAP,
  listDispositions,
  getDisposition,
  validateDisposition,
  computeNextTouchAt,
} = require("../../packages/shared-services/src/dispositionMapService");

test("DISPOSITION_MAP has expected keys", () => {
  const expected = ["callback", "postdate", "deal", "dnc", "wrong_number", "did_not_connect", "voicemail"];
  for (const k of expected) {
    assert.ok(DISPOSITION_MAP[k], `missing disposition: ${k}`);
  }
});

test("each entry has rcxCode + rescheduleRule + queueItemState", () => {
  for (const [key, def] of Object.entries(DISPOSITION_MAP)) {
    assert.ok(def.rcxCode, `${key} missing rcxCode`);
    assert.ok(def.rescheduleRule, `${key} missing rescheduleRule`);
    assert.ok(["completed", "recycled"].includes(def.queueItemState), `${key} bad queueItemState`);
    assert.equal(typeof def.isTerminal, "boolean", `${key} isTerminal not bool`);
  }
});

test("terminal dispositions match the queueItemState=completed rule", () => {
  for (const [key, def] of Object.entries(DISPOSITION_MAP)) {
    if (def.isTerminal) {
      assert.equal(def.queueItemState, "completed", `${key} terminal but not completed`);
    } else {
      assert.equal(def.queueItemState, "recycled", `${key} non-terminal but not recycled`);
    }
  }
});

test("RingCX recycling outcomes use campaign disposition labels", () => {
  assert.equal(DISPOSITION_MAP.did_not_connect.rcxCode, "Auto Dispo");
  assert.equal(DISPOSITION_MAP.voicemail.rcxCode, "VM DROP");
});

test("listDispositions returns array with key + meta", () => {
  const list = listDispositions();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 7);
  assert.ok(list.every((d) => d.key && d.label && d.rcxCode));
});

test("getDisposition returns the entry or null", () => {
  assert.ok(getDisposition("callback"));
  assert.equal(getDisposition("nonexistent"), null);
});

test("validateDisposition — callback requires callbackAt", () => {
  const r = validateDisposition("callback", {});
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /callbackAt/);
});

test("validateDisposition — callback with valid future callbackAt", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const r = validateDisposition("callback", { callbackAt: future });
  assert.equal(r.ok, true);
});

test("validateDisposition — callback with past callbackAt fails", () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = validateDisposition("callback", { callbackAt: past });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /future/);
});

test("validateDisposition — unknown key fails", () => {
  const r = validateDisposition("nonexistent", {});
  assert.equal(r.ok, false);
});

test("validateDisposition — terminal dispositions need no payload", () => {
  for (const k of ["deal", "dnc", "postdate", "wrong_number"]) {
    assert.equal(validateDisposition(k, {}).ok, true, `${k} should validate empty`);
  }
});

test("computeNextTouchAt — stop returns null", () => {
  assert.equal(computeNextTouchAt("stop", {}), null);
});

test("computeNextTouchAt — null/undefined returns null", () => {
  assert.equal(computeNextTouchAt(null, {}), null);
  assert.equal(computeNextTouchAt(undefined, {}), null);
});

test("computeNextTouchAt — agreed returns parsed callbackAt", () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const result = computeNextTouchAt("agreed", { callbackAt: future.toISOString() });
  assert.equal(result.getTime(), future.getTime());
});

test("computeNextTouchAt — +30m advances 30 min", () => {
  const now = new Date("2026-05-04T12:00:00Z");
  const result = computeNextTouchAt("+30m", {}, now);
  assert.equal(result.getTime(), now.getTime() + 30 * 60 * 1000);
});

test("computeNextTouchAt — +1d advances 24 hours", () => {
  const now = new Date("2026-05-04T12:00:00Z");
  const result = computeNextTouchAt("+1d", {}, now);
  assert.equal(result.getTime(), now.getTime() + 24 * 60 * 60 * 1000);
});

test("computeNextTouchAt — +30d advances 30 days", () => {
  const now = new Date("2026-05-04T12:00:00Z");
  const result = computeNextTouchAt("+30d", {}, now);
  assert.equal(result.getTime(), now.getTime() + 30 * 24 * 60 * 60 * 1000);
});

test("computeNextTouchAt — invalid pattern returns null", () => {
  assert.equal(computeNextTouchAt("hello world", {}), null);
});

test("computeNextTouchAt — +2w advances 14 days", () => {
  const now = new Date("2026-05-04T12:00:00Z");
  const result = computeNextTouchAt("+2w", {}, now);
  assert.equal(result.getTime(), now.getTime() + 14 * 24 * 60 * 60 * 1000);
});

test("DISPOSITION_MAP is frozen (immutable)", () => {
  assert.throws(() => { DISPOSITION_MAP.deal = "tampered"; }, /TypeError/);
});
