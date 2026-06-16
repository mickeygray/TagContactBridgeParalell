#!/usr/bin/env node
"use strict";

// VM THEME ANSWERER — service-grade successor to vm-ext-answerer.js.
// Registers ALL themed voicemail-drop extensions (parent JWT + account-scoped
// device lookup — same registration path the barge service and the one-off
// answerer proved), auto-answers inbound cold transfers, plays that
// extension's themed message, hangs up, re-arms.
//
// Theme map (disposition cold-transfer targets -> message):
//   987  Online Inquiry     (med)  voicemail-shared.raw     DID 213-335-3006
//   1101 Free Consultation  (low)  voicemails/445.raw       DID 424-207-1310
//   1102 Tailor Made        (med)  voicemails/966.raw       DID 213-784-3567
//   1104 Balance Due        (high) voicemails/741.raw       DID 818-264-4826
//   1105 Notices            (med)  voicemails/743.raw       DID 818-793-5377
//
// Run forever (systemd Restart=always). Each extension re-registers on a
// rolling cycle (default 50 min) when idle so SIP registrations never go
// stale. Themes whose audio file is missing are skipped with a warning.
//
//   node scripts/vm-theme-answerer.js                # all themes
//   node scripts/vm-theme-answerer.js --only 987,1101

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Softphone = require("ringcentral-softphone");
const { RtpPacket, RtpHeader } = require("werift-rtp");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const REPO = path.resolve(__dirname, "..");
const AUDIO = path.join(REPO, "runtime", "audio");
// 2min default (was 50): floor evidence showed inbound transfers rolling to
// the extensions' RC voicemail 10+ minutes after a registration cycle — SIP
// bindings appear to expire well before 50min and the lib does not refresh.
// Short cycles keep the registration hot until a proper keepalive lands.
// (VM_ANSWERER_REREGISTER_MIN retired: the blind 2-min teardown/rebuild cycle
// is gone. The SDK refreshes registration every 30s at the SIP layer; recovery
// is event-driven via registrationError + the slow idle safety net below.)
const ANSWER_DELAY_MS = Math.max(0, Number(process.env.VM_ANSWERER_ANSWER_DELAY_MS || 600));
// Multi-call answering: a declined call rolls to the extension's RC voicemail
// (a prospect mailbox then records a greeting + dead air). Each answered call
// gets its own RTP session + paced sender, so concurrency is safe.
const MAX_CONCURRENT = Math.max(1, Number(process.env.VM_ANSWERER_MAX_CONCURRENT || 4));
const REQUIRE_OWN_MONITOR_JWT = ["1", "true", "yes", "on"].includes(
  String(process.env.VM_ANSWERER_REQUIRE_OWN_JWT || process.env.EX_BARGE_REQUIRE_OWN_JWT || "").trim().toLowerCase(),
);

const THEMES = [
  { ext: "987", theme: "Phil / Voicemail One", raw: path.join(AUDIO, "voicemails", "319.raw") },
  { ext: "1101", theme: "Sean Lucas", raw: path.join(AUDIO, "voicemails", "445.raw") },
  { ext: "1102", theme: "Bruce Allen", raw: path.join(AUDIO, "voicemails", "966.raw") },
  { ext: "1104", theme: "Chris Bolt", raw: path.join(AUDIO, "voicemails", "741.raw") },
  { ext: "1105", theme: "James Sharp", raw: path.join(AUDIO, "voicemails", "743.raw") },
  { ext: "1106", theme: "Brad Hansen", raw: path.join(AUDIO, "voicemails", "742.raw") },
];

const MONITOR_JWT_ENV_ALIASES = new Map([
  ["987", "PHIL_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1101", "SEAN_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1102", "BRUCE_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1103", "ANTHONY_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1104", "CHRIS_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1105", "JAMES_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1106", "BRAD_RING_CENTRAL_MONITOR_JWT_TOKEN"],
]);

process.on("uncaughtException", (e) => console.error(`[uncaught] ${(e && e.code) || ""} ${(e && e.message) || e}`));
process.on("unhandledRejection", (e) => console.error(`[unhandledRejection] ${(e && e.message) || e}`));

function log(ext, msg) {
  console.log(`[${new Date().toISOString()}] [${ext}] ${msg}`);
}

// Token CACHE + FAILURE COOLDOWN. REST (token + device + sip-info) happens at
// BOOTSTRAP only — steady-state registration upkeep is pure SIP (the softphone
// SDK re-REGISTERs every 30s on its own socket; zero RC API commands). If a
// token mint FAILS for any reason, we are "not dialed into the platform":
// back off and try again after 3 minutes — never hot-loop the auth endpoint.
const AUTH_FAILURE_BACKOFF_MS = Math.max(30_000, Number(process.env.VM_ANSWERER_AUTH_BACKOFF_MS || 180_000));
const tokenCache = { value: null, exp: 0, inflight: null, failUntil: 0 };
async function token() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.exp) return tokenCache.value;
  if (now < tokenCache.failUntil) {
    throw new Error(`platform auth in backoff until ${new Date(tokenCache.failUntil).toISOString()}`);
  }
  if (tokenCache.inflight) return tokenCache.inflight;
  tokenCache.inflight = (async () => {
    try {
      return await mintToken();
    } catch (e) {
      // ANY mint failure (HTTP error or network) opens the backoff window.
      if (!tokenCache.failUntil) tokenCache.failUntil = Date.now() + AUTH_FAILURE_BACKOFF_MS;
      throw e;
    }
  })();
  try {
    return await tokenCache.inflight;
  } finally {
    tokenCache.inflight = null;
  }
}

async function mintToken() {
  const basic = Buffer.from(`${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RING_CENTRAL_JWT_TOKEN,
  });
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const t = await r.text();
  if (!r.ok) {
    throw new Error(`oauth ${r.status}: ${t.slice(0, 160)} (auth backoff ${Math.round(AUTH_FAILURE_BACKOFF_MS / 1000)}s)`);
  }
  tokenCache.failUntil = 0;
  const parsed = JSON.parse(t);
  tokenCache.value = parsed.access_token;
  tokenCache.exp = Date.now() + Math.max(60_000, ((Number(parsed.expires_in) || 3600) - 300) * 1000);
  return tokenCache.value;
}

async function rcGet(tok, endpoint) {
  const r = await fetch(`${RC_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) {
    const e = new Error(`GET ${endpoint.split("?")[0]} ${r.status}: ${t.slice(0, 140)}`);
    e.status = r.status;
    throw e;
  }
  return t ? JSON.parse(t) : null;
}

async function rcPost(tok, endpoint, body) {
  const r = await fetch(`${RC_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  if (!r.ok) {
    const e = new Error(`POST ${endpoint.split("?")[0]} ${r.status}: ${t.slice(0, 140)}`);
    e.status = r.status;
    throw e;
  }
  return t ? JSON.parse(t) : null;
}

function loadJwtMap() {
  const map = new Map();
  const file = process.env.EX_BARGE_JWT_MAP || process.env.VM_ANSWERER_JWT_MAP;
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(parsed || {})) {
        if (v) map.set(String(k).trim(), String(v).trim());
      }
    } catch (e) {
      console.error(`[auth] monitor JWT map read failed: ${e.message}`);
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^EX_BARGE_JWT_(\d+)$/.exec(key) || /^VM_ANSWERER_JWT_(\d+)$/.exec(key);
    if (match && value) map.set(match[1], String(value).trim());
  }
  return map;
}

const JWT_MAP = loadJwtMap();

function jwtForExt(ext) {
  const key = String(ext || "").trim();
  const direct = JWT_MAP.get(key);
  if (direct) return direct;
  const alias = MONITOR_JWT_ENV_ALIASES.get(key);
  return alias && process.env[alias] ? String(process.env[alias]).trim() : null;
}

const extTokenCache = new Map();
async function tokenForExt(ext) {
  const key = String(ext || "").trim();
  const jwt = jwtForExt(key);
  if (!jwt) return null;
  const now = Date.now();
  const cached = extTokenCache.get(key) || { value: null, exp: 0, inflight: null };
  if (cached.value && now < cached.exp) return cached.value;
  if (cached.inflight) return cached.inflight;
  cached.inflight = (async () => {
    const basic = Buffer.from(`${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });
    const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`OAuth(monitor ${key}) ${r.status}: ${t.slice(0, 140)}`);
    const parsed = JSON.parse(t);
    cached.value = parsed.access_token;
    cached.exp = Date.now() + Math.max(60_000, ((Number(parsed.expires_in) || 3600) - 120) * 1000);
    log(key, "token via own JWT");
    return cached.value;
  })();
  extTokenCache.set(key, cached);
  try {
    return await cached.inflight;
  } finally {
    cached.inflight = null;
  }
}

function normalizeSipInfo(raw) {
  const row = Array.isArray(raw?.sipInfo) ? raw.sipInfo[0] : raw;
  if (!row) return null;
  return {
    domain: row.domain,
    userName: row.userName || row.username,
    password: row.password,
    authorizationId: row.authorizationId,
    outboundProxy: row.outboundProxy || null,
    outboundProxies: row.outboundProxies || raw?.outboundProxies || null,
  };
}

function pickProxyTLS(sipInfo, region = "NA") {
  const proxies = Array.isArray(sipInfo?.outboundProxies) ? sipInfo.outboundProxies : [];
  const hit = proxies.find((p) => String(p.region || "").toUpperCase() === String(region).toUpperCase());
  return (hit && (hit.proxyTLS || hit.proxy)) || sipInfo?.outboundProxy || null;
}

function guardNoCseqMessages(sp) {
  const emit = sp.emit.bind(sp);
  sp.emit = (eventName, ...args) => {
    const message = args[0];
    if (eventName === "message" && message && !message.headers?.CSeq) {
      return false;
    }
    return emit(eventName, ...args);
  };
}

// Catch-up-paced PCMU sender (proven in ex-barge-button + vm-ext-answerer;
// naive per-frame timers garble on loaded hosts).
function sendAudioPaced(callSession, buffer, { onLog, onFinished, leadFrames = 3 } = {}) {
  const codec = callSession.softphone.codec;
  const packetSize = codec.packetSize;
  const frameMs = (codec.timestampInterval / (codec.id === 0 ? 8 : 16)) || 20;
  const totalFrames = Math.floor(buffer.length / packetSize);
  let sent = 0;
  let offset = 0;
  let stopped = false;
  const startTime = Date.now();
  const sendOne = () => {
    const chunk = buffer.subarray(offset, offset + packetSize);
    const payload = callSession.encoder.encode(chunk);
    const rtp = new RtpPacket(
      new RtpHeader({
        version: 2, padding: false, paddingSize: 0, extension: false, marker: false,
        payloadOffset: 12, payloadType: codec.id,
        sequenceNumber: callSession.sequenceNumber, timestamp: callSession.timestamp,
        ssrc: callSession.ssrc, csrcLength: 0, csrc: [], extensionProfile: 48862,
        extensionLength: undefined, extensions: [],
      }),
      payload,
    );
    callSession.send(callSession.srtpSession.encrypt(rtp.payload, rtp.header));
    callSession.sequenceNumber += 1;
    if (callSession.sequenceNumber > 65535) callSession.sequenceNumber = 0;
    callSession.timestamp += codec.timestampInterval;
    offset += packetSize;
    sent += 1;
  };
  const finish = () => {
    if (onLog) onLog(`paced send FINISHED ${sent}/${totalFrames} frames in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    if (onFinished) onFinished();
  };
  const tick = () => {
    if (stopped || callSession.disposed) return;
    const elapsed = Date.now() - startTime;
    const target = Math.min(totalFrames, Math.floor(elapsed / frameMs) + leadFrames);
    let guard = 0;
    while (sent < target && sent < totalFrames) {
      try { sendOne(); } catch (e) { if (onLog) onLog(`send error @frame ${sent}: ${e && e.message}`); stopped = true; finish(); return; }
      if (++guard > 200) break;
    }
    if (sent >= totalFrames) { finish(); return; }
    setTimeout(tick, 5);
  };
  setTimeout(tick, 0);
  return { stop: () => { stopped = true; } };
}

// Resolve extension id + OtherPhone device once per theme (cached).
async function resolveDevice(tok, extNumber, cache) {
  if (cache.has(extNumber)) return cache.get(extNumber);
  let target = null;
  for (let p = 1; p <= 20; p += 1) {
    const d = await rcGet(tok, `/restapi/v1.0/account/~/extension?perPage=200&page=${p}`);
    const recs = Array.isArray(d?.records) ? d.records : [];
    target = recs.find((r) => String(r.extensionNumber || "") === extNumber) || target;
    if (target || recs.length < 200) break;
  }
  if (!target) throw new Error(`ext ${extNumber} not found in account`);
  const devResp = await rcGet(tok, `/restapi/v1.0/account/~/extension/${target.id}/device`);
  const device = (devResp?.records || []).find((d) => d.type === "OtherPhone") || (devResp?.records || [])[0];
  if (!device?.id) throw new Error(`no softphone device on ext ${extNumber}`);
  const resolved = { extensionId: target.id, deviceId: device.id };
  cache.set(extNumber, resolved);
  return resolved;
}

async function resolveOwnProvisionedSipInfo(extNumber) {
  const tok = await tokenForExt(extNumber);
  if (!tok) return null;
  const me = await rcGet(tok, "/restapi/v1.0/account/~/extension/~");
  if (me?.extensionNumber && String(me.extensionNumber) !== String(extNumber)) {
    throw new Error(`JWT for ext ${extNumber} authenticated as ext ${me.extensionNumber}`);
  }
  const transport = String(process.env.VM_ANSWERER_SIP_TRANSPORT || "WSS").trim().toUpperCase();
  const provisioned = await rcPost(tok, "/restapi/v1.0/client-info/sip-provision", {
    sipInfo: [{ transport }],
  });
  const sipInfo = normalizeSipInfo(provisioned);
  if (!sipInfo?.domain || !sipInfo?.userName) {
    throw new Error(`sip-provision returned incomplete credentials for ext ${extNumber}`);
  }
  return { sipInfo, deviceId: "client-info/sip-provision", via: "own-jwt sip-provision" };
}

async function resolveSharedDeviceSipInfo(extNumber, deviceCache) {
  const tok = await token();
  const { deviceId } = await resolveDevice(tok, extNumber, deviceCache);
  const sipInfo = normalizeSipInfo(await rcGet(tok, `/restapi/v1.0/account/~/device/${deviceId}/sip-info`));
  if (!sipInfo?.domain || !sipInfo?.userName) {
    throw new Error(`device sip-info returned incomplete credentials for ext ${extNumber}`);
  }
  return { sipInfo, deviceId, via: "shared-token device-sip-info" };
}

async function startAnswerer(theme, deviceCache, sipInfoCache, onRegistrationDead) {
  const wav = fs.readFileSync(theme.raw);
  // SIP credentials are STABLE — fetch once per extension per process. Rebuilds
  // after socket death reuse the cache: zero REST, zero tokens, pure SIP.
  let cached = sipInfoCache.get(theme.ext);
  if (!cached) {
    try {
      cached = await resolveOwnProvisionedSipInfo(theme.ext);
    } catch (e) {
      if (REQUIRE_OWN_MONITOR_JWT) throw e;
      log(theme.ext, `own-jwt sip-provision failed (${e.message}); falling back to shared device sip-info`);
    }
    if (!cached) {
      cached = await resolveSharedDeviceSipInfo(theme.ext, deviceCache);
    }
    sipInfoCache.set(theme.ext, cached);
  }
  const { deviceId, sipInfo, via } = cached;

  const sp = new Softphone({
    domain: sipInfo.domain,
    outboundProxy: pickProxyTLS(sipInfo, process.env.VM_ANSWERER_REGION || "NA"),
    username: sipInfo.userName,
    password: sipInfo.password,
    authorizationId: sipInfo.authorizationId,
    codec: "PCMU/8000",
  });
  guardNoCseqMessages(sp);
  try {
    await sp.register();
  } catch (e) {
    if (via === "own-jwt sip-provision") sipInfoCache.delete(theme.ext);
    throw e;
  }
  log(theme.ext, `REGISTERED "${theme.theme}" via ${via} (device ${deviceId}, ${(wav.length / 8000).toFixed(1)}s message)`);
  // The SDK re-REGISTERs every 30s on its own (SIP-only). When the socket
  // dies, that refresh errors — THIS is the real failure mode (laptop sleep,
  // NAT timeout), and it's event-driven now instead of blind-cycle-papered.
  sp.on("registrationError", (e) => {
    if (typeof onRegistrationDead === "function") onRegistrationDead(theme, e);
  });
  const state = { sp, active: 0, disposed: false, lastSipAt: Date.now() };
  // PROOF OF LIFE for the half-open-socket trap: every 30s refresh draws a
  // SIP 200 OK back through this socket, so ANY inbound SIP message stamps
  // liveness. Silence > ~3 refresh cycles = dead socket even though no error
  // ever fired — the orchestrator's liveness check rebuilds on it.
  sp.on("message", () => { state.lastSipAt = Date.now(); });
  sp.on("invite", async (inviteMessage) => {
    const from = String(inviteMessage?.headers?.From || "").slice(0, 120);
    log(theme.ext, `INVITE from ${from} (active ${state.active}/${MAX_CONCURRENT})`);
    if (state.active >= MAX_CONCURRENT) {
      log(theme.ext, `at capacity (${MAX_CONCURRENT}) — declining`);
      try { await sp.decline(inviteMessage); } catch {}
      return;
    }
    state.active += 1;
    try {
      const callSession = await sp.answer(inviteMessage);
      log(theme.ext, `ANSWERED — playing "${theme.theme}" in ${ANSWER_DELAY_MS}ms (active ${state.active})`);
      await new Promise((r) => setTimeout(r, ANSWER_DELAY_MS));
      await new Promise((resolve) => {
        sendAudioPaced(callSession, wav, { onLog: (m) => log(theme.ext, m), onFinished: resolve });
        callSession.once("disposed", resolve);
      });
      await new Promise((r) => setTimeout(r, 500));
      try { await callSession.hangup(); } catch {}
      log(theme.ext, `hung up — re-armed (active ${state.active - 1})`);
    } catch (e) {
      log(theme.ext, `answer/play error: ${e.message}`);
    } finally {
      state.active -= 1;
    }
  });

  state.dispose = async () => {
    state.disposed = true;
    try { await sp.revoke(); } catch {}
  };
  return state;
}

(async () => {
  const argv = process.argv.slice(2);
  const onlyArg = argv.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? new Set(String(onlyArg.includes("=") ? onlyArg.split("=")[1] : argv[argv.indexOf("--only") + 1] || "").split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const themes = THEMES.filter((t) => {
    if (only && !only.has(t.ext)) return false;
    if (!fs.existsSync(t.raw)) {
      console.error(`[skip] ${t.ext} "${t.theme}" — audio missing: ${t.raw}`);
      return false;
    }
    return true;
  });
  if (!themes.length) throw new Error("no themes to serve");

  const deviceCache = new Map();
  const sipInfoCache = new Map();
  const live = new Map();
  // Per-ext rebuild orchestration: debounced (registrationError fires every
  // 30s while a socket is dead) with exponential backoff 5s → 3min.
  const rebuildState = new Map(); // ext -> { timer, delayMs }

  function scheduleRebuild(theme, reason) {
    const state = rebuildState.get(theme.ext) || { timer: null, delayMs: 5_000 };
    if (state.timer) return; // already scheduled
    log(theme.ext, `rebuild scheduled in ${Math.round(state.delayMs / 1000)}s (${reason})`);
    state.timer = setTimeout(async () => {
      state.timer = null;
      const current = live.get(theme.ext);
      if (current && current.active > 0) {
        // Mid-call: the RTP session is independent of the registration; finish
        // the call, then rebuild.
        state.delayMs = 5_000;
        rebuildState.set(theme.ext, state);
        scheduleRebuild(theme, "deferred-active-call");
        return;
      }
      try {
        if (current) await current.dispose();
      } catch {}
      live.delete(theme.ext);
      try {
        const next = await startAnswerer(theme, deviceCache, sipInfoCache, onRegistrationDead);
        next.upAt = Date.now();
        live.set(theme.ext, next);
        state.delayMs = 5_000; // healthy again: reset backoff
      } catch (e) {
        console.error(`[${theme.ext}] rebuild FAILED: ${e.message}`);
        state.delayMs = Math.min(state.delayMs * 2, AUTH_FAILURE_BACKOFF_MS);
        rebuildState.set(theme.ext, state);
        scheduleRebuild(theme, "rebuild-failed");
        return;
      }
      rebuildState.set(theme.ext, state);
    }, state.delayMs);
    rebuildState.set(theme.ext, state);
  }

  function onRegistrationDead(theme, error) {
    log(theme.ext, `registrationError: ${String(error?.message || error).slice(0, 120)}`);
    scheduleRebuild(theme, "registration-error");
  }

  async function bringUp(theme) {
    try {
      const state = await startAnswerer(theme, deviceCache, sipInfoCache, onRegistrationDead);
      state.upAt = Date.now();
      live.set(theme.ext, state);
    } catch (e) {
      console.error(`[${theme.ext}] registration FAILED: ${e.message}`);
      scheduleRebuild(theme, "initial-bringup-failed");
    }
  }

  for (const theme of themes) {
    await bringUp(theme); // serial: avoids hammering the auth endpoint
  }
  console.log(`[answerer] serving ${live.size}/${themes.length} themes; SIP-layer refresh is the SDK's 30s cycle (no REST); event-driven rebuild on registrationError`);

  // LIVENESS CHECK (closes the half-open-socket trap): the SDK's 30s REGISTER
  // refresh draws a 200 OK back over the socket, so lastSipAt advances every
  // ~30s on a healthy connection. Silence past VM_ANSWERER_SIP_SILENCE_S
  // (default 95s ≈ 3 missed refreshes) = dead socket regardless of errors —
  // rebuild from cached credentials (pure SIP, zero REST).
  const sipSilenceMs = Math.max(45_000, Number(process.env.VM_ANSWERER_SIP_SILENCE_S ?? 95) * 1000);
  setInterval(() => {
    for (const theme of themes) {
      const state = live.get(theme.ext);
      if (!state) continue; // rebuild already in flight
      if (state.active > 0) continue;
      if (Date.now() - (state.lastSipAt || state.upAt || 0) > sipSilenceMs) {
        log(theme.ext, `no SIP traffic for ${Math.round((Date.now() - (state.lastSipAt || state.upAt || 0)) / 1000)}s — socket presumed dead`);
        scheduleRebuild(theme, "sip-silence");
      }
    }
  }, 30_000);
})().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
