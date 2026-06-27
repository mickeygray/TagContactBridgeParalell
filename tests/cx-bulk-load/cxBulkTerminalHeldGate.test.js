"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  shouldBypassHeldGateForBulkTerminal,
} = require("../../packages/shared-services/src/cxCadenceService");

function bulkItem(patch = {}) {
  return {
    state: "claimed",
    metadata: { reservationRail: "bulk_load" },
    ...patch,
  };
}

test("bulk terminal rows with UII proof can bypass the held-for-disposition gate", () => {
  assert.equal(shouldBypassHeldGateForBulkTerminal({
    payload: { sourceService: "cx-bulk-load", uii: "uii-1" },
    queueItem: bulkItem(),
    queueState: "claimed",
  }), true);
});

test("bulk terminal bypass requires bulk ownership", () => {
  assert.equal(shouldBypassHeldGateForBulkTerminal({
    payload: { sourceService: "cx-bulk-load", uii: "uii-1" },
    queueItem: { state: "claimed", metadata: {} },
    queueState: "claimed",
  }), false);
});

test("bulk terminal bypass requires UII or call-session proof", () => {
  assert.equal(shouldBypassHeldGateForBulkTerminal({
    payload: { sourceService: "cx-bulk-load" },
    queueItem: bulkItem(),
    queueState: "claimed",
  }), false);
});

test("bulk terminal bypass does not reopen completed or cancelled rows", () => {
  assert.equal(shouldBypassHeldGateForBulkTerminal({
    payload: { sourceService: "cx-bulk-load", callSessionId: "uii-1" },
    queueItem: bulkItem({ state: "completed" }),
    queueState: "completed",
  }), false);
});

test("legacy terminal rows cannot use the bulk held-gate bypass", () => {
  assert.equal(shouldBypassHeldGateForBulkTerminal({
    payload: { sourceService: "ringcentral-cx", uii: "uii-1" },
    queueItem: bulkItem(),
    queueState: "claimed",
  }), false);
});
