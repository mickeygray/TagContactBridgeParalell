"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildFamilyTargets, readEnvNonNegInt } = require("../../packages/shared-services/src/cxReserveModeService");

// A resolved policy (isResolvedQueuePolicy needs label+enabled + the four buckets).
const policy15_10_5_5 = {
  label: "Test",
  enabled: true,
  fresh: { eligible: true, targetOpen: 15 },
  day2to15: { targetOpen: 10 },
  day16to30: { targetOpen: 5 },
  aged: { targetOpen: 5, fillRemainder: true },
};

test("mix (default) maps per-family targetOpen straight through (15/10/5/5)", () => {
  const targets = buildFamilyTargets({ policy: policy15_10_5_5, totalDeficit: 35, env: {} });
  assert.deepEqual(targets, {
    "fresh-day1": 15,
    "fresh-day2to10": 10,
    "fresh-day16to30": 5,
    aged: 5,
  });
});

test("green-first sends the whole deficit to fresh-day1, zeroes the rest", () => {
  const targets = buildFamilyTargets({
    policy: policy15_10_5_5,
    totalDeficit: 30,
    env: { RC_CX_RESERVE_MODE: "green-first" },
  });
  assert.deepEqual(targets, { "fresh-day1": 30, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 });
});

test("green-first does not reserve fresh when the policy says fresh is ineligible", () => {
  const freshClosed = { ...policy15_10_5_5, fresh: { eligible: false, targetOpen: 15 } };
  const targets = buildFamilyTargets({
    policy: freshClosed,
    totalDeficit: 30,
    env: { RC_CX_RESERVE_MODE: "green-first" },
  });
  assert.deepEqual(targets, { "fresh-day1": 0, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 });
});

test("aged floor applies in green-first (the only aged guarantee there)", () => {
  const targets = buildFamilyTargets({
    policy: policy15_10_5_5,
    totalDeficit: 30,
    env: { RC_CX_RESERVE_MODE: "green-first", RC_CX_AGED_MIN_RESERVE_PER_CYCLE: "4" },
  });
  assert.equal(targets.aged, 4);
});

test("aged floor lifts a policy-aged of 0 in mix mode", () => {
  const agedZero = { ...policy15_10_5_5, aged: { targetOpen: 0, fillRemainder: false } };
  const targets = buildFamilyTargets({
    policy: agedZero,
    totalDeficit: 35,
    env: { RC_CX_AGED_MIN_RESERVE_PER_CYCLE: "3" },
  });
  assert.equal(targets.aged, 3);
});

test("aged floor never lowers a higher policy aged target", () => {
  const targets = buildFamilyTargets({
    policy: policy15_10_5_5,
    totalDeficit: 35,
    env: { RC_CX_AGED_MIN_RESERVE_PER_CYCLE: "2" },
  });
  assert.equal(targets.aged, 5); // max(5, 2)
});

test("a disabled policy yields all-zero targets in mix", () => {
  const disabled = { ...policy15_10_5_5, enabled: false };
  const targets = buildFamilyTargets({ policy: disabled, totalDeficit: 35, env: {} });
  assert.deepEqual(targets, { "fresh-day1": 0, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 });
});

test("a disabled policy stays all-zero even when aged floor env is set", () => {
  const disabled = { ...policy15_10_5_5, enabled: false };
  const mixTargets = buildFamilyTargets({
    policy: disabled,
    totalDeficit: 35,
    env: { RC_CX_AGED_MIN_RESERVE_PER_CYCLE: "4" },
  });
  const greenFirstTargets = buildFamilyTargets({
    policy: disabled,
    totalDeficit: 35,
    env: { RC_CX_RESERVE_MODE: "green-first", RC_CX_AGED_MIN_RESERVE_PER_CYCLE: "4" },
  });
  assert.deepEqual(mixTargets, { "fresh-day1": 0, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 });
  assert.deepEqual(greenFirstTargets, { "fresh-day1": 0, "fresh-day2to10": 0, "fresh-day16to30": 0, aged: 0 });
});

test("readEnvNonNegInt: fallback when unset, truncates, rejects negative/NaN", () => {
  assert.equal(readEnvNonNegInt("MISSING", 7, {}), 7);
  assert.equal(readEnvNonNegInt("N", 0, { N: "5.9" }), 5);
  assert.equal(readEnvNonNegInt("N", 9, { N: "-2" }), 9);
  assert.equal(readEnvNonNegInt("N", 9, { N: "x" }), 9);
});
