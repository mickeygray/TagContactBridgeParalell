"use strict";

// Pure-function tests for pacing config patch validation.
// Run via: node --test tests/queue/pacingConfigValidation.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { validatePatch } = require("../../packages/shared-services/src/pacingConfigService");

test("empty patch is valid", () => {
  const r = validatePatch({});
  assert.equal(r.ok, true);
});

test("perAgentSliceSize must be integer", () => {
  const r = validatePatch({ perAgentSliceSize: 10.5 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /perAgentSliceSize/);
});

test("perAgentSliceSize must be in range [1, 200]", () => {
  assert.equal(validatePatch({ perAgentSliceSize: 0 }).ok, false);
  assert.equal(validatePatch({ perAgentSliceSize: 1 }).ok, true);
  assert.equal(validatePatch({ perAgentSliceSize: 200 }).ok, true);
  assert.equal(validatePatch({ perAgentSliceSize: 201 }).ok, false);
});

test("teamHourlyTarget must be in range [1, 10000]", () => {
  assert.equal(validatePatch({ teamHourlyTarget: 0 }).ok, false);
  assert.equal(validatePatch({ teamHourlyTarget: 1 }).ok, true);
  assert.equal(validatePatch({ teamHourlyTarget: 10000 }).ok, true);
  assert.equal(validatePatch({ teamHourlyTarget: 10001 }).ok, false);
});

test("freshLeadTimerSeconds must be in [10, 3600]", () => {
  assert.equal(validatePatch({ freshLeadTimerSeconds: 5 }).ok, false);
  assert.equal(validatePatch({ freshLeadTimerSeconds: 10 }).ok, true);
  assert.equal(validatePatch({ freshLeadTimerSeconds: 3600 }).ok, true);
  assert.equal(validatePatch({ freshLeadTimerSeconds: 3601 }).ok, false);
});

test("businessHoursEnd must be > businessHoursStart when both provided", () => {
  const r = validatePatch({ businessHoursStart: 10, businessHoursEnd: 8 });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /businessHoursEnd/);
});

test("businessHoursEnd > businessHoursStart passes", () => {
  const r = validatePatch({ businessHoursStart: 8, businessHoursEnd: 16 });
  assert.equal(r.ok, true);
});

test("businessDays must be array of 0-6 integers", () => {
  assert.equal(validatePatch({ businessDays: [1, 2, 3, 4, 5] }).ok, true);
  assert.equal(validatePatch({ businessDays: [1, 7] }).ok, false);
  assert.equal(validatePatch({ businessDays: [-1] }).ok, false);
  assert.equal(validatePatch({ businessDays: "monday" }).ok, false);
});

test("holidays must be YYYY-MM-DD strings", () => {
  assert.equal(validatePatch({ holidays: ["2026-12-25"] }).ok, true);
  assert.equal(validatePatch({ holidays: ["12-25-2026"] }).ok, false);
  assert.equal(validatePatch({ holidays: ["dec 25"] }).ok, false);
  assert.equal(validatePatch({ holidays: [] }).ok, true);
});

test("businessHoursTimezone must be valid IANA", () => {
  assert.equal(validatePatch({ businessHoursTimezone: "America/Los_Angeles" }).ok, true);
  assert.equal(validatePatch({ businessHoursTimezone: "UTC" }).ok, true);
  assert.equal(validatePatch({ businessHoursTimezone: "Mars/Olympus_Mons" }).ok, false);
});

test("multiple errors accumulate", () => {
  const r = validatePatch({
    perAgentSliceSize: -1,
    teamHourlyTarget: 0,
    holidays: ["nope"],
  });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 3);
});
