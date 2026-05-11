"use strict";

// Pure-function tests for the proportional age-mix sampling math.
// No Mongo, no async deps. Run via:
//   node --test tests/queue/computeTargetMix.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { computeTargetMix } = require("../../packages/shared-services/src/agentSliceService");

test("empty pool → zero target", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 0, aged: 0 },
    sliceSize: 10,
  });
  assert.deepEqual(target, { day2_10: 0, aged: 0 });
});

test("only day2_10 in pool → all 10 from day2_10", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 50, aged: 0 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10, 10);
  assert.equal(target.aged, 0);
});

test("only aged in pool → all 10 from aged", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 0, aged: 50 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10, 0);
  assert.equal(target.aged, 10);
});

test("50/50 split → 5/5 slice", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 50, aged: 50 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10 + target.aged, 10);
  assert.equal(target.day2_10, 5);
  assert.equal(target.aged, 5);
});

test("70/30 split → 7/3 slice", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 70, aged: 30 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10 + target.aged, 10);
  assert.equal(target.day2_10, 7);
  assert.equal(target.aged, 3);
});

test("pool smaller than slice size → caps to pool", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 3, aged: 4 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10 + target.aged, 7);
  assert.equal(target.day2_10, 3);
  assert.equal(target.aged, 4);
});

test("33/67 split with rounding drift → still sums to 10", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 33, aged: 67 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10 + target.aged, 10);
  // 10 * 0.33 = 3.3 → 3, 10 * 0.67 = 6.7 → 7. Total = 10. Good.
});

test("80/20 with sliceSize 5 → 4/1", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 80, aged: 20 },
    sliceSize: 5,
  });
  assert.equal(target.day2_10 + target.aged, 5);
  assert.equal(target.day2_10, 4);
  assert.equal(target.aged, 1);
});

test("integer rounding edge — 1/1 with sliceSize 1 picks one bucket", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 1, aged: 1 },
    sliceSize: 1,
  });
  assert.equal(target.day2_10 + target.aged, 1);
});

test("very imbalanced — 100/1 still represents the smaller bucket if size allows", () => {
  const target = computeTargetMix({
    poolByAgeBucket: { day2_10: 100, aged: 1 },
    sliceSize: 10,
  });
  assert.equal(target.day2_10 + target.aged, 10);
  // 10 * 100/101 ≈ 9.9 → 10; 10 * 1/101 ≈ 0.099 → 0
  assert.equal(target.day2_10, 10);
  assert.equal(target.aged, 0);
});
