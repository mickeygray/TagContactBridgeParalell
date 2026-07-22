"use strict";

// Multi-leg supervision test: can ONE monitor device hold SEVERAL concurrent
// supervision legs, and can we tell which leg belongs to which session/party?
//
// Answers the monitor-scaling question for the PhoneBurner-era coach:
//   - POOL model: one supervisor device fans out across many agents' calls
//     (INVITEs are discernible per session) -> two monitors cover the floor.
//   - 1:1 model: the device rejects a second concurrent supervision INVITE ->
//     the 1101-1106 per-agent monitor bank is load-bearing.
//
//   node scripts/rc-ex-multi-monitor-test.js --monitor CHRIS --sup-ext 1104 \
//     --targets "741:agent,741:remote,742:agent,742:remote" --timeout-sec 60
//
// Each supervise POST is issued in order; every inbound INVITE is answered and
// captured to its own .pcmu. For every leg we dump identifying SIP headers
// (P-rc-api-ids carries party-id + session-id on RingCentral INVITEs) and match
// them against the supervise response's party id. The final JSON reports, per
// target: attached?, invite matched?, packets, active seconds - plus overall
// CONCURRENCY and DISCERNMENT verdicts.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Softphone = require("ringcentral-softphone");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const SAMPLE_RATE = 8000;
const ACTIVE_MEAN_ABS = 300;

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ulawToLinearSample(value) {
  let sample = (~value) & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

async function rcAccessToken({ jwtToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtToken,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`RC OAuth failed: ${response.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json.access_token;
}

async function rcRequest(token, method, endpoint, body) {
  const response = await fetch(`${RC_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`${method} ${endpoint} failed: ${response.status} ${text.slice(0, 400)}`);
  return json;
}

async function resolveExtension(token, extensionNumber) {
  for (let page = 1; page <= 20; page += 1) {
    const data = await rcRequest(token, "GET", `/restapi/v1.0/account/~/extension?perPage=200&page=${page}`);
    const records = Array.isArray(data?.records) ? data.records : [];
    const hit = records.find((record) => String(record.extensionNumber || "") === String(extensionNumber));
    if (hit) return hit;
    if (records.length < 200) break;
  }
  return null;
}

function pickProxy(sipInfo) {
  const proxies = Array.isArray(sipInfo?.outboundProxies) ? sipInfo.outboundProxies : [];
  const hit = proxies.find((proxy) => String(proxy.region || "").toUpperCase() === "NA" && proxy.proxyTLS)
    || proxies.find((proxy) => proxy.proxyTLS) || null;
  return hit?.proxyTLS || "sip10.ringcentral.com:5096";
}

// Newest session on the agent's active-calls that still has a LIVE party owned
// by the agent (mirrors the capture script's agent-live picker).
async function findLiveAgentSession(token, agentExtensionId) {
  const active = await rcRequest(token, "GET", `/restapi/v1.0/account/~/extension/${agentExtensionId}/active-calls?view=Detailed`);
  const records = (Array.isArray(active?.records) ? active.records : []).filter((r) => r.telephonySessionId);
  const sorted = [...records].sort((a, b) => (Date.parse(b.startTime || 0) || 0) - (Date.parse(a.startTime || 0) || 0));
  for (const record of sorted) {
    try {
      const session = await rcRequest(token, "GET", `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(record.telephonySessionId)}`);
      const parties = Array.isArray(session?.parties) ? session.parties : [];
      const live = parties.filter((p) => !["disconnected", "gone"].includes(String(p.status?.code || p.status || "").toLowerCase()));
      const agentParty = live.find((p) => String(p.extensionId || p.owner?.extensionId || "") === String(agentExtensionId));
      if (agentParty) {
        const remoteParty = live.find((p) => p.id !== agentParty.id
          && !String(p.status?.reason || "").toLowerCase().includes("supervis")
          && String(p.extensionId || p.owner?.extensionId || "") !== String(agentExtensionId));
        return { session, agentParty, remoteParty: remoteParty || null };
      }
    } catch { /* stale session; keep scanning */ }
  }
  return null;
}

const INTEREST_HEADERS = ["P-rc-api-ids", "p-rc-api-ids", "P-Rc-Api-Ids", "Call-ID", "From", "To", "P-Asserted-Identity", "Contact"];

function dumpInviteHeaders(inviteMessage) {
  const out = {};
  for (const name of INTEREST_HEADERS) {
    try {
      const value = inviteMessage.getHeader(name);
      if (value) out[name] = String(value);
    } catch { /* header accessor variant not supported */ }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const monitorName = readFlag(argv, "--monitor", "CHRIS").toUpperCase();
  const supExtNumber = readFlag(argv, "--sup-ext", "1104");
  const requestedDeviceId = readFlag(argv, "--device-id", "");
  const targetsRaw = readFlag(argv, "--targets", "");
  const timeoutSec = Math.max(20, Math.min(600, Number(readFlag(argv, "--timeout-sec", "60")) || 60));
  const outDir = path.resolve("runtime", "ex-multi-monitor-test", timestampForFile());

  if (!targetsRaw) {
    console.error('usage: node scripts/rc-ex-multi-monitor-test.js --monitor CHRIS --sup-ext 1104 --targets "741:agent,741:remote,742:agent" [--timeout-sec 60]');
    process.exit(1);
  }
  const targets = targetsRaw.split(",").map((chunk) => {
    const [ext, mode] = chunk.trim().split(":");
    return { agentExt: ext, partyMode: (mode || "agent").toLowerCase() };
  });

  const monitorJwt = process.env[`${monitorName}_RING_CENTRAL_MONITOR_JWT_TOKEN`];
  if (!monitorJwt) throw new Error(`no ${monitorName}_RING_CENTRAL_MONITOR_JWT_TOKEN in .env`);

  fs.mkdirSync(outDir, { recursive: true });

  // Lookup uses the admin JWT; supervise uses the monitor user's JWT (device owner).
  const lookupToken = await rcAccessToken({
    jwtToken: process.env.RING_CENTRAL_JWT_TOKEN,
    clientId: process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret: process.env.RING_CENTRAL_CLIENT_SECRET,
  });
  const monitorToken = await rcAccessToken({
    jwtToken: monitorJwt,
    clientId: process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret: process.env.RING_CENTRAL_CLIENT_SECRET,
  });

  const supExt = await resolveExtension(lookupToken, supExtNumber);
  if (!supExt) throw new Error(`Could not resolve supervisor extension ${supExtNumber}`);
  const devices = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/extension/${supExt.id}/device`);
  const deviceRows = (Array.isArray(devices?.records) ? devices.records : []).filter((row) => row.type !== "WebRTC");
  const device = requestedDeviceId
    ? deviceRows.find((row) => String(row.id) === String(requestedDeviceId))
    : deviceRows[0];
  if (!device?.id) throw new Error(`No SIP-registrable device on extension ${supExtNumber}`);
  const sipInfo = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/device/${device.id}/sip-info`);

  const softphone = new Softphone({
    domain: sipInfo.domain,
    outboundProxy: pickProxy(sipInfo),
    username: sipInfo.userName,
    password: sipInfo.password,
    authorizationId: sipInfo.authorizationId,
    codec: "PCMU/8000",
  });

  console.log(`multi-monitor test: supervisor ${supExt.name} ext=${supExt.extensionNumber} device=${device.id} monitorJwt=${monitorName}`);
  console.log(`targets: ${targets.map((t) => `${t.agentExt}:${t.partyMode}`).join(", ")}`);

  // Answer EVERY invite; tag legs in arrival order and capture separately.
  const legs = [];
  softphone.on("invite", async (inviteMessage) => {
    const index = legs.length;
    const headers = dumpInviteHeaders(inviteMessage);
    const leg = { index, headers, packets: 0, bytes: 0, totalAbs: 0, samples: 0, activeSamples: 0, file: path.join(outDir, `leg-${index}.pcmu`), disposed: false };
    legs.push(leg);
    console.log(`[invite ${index}] headers=${JSON.stringify(headers)}`);
    try {
      const session = await softphone.answer(inviteMessage);
      const stream = fs.createWriteStream(leg.file, { flags: "a" });
      session.on("audioPacket", (rtpPacket) => {
        leg.packets += 1;
        leg.bytes += rtpPacket.payload.length;
        for (const byte of rtpPacket.payload) {
          const abs = Math.abs(ulawToLinearSample(byte));
          leg.totalAbs += abs;
          leg.samples += 1;
          if (abs > ACTIVE_MEAN_ABS) leg.activeSamples += 1;
        }
        stream.write(rtpPacket.payload);
      });
      session.once("disposed", () => { leg.disposed = true; stream.end(); });
      console.log(`[answer ${index}] capturing to ${leg.file}`);
    } catch (error) {
      leg.answerError = error.message;
      console.error(`[invite ${index}] answer failed: ${error.message}`);
    }
  });

  await softphone.register();
  console.log("[register] supervisor softphone registered");

  // Issue supervise POSTs sequentially (small gap so invite order tracks target order).
  const results = [];
  for (const target of targets) {
    const row = { target: `${target.agentExt}:${target.partyMode}`, ok: false };
    results.push(row);
    try {
      const agentExt = await resolveExtension(lookupToken, target.agentExt);
      if (!agentExt) throw new Error(`cannot resolve ext ${target.agentExt}`);
      const found = await findLiveAgentSession(lookupToken, agentExt.id);
      if (!found) throw new Error(`no live call on ext ${target.agentExt}`);
      const party = target.partyMode === "remote" ? found.remoteParty : found.agentParty;
      if (!party?.id) throw new Error(`no ${target.partyMode} party on session ${found.session.id}`);
      row.telephonySessionId = found.session.id;
      row.supervisedPartyId = party.id;
      const endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(found.session.id)}/parties/${encodeURIComponent(party.id)}/supervise`;
      let response;
      try {
        response = await rcRequest(monitorToken, "POST", endpoint, {
          mode: "Listen", supervisorDeviceId: String(device.id), agentExtensionId: String(agentExt.id),
        });
      } catch (error) {
        if (!/agentExtensionId|CMN-10/i.test(String(error?.message || ""))) throw error;
        response = await rcRequest(monitorToken, "POST", endpoint, {
          mode: "Listen", supervisorDeviceId: String(device.id),
        });
      }
      row.ok = true;
      row.supervisionPartyId = response?.id || null;
      console.log(`[supervise] ${row.target} -> session=${row.telephonySessionId} watchedParty=${row.supervisedPartyId} supervisionParty=${row.supervisionPartyId}`);
    } catch (error) {
      row.error = error.message;
      console.error(`[supervise] ${row.target} FAILED: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  const stopAt = Date.now() + timeoutSec * 1000;
  while (Date.now() < stopAt) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  softphone.revoke();

  const attached = results.filter((row) => row.ok).length;
  const answered = legs.filter((leg) => !leg.answerError).length;
  const withApiIds = legs.filter((leg) => Object.keys(leg.headers).some((h) => h.toLowerCase() === "p-rc-api-ids")).length;
  const summary = {
    superviseAccepted: `${attached}/${targets.length}`,
    invitesAnswered: `${answered}/${legs.length}`,
    concurrency: answered >= 2 ? "MULTI-LEG OK (one device held multiple supervision calls)" : (attached >= 2 ? "SUPERVISE ACCEPTED BUT <2 LEGS ANSWERED" : "INSUFFICIENT LEGS - see errors"),
    discernment: withApiIds === legs.length && legs.length > 0
      ? "HEADERS PRESENT ON ALL LEGS (p-rc-api-ids maps invite->session/party)"
      : `p-rc-api-ids on ${withApiIds}/${legs.length} legs - match by supervise order as fallback`,
    supervises: results,
    legs: legs.map((leg) => ({
      index: leg.index,
      headers: leg.headers,
      packets: leg.packets,
      bytes: leg.bytes,
      meanAbs: leg.samples ? Math.round(leg.totalAbs / leg.samples) : 0,
      activePct: leg.samples ? Number(((leg.activeSamples / leg.samples) * 100).toFixed(2)) : 0,
      file: leg.file,
      answerError: leg.answerError || null,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

// Force exit: softphone SIP keepalive timers otherwise keep this process (and
// every live supervision leg it holds) alive indefinitely after revoke().
main().then(() => process.exit(0)).catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
