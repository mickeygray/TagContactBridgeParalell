"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  nightlyOwnsStandaloneTask,
} = require("../../apps/control-plane/src/services/scheduledPassOwnership");

test("a nightly task cannot disable its standalone owner unless both owners agree", () => {
  const taskFlag = "NIGHTLY_ACTIVITY_REVIEW_ENABLED";
  assert.equal(nightlyOwnsStandaloneTask(taskFlag, { env: {} }), false);
  assert.equal(nightlyOwnsStandaloneTask(taskFlag, {
    env: { NIGHTLY_HYGIENE_ENABLED: "true" },
  }), false);
  assert.equal(nightlyOwnsStandaloneTask(taskFlag, {
    env: { [taskFlag]: "true" },
  }), false);
  assert.equal(nightlyOwnsStandaloneTask(taskFlag, {
    env: { NIGHTLY_HYGIENE_ENABLED: "true", [taskFlag]: "true" },
  }), true);
});

test("an already-configured nightly runtime still requires the task flag", () => {
  assert.equal(nightlyOwnsStandaloneTask("NIGHTLY_SPEND_SYNC_ENABLED", {
    nightlyConfigured: true,
    env: {},
  }), false);
  assert.equal(nightlyOwnsStandaloneTask("NIGHTLY_SPEND_SYNC_ENABLED", {
    nightlyConfigured: true,
    env: { NIGHTLY_SPEND_SYNC_ENABLED: "TRUE" },
  }), true);
});
