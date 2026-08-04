"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWorkerState,
  intervalDue,
  isPacificBusinessDay,
  isRvmDispositionPollingEnabled,
  runRvmDispositionPollIfDue,
} = require("../../apps/outbound-gateway/src/server");

test("RVM disposition polling is hard-gated off by default", () => {
  assert.equal(isRvmDispositionPollingEnabled({ env: {}, config: {} }), false);
  assert.equal(
    isRvmDispositionPollingEnabled({
      env: { RVM_DISPOSITION_POLL_ENABLED: "true" },
      config: {},
    }),
    true,
  );
});

test("RVM disposition polling owns one five-minute cadence for both stores", async () => {
  const workerState = createWorkerState();
  const calls = [];
  const pollCounter = async () => { calls.push("counter"); return { polled: 0 }; };
  const pollScheduled = async () => { calls.push("scheduled"); return { polled: 0 }; };
  const started = new Date("2026-08-03T16:00:00.000Z");

  const first = await runRvmDispositionPollIfDue({
    workerState, now: started, intervalMs: 300_000, pollCounter, pollScheduled,
  });
  assert.equal(first.status, "completed");
  assert.deepEqual(calls, ["counter", "scheduled"]);

  const early = await runRvmDispositionPollIfDue({
    workerState,
    now: new Date(started.getTime() + 299_999),
    intervalMs: 300_000,
    pollCounter,
    pollScheduled,
  });
  assert.equal(early.status, "not-due");
  assert.deepEqual(calls, ["counter", "scheduled"]);

  const due = await runRvmDispositionPollIfDue({
    workerState,
    now: new Date(started.getTime() + 300_000),
    intervalMs: 300_000,
    pollCounter,
    pollScheduled,
  });
  assert.equal(due.status, "completed");
  assert.deepEqual(calls, ["counter", "scheduled", "counter", "scheduled"]);
  assert.equal(intervalDue(workerState.rvmDisposition.lastCheckedAt, new Date(started.getTime() + 599_999), 300_000), false);
});

test("one RVM disposition lane failing does not suppress the other lane", async () => {
  const workerState = createWorkerState();
  let scheduledCalls = 0;
  const result = await runRvmDispositionPollIfDue({
    workerState,
    now: new Date("2026-08-03T16:00:00.000Z"),
    pollCounter: async () => { throw new Error("counter unavailable"); },
    pollScheduled: async () => { scheduledCalls += 1; return { polled: 0 }; },
  });
  assert.equal(result.status, "partial");
  assert.equal(scheduledCalls, 1);
  assert.equal(workerState.rvmDisposition.lastError, "counter");
});

test("RVM disposition polling is dormant on Pacific weekends", async () => {
  const workerState = createWorkerState();
  let calls = 0;
  const now = new Date("2026-08-02T16:00:00.000Z");
  assert.equal(isPacificBusinessDay(now), false);
  const result = await runRvmDispositionPollIfDue({
    workerState,
    now,
    pollCounter: async () => { calls += 1; },
    pollScheduled: async () => { calls += 1; },
  });
  assert.deepEqual(result, { status: "weekend-paused" });
  assert.equal(calls, 0);
  assert.equal(workerState.rvmDisposition.lastCheckedAt, null);
});

test("lead cadence declares targeted RVM and tenant email-hash indexes", () => {
  const LeadCadence = require("../../packages/shared-models/src/LeadCadence");
  const byName = new Map(LeadCadence.schema.indexes().map(([keys, options]) => [options.name, { keys, options }]));
  assert.deepEqual(byName.get("lead_cadence_domain_email_hash").keys, { domain: 1, emailHash: 1 });
  assert.deepEqual(byName.get("lead_cadence_scheduled_rvm_poll").keys, {
    "schedule.actions.providerDelivery.postedAt": 1,
  });
  assert.equal(byName.get("lead_cadence_scheduled_rvm_poll").options.sparse, true);
  assert.deepEqual(byName.get("lead_cadence_counter_rvm_poll").keys, {
    "counterCadence.rvmDeliveries.postedAt": 1,
  });
  assert.equal(byName.get("lead_cadence_counter_rvm_poll").options.sparse, true);
});
