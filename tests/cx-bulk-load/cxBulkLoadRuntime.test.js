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
  assert.equal(_test.bulkOutcomeDisposition("bad_number"), "Auto Dispo");
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

function hangupClient() {
  const calls = [];
  return {
    calls,
    async hangupCall(uii) {
      calls.push(uii);
      return true;
    },
  };
}

test("voicemail outcome skips the post-disposition hangup — the VM DROP transfer owns the call end", async () => {
  // Field find 2026-07-06: VM DROP is xfer:2 — RingCX ends the call by transferring
  // the leg to the drop system. Hanging up right after the disposition kills the
  // drop mid-transfer (disposition accepted, hangup accepted, no voicemail landed).
  const client = hangupClient();
  const result = await _test.runPostDispositionHangupProbe(client, {
    session: { sessionId: "cxbl-test" },
    candidate: { queueItemId: "qi-vm" },
    uii: "20260706000000000000000000001",
    disposition: "VM DROP",
    outcome: "voicemail",
  });
  assert.equal(result.skipped, true);
  assert.equal(result.executed, false);
  assert.equal(result.reason, "voicemail-transfer-owns-call-end");
  assert.equal(result.ok, true);
  assert.deepEqual(client.calls, [], "hangupCall must never fire for a voicemail disposition");
});

test("did_not_connect outcome still runs the post-disposition hangup (Auto Dispo records but doesn't drop)", async () => {
  const client = hangupClient();
  const result = await _test.runPostDispositionHangupProbe(client, {
    session: { sessionId: "cxbl-test" },
    candidate: { queueItemId: "qi-dnc" },
    uii: "20260706000000000000000000002",
    disposition: "Auto Dispo",
    outcome: "did_not_connect",
  });
  assert.equal(result.executed, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "accepted");
  assert.deepEqual(client.calls, ["20260706000000000000000000002"]);
});

test("bad_number outcome still runs the post-disposition hangup", async () => {
  const client = hangupClient();
  const result = await _test.runPostDispositionHangupProbe(client, {
    session: { sessionId: "cxbl-test" },
    candidate: { queueItemId: "qi-bad" },
    uii: "20260708000000000000000000001",
    disposition: "Auto Dispo",
    outcome: "bad_number",
  });
  assert.equal(result.executed, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, "accepted");
  assert.deepEqual(client.calls, ["20260708000000000000000000001"]);
});

test("lane disposition controls the active lane UII without requiring a bulk session", async () => {
  const calls = [];
  const outboxRows = [];
  const client = {
    async dispositionCall(uii, opts) {
      calls.push({ type: "disposition", uii, opts });
      return { ok: true };
    },
    async hangupCall(uii) {
      calls.push({ type: "hangup", uii });
      return true;
    },
  };
  const result = await _test.executeLaneCallDisposition({
    client,
    laneCall: {
      lane: "firstTouch",
      uii: "uii-lane-1",
      externId: "cxft-wynn-row1",
      caseId: 101,
      domain: "WYNN",
      name: "Lane Test",
    },
    outcome: "did_not_connect",
    agent: {
      agentEmail: "mgray@taxadvocategroup.com",
      cxAgentId: "7007",
      agentExtensionId: "101",
    },
    deps: {
      insertOutboxRow: async (row) => {
        outboxRows.push(row);
        return row;
      },
    },
  });
  assert.equal(result.dispositionOk, true);
  assert.equal(result.disposition, "Auto Dispo");
  assert.equal(result.persisted, true);
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0].agentId, "7007", "RingCX agent ID is not replaced by the extension ID");
  assert.equal(outboxRows[0].agentExtensionId, "101");
  assert.equal(outboxRows[0].payload.agentId, "7007");
  assert.equal(outboxRows[0].payload.agentExtensionId, "101");
  assert.deepEqual(calls, [
    { type: "disposition", uii: "uii-lane-1", opts: { disposition: "Auto Dispo", callback: false, notes: undefined } },
    { type: "hangup", uii: "uii-lane-1" },
  ]);
});

test("legacy direct terminal dispatch preserves both agent identities", async () => {
  let received = null;
  const result = await _test.dispatchCadenceEvent({
    queueItemId: "q-1",
    domain: "WYNN",
    caseId: 101,
    uii: "uii-1",
    externId: "cxbl-wynn-q-1",
    agentId: "7007",
    agentExtensionId: "101",
    agentEmail: "agent@example.com",
    outcome: "answered",
    source: "agent-button",
    at: "2026-07-09T12:00:00.000Z",
  }, async (payload) => {
    received = payload;
    return { ok: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(received.agentId, "7007");
  assert.equal(received.agentExtensionId, "101");
  assert.equal(received.actorEmail, "agent@example.com");
  assert.equal(received.outcomeAt, "2026-07-09T12:00:00.000Z");
});

test("ghost-rescue decision: innocent deaths rescue, compliance/foreign/racing rows never do", () => {
  const d = _test.deriveRescueDecision;
  const sess = "cxbl-me";
  // innocent bleed — rescueable
  assert.deepEqual(d({ state: "cancelled", metadata: { cancelledReason: "drill-manufactured-drift" } }, sess), { rescue: true, reason: "rescue-from-cancelled" });
  assert.deepEqual(d({ state: "ready", metadata: {} }, sess), { rescue: true, reason: "rescue-from-ready" });
  // compliance owns DNC/contact-blocked rows — never rescued, under EITHER reason key
  // (cancelReserved writes cancelledReason; stopCaseContact→cancelActiveQueueItems writes
  // cancelReason — the adversarial pass caught the gate reading only one of them)
  assert.equal(d({ state: "cancelled", metadata: { cancelledReason: "bulk-contact-blocked:dnc" } }, sess).rescue, false);
  assert.equal(d({ state: "cancelled", metadata: { cancelledReason: "enforced-DNC" } }, sess).reason, "contact-blocked");
  assert.equal(d({ state: "cancelled", metadata: { cancelReason: "contact-blocked" } }, sess).reason, "contact-blocked");
  assert.equal(d({ state: "cancelled", metadata: { cancelReason: "dnc" } }, sess).rescue, false);
  // another live session's row — theirs
  assert.equal(d({ state: "ready", metadata: { reservationSessionId: "cxbl-someone-else" } }, sess).reason, "reservation-foreign");
  // claimed/serving = the normal stamp's territory; a miss there is a race, not a death
  assert.equal(d({ state: "claimed", metadata: { reservationSessionId: sess } }, sess).reason, "state-claimed");
  assert.equal(d(null, sess).reason, "row-missing");
});

test("off-hook gate fails closed on a busy/on-call agent (ready=false despite a truthy sessionId)", () => {
  const offhook = _test.isBulkLoginOffhook;
  // Mid-call agent: merely logged in (truthy sessionId) but the summarizer flagged a failure.
  assert.equal(offhook({ sessionId: "sess-1", offHook: null, ready: false, failures: ["agent-session-busy"] }), false, "busy agent must NOT pass the off-hook gate");
  assert.equal(offhook({ sessionId: "sess-1", ready: false, failures: ["agent-pending-disposition"] }), false, "pending-disposition agent rejected");
  // Clean off-hook: logged in, no failures -> ready true.
  assert.equal(offhook({ sessionId: "sess-1", ready: true, offHook: true }), true, "a clean off-hook agent passes");
  assert.equal(offhook({ sessionId: "sess-1", ready: true }), true, "logged-in + ready (no failures) passes on sessionId");
});
