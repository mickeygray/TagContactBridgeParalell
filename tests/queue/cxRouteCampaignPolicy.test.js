"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeRouteCampaigns,
} = require("../../packages/shared-services/src/cxQueuePolicyService");

test("ld-custom subscription expands to all custom LD sibling buckets", () => {
  assert.deepEqual(normalizeRouteCampaigns("ld-custom"), [
    "ld-custom",
    "ld-custom-2",
    "ld-custom-3",
  ]);
});

test("specific LD bucket subscriptions stay specific", () => {
  assert.deepEqual(normalizeRouteCampaigns("ld-custom-2, ld-custom-3"), [
    "ld-custom-2",
    "ld-custom-3",
  ]);
});
