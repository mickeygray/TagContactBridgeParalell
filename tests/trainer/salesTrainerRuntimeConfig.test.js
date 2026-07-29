"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const {
  buildSalesTrainerAccount,
  issueSalesTrainerToken,
} = require("../../packages/shared-services/src/taxResolutionSalesTrainerService");
const {
  createSalesTrainerRouter,
} = require("../../apps/control-plane/src/routes/salesTrainer");

const FEATURE_ENV_KEYS = [
  "SALES_TRAINER_ALLOWED_EMAILS",
  "SALES_TRAINER_TOKEN_SECRET",
  "SALES_TRAINER_COURSE_V1_ENABLED",
  "SALES_TRAINER_GAUNTLET_V1_ENABLED",
  "SALES_TRAINER_CALL_REVIEW_V1_ENABLED",
];

test("authenticated Trainer config exposes only resolved feature booleans", async (t) => {
  const prior = Object.fromEntries(
    FEATURE_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.SALES_TRAINER_ALLOWED_EMAILS = "phase0@example.test";
  process.env.SALES_TRAINER_TOKEN_SECRET = "phase0-test-secret-not-for-production";
  process.env.SALES_TRAINER_COURSE_V1_ENABLED = "true";
  process.env.SALES_TRAINER_GAUNTLET_V1_ENABLED = "false";
  process.env.SALES_TRAINER_CALL_REVIEW_V1_ENABLED = "on";
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const email = "phase0@example.test";
  const token = issueSalesTrainerToken(
    { jwtSecret: "unused-test-fallback" },
    email,
    buildSalesTrainerAccount(email),
  ).token;
  const pass = (_req, _res, next) => next();
  const app = express();
  app.use(
    "/api/sales-trainer",
    createSalesTrainerRouter(
      { requireAuth: pass, requireAdmin: pass },
      { jwtSecret: "unused-test-fallback" },
    ),
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/sales-trainer/config`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.features, {
    courseV1Enabled: true,
    gauntletV1Enabled: false,
    callReviewV1Enabled: true,
  });
  assert.equal(
    JSON.stringify(body.result.features).includes("SALES_TRAINER_"),
    false,
  );
});
