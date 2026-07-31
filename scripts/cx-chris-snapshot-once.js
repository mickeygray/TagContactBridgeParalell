#!/usr/bin/env node
"use strict";

// One masked, read-only Chris RingCX login/call snapshot.

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");
const {
  activeCallRows,
  callMatchesAgent,
  isSoftphoneLogin,
  loginState,
  offhookCount,
} = require("./cx-suspect-watchdog");

const TARGET = Object.freeze({
  name: "Chris",
  agentId: "21810",
  agentGroupId: "2187",
});

async function main() {
  const client = createRingcxVoiceClient();
  const [login, callsPayload] = await Promise.all([
    client.getAgentLogin(TARGET.agentId, TARGET.agentGroupId),
    client.listActiveCalls({
      product: "ACCOUNT",
      productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
    }),
  ]);
  const calls = activeCallRows(callsPayload);
  console.log(JSON.stringify({
    agent: TARGET.name,
    state: loginState(login),
    softphone: isSoftphoneLogin(login),
    liveOffhookCount: offhookCount(login),
    loginPresent: Boolean(login),
    hasActiveCall: calls.some((row) => callMatchesAgent(row, TARGET.agentId)),
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: String(error?.message || error)
      .replace(/\b\d{7,}\b/g, "[masked]")
      .slice(0, 160),
  }));
  process.exitCode = 1;
});
