"use strict";

const FEATURE_ENV_KEYS = Object.freeze({
  courseV1Enabled: "SALES_TRAINER_COURSE_V1_ENABLED",
  gauntletV1Enabled: "SALES_TRAINER_GAUNTLET_V1_ENABLED",
  callReviewV1Enabled: "SALES_TRAINER_CALL_REVIEW_V1_ENABLED",
});

function parseBooleanFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "").trim().toLowerCase(),
  );
}

function getSalesTrainerFeatureFlags(source = process.env) {
  const env = source && typeof source === "object" ? source : {};
  return Object.freeze(
    Object.fromEntries(
      Object.entries(FEATURE_ENV_KEYS).map(([key, envKey]) => [
        key,
        parseBooleanFlag(env[envKey]),
      ]),
    ),
  );
}

module.exports = {
  FEATURE_ENV_KEYS,
  getSalesTrainerFeatureFlags,
  parseBooleanFlag,
};
