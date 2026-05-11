"use strict";

// Speculative presence bridge — RC EX extension → CX agent state.
//
// Polls a RingCentral extension's presence + activeCalls every 2s,
// normalizes a snapshot, runs it through Codex's `deriveCxRouting`,
// and (when desiredAvailability flips) tries to apply the change to
// RingCX. "Speculative" because the local cxRouting state in Mongo
// is the optimistic source of truth — we set it immediately, then
// best-effort push to RingCX (which has no clean state-change API
// for the integrated softphone right now, so the push is a stub).
//
// Usage:
//   node scripts/rcx-presence-bridge.js              # default ext + cx agent from env
//   node scripts/rcx-presence-bridge.js --ext 101 --cx-agent 20563
//   node scripts/rcx-presence-bridge.js --apply-logout   # actually call /logout on busy
//                                                            (heavy — disconnects dashboard)
//   node scripts/rcx-presence-bridge.js --once       # one-shot snapshot + decision
//
// Reads from .env:
//   RING_CENTRAL_JWT_TOKEN, RING_CENTRAL_CLIENT_ID, RING_CENTRAL_CLIENT_SECRET
//   RINGCX_VOICE_AGENT_RC_USER_ID  (defaults to mgray's id 63730035004)
//   RINGCX_VOICE_AGENT_GROUP_ID    (defaults to 2156)
//   The CX agent id needs to be passed via --cx-agent or hard-coded
//   per agent (we don't have a global env for it yet).

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) { return argv.includes(name); }
function ts() { return new Date().toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour12: false }); }

// Force unbuffered stdout — when this script runs in the background
// (piped through `tail` or redirected to a file), Node's default
// line-buffering hides log output until the process exits. Override
// to flush every write.
const fs = require("fs");
const LOG_FILE = path.resolve(__dirname, "..", "out", "rcx-presence-bridge.log");
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(line) {
  process.stdout.write(line + "\n");
  fs.appendFileSync(LOG_FILE, line + "\n");
}

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

let cachedRcToken = null;
let cachedRcExpiresAt = 0;

async function rcAccessToken() {
  if (cachedRcToken && Date.now() < cachedRcExpiresAt - 60_000) return cachedRcToken;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RING_CENTRAL_JWT_TOKEN,
  });
  const basic = Buffer.from(
    `${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`,
  ).toString("base64");
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`RC OAuth failed: ${JSON.stringify(json)}`);
  cachedRcToken = json.access_token;
  cachedRcExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedRcToken;
}

async function fetchRcPresence(rcUserId) {
  const tok = await rcAccessToken();
  const r = await fetch(
    `${RC_BASE}/restapi/v1.0/account/~/extension/${rcUserId}/presence?detailedTelephonyState=true`,
    { headers: { Authorization: `Bearer ${tok}` } },
  );
  if (!r.ok) throw new Error(`presence ${rcUserId}: ${r.status} ${await r.text()}`);
  return r.json();
}

// Inline copy of Codex's deriveCxRouting decision logic so we don't
// need a shared-services bootstrap to run this script. Mirror it
// exactly so the speculative state matches what mirrorAgentState
// would compute when fed the same snapshot.
function deriveCxRouting(snapshot, existingRouting = null) {
  // Mirror agentAvailabilityService.deriveCxRouting: Ringing is NOT
  // busy because mailer queues ring every agent's phone. Only the
  // agent who connects the call should drop out of the CX pool.
  const exBusyStatuses = new Set(["CallConnected", "OnHold"]);
  const appBusyStatuses = new Set(["onCall"]);
  const exBusy = exBusyStatuses.has(snapshot.exTelephonyStatus);
  const appBusy = appBusyStatuses.has(snapshot.status);
  const currentCall = snapshot.currentCall || {};
  const channel = String(currentCall.channel || "").trim().toLowerCase();
  const activeExCall = channel === "ex" && (
    currentCall.sessionId || currentCall.telephonySessionId || currentCall.from || currentCall.to
  );
  const busy = exBusy || appBusy || activeExCall;

  return {
    desiredAvailability: busy ? "unavailable" : "available",
    reason: busy ? "ex-busy" : "ex-idle",
    syncedAt: new Date(),
    lastSource: "presence-bridge",
  };
}

// Build the snapshot shape Codex's deriveCxRouting expects from a raw
// RC presence response. We only fill the fields that drive the
// busy/idle decision.
function snapshotFromRcPresence(rcPresence, extensionId) {
  const activeCall = Array.isArray(rcPresence.activeCalls) ? rcPresence.activeCalls[0] : null;
  return {
    extensionId,
    cxAgentId: process.env.RINGCX_VOICE_AGENT_RC_USER_ID,
    name: rcPresence.contact?.firstName ? `${rcPresence.contact.firstName} ${rcPresence.contact.lastName || ""}`.trim() : null,
    status: rcPresence.userStatus === "Available" ? "available" : "busy",
    exTelephonyStatus: rcPresence.telephonyStatus || "NoCall",
    exPresenceStatus: rcPresence.presenceStatus || "Offline",
    currentCall: activeCall ? {
      sessionId: activeCall.sessionId,
      telephonySessionId: activeCall.telephonySessionId,
      from: activeCall.from,
      to: activeCall.to,
      direction: activeCall.direction,
      channel: "ex",
    } : {},
  };
}

async function applyToRingcx(client, agentId, desiredAvailability, opts = {}) {
  // Speculative apply layer. Two real options today:
  //   (a) /agents/{id}/logout returns true — disconnects dashboard
  //   (b) noop + rely on application-level lead-load suppression
  //
  // We default to (b) until we find a state-change endpoint that
  // doesn't kill the dashboard session. --apply-logout opts in to (a).
  if (!opts.applyLogout) {
    return { applied: "skipped", reason: "no apply path enabled (rerun with --apply-logout to use logout)" };
  }
  if (desiredAvailability === "unavailable") {
    try {
      const r = await client.request("POST", `/voice/api/v1/admin/accounts/${client.config.accountId}/agentGroups/${opts.agentGroupId}/agents/${agentId}/logout`);
      return { applied: "logout", result: r };
    } catch (e) {
      return { applied: "logout-failed", error: e.message };
    }
  }
  // For "available" we'd need to log the user back in, but the dashboard
  // requires browser interaction. Best we can do is signal — log it.
  return { applied: "noop-relogin-needed-via-dashboard", desiredAvailability };
}

async function main() {
  const argv = process.argv.slice(2);
  const ext = readFlag(argv, "--ext") || "101";
  const rcUserId = readFlag(argv, "--rc-user") || process.env.RINGCX_VOICE_AGENT_RC_USER_ID || "63730035004";
  const cxAgentId = Number(readFlag(argv, "--cx-agent") || "20563");
  const agentGroupId = Number(readFlag(argv, "--cx-group") || "2156");
  const intervalMs = Number(readFlag(argv, "--interval") || "2000");
  const once = hasFlag(argv, "--once");
  const applyLogout = hasFlag(argv, "--apply-logout");

  console.log("══ rcx-presence-bridge");
  console.log("  ext:        ", ext);
  console.log("  rcUserId:   ", rcUserId);
  console.log("  cxAgentId:  ", cxAgentId);
  console.log("  cxGroup:    ", agentGroupId);
  console.log("  interval:   ", intervalMs + "ms", once ? "(--once)" : "");
  console.log("  apply mode: ", applyLogout ? "LOGOUT (heavy)" : "log-only (safe)");
  console.log("");

  const client = createRingcxVoiceClient();
  let lastDesired = null;
  let lastTelephony = null;

  async function tick() {
    try {
      const pres = await fetchRcPresence(rcUserId);
      const snap = snapshotFromRcPresence(pres, ext);
      const routing = deriveCxRouting(snap);
      const changed = routing.desiredAvailability !== lastDesired;
      const telChanged = pres.telephonyStatus !== lastTelephony;
      if (changed || telChanged || lastDesired === null) {
        const flag = changed ? "🔁" : "  ";
        log(`${ts()} ${flag} telephony=${pres.telephonyStatus.padEnd(15)} userStatus=${pres.userStatus.padEnd(11)} → cxRouting.desiredAvailability=${routing.desiredAvailability} (${routing.reason})`);
        if (changed) {
          const apply = await applyToRingcx(client, cxAgentId, routing.desiredAvailability, { agentGroupId, applyLogout });
          log(`              apply: ${apply.applied}${apply.reason ? " — " + apply.reason : ""}${apply.error ? " (err: " + apply.error + ")" : ""}`);
        }
        lastDesired = routing.desiredAvailability;
        lastTelephony = pres.telephonyStatus;
      }
    } catch (e) {
      log(`${ts()}  ⚠ poll error: ${e.message}`);
    }
  }

  if (once) {
    await tick();
    return;
  }

  console.log("watching... (ctrl-c to stop)");
  await tick();
  setInterval(tick, intervalMs);
  // keep process alive
  await new Promise(() => {});
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
