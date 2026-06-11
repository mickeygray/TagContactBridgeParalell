"use strict";

// Coach-triggered voicemail drop trigger: default-off, HARD agent allowlist
// (Michael Gray rollout), optional phone gate, fires at most once per session.
// Gating is tested via maybeFire's return; the RC transfer chain is tested by
// awaiting transferAgentPeer directly (no timer races). fetch is stubbed.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createLiveCoachVmTransferTrigger,
} = require("../../packages/shared-services/src/liveCoachVmTransferService");

function makeFetchStub() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    // oauth bodies are URL-encoded, not JSON — parse leniently.
    let body = null;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { body = String(init.body); }
    }
    calls.push({ url: String(url), method: init.method || "GET", body });
    const u = String(url);
    const respond = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (u.includes("/restapi/oauth/token")) return respond({ access_token: "tok", expires_in: 3600 });
    if (u.includes("/active-calls")) {
      return respond({ records: [{ telephonyStatus: "CallConnected", telephonySessionId: "ts-1", direction: "Inbound" }] });
    }
    if (u.includes("/parties/p-agent/transfer")) return respond({ id: "p-agent", status: { code: "Gone" } });
    if (u.includes("/telephony/sessions/ts-1")) {
      return respond({ parties: [
        { id: "p-agent", extensionId: "63730035004", status: { code: "Answered" } },
        { id: "p-peer", extensionId: "", status: { code: "Answered" } },
      ] });
    }
    return respond({});
  };
  return { fetchImpl, calls };
}

function env(overrides = {}) {
  return {
    RING_CENTRAL_CLIENT_ID: "id",
    RING_CENTRAL_CLIENT_SECRET: "secret",
    RING_CENTRAL_JWT_TOKEN: "jwt",
    LIVE_COACH_VM_TRANSFER_ENABLED: "true",
    LIVE_COACH_VM_TRANSFER_AGENT_ALLOWLIST: "mgray@taxadvocategroup.com,63730035004,michael gray",
    LIVE_COACH_VM_TRANSFER_TARGET_EXT: "98765",
    LIVE_COACH_VM_TRANSFER_BEEP_DELAY_MS: "0",
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: "coach-test-1",
    metadata: {
      phone: "3106665997",
      agentExtension: "63730035004",
      agentEmail: "mgray@taxadvocategroup.com",
      agentName: "Michael Gray",
    },
    ...overrides,
  };
}

test("fires for an allowlisted agent, once per session", () => {
  const { fetchImpl } = makeFetchStub();
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env() });
  assert.equal(trigger.maybeFire(session(), { match: "leave a message" }), true);
  assert.equal(trigger.maybeFire(session()), false, "same session must not double-fire");
  assert.equal(trigger.maybeFire(session({ id: "coach-test-2" })), true, "a new session fires fresh");
});

test("agent gate: non-allowlisted agent never fires; matching by name alone works", () => {
  const { fetchImpl } = makeFetchStub();
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env() });
  assert.equal(trigger.maybeFire(session({
    id: "s-brad",
    metadata: { phone: "3106665997", agentExtension: "63914587004", agentEmail: "bhansen@taxadvocategroup.com", agentName: "Brad Hansen" },
  })), false);
  assert.equal(trigger.maybeFire(session({
    id: "s-name-only",
    metadata: { phone: "3106665997", agentExtension: "63730035004", agentName: "Michael Gray" },
  })), true);
});

test("empty agent allowlist never fires, even when enabled", () => {
  const { fetchImpl } = makeFetchStub();
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env({ LIVE_COACH_VM_TRANSFER_AGENT_ALLOWLIST: "" }) });
  assert.equal(trigger.maybeFire(session()), false);
});

test("disabled by default", () => {
  const { fetchImpl } = makeFetchStub();
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env({ LIVE_COACH_VM_TRANSFER_ENABLED: "" }) });
  assert.equal(trigger.maybeFire(session()), false);
});

test("optional phone allowlist adds a second gate when set", () => {
  const { fetchImpl } = makeFetchStub();
  const gated = createLiveCoachVmTransferTrigger({
    fetchImpl,
    env: env({ LIVE_COACH_VM_TRANSFER_PHONE_ALLOWLIST: "3106665997" }),
  });
  assert.equal(gated.maybeFire(session()), true);
  assert.equal(gated.maybeFire(session({
    id: "s-other-phone",
    metadata: { ...session().metadata, phone: "8185551234" },
  })), false);
});

test("transferAgentPeer: finds the agent party and transfers its peer to the target ext", async () => {
  const { fetchImpl, calls } = makeFetchStub();
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env() });
  const result = await trigger.transferAgentPeer("63730035004");
  assert.equal(result.telephonySessionId, "ts-1");
  assert.equal(result.partyId, "p-agent");
  assert.equal(result.targetExt, "98765");
  const transfer = calls.find((c) => c.url.includes("/parties/p-agent/transfer"));
  assert.ok(transfer, "transfer POST must be made");
  assert.equal(transfer.method, "POST");
  assert.deepEqual(transfer.body, { extensionNumber: "98765" });
});

function makeRingcxStub() {
  const calls = [];
  return {
    calls,
    addSessionToCall: async (uii, opts) => { calls.push({ fn: "addSessionToCall", uii, opts }); return { ok: true }; },
    hangupCall: async (uii) => { calls.push({ fn: "hangupCall", uii }); return { ok: true }; },
    dispositionCall: async (uii, opts) => { calls.push({ fn: "dispositionCall", uii, opts }); return { ok: true }; },
  };
}

test("ringcx-disposition mode: sets the VM disposition on the session's UII", async () => {
  const ringcxClient = makeRingcxStub();
  const trigger = createLiveCoachVmTransferTrigger({
    ringcxClient,
    env: env({ LIVE_COACH_VM_TRANSFER_MODE: "ringcx-disposition" }),
  });
  // UII parsed off the coach session id tail.
  const result = await trigger.dispositionVoicemail("202606101712033970000608754741");
  assert.equal(result.disposition, "Voicemail Drop");
  const call = ringcxClient.calls.find((c) => c.fn === "dispositionCall");
  assert.ok(call, "dispositionCall must be made");
  assert.equal(call.uii, "202606101712033970000608754741");
  assert.equal(call.opts.disposition, "Voicemail Drop");
});

test("ringcx modes: maybeFire extracts the UII from the session id and gates on it", () => {
  const ringcxClient = makeRingcxStub();
  const trigger = createLiveCoachVmTransferTrigger({
    ringcxClient,
    env: env({ LIVE_COACH_VM_TRANSFER_MODE: "ringcx-disposition" }),
  });
  assert.equal(trigger.maybeFire(session({ id: "coach-cx-63730035004-202606101712033970000608754741" })), true);
  assert.equal(
    trigger.maybeFire(session({ id: "coach-no-uii-here" })),
    false,
    "no UII anywhere -> skipped",
  );
  // metadata.uii wins even when the id has no digit tail
  assert.equal(
    trigger.maybeFire(session({
      id: "coach-meta-uii",
      metadata: { ...session().metadata, uii: "202606101712030000000000000001" },
    })),
    true,
  );
});

test("ringcx-barge mode: barges the announcement ext into the UII, then hangs up", async () => {
  const ringcxClient = makeRingcxStub();
  const trigger = createLiveCoachVmTransferTrigger({
    ringcxClient,
    env: env({
      LIVE_COACH_VM_TRANSFER_MODE: "ringcx-barge",
      LIVE_COACH_VM_BARGE_HANGUP_AFTER_MS: "0",
    }),
  });
  const result = await trigger.bargeAnnouncement("202606101712033970000608754741");
  assert.equal(result.targetExt, "98765");
  const barge = ringcxClient.calls.find((c) => c.fn === "addSessionToCall");
  assert.ok(barge, "addSessionToCall must be made");
  assert.deepEqual(barge.opts, { destination: "98765", sessionType: "BARGEIN" });
  assert.equal(ringcxClient.calls.some((c) => c.fn === "hangupCall"), false, "hangup disabled at 0ms");
});

test("transferAgentPeer: no connected call -> clean error, no transfer", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const respond = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (String(url).includes("/restapi/oauth/token")) return respond({ access_token: "tok", expires_in: 3600 });
    if (String(url).includes("/active-calls")) return respond({ records: [] });
    return respond({});
  };
  const trigger = createLiveCoachVmTransferTrigger({ fetchImpl, env: env() });
  await assert.rejects(() => trigger.transferAgentPeer("63730035004"), /no connected active-call/);
  assert.equal(calls.some((c) => c.url.includes("/transfer")), false);
});
