"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveElevationMinPaid,
  buildElevationCandidateQuery,
} = require("../../packages/shared-services/src/resolutionBankService");

const ENV_KEY = "RESOLUTION_ELEVATION_MIN_PAID";

function withEnv(value, fn) {
  const saved = process.env[ENV_KEY];
  if (value === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
  }
}

// ── resolveElevationMinPaid ───────────────────────────────────────────────────
test("resolveElevationMinPaid: fails OPEN to 0 (ungated) when unset / zero / negative / NaN", () => {
  withEnv(undefined, () => {
    assert.equal(resolveElevationMinPaid(), 0);
    assert.equal(resolveElevationMinPaid(0), 0);
    assert.equal(resolveElevationMinPaid(-5000), 0);
    assert.equal(resolveElevationMinPaid("not-a-number"), 0);
  });
});

test("resolveElevationMinPaid: reads the env knob when no override is passed", () => {
  withEnv("5000", () => {
    assert.equal(resolveElevationMinPaid(), 5000);
  });
});

test("resolveElevationMinPaid: an explicit override wins over the env knob", () => {
  withEnv("9999", () => {
    assert.equal(resolveElevationMinPaid(5000), 5000);
  });
});

// ── buildElevationCandidateQuery ──────────────────────────────────────────────
test("buildElevationCandidateQuery: ungated (minPaid 0) is byte-identical to the pre-gate query", () => {
  assert.deepEqual(
    buildElevationCandidateQuery({ domains: ["TAG"], minPaid: 0 }),
    { statusCategory: "client", domain: { $in: ["TAG"] } },
  );
});

test("buildElevationCandidateQuery: gated (minPaid 5000) requires totalPaid >= 5000", () => {
  assert.deepEqual(
    buildElevationCandidateQuery({ domains: ["TAG", "WYNN"], minPaid: 5000 }),
    { statusCategory: "client", domain: { $in: ["TAG", "WYNN"] }, totalPaid: { $gte: 5000 } },
  );
});

test("buildElevationCandidateQuery: a negative/invalid minPaid does not add a filter (fail-open)", () => {
  assert.deepEqual(
    buildElevationCandidateQuery({ domains: ["AMITY"], minPaid: -1 }),
    { statusCategory: "client", domain: { $in: ["AMITY"] } },
  );
});
