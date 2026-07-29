"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  FEATURE_ENV_KEYS,
  getSalesTrainerFeatureFlags,
  parseBooleanFlag,
} = require("../../packages/shared-services/src/salesTrainerFeatureFlags");

test("all Trainer v1 features default off", () => {
  assert.deepEqual(getSalesTrainerFeatureFlags({}), {
    courseV1Enabled: false,
    gauntletV1Enabled: false,
    callReviewV1Enabled: false,
  });
});

test("feature flags resolve independently from explicit truthy values", () => {
  assert.deepEqual(
    getSalesTrainerFeatureFlags({
      SALES_TRAINER_COURSE_V1_ENABLED: "true",
      SALES_TRAINER_GAUNTLET_V1_ENABLED: "0",
      SALES_TRAINER_CALL_REVIEW_V1_ENABLED: "ON",
    }),
    {
      courseV1Enabled: true,
      gauntletV1Enabled: false,
      callReviewV1Enabled: true,
    },
  );
});

test("only documented boolean-like values opt a feature in", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
    assert.equal(parseBooleanFlag(value), true, String(value));
  }
  for (const value of [undefined, null, "", "0", "false", "enabled", "random"]) {
    assert.equal(parseBooleanFlag(value), false, String(value));
  }
});

test("public feature names map only to the three approved environment keys", () => {
  assert.deepEqual(FEATURE_ENV_KEYS, {
    courseV1Enabled: "SALES_TRAINER_COURSE_V1_ENABLED",
    gauntletV1Enabled: "SALES_TRAINER_GAUNTLET_V1_ENABLED",
    callReviewV1Enabled: "SALES_TRAINER_CALL_REVIEW_V1_ENABLED",
  });
});
