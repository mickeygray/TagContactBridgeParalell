"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { _test } = require("../../packages/shared-services/src/cxBulkLoadRuntime");

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (previous[key] == null) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function pauseClient() {
  const calls = [];
  return {
    calls,
    async setAgentState(agentId, stateId, agentGroupId) {
      calls.push({ agentId, stateId, agentGroupId });
      return { ok: true };
    },
  };
}

test("bulkOutcomeDisposition maps bulk UI outcomes to configured RingCX dispositions", () => {
  assert.equal(_test.bulkOutcomeDisposition("voicemail"), "VM DROP");
  assert.equal(_test.bulkOutcomeDisposition("dnc"), "Auto Dispo");
  assert.equal(_test.bulkOutcomeDisposition("answered"), "Auto Dispo");
});

test("progressive pause holdUntilResume pauses without scheduling restore and resume makes available", async () => withEnv({
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED: "true",
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS: "10",
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_STATE_ID: "WORKING",
  CX_BULK_LOAD_PROGRESSIVE_AVAILABLE_STATE_ID: "AVAILABLE",
}, async () => {
  const client = pauseClient();
  const session = { cxAgentId: "agent1", ringcx: { agentGroupId: "group1" } };
  const paused = await _test.pauseRingcxProgressiveDialing(client, session, { holdUntilResume: true });
  assert.equal(paused.ok, true);
  assert.equal(paused.restoreScheduled, false);
  assert.deepEqual(client.calls.map((call) => call.stateId), ["WORKING"]);

  const resumed = await _test.resumeRingcxProgressiveDialing(client, session);
  assert.equal(resumed.ok, true);
  assert.deepEqual(client.calls.map((call) => call.stateId), ["WORKING", "AVAILABLE"]);
}));

test("progressive pause token supersedes stale restores", async () => withEnv({
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED: "true",
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS: "10",
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_STATE_ID: "WORKING",
  CX_BULK_LOAD_PROGRESSIVE_AVAILABLE_STATE_ID: "AVAILABLE",
}, async () => {
  const client = pauseClient();
  const session = { cxAgentId: "agent2", ringcx: { agentGroupId: "group1" } };
  await _test.pauseRingcxProgressiveDialing(client, session, { reason: "first" });
  await _test.pauseRingcxProgressiveDialing(client, session, { reason: "second", holdUntilResume: true });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(client.calls.map((call) => call.stateId), ["WORKING", "WORKING"]);
  await _test.resumeRingcxProgressiveDialing(client, session);
  assert.deepEqual(client.calls.map((call) => call.stateId), ["WORKING", "WORKING", "AVAILABLE"]);
}));

test("progressive pause can be disabled by env", async () => withEnv({
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED: "false",
  CX_BULK_LOAD_PROGRESSIVE_PAUSE_STATE_ID: "WORKING",
  CX_BULK_LOAD_PROGRESSIVE_AVAILABLE_STATE_ID: "AVAILABLE",
}, async () => {
  const client = pauseClient();
  const result = await _test.pauseRingcxProgressiveDialing(client, { cxAgentId: "agent3", ringcx: { agentGroupId: "group1" } });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "disabled");
  assert.equal(client.calls.length, 0);
}));

test("off-hook gate fails closed on a busy/on-call agent (ready=false despite a truthy sessionId)", () => {
  const offhook = _test.isBulkLoginOffhook;
  // Mid-call agent: merely logged in (truthy sessionId) but the summarizer flagged a failure.
  assert.equal(offhook({ sessionId: "sess-1", offHook: null, ready: false, failures: ["agent-session-busy"] }), false, "busy agent must NOT pass the off-hook gate");
  assert.equal(offhook({ sessionId: "sess-1", ready: false, failures: ["agent-pending-disposition"] }), false, "pending-disposition agent rejected");
  // Clean off-hook: logged in, no failures -> ready true.
  assert.equal(offhook({ sessionId: "sess-1", ready: true, offHook: true }), true, "a clean off-hook agent passes");
  assert.equal(offhook({ sessionId: "sess-1", ready: true }), true, "logged-in + ready (no failures) passes on sessionId");
});
