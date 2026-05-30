"use strict";

const crypto = require("crypto");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { emitSyntheticCxCallEvent } = require("./emit-synthetic-cx-call-event");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || value === "" ? fallback : value;
}

function clean(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(24)} ${value == null || value === "" ? "(none)" : value}`);
}

function summarizeActiveCall(row = {}) {
  const raw = JSON.stringify(row || {});
  return {
    uii: clean(row.uii || row.UII || row.callId || row.callID || row.activeCallId || row.interactionId || "", 160),
    state: row.state || row.callState || row.status || row.dialState || null,
    agentId: row.agentId || row.agent?.agentId || row.agent?.id || null,
    phone: maskPhone(row.phone || row.destination || row.leadPhone || row.customerPhone || row.dnis || row.ani || raw),
  };
}

function coerceActiveCallRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.records)) return response.records;
  if (Array.isArray(response?.content)) return response.content;
  if (Array.isArray(response?.activeCalls)) return response.activeCalls;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

async function findActiveCall(client, { phone, externId, campaignId, seconds = 90 }) {
  const phoneLast10 = normalizePhone(phone).slice(-10);
  const deadline = Date.now() + Math.max(Number(seconds) || 0, 0) * 1000;
  let observations = 0;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const response = await client.listActiveCalls({
      product: "ACCOUNT",
      productId: client.config?.accountId || process.env.RINGCX_VOICE_ACCOUNT_ID,
    });
    const rows = coerceActiveCallRows(response);
    observations += 1;
    lastCount = rows.length;
    for (const row of rows) {
      const raw = JSON.stringify(row || {});
      const matchesExtern = externId && raw.includes(String(externId));
      const matchesPhone = phoneLast10 && raw.includes(phoneLast10);
      const matchesCampaignPhone = campaignId && raw.includes(String(campaignId)) && matchesPhone;
      if (!matchesExtern && !matchesPhone && !matchesCampaignPhone) continue;
      const summary = summarizeActiveCall(row);
      if (summary.uii) return { row, summary, observations, lastCount };
    }
    await sleep(2000);
  }
  return { row: null, summary: null, observations, lastCount };
}

async function attachMonitor(client, uii, destinations) {
  const attempts = [];
  for (const destination of destinations) {
    const dest = clean(destination, 120);
    if (!dest) continue;
    try {
      const response = await client.addSessionToCall(uii, {
        destination: dest,
        sessionType: "MONITOR",
      });
      return { ok: true, destination: dest, response, attempts };
    } catch (error) {
      attempts.push({ destination: dest, error: error.message });
    }
  }
  return { ok: false, attempts };
}

function printHelp() {
  console.log(`Send one RingCX campaign lead and emit a synthetic cx.call.placed event.

Usage:
  node scripts/send-live-coach-campaign-call.js [options]

Options:
  --to PHONE                 Destination phone. Defaults PARALLEL_TEST_PHONE / DEPLOY_PANEL_PHONE.
  --agent-email EMAIL        Agent email for event routing.
  --campaign-id ID           RingCX campaign id. Defaults RINGCX_VOICE_DEFAULT_CAMPAIGN_ID.
  --dial-group-id ID         RingCX dial group id. Defaults RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID.
  --extension-id ID          RingEX extension id for the synthetic event. Defaults 63730035004.
  --monitor-dest LIST        Comma list for addSessionToCall. Defaults 987,2133353006,+12133353006.
  --watch-sec N              Seconds to watch activeCalls/list for UII. Default 90.
  --no-attach                Do not attach monitor after active call is found.
  --dry                      Print payloads without calling RingCX or Mongo.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const destination = normalizePhone(readFlag(argv, "--to", env("PARALLEL_TEST_PHONE", env("DEPLOY_PANEL_PHONE", ""))));
  const campaignId = clean(readFlag(argv, "--campaign-id", env("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID", "2306")), 80);
  const dialGroupId = clean(readFlag(argv, "--dial-group-id", env("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID", "963")), 80);
  const agentEmail = clean(readFlag(argv, "--agent-email", env("RINGCX_VOICE_AGENT_EMAIL", env("RINGCX_VOICE_RC_USER_EMAIL", "mgray@taxadvocategroup.com"))), 180);
  const extensionId = clean(readFlag(argv, "--extension-id", env("EX_LIVE_MONITOR_EVENT_GATE_AGENT_EXTENSION_ID", "63730035004")), 80);
  const agentName = clean(readFlag(argv, "--agent-name", "Michael Gray"), 120);
  const firstName = clean(readFlag(argv, "--first-name", "Mickey"), 80);
  const lastName = clean(readFlag(argv, "--last-name", "CoachTest"), 80);
  const caseId = clean(readFlag(argv, "--case-id", `live-coach-${Date.now()}`), 120);
  const watchSec = Math.max(0, Number(readFlag(argv, "--watch-sec", "90")) || 90);
  const dry = hasFlag(argv, "--dry");
  const attach = !hasFlag(argv, "--no-attach");
  const monitorDestinations = String(readFlag(argv, "--monitor-dest", env("EX_LIVE_MONITOR_ATTACH_DESTINATIONS", "987,2133353006,+12133353006")))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!destination) throw new Error("missing --to phone or PARALLEL_TEST_PHONE/DEPLOY_PANEL_PHONE");
  if (!campaignId) throw new Error("missing --campaign-id or RINGCX_VOICE_DEFAULT_CAMPAIGN_ID");

  const runId = `rt-coach-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const externId = runId.slice(0, 120);
  const queueItemId = `synthetic-live-coach-${runId}`;
  const callSessionId = `synthetic-call-${runId}`;
  const loadPayload = {
    description: `live coach test ${externId}`,
    dialPriority: "IMMEDIATE",
    duplicateHandling: "REMOVE_FROM_LIST",
    listState: "ACTIVE",
    timeZoneOption: "NPA_NXX",
    phoneNumbersI18nEnabled: false,
    internationalNumberFormat: false,
    uploadLeads: [{
      externId,
      leadPhone: destination,
      firstName,
      lastName,
      extendedLeadData: {
        source: "live-coach-test",
        caseId,
        agentEmail,
        expectedLeadPhoneLast4: destination.slice(-4),
      },
    }],
  };
  const eventOptions = {
    durationSec: 2700,
    caseId,
    queueItemId,
    callSessionId,
    agentEmail,
    agentName,
    extensionId,
    phone: destination,
    campaignId,
    dialGroupId,
    testSource: "send-live-coach-campaign-call",
    dedupeKey: `synthetic-live-coach:${runId}`,
  };

  console.log("Live coach campaign call test");
  logKv("destination", maskPhone(destination));
  logKv("agentEmail", agentEmail);
  logKv("extensionId", extensionId);
  logKv("campaignId", campaignId);
  logKv("externId", externId);
  logKv("dry", dry);

  if (dry) {
    console.log(JSON.stringify({ loadPayload, eventOptions }, null, 2));
    return;
  }

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();
  logKv("authedAs", who.rcUser?.email || "(unknown)");

  const loadResult = await client.loadLeads(campaignId, loadPayload);
  logKv("loadLeads", JSON.stringify(loadResult).slice(0, 400));

  await connectMongo(getSharedConfig());
  try {
    const eventResult = await emitSyntheticCxCallEvent(eventOptions);
    logKv("syntheticEvent", eventResult.summary.eventId);
    logKv("eventExpires", eventResult.summary.expiresAt);
  } finally {
    await disconnectMongo().catch(() => null);
  }

  if (!attach && watchSec <= 0) return;

  const active = await findActiveCall(client, {
    phone: destination,
    externId,
    campaignId,
    seconds: watchSec,
  });
  if (!active.summary?.uii) {
    logKv("activeCall", `not found after ${active.observations} polls (lastCount=${active.lastCount})`);
    return;
  }
  logKv("activeCall", JSON.stringify(active.summary));

  if (attach) {
    const attachResult = await attachMonitor(client, active.summary.uii, monitorDestinations);
    logKv("monitorAttach", JSON.stringify({
      ok: attachResult.ok,
      destination: attachResult.destination || null,
      attempts: attachResult.attempts,
    }).slice(0, 500));
  }
}

main().catch(async (error) => {
  console.error(`fatal: ${error.message}`);
  await disconnectMongo().catch(() => null);
  process.exit(1);
});
