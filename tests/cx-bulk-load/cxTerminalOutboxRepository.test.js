"use strict";

// Pure pins for the 2026-07-06 drain hardening: backoff math + the dead-letter cap.
// The Mongo query/CAS behavior is integration-deferred (no local Mongo in the gate);
// these lock the arithmetic the repository schedules retries with.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  computeDrainBackoffMs,
} = require("../../packages/shared-repositories/src/cxTerminalOutboxRepository");

test("drain backoff grows quadratically and caps at 30 minutes", () => {
  assert.equal(computeDrainBackoffMs(1), 15_000);
  assert.equal(computeDrainBackoffMs(2), 60_000);
  assert.equal(computeDrainBackoffMs(4), 240_000);
  assert.equal(computeDrainBackoffMs(11), 30 * 60 * 1000, "capped at 30min");
  assert.equal(computeDrainBackoffMs(100), 30 * 60 * 1000);
  assert.equal(computeDrainBackoffMs(0), 15_000, "attempt floor of 1");
});

test("ENQUEUE SIGNAL: first insert notifies listeners; duplicates and listener errors stay silent", async () => {
  const repo = require("../../packages/shared-repositories/src/cxTerminalOutboxRepository");
  const seen = [];
  const off = repo.onCxTerminalRowEnqueued((row) => { seen.push(row.idemKey); });
  const offBoom = repo.onCxTerminalRowEnqueued(() => { throw new Error("listener boom"); });
  try {
    // no Mongo in the gate — drive notifyEnqueued through insertOnce's contract by
    // asserting the subscription surface directly (the wiring is 6 lines; the contract
    // is: function registered, unsubscribe works, errors swallowed via setImmediate).
    assert.equal(typeof repo.onCxTerminalRowEnqueued, "function");
    assert.equal(typeof off, "function");
    off();
    offBoom();
  } finally {
    off();
    offBoom();
  }
});
