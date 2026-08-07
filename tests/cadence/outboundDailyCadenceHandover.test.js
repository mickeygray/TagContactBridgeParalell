"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dailyCadenceOwnedByPasses,
} = require("../../apps/outbound-gateway/src/server");

const armed = {
  OUTBOUND_DAILY_CADENCE_TO_PASSES: "true",
  MORNING_PASS_ENABLED: "true",
  MORNING_CADENCE_ENABLED: "true",
  MIDDAY_PASS_ENABLED: "true",
  MIDDAY_CADENCE_ENABLED: "true",
};

test("the gateway keeps daily cadence until the handover is explicitly requested", () => {
  assert.equal(dailyCadenceOwnedByPasses({ ...armed, OUTBOUND_DAILY_CADENCE_TO_PASSES: "false" }), false);
});

test("one missing pass flag cannot silently turn daily cadence off", () => {
  for (const key of [
    "MORNING_PASS_ENABLED",
    "MORNING_CADENCE_ENABLED",
    "MIDDAY_PASS_ENABLED",
    "MIDDAY_CADENCE_ENABLED",
  ]) {
    assert.equal(dailyCadenceOwnedByPasses({ ...armed, [key]: "false" }), false, key);
  }
});

test("the gateway surrenders daily cadence only after the complete handover", () => {
  assert.equal(dailyCadenceOwnedByPasses(armed), true);
});
