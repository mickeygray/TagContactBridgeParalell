"use strict";

// PhoneBurner-era headless monitor daemon (prototype).
//
// Records every covered agent's live PB call audio as SEPARATED LEGS via
// RingEX per-party supervision, and snips the continuous tape into per-call
// recordings using PhoneBurner call_done webhook events (already captured in
// Mongo as LeadDeliveryEvent by the lead-delivery route) as the metronome:
//
//   attach loop   - per agent: find the live PB dial-in session (agent-live),
//                   hold TWO supervision legs (agent party + remote party),
//                   re-attach when the session rotates or a leg drops.
//   segmenter     - tail LeadDeliveryEvent for call_done (provider=phoneburner,
//                   safePayload.sourceAgentId = the agent): SNIP both leg files,
//                   label them with providerCallId/contact/outcome/duration,
//                   convert to WAV, restart fresh segment files.
//                   call_begin (if the PB hook is enabled) is advisory only:
//                   recorded as a trim marker in the segment sidecar.
//   guards        - max-segment-length snip (missed call_done), MBW-005 backoff
//                   (agent between dial-ins), forced process exit (softphone
//                   keepalive timers otherwise hold supervision legs forever).
//
//   node scripts/pb-monitor-daemon.js \
//     --map "741:chris_bolt:CHRIS,742:brad_hansen:CHRIS" \
//     --run-min 60
//
// Map entries are agentExt:leadDeliveryAgentId:MONITOR (monitor = env JWT
// prefix, e.g. CHRIS -> CHRIS_RING_CENTRAL_MONITOR_JWT_TOKEN; the monitor's
// extension/device are resolved automatically). Read-only toward the floor:
// Listen-mode supervision + reading webhook events the route already stores.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const Softphone = require("ringcentral-softphone");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function stamp() {
  return new Date().toISOString();
}

function fileStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(event, details = {}) {
  console.log(`${stamp()} ${event} ${JSON.stringify(details)}`);
}

// ── u-law -> WAV (for listenable snips) ──────────────────────────────────────

function ulawToLinearSample(value) {
  let sample = (~value) & 0xff;
  const sign = sample & 0x80;
  const exponent = (sample >> 4) & 0x07;
  const mantissa = sample & 0x0f;
  sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function pcmuFileToWav(src, dst) {
  const mu = fs.readFileSync(src);
  const pcm = Buffer.alloc(mu.length * 2);
  for (let i = 0; i < mu.length; i += 1) pcm.writeInt16LE(ulawToLinearSample(mu[i]), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(dst, Buffer.concat([header, pcm]));
}

// ── RingCentral REST helpers (mirrors the proven capture-script machinery) ───

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
  if (!response.ok) throw new Error(`RC OAuth failed: ${response.status}`);
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
  if (!response.ok) {
    const error = new Error(`${method} ${endpoint} failed: ${response.status} ${text.slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
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

function parseRcApiIds(inviteMessage) {
  let raw = "";
  for (const name of ["P-rc-api-ids", "p-rc-api-ids", "P-Rc-Api-Ids"]) {
    try { raw = inviteMessage.getHeader(name) || raw; } catch {}
    if (raw) break;
  }
  const partyId = /party-id=([^;]+)/.exec(raw)?.[1] || null;
  const sessionId = /session-id=([^;]+)/.exec(raw)?.[1] || null;
  return { partyId, sessionId };
}

// ── coach session lifecycle (per PB call) ───────────────────────────────────
// Binds the agent's monitored call to a live-coach session on the ai-bus, so the
// same person's cockpit/wallboard lane (matched by agentEmail/agentExtension)
// receives the coaching. Synthetic identity uii="pb:<providerCallId>" ties the
// coach session to the PB call the segmenter already tracks. No-op when the coach
// mode is not "live" or no ai-bus URL is configured (dry runs still record+snip).
function createCoachBinder({ aiBusUrl, mode }) {
  const enabled = mode === "live" && Boolean(aiBusUrl);
  const secret = process.env.AI_BUS_INTERNAL_SECRET || "";
  async function post(pathname, body) {
    const headers = { "content-type": "application/json" };
    if (secret) headers["x-internal-secret"] = secret;
    const response = await fetch(`${aiBusUrl}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${pathname} ${response.status} ${text.slice(0, 160)}`);
    try { return text ? JSON.parse(text) : {}; } catch { return {}; }
  }
  return {
    enabled,
    async start({ providerCallId, agent }) {
      if (!enabled) return null;
      const uii = `pb:${providerCallId || `nocall-${fileStamp()}`}`;
      const created = await post("/api/ai/live-coach/grpc/start", {
        source: "pb-monitor-daemon",
        uii,
        agentEmail: agent.email,
        agentExtension: agent.agentExt,
        agentName: agent.agentName,
      });
      return { sessionId: created?.sessionId || created?.id || null, uii };
    },
    async input(sessionId, uii, { text, role, isFinal, itemId, channel }) {
      if (!enabled || !sessionId) return;
      await post(`/api/ai/live-coach/grpc/${encodeURIComponent(sessionId)}/input`, {
        text, role, isFinal, itemId, channel, uii, at: stamp(), source: "pb-monitor-daemon",
      });
    },
    async stop(sessionId, reason) {
      if (!enabled || !sessionId) return;
      try { await post(`/api/ai/live-coach/grpc/${encodeURIComponent(sessionId)}/stop`, { reason }); } catch {}
    },
  };
}

// ── segment bookkeeping ──────────────────────────────────────────────────────

class AgentRecorder {
  constructor({ agentExt, agentId, outDir }) {
    this.agentExt = agentExt;
    this.agentId = agentId;
    this.dir = path.join(outDir, `${agentExt}-${agentId}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.segmentStartedAt = null;
    this.streams = { agent: null, remote: null };
    this.paths = { agent: null, remote: null };
    this.markers = [];
    this.segmentsCut = 0;
    this.bytes = { agent: 0, remote: 0 };
  }

  openSegment() {
    const base = path.join(this.dir, `current-${fileStamp()}`);
    this.paths = { agent: `${base}-agent.pcmu`, remote: `${base}-prospect.pcmu` };
    this.streams = {
      agent: fs.createWriteStream(this.paths.agent, { flags: "a" }),
      remote: fs.createWriteStream(this.paths.remote, { flags: "a" }),
    };
    this.segmentStartedAt = Date.now();
    this.markers = [];
    this.bytes = { agent: 0, remote: 0 };
  }

  write(leg, payload) {
    if (!this.streams[leg]) this.openSegment();
    this.streams[leg].write(payload);
    this.bytes[leg] += payload.length;
  }

  addMarker(marker) {
    this.markers.push({ ...marker, at: stamp() });
  }

  // Close the current pair, label with the call_done identity, restart.
  snip({ providerCallId, providerContactId, outcome, durationSeconds, dialSessionId, reason }) {
    if (!this.segmentStartedAt) return null;
    for (const leg of ["agent", "remote"]) this.streams[leg]?.end();
    const callLabel = String(providerCallId || `unlabeled-${fileStamp()}`).replace(/[^\w-]/g, "_");
    const base = path.join(this.dir, `${fileStamp()}-${callLabel}`);
    const result = { base, legs: {} };
    for (const leg of ["agent", "remote"]) {
      const src = this.paths[leg];
      const suffix = leg === "agent" ? "agent" : "prospect";
      if (src && fs.existsSync(src)) {
        const pcmuDst = `${base}-${suffix}.pcmu`;
        fs.renameSync(src, pcmuDst);
        try {
          pcmuFileToWav(pcmuDst, `${base}-${suffix}.wav`);
          result.legs[leg] = `${base}-${suffix}.wav`;
        } catch (error) {
          result.legs[leg] = pcmuDst;
          log("daemon.wav_convert_failed", { agentExt: this.agentExt, error: error.message });
        }
      }
    }
    fs.writeFileSync(`${base}.json`, `${JSON.stringify({
      agentExt: this.agentExt,
      agentId: this.agentId,
      providerCallId: providerCallId || null,
      providerContactId: providerContactId || null,
      outcome: outcome || null,
      durationSeconds: durationSeconds ?? null,
      dialSessionId: dialSessionId || null,
      snipReason: reason,
      segmentSeconds: Math.round((Date.now() - this.segmentStartedAt) / 1000),
      bytes: this.bytes,
      markers: this.markers,
    }, null, 2)}\n`);
    this.segmentsCut += 1;
    this.streams = { agent: null, remote: null };
    this.paths = { agent: null, remote: null };
    this.segmentStartedAt = null;
    this.openSegment();
    return result;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const agentsRaw = readFlag(argv, "--agents", "");
  const mapRaw = readFlag(argv, "--map", "");
  const coachMode = readFlag(argv, "--coach", "dry"); // dry | live | off
  const aiBusUrl = readFlag(argv, "--ai-bus-url", process.env.AI_BUS_URL || "").replace(/\/$/, "");
  const runMin = Math.max(1, Math.min(12 * 60, Number(readFlag(argv, "--run-min", "60")) || 60));
  const attachEverySec = Math.max(10, Number(readFlag(argv, "--attach-every-sec", "20")) || 20);
  const pollEverySec = Math.max(1, Number(readFlag(argv, "--poll-every-sec", "2")) || 2);
  const statusEverySec = Math.max(10, Number(readFlag(argv, "--status-every-sec", "60")) || 60);
  const maxSegmentMin = Math.max(2, Number(readFlag(argv, "--max-segment-min", "30")) || 30);
  const outDir = path.resolve(readFlag(argv, "--out", path.join("runtime", "pb-monitor-segments")));

  if (!agentsRaw && !mapRaw) {
    console.error('usage: node scripts/pb-monitor-daemon.js --agents "chris_bolt:CHRIS,brad_hansen:CHRIS" [--coach dry|live|off] [--run-min 60]');
    console.error('       (legacy: --map "741:chris_bolt:CHRIS,..." skips the auto identity resolution)');
    process.exit(1);
  }

  // Mongo (read-only tail of the webhook events the lead-delivery route stores).
  const { connectMongo } = require("../packages/event-core/src");
  const { getSharedConfig } = require("../packages/shared-config/src");
  const { LeadDeliveryEvent, UserAccount } = require("../packages/shared-models/src");
  await connectMongo(getSharedConfig());
  log("daemon.mongo_connected", {});

  // The AgentBinding spine: pair the agent's PB events (leadDeliveryAgentId),
  // monitor legs (RC extension), UI session (app email), and coach sessions
  // from ONE input (agentId:MONITOR) so the pairing cannot drift:
  //   lead-delivery config: agentId -> applicationAccountEmail
  //   UserAccount:          email   -> extensionNumber/extensionId/name
  let agents;
  if (agentsRaw) {
    const deliveryConfig = require("../config/lead-delivery-agents.json");
    agents = [];
    for (const chunk of agentsRaw.split(",")) {
      const [agentId, monitorName] = chunk.trim().split(":");
      if (!agentId || !monitorName) throw new Error(`bad --agents entry: ${chunk}`);
      const policy = deliveryConfig.agents?.[agentId];
      if (!policy?.applicationAccountEmail) throw new Error(`agent ${agentId} not in config/lead-delivery-agents.json`);
      const account = await UserAccount.findOne({ email: policy.applicationAccountEmail }).lean();
      if (!account?.extensionNumber) throw new Error(`no UserAccount/extension for ${policy.applicationAccountEmail}`);
      agents.push({
        agentExt: String(account.extensionNumber),
        agentId,
        monitorName: monitorName.toUpperCase(),
        email: policy.applicationAccountEmail,
        agentName: account.name || policy.displayName || agentId,
        rcExtensionId: String(account.extensionId || ""),
      });
      log("daemon.binding_resolved", {
        agentId, email: policy.applicationAccountEmail, agentExt: account.extensionNumber, monitor: monitorName.toUpperCase(),
      });
    }
  } else {
    agents = mapRaw.split(",").map((chunk) => {
      const [agentExt, agentId, monitorName] = chunk.trim().split(":");
      if (!agentExt || !agentId || !monitorName) throw new Error(`bad --map entry: ${chunk}`);
      return { agentExt, agentId, monitorName: monitorName.toUpperCase(), email: null, agentName: agentId, rcExtensionId: "" };
    });
  }

  const lookupToken = await rcAccessToken({
    jwtToken: process.env.RING_CENTRAL_JWT_TOKEN,
    clientId: process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret: process.env.RING_CENTRAL_CLIENT_SECRET,
  });

  // One softphone + one supervise token per distinct monitor.
  const monitors = new Map();
  for (const name of new Set(agents.map((a) => a.monitorName))) {
    const jwt = process.env[`${name}_RING_CENTRAL_MONITOR_JWT_TOKEN`];
    if (!jwt) throw new Error(`no ${name}_RING_CENTRAL_MONITOR_JWT_TOKEN in .env`);
    const superviseToken = await rcAccessToken({
      jwtToken: jwt,
      clientId: process.env.RING_CENTRAL_CLIENT_ID,
      clientSecret: process.env.RING_CENTRAL_CLIENT_SECRET,
    });
    const me = await rcRequest(superviseToken, "GET", "/restapi/v1.0/account/~/extension/~");
    const devices = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/extension/${me.id}/device`);
    const device = (Array.isArray(devices?.records) ? devices.records : []).find((row) => row.type !== "WebRTC");
    if (!device?.id) throw new Error(`monitor ${name} (ext ${me.extensionNumber}) has no SIP-registrable device`);
    const sipInfo = await rcRequest(lookupToken, "GET", `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
    const softphone = new Softphone({
      domain: sipInfo.domain,
      outboundProxy: pickProxy(sipInfo),
      username: sipInfo.userName,
      password: sipInfo.password,
      authorizationId: sipInfo.authorizationId,
      codec: "PCMU/8000",
    });
    monitors.set(name, { name, superviseToken, deviceId: String(device.id), ext: me.extensionNumber, softphone });
    log("daemon.monitor_ready", { monitor: name, ext: me.extensionNumber, deviceId: device.id });
  }

  // Per-agent state: recorder + attach bookkeeping.
  const state = new Map();
  for (const agent of agents) {
    const ext = await resolveExtension(lookupToken, agent.agentExt);
    if (!ext) throw new Error(`cannot resolve agent ext ${agent.agentExt}`);
    const recorder = new AgentRecorder({ agentExt: agent.agentExt, agentId: agent.agentId, outDir });
    recorder.openSegment();
    state.set(agent.agentExt, {
      ...agent,
      extensionId: String(ext.id),
      recorder,
      sessionId: null,
      legs: { agent: null, remote: null }, // { supervisionPartyId, live }
      attachErrors: 0,
      lastAttachError: null,
      coach: null, // { sessionId, uii, providerCallId } while a call's coach session is open
    });
  }

  const coachBinder = createCoachBinder({ aiBusUrl, mode: coachMode });
  log("daemon.coach_mode", { mode: coachMode, live: coachBinder.enabled, aiBusUrl: aiBusUrl || null });

  // supervisionPartyId -> { agentExt, leg } routing table for incoming INVITEs.
  const partyRoute = new Map();

  // The supervision INVITE can arrive BEFORE the supervise REST response returns
  // the party id (observed live: a refused INVITE leaves the supervision party
  // stuck "Proceeding" and later attaches 409). Unrouted invites are parked here
  // and answered as soon as the route lands; stale ones expire.
  const pendingInvites = [];
  const PENDING_INVITE_TTL_MS = 15000;

  async function answerRoutedInvite(monitor, inviteMessage, ids, route) {
    try {
      const session = await monitor.softphone.answer(inviteMessage);
      const row = state.get(route.agentExt);
      row.legs[route.leg] = { supervisionPartyId: ids.partyId, live: true };
      log("daemon.leg_attached", { agentExt: route.agentExt, leg: route.leg, partyId: ids.partyId });
      session.on("audioPacket", (rtpPacket) => {
        row.recorder.write(route.leg, rtpPacket.payload);
      });
      session.once("disposed", () => {
        if (row.legs[route.leg]?.supervisionPartyId === ids.partyId) row.legs[route.leg] = null;
        partyRoute.delete(ids.partyId);
        log("daemon.leg_dropped", { agentExt: route.agentExt, leg: route.leg, partyId: ids.partyId });
      });
    } catch (error) {
      log("daemon.answer_failed", { agentExt: route.agentExt, leg: route.leg, error: error.message });
    }
  }

  function drainPendingInvites() {
    const now = Date.now();
    for (let i = pendingInvites.length - 1; i >= 0; i -= 1) {
      const pending = pendingInvites[i];
      const route = pending.ids.partyId ? partyRoute.get(pending.ids.partyId) : null;
      if (route) {
        pendingInvites.splice(i, 1);
        answerRoutedInvite(pending.monitor, pending.inviteMessage, pending.ids, route);
      } else if (now - pending.at > PENDING_INVITE_TTL_MS) {
        pendingInvites.splice(i, 1);
        log("daemon.invite_expired_unrouted", { partyId: pending.ids.partyId, sessionId: pending.ids.sessionId });
      }
    }
  }

  for (const monitor of monitors.values()) {
    monitor.softphone.on("invite", (inviteMessage) => {
      const ids = parseRcApiIds(inviteMessage);
      const route = ids.partyId ? partyRoute.get(ids.partyId) : null;
      if (route) {
        answerRoutedInvite(monitor, inviteMessage, ids, route);
        return;
      }
      // Race window: REST response not back yet. Park and let the drain answer it.
      pendingInvites.push({ monitor, inviteMessage, ids, at: Date.now() });
      log("daemon.invite_parked", { partyId: ids.partyId, sessionId: ids.sessionId, monitor: monitor.name });
    });
    await monitor.softphone.register();
    log("daemon.monitor_registered", { monitor: monitor.name });
  }

  async function attachAgent(row) {
    const monitor = monitors.get(row.monitorName);
    const found = await findLiveAgentSession(lookupToken, row.extensionId);
    if (!found) {
      row.lastAttachError = "no-live-session";
      return;
    }
    if (row.sessionId && row.sessionId !== found.session.id) {
      log("daemon.session_rotated", { agentExt: row.agentExt, from: row.sessionId, to: found.session.id });
      row.legs = { agent: null, remote: null };
    }
    row.sessionId = found.session.id;
    const targets = [
      { leg: "agent", party: found.agentParty },
      { leg: "remote", party: found.remoteParty },
    ];
    for (const target of targets) {
      if (row.legs[target.leg]?.live) continue;
      if (!target.party?.id) { row.lastAttachError = `no-${target.leg}-party`; continue; }
      const endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(found.session.id)}/parties/${encodeURIComponent(target.party.id)}/supervise`;
      try {
        let response;
        try {
          response = await rcRequest(monitor.superviseToken, "POST", endpoint, {
            mode: "Listen", supervisorDeviceId: monitor.deviceId, agentExtensionId: row.extensionId,
          });
        } catch (error) {
          if (!/agentExtensionId|CMN-10/i.test(String(error?.message || ""))) throw error;
          response = await rcRequest(monitor.superviseToken, "POST", endpoint, {
            mode: "Listen", supervisorDeviceId: monitor.deviceId,
          });
        }
        if (response?.id) {
          partyRoute.set(String(response.id), { agentExt: row.agentExt, leg: target.leg });
          log("daemon.supervise_requested", { agentExt: row.agentExt, leg: target.leg, supervisionPartyId: response.id });
          drainPendingInvites(); // the INVITE may have raced the REST response
        }
        row.attachErrors = 0;
        row.lastAttachError = null;
      } catch (error) {
        row.attachErrors += 1;
        row.lastAttachError = error.message.slice(0, 160);
        // MBW-005 = agent between dials; MBW-002 = permission; both retry next tick.
        log("daemon.supervise_failed", { agentExt: row.agentExt, leg: target.leg, error: row.lastAttachError });
      }
    }
  }

  // Segmenter: tail call_done (snip) + call_begin (advisory marker).
  let cursor = new Date();
  let eventsSeen = 0;
  const agentById = new Map(agents.map((a) => [a.agentId, a.agentExt]));
  async function pollEvents() {
    const rows = await LeadDeliveryEvent.find({
      provider: "phoneburner",
      eventType: { $in: ["call_done", "call_begin"] },
      receivedAt: { $gt: cursor },
    }).sort({ receivedAt: 1 }).limit(200).lean();
    for (const event of rows) {
      cursor = event.receivedAt > cursor ? event.receivedAt : cursor;
      const agentExt = agentById.get(String(event.safePayload?.sourceAgentId || ""));
      if (!agentExt) continue;
      const row = state.get(agentExt);
      eventsSeen += 1;
      if (event.eventType === "call_begin") {
        row.recorder.addMarker({ type: "call_begin", providerCallId: event.providerCallId });
        // A new call_begin implicitly closes any coach session left open by a
        // missed call_done (number-change-as-boundary, enforced structurally).
        if (row.coach) {
          await coachBinder.stop(row.coach.sessionId, "superseded-by-next-call_begin");
          row.coach = null;
        }
        try {
          const started = await coachBinder.start({ providerCallId: event.providerCallId, agent: row });
          if (started?.sessionId) {
            row.coach = { ...started, providerCallId: event.providerCallId };
            log("daemon.coach_started", { agentExt, agentEmail: row.email, providerCallId: event.providerCallId, coachSessionId: started.sessionId });
          }
        } catch (error) {
          log("daemon.coach_start_failed", { agentExt, providerCallId: event.providerCallId, error: error.message });
        }
        continue;
      }
      // call_done: stop this call's coach session, then snip the tape.
      if (row.coach) {
        await coachBinder.stop(row.coach.sessionId, "call_done");
        log("daemon.coach_stopped", { agentExt, providerCallId: event.providerCallId, coachSessionId: row.coach.sessionId });
        row.coach = null;
      }
      const snip = row.recorder.snip({
        providerCallId: event.providerCallId,
        providerContactId: event.providerContactId,
        outcome: event.normalizedOutcome,
        durationSeconds: event.safePayload?.durationSeconds,
        dialSessionId: event.safePayload?.providerDialSessionId,
        reason: "call_done",
      });
      log("daemon.segment_cut", {
        agentExt,
        providerCallId: event.providerCallId,
        outcome: event.normalizedOutcome,
        durationSeconds: event.safePayload?.durationSeconds ?? null,
        files: snip?.legs || null,
      });
    }
  }

  function timeoutSnips() {
    for (const row of state.values()) {
      const recorder = row.recorder;
      if (recorder.segmentStartedAt && (Date.now() - recorder.segmentStartedAt) > maxSegmentMin * 60 * 1000) {
        const hasAudio = recorder.bytes.agent + recorder.bytes.remote > 0;
        if (!hasAudio) { recorder.segmentStartedAt = Date.now(); continue; }
        const snip = recorder.snip({ reason: "max-segment-timeout" });
        log("daemon.segment_cut", { agentExt: row.agentExt, reason: "max-segment-timeout", files: snip?.legs || null });
      }
    }
  }

  function status() {
    for (const row of state.values()) {
      log("daemon.status", {
        agentExt: row.agentExt,
        sessionId: row.sessionId,
        legAgent: Boolean(row.legs.agent?.live),
        legRemote: Boolean(row.legs.remote?.live),
        segmentsCut: row.recorder.segmentsCut,
        currentBytes: row.recorder.bytes,
        lastAttachError: row.lastAttachError,
      });
    }
    log("daemon.events", { eventsSeen });
  }

  log("daemon.start", { agents: agents.map((a) => `${a.agentExt}:${a.agentId}:${a.monitorName}`), runMin, outDir });

  const stopAt = Date.now() + runMin * 60 * 1000;
  let stopping = false;
  const shutdown = () => { stopping = true; };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  let lastAttach = 0;
  let lastStatus = 0;
  while (Date.now() < stopAt && !stopping) {
    const now = Date.now();
    if (now - lastAttach >= attachEverySec * 1000) {
      lastAttach = now;
      for (const row of state.values()) {
        try { await attachAgent(row); } catch (error) { log("daemon.attach_loop_error", { agentExt: row.agentExt, error: error.message }); }
      }
      timeoutSnips();
    }
    if (now - lastStatus >= statusEverySec * 1000) {
      lastStatus = now;
      status();
    }
    try { await pollEvents(); } catch (error) { log("daemon.poll_error", { error: error.message }); }
    drainPendingInvites();
    await new Promise((resolve) => setTimeout(resolve, pollEverySec * 1000));
  }

  // Final snip of any in-flight audio + close any open coach session, then report.
  for (const row of state.values()) {
    if (row.coach) {
      await coachBinder.stop(row.coach.sessionId, "daemon-shutdown");
      row.coach = null;
    }
    if (row.recorder.bytes.agent + row.recorder.bytes.remote > 0) {
      row.recorder.snip({ reason: "daemon-shutdown" });
    }
  }
  status();
  for (const monitor of monitors.values()) {
    try { monitor.softphone.revoke(); } catch {}
  }
  log("daemon.stop", { reason: stopping ? "signal" : "run-min-elapsed" });
}

// Force exit: softphone SIP keepalive timers + mongoose otherwise keep this
// process (and every live supervision leg it holds) alive indefinitely.
main().then(() => process.exit(0)).catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
