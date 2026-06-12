#!/usr/bin/env node
"use strict";

// EX BARGE BUTTON -- independent test instance.
//
// Registers the monitor extension's softphone (default PHIL / 987) and, on click,
// dials the RingCentral BARGE star code *82<agentExt> -- which joins the agent's
// live call as a TALKING participant (heard by all). Optionally streams a WAV into
// the call on connect (the voicemail-drop test). Whisper is *81<agentExt>.
//
// This is the path that actually works: barge is a star-code CALL from a registered
// softphone, NOT the supervise REST mode (which is Listen-only). Uses the installed
// ringcentral-softphone (TS SDK): softphone.call() + callSession.streamAudio(), PCMU/8000.
//
// Auth: default RC app creds (RING_CENTRAL_JWT_TOKEN / _CLIENT_ID / _CLIENT_SECRET)
// to read the monitor extension's device sip-info; the softphone then registers with
// those SIP creds (so the *82 call is authorized as the monitor, using its Call-
// Monitoring permission over the agent).
//
// Run:  node scripts/ex-barge-button.js --port 7335 --supervisor-ext 987 --agent-ext 101 [--wav path.raw]
//       then open http://127.0.0.1:7335/

const http = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Softphone = require("ringcentral-softphone");
const { RtpPacket, RtpHeader } = require("werift-rtp");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

// The softphone's TLS socket throws an unhandled ECONNRESET when the barge call tears down.
// Keep the server alive (it's a test rig) so one call's teardown doesn't kill registration.
process.on("uncaughtException", (e) => console.error(`[uncaught] ${(e && e.code) || ""} ${(e && e.message) || e}`));
process.on("unhandledRejection", (e) => console.error(`[unhandledRejection] ${(e && e.message) || e}`));

function env(n, f = "") { const v = process.env[n]; return v == null || v === "" ? f : String(v); }
function boolEnv(n, fb = false) {
  const v = process.env[n];
  if (v == null || v === "") return fb;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function readFlag(argv, name, fb = "") {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && i < argv.length - 1 ? argv[i + 1] : fb;
}

function summarizeEventArg(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return value;
  if (type === "bigint") return String(value);
  if (type === "function") return `[Function ${value.name || "anonymous"}]`;
  if (Buffer.isBuffer(value)) return { type: "Buffer", length: value.length };
  if (depth >= 2) return `[${value?.constructor?.name || "Object"}]`;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => summarizeEventArg(item, depth + 1, seen));
  }
  const out = {};
  const ctor = value?.constructor?.name;
  if (ctor && ctor !== "Object") out.type = ctor;
  for (const key of Object.keys(value || {}).slice(0, 20)) {
    try {
      const child = value[key];
      if (typeof child !== "function") out[key] = summarizeEventArg(child, depth + 1, seen);
    } catch (error) {
      out[key] = `[read error: ${error.message}]`;
    }
  }
  return out;
}

function summarizeEventArgs(args) {
  return Array.from(args || []).slice(0, 5).map((arg) => summarizeEventArg(arg));
}

// RC platform token. PREFER borrowing the control-plane's token (it already keeps
// one on a cached, backoff-aware refresh loop) so this service never calls RC's
// oauth/token endpoint -- it can't add load to RingCentral's per-app Auth rate-limit
// group or contribute to locking the floor out, and it refreshes in lockstep with
// the app. Falls back to a direct JWT grant only if the control-plane is unreachable
// (standalone / local use). Cached + single-flight either way.
const CONTROL_PLANE_URL = (process.env.CONTROL_PLANE_URL || process.env.CONTROL_PLANE_BASE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const INTERNAL_SECRET = String(process.env.INTERNAL_SERVICE_SECRET || process.env.AI_BUS_INTERNAL_SECRET || "").trim();

async function borrowTokenFromApp() {
  if (!INTERNAL_SECRET) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${CONTROL_PLANE_URL}/api/internal/rc/access-token`, {
      headers: { "x-internal-secret": INTERNAL_SECRET, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || !j.accessToken) return null;
    const expMs = j.expiresAt ? Date.parse(j.expiresAt) : NaN;
    const exp = Number.isFinite(expMs) ? expMs - 120_000 : Date.now() + 5 * 60_000;
    return { value: j.accessToken, exp };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function directToken() {
  const jwt = process.env.RING_CENTRAL_JWT_TOKEN;
  const id = process.env.RING_CENTRAL_CLIENT_ID;
  const secret = process.env.RING_CENTRAL_CLIENT_SECRET;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: controller.signal,
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`OAuth ${r.status}: ${t.slice(0, 200)}`);
    const j = JSON.parse(t);
    return { value: j.access_token, exp: Date.now() + Math.max(60_000, ((Number(j.expires_in) || 3600) - 120) * 1000) };
  } finally {
    clearTimeout(timer);
  }
}

let _tok = { value: null, exp: 0, inflight: null, source: null };
async function token() {
  const now = Date.now();
  if (_tok.value && now < _tok.exp) return _tok.value;
  if (_tok.inflight) return _tok.inflight;
  _tok.inflight = (async () => {
    const borrowed = await borrowTokenFromApp();
    const t = borrowed || await directToken();
    _tok.value = t.value;
    _tok.exp = t.exp;
    const src = borrowed ? "app-broker" : "direct-jwt";
    if (_tok.source !== src) { console.log(`[auth] RC token via ${src}`); _tok.source = src; }
    return _tok.value;
  })();
  try { return await _tok.inflight; } finally { _tok.inflight = null; }
}
// ---- per-extension JWTs (preferred) ----------------------------------------
// Each monitor authenticates AS ITSELF with its own JWT, so we never lean on one
// account-admin token and every registration/leg is scoped to its own extension.
// Supply either EX_BARGE_JWT_MAP (path to JSON {"987":"<jwt>", ...}) or per-ext env
// vars EX_BARGE_JWT_987=<jwt>. If no JWT is configured for an extension, we fall
// back to the shared app-broker/direct token + account-scoped lookup (legacy path).
// Set EX_BARGE_REQUIRE_OWN_JWT=true to fail closed instead of using that legacy
// fallback; production voicemail drop should run in that mode once monitor JWTs
// are configured.
const requireOwnMonitorJwt = boolEnv("EX_BARGE_REQUIRE_OWN_JWT") || boolEnv("EX_BARGE_REQUIRE_MONITOR_JWT");
const monitorJwtEnvAliases = new Map([
  ["987", "PHIL_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1101", "SEAN_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1102", "BRUCE_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1103", "ANTHONY_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1104", "CHRIS_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1105", "JAMES_RING_CENTRAL_MONITOR_JWT_TOKEN"],
  ["1106", "BRAD_RING_CENTRAL_MONITOR_JWT_TOKEN"],
]);
let _jwtMap = null;
function loadJwtMap() {
  if (_jwtMap) return _jwtMap;
  _jwtMap = new Map();
  const file = process.env.EX_BARGE_JWT_MAP;
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(j)) if (v) _jwtMap.set(String(k).trim(), String(v).trim());
    } catch (e) { console.error(`[auth] EX_BARGE_JWT_MAP read failed: ${e.message}`); }
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^EX_BARGE_JWT_(\d+)$/.exec(k);
    if (m && v) _jwtMap.set(m[1], String(v).trim());
  }
  if (_jwtMap.size) console.log(`[auth] per-extension JWTs loaded for: ${[..._jwtMap.keys()].join(", ")}`);
  return _jwtMap;
}
function jwtForExt(ext) {
  const key = String(ext).trim();
  const direct = loadJwtMap().get(key);
  if (direct) return direct;
  const alias = monitorJwtEnvAliases.get(key);
  return alias && process.env[alias] ? String(process.env[alias]).trim() : null;
}

async function jwtGrant(jwt) {
  const id = process.env.RING_CENTRAL_CLIENT_ID;
  const secret = process.env.RING_CENTRAL_CLIENT_SECRET;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`OAuth(ext-jwt) ${r.status}: ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  return { value: j.access_token, exp: Date.now() + Math.max(60_000, ((Number(j.expires_in) || 3600) - 120) * 1000) };
}

// Per-extension token cache (single-flight per ext). Returns null when no JWT is set
// for the extension, so callers can fall back to the shared token.
const _extTok = new Map(); // ext -> { value, exp, inflight }
async function tokenForExt(ext) {
  const jwt = jwtForExt(ext);
  if (!jwt) return null;
  const key = String(ext).trim();
  const now = Date.now();
  let c = _extTok.get(key) || { value: null, exp: 0, inflight: null };
  if (c.value && now < c.exp) return c.value;
  if (c.inflight) return c.inflight;
  _extTok.set(key, c);
  c.inflight = (async () => {
    const t = await jwtGrant(jwt);
    c.value = t.value; c.exp = t.exp;
    console.log(`[auth] monitor ${key} token via own-jwt`);
    return c.value;
  })();
  try { return await c.inflight; } finally { c.inflight = null; }
}

async function get(tok, endpoint) {
  const r = await fetch(`${RC_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET ${endpoint} ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
// Cache the full extension list briefly so warming N monitors paginates ONCE,
// not N times (each pass is up to 20 GETs). 60s TTL covers a boot burst + re-warms.
let _extCache = { at: 0, byNum: null };
async function loadExtensionIndex(tok) {
  const now = Date.now();
  if (_extCache.byNum && now - _extCache.at < 60_000) return _extCache.byNum;
  const byNum = new Map();
  for (let p = 1; p <= 20; p += 1) {
    const d = await get(tok, `/restapi/v1.0/account/~/extension?perPage=200&page=${p}`);
    const recs = Array.isArray(d?.records) ? d.records : [];
    for (const r of recs) byNum.set(String(r.extensionNumber || ""), r);
    if (recs.length < 200) break;
  }
  _extCache = { at: now, byNum };
  return byNum;
}
async function resolveExt(tok, num) {
  const idx = await loadExtensionIndex(tok);
  return idx.get(String(num)) || null;
}
function pickOtherPhone(devices, requestedId = "") {
  if (requestedId) return devices.find((d) => String(d.id) === String(requestedId)) || null;
  // ringcentral-softphone requires a device of type OtherPhone ("Existing Phone").
  return devices.find((d) => d.type === "OtherPhone") || devices[0] || null;
}
function pickProxyTLS(sipInfo, region = "NA") {
  const proxies = Array.isArray(sipInfo?.outboundProxies) ? sipInfo.outboundProxies : [];
  const hit = proxies.find((p) => String(p.region || "").toUpperCase() === region.toUpperCase()) || proxies[0];
  // Older sip-info shape exposes a flat `outboundProxy`; newer one has the proxies array.
  return (hit && (hit.proxyTLS || hit.proxy)) || sipInfo?.outboundProxy || null;
}

// ---- monitor softphone registry --------------------------------------------
// Production shape: each agent has a dedicated headless monitor (barger) that
// has 1:1 call-monitoring permission over them (e.g. 987 -> Phil). We register a
// softphone per monitor extension on demand and cache it (warm for reuse). The
// control-plane resolves WHICH monitor + target + voicemail per agent and passes
// monitorExt in; this service just registers/holds the softphones and plays.
const monitors = new Map(); // ext -> { softphone, registered, regError, meta, registering }
let defaultMonitorExt = null;
const armedBarges = new Map(); // monitorExt:*82:agentExt -> active silent barge leg

async function registerMonitor(monitorExt, { deviceId = "", region = "NA" } = {}) {
  const key = String(monitorExt || "").trim();
  if (!key) throw new Error("monitorExt required");
  let entry = monitors.get(key);
  if (entry && entry.registered && entry.softphone) return entry;
  if (entry && entry.registering) { try { await entry.registering; } catch {} return monitors.get(key); }

  entry = entry || { softphone: null, registered: false, regError: null, meta: {}, registering: null, regErrorSinceWarm: false, lastWarmAt: null, lastBargeAt: 0 };
  monitors.set(key, entry);
  entry.registering = (async () => {
    // Prefer the extension's OWN jwt (self-scoped). Fall back to the shared token +
    // account-scoped lookup by ext.id when no per-ext jwt is configured.
    // A bad/expired per-ext JWT must NOT break registration -- fall back to the shared token.
    let ownTok = null;
    try {
      ownTok = await tokenForExt(key);
    } catch (e) {
      if (requireOwnMonitorJwt) throw e;
      console.warn(`[auth] monitor ${key} own-jwt failed (${e.message}); falling back to shared token`);
      ownTok = null;
    }
    let tok; let extId = null; let devResp; let authSrc; let sipInfo; let device;
    if (ownTok) {
      try {
        tok = ownTok;
        authSrc = "own-jwt";
        const me = await get(tok, `/restapi/v1.0/account/~/extension/~`);
        extId = me?.id || null;
        if (me?.extensionNumber && String(me.extensionNumber) !== key) {
          throw new Error(`jwt for ext ${key} authenticated as ext ${me.extensionNumber} -- wrong jwt`);
        }
        devResp = await get(tok, `/restapi/v1.0/account/~/extension/~/device`);
        device = pickOtherPhone(Array.isArray(devResp?.records) ? devResp.records : [], deviceId);
        if (!device?.id) throw new Error(`no OtherPhone device on ext ${key}`);
        sipInfo = await get(tok, `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
      } catch (e) {
        if (requireOwnMonitorJwt) throw e;
        console.warn(`[auth] monitor ${key} own-jwt registration failed (${e.message}); falling back to shared token`);
        ownTok = null;
        tok = null;
        extId = null;
        devResp = null;
        authSrc = null;
        sipInfo = null;
        device = null;
      }
    }
    if (!ownTok) {
      if (requireOwnMonitorJwt) {
        throw new Error(`own JWT required for monitor ext ${key}; set EX_BARGE_JWT_${key} or EX_BARGE_JWT_MAP`);
      }
      tok = await token();
      authSrc = "shared-token";
      const ext = await resolveExt(tok, key);
      if (!ext) throw new Error(`monitor ext ${key} not found`);
      extId = ext.id;
      devResp = await get(tok, `/restapi/v1.0/account/~/extension/${ext.id}/device`);
      device = pickOtherPhone(Array.isArray(devResp?.records) ? devResp.records : [], deviceId);
      if (!device?.id) throw new Error(`no OtherPhone device on ext ${key}`);
      sipInfo = await get(tok, `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
    }
    const outboundProxy = pickProxyTLS(sipInfo, region);
    const sp = new Softphone({
      domain: sipInfo.domain,
      outboundProxy,
      username: sipInfo.userName,
      password: sipInfo.password,
      authorizationId: sipInfo.authorizationId,
      codec: "PCMU/8000",
    });
    // The lib re-REGISTERs every 30s (keepalive) but only emits on failure and never
    // reconnects a dead TLS socket. Flag it so the health loop can do a full re-warm.
    sp.on("registrationError", (e) => {
      entry.regError = (e && e.message) || String(e);
      entry.registered = false;
      entry.regErrorSinceWarm = true;
      entry.regErrorAt = Date.now();
    });
    await sp.register();
    entry.softphone = sp;
    entry.registered = true;
    entry.regError = null;
    entry.regErrorSinceWarm = false;
    entry.lastWarmAt = Date.now();
    entry.meta = { ext: key, extId, deviceId: device.id, outboundProxy, domain: sipInfo.domain, authSrc };
    console.log(`  monitor ${key} REGISTERED via ${authSrc} (device ${device.id}, proxy ${outboundProxy})`);
  })();
  try {
    await entry.registering;
  } catch (e) {
    entry.regError = e.message;
    entry.registered = false;
    console.error(`  monitor ${key} registration FAILED: ${e.message}`);
  } finally {
    entry.registering = null;
  }
  return monitors.get(key);
}

function entryForSoftphone(sp) {
  for (const e of monitors.values()) if (e.softphone === sp) return e;
  return null;
}

// Full re-warm: tear the dead softphone down (clears its keepalive interval + socket)
// and register a fresh one. Used by the health loop to recover a downed monitor.
async function reWarmMonitor(key, opts = {}) {
  const entry = monitors.get(key);
  if (entry?.softphone && typeof entry.softphone.revoke === "function") {
    try { entry.softphone.revoke(); } catch {}
  }
  if (entry) { entry.softphone = null; entry.registered = false; }
  return registerMonitor(key, opts);
}

// Registration health/self-heal. The softphone keepalive can't recover a dead TLS
// socket, so any monitor that has logged a registrationError since its last good
// warm gets a full re-warm -- but only when it's idle (no in-flight/armed barge,
// no recent drop) so we never tear down a softphone mid-call.
let healthTimer = null;
function startMonitorHealthLoop({ region = "NA", intervalMs } = {}) {
  if (healthTimer) return;
  const ms = Number(intervalMs || env("EX_BARGE_HEALTH_MS", "30000")) || 30000;
  healthTimer = setInterval(async () => {
    for (const [key, entry] of monitors) {
      // Act on monitors that aren't registered (boot failure, e.g. rate-limited) OR
      // logged a keepalive registrationError since their last good warm.
      if (entry.registered && !entry.regErrorSinceWarm) continue;
      if (entry.registering) continue;
      if (Date.now() - (entry.lastBargeAt || 0) < 60000) continue; // recent/active drop -> leave alone
      if ([...armedBarges.keys()].some((k) => k.startsWith(`${key}:`))) continue; // armed leg in use
      console.log(`[health] re-warming monitor ${key} (reg error since warm: ${entry.regError})`);
      try {
        await reWarmMonitor(key, { region });
        console.log(`[health] monitor ${key} -> registered=${monitors.get(key)?.registered}`);
      } catch (e) {
        console.error(`[health] re-warm ${key} failed: ${e.message}`);
      }
    }
  }, ms);
  if (healthTimer.unref) healthTimer.unref();
}

async function getMonitorSoftphone(monitorExt, opts) {
  const key = String(monitorExt || "").trim();
  const cached = monitors.get(key);
  if (cached && cached.registered && cached.softphone) return cached.softphone;
  const fresh = await registerMonitor(key, opts);
  if (!fresh || !fresh.registered || !fresh.softphone) {
    throw new Error(`monitor ${key} not registered${fresh?.regError ? `: ${fresh.regError}` : ""}`);
  }
  return fresh.softphone;
}

function monitorsStatus() {
  const list = Array.from(monitors.entries()).map(([ext, e]) => ({
    ext,
    registered: Boolean(e.registered),
    regError: e.regError || null,
    regErrorSinceWarm: Boolean(e.regErrorSinceWarm),
    lastWarmAt: e.lastWarmAt ? new Date(e.lastWarmAt).toISOString() : null,
    deviceId: e.meta?.deviceId || null,
    authSrc: e.meta?.authSrc || null,
  }));
  const armed = Array.from(armedBarges.values()).map(summarizeArmedBarge);
  const def = defaultMonitorExt ? monitors.get(defaultMonitorExt) : null;
  return {
    registered: list.some((m) => m.registered),
    defaultMonitorExt,
    requireOwnMonitorJwt,
    monitorMeta: def?.meta || {},
    regError: def?.regError || null,
    monitors: list,
    armed,
  };
}

// ---- the barge action ------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Catch-up-paced audio sender. Replaces callSession.streamAudio()'s naive
// "send 1 packet, setTimeout(20)" loop, which on Windows fires at the ~15.6ms
// timer granularity (=> ~31ms/packet => slower than realtime => receiver jitter
// buffer starves => "stitched"/gappy audio). Here each tick sends however many
// packets are needed to keep a small CONSTANT lead (LEAD_FRAMES) buffered at the
// receiver, so late timers self-correct and the average rate is exactly realtime.
function sendAudioPaced(callSession, buffer, { log, onFinished, leadFrames = 3 } = {}) {
  const codec = callSession.softphone.codec;
  const packetSize = codec.packetSize;            // PCMU: 160 bytes
  const frameMs = (codec.timestampInterval / (codec.id === 0 ? 8 : 16)) || 20; // 160/8 = 20ms for PCMU
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
    if (log) log(`paced send FINISHED ${sent}/${totalFrames} frames in ${((Date.now() - startTime) / 1000).toFixed(1)}s (expected ~${(totalFrames * frameMs / 1000).toFixed(1)}s)`);
    if (onFinished) onFinished();
  };

  const tick = () => {
    if (stopped || callSession.disposed) return;
    // How many frames SHOULD have been emitted by now, plus a constant lead.
    const elapsed = Date.now() - startTime;
    const target = Math.min(totalFrames, Math.floor(elapsed / frameMs) + leadFrames);
    let guard = 0;
    while (sent < target && sent < totalFrames) {
      try { sendOne(); } catch (e) { if (log) log(`send error @frame ${sent}: ${e && e.message}`); stopped = true; finish(); return; }
      if (++guard > 200) break; // never block the loop
    }
    if (sent >= totalFrames) { finish(); return; }
    setTimeout(tick, 5); // tick fast; real cadence is governed by wall-clock target
  };

  setTimeout(tick, 0);
  return { stop: () => { stopped = true; } };
}

// G.711 mu-law byte -> linear PCM sample (~ -32124..32124).
function muLawDecode(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}
function muLawRms(buf) {
  if (!buf || buf.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < buf.length; i += 1) { const s = muLawDecode(buf[i]); sumSq += s * s; }
  return Math.sqrt(sumSq / buf.length);
}

function bargeArmKey(monitorExt, code, agentExtNumber) {
  return [
    String(monitorExt || "").trim(),
    String(code || "*82").trim(),
    String(agentExtNumber || "").trim(),
  ].join(":");
}

function summarizeArmedBarge(arm) {
  if (!arm) return null;
  return {
    key: arm.key,
    monitorExt: arm.monitorExt,
    agentExtNumber: arm.agentExtNumber,
    code: arm.code,
    dial: arm.dial,
    sessionId: arm.sessionId || null,
    partyId: arm.partyId || null,
    inboundRtpSeen: arm.inbound || 0,
    mediaUp: arm.firstPt !== null,
    payloadType: arm.firstPt,
    playing: Boolean(arm.playing),
    released: Boolean(arm.released),
    createdAt: arm.createdAt,
    releasedAt: arm.releasedAt || null,
  };
}

function boundedMs(value, fallback, { min = 0, max = 30000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

async function waitForArmedBarge(key, waitMs = 0) {
  const started = Date.now();
  for (;;) {
    const arm = armedBarges.get(key);
    if (arm && !arm.released && !arm.callSession?.disposed) return arm;
    if (Date.now() - started >= waitMs) return null;
    await sleep(25);
  }
}

function buildRecorder(prefix, steps, events) {
  const log = (m) => { steps.push(m); console.log(`[${prefix}] ${m}`); };
  const recordEvent = (type, extra = {}) => {
    const event = { type, at: new Date().toISOString(), ...extra };
    events.push(event);
    console.log(`[${prefix}:event] ${JSON.stringify(event)}`);
    return event;
  };
  return { log, recordEvent };
}

// Dialing must never hang the HTTP handler (and leave a half-open leg) if RC stalls.
// Race the softphone.call against a hard timeout so a stuck dial fails fast.
async function dialWithTimeout(softphone, dial) {
  const ms = Number(env("EX_BARGE_DIAL_TIMEOUT_MS", "20000")) || 20000;
  let timer = null;
  try {
    return await Promise.race([
      softphone.call(dial),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`dial ${dial} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Safety cap: a play must never block the handler forever if the leg never disposes
// or sendAudioPaced never reports finished. Force a hangup + release at the cap.
const PLAY_HARD_CAP_MS = Number(env("EX_BARGE_PLAY_HARD_CAP_MS", "120000")) || 120000;

// /arm must confirm the *82 leg actually JOINED a connected call (inbound media)
// before it reports armed:true. A *82 dial to an extension whose call is still
// RINGING the far end (no media yet) gets 486/no-media -- reporting armed:true
// there made the client believe it was ready and never re-arm once the call
// actually connected to voicemail. Wait this long for first inbound RTP.
const ARM_MEDIA_CONFIRM_MS = Number(env("EX_BARGE_ARM_MEDIA_CONFIRM_MS", "3500")) || 3500;

// An armed leg is only trustworthy for the call it joined. The arm key has NO
// session scope (monitorExt:code:agentExt), so the same agent's NEXT call maps
// to the same key — an old-but-alive leg could be reused and a voicemail
// streamed into the wrong call. Treat anything released, disposed, or older
// than this as stale: purge, never reuse.
const ARM_MAX_AGE_MS = Number(env("EX_BARGE_ARM_MAX_AGE_MS", "180000")) || 180000;
function armIsStale(arm) {
  if (!arm) return true;
  if (arm.released || arm.callSession?.disposed) return true;
  const createdMs = Date.parse(arm.createdAt || "") || 0;
  return Boolean(createdMs && Date.now() - createdMs > ARM_MAX_AGE_MS);
}

async function armBarge(softphone, { monitorExt, agentExtNumber, code }) {
  if (!softphone) throw new Error("no registered monitor softphone for this barge");
  const key = bargeArmKey(monitorExt, code, agentExtNumber);
  const existing = armedBarges.get(key);
  if (existing && !armIsStale(existing)) {
    existing.reused = true;
    return existing;
  }
  // Drop any stale/disposed/aged entry so it can't be reused or block the health loop.
  if (existing) armedBarges.delete(key);

  const dial = `${code}${agentExtNumber}`;
  const steps = [];
  const events = [];
  const { log, recordEvent } = buildRecorder("barge-arm", steps, events);

  log(`dialing ${dial}`);
  recordEvent("dial.start", { dial, monitorExt, agentExtNumber, code });
  const callSession = await dialWithTimeout(softphone, dial);
  const arm = {
    key,
    monitorExt,
    agentExtNumber,
    code,
    dial,
    callSession,
    sessionId: callSession.sessionId || null,
    partyId: callSession.partyId || null,
    inbound: 0,
    firstPt: null,
    steps,
    events,
    playing: false,
    released: false,
    createdAt: new Date().toISOString(),
    log,
    recordEvent,
  };
  armedBarges.set(key, arm);

  log(`call set up sessionId=${arm.sessionId || "?"} partyId=${arm.partyId || "?"}`);
  recordEvent("call.setup", { sessionId: arm.sessionId, partyId: arm.partyId });

  const onPkt = (pkt) => {
    arm.inbound += 1;
    if (arm.firstPt === null) {
      arm.firstPt = (pkt && pkt.header && pkt.header.payloadType);
      log(`first INBOUND rtp (payloadType=${arm.firstPt}) -> media path UP`);
      recordEvent("media.firstInboundRtp", { payloadType: arm.firstPt, inboundRtpSeen: arm.inbound });
    }
  };
  arm.onPkt = onPkt;
  try { callSession.on("audioPacket", onPkt); } catch {}
  try { callSession.on("rtpPacket", onPkt); } catch {}
  callSession.once("answered", (...args) => {
    log("event: answered");
    recordEvent("call.answered", { args: summarizeEventArgs(args) });
  });
  callSession.once("busy", (...args) => {
    log("event: busy (486) -- target unreachable/invalid");
    recordEvent("call.busy", { args: summarizeEventArgs(args) });
    // Unanswered/invalid target: tear the leg down and drop the arm so it can't leak.
    arm.released = true;
    arm.releasedAt = new Date().toISOString();
    try { callSession.hangup?.(); } catch {}
    armedBarges.delete(key);
  });
  callSession.once("disposed", (...args) => {
    arm.released = true;
    arm.releasedAt = new Date().toISOString();
    log(`event: disposed (inbound rtp seen=${arm.inbound})`);
    recordEvent("call.disposed", { inboundRtpSeen: arm.inbound, args: summarizeEventArgs(args) });
    armedBarges.delete(key);
  });

  return arm;
}

async function waitForArmedMedia(arm, mediaCapMs = 5000) {
  const start = Date.now();
  while (arm.firstPt === null && Date.now() - start < mediaCapMs && !arm.callSession?.disposed) {
    await sleep(25);
  }
  arm.log(`media ${arm.firstPt === null ? "NOT up after cap" : `up after ${Date.now() - start}ms`}`);
  arm.recordEvent("media.ready", {
    mediaUp: arm.firstPt !== null,
    payloadType: arm.firstPt,
    waitMs: Date.now() - start,
  });
}

async function playArmedBarge(arm, { wavPath, delayMs, trigger = "silence", silenceRms = 700, silenceHoldMs = 1200, minWaitMs = 1500, cueMaxWaitMs = 15000, waitForRelease = true }) {
  if (!arm) throw new Error("no armed barge leg");
  if (arm.released || arm.callSession?.disposed) throw new Error("armed barge leg is already released");
  if (arm.playing) throw new Error("armed barge leg is already playing");
  if (!wavPath) throw new Error("wavPath required");
  arm.playing = true;

  let buf;
  try {
    buf = fs.readFileSync(wavPath);
  } catch (e) {
    // Missing/unreadable WAV: never leave the leg armed-but-silent. Tear down + drop.
    arm.playing = false;
    try { await arm.callSession.hangup(); } catch {}
    arm.released = true;
    armedBarges.delete(arm.key);
    throw new Error(`voicemail file unreadable (${wavPath}): ${e.message}`);
  }
  arm.recordEvent("playback.loaded", { wavPath, bytes: buf.length });
  await waitForArmedMedia(arm);

  if (trigger === "silence") {
    arm.log(`waiting for play cue: silence>=${silenceHoldMs}ms after activity (rms<${silenceRms}, min ${minWaitMs}ms, max ${cueMaxWaitMs}ms)`);
    const cue = await waitForPlayCue(arm.callSession, { log: arm.log, silenceRms, silenceHoldMs, minWaitMs, maxWaitMs: cueMaxWaitMs });
    arm.recordEvent("playback.cue", { trigger, cue });
    if (cue === "disposed" || arm.callSession?.disposed || arm.released) {
      arm.playing = false;
      arm.released = true;
      arm.releasedAt = arm.releasedAt || new Date().toISOString();
      armedBarges.delete(arm.key);
      return {
        ok: true,
        armed: true,
        played: false,
        released: true,
        reason: "disposed-before-playback",
        inboundRtpSeen: arm.inbound,
        dial: arm.dial,
        sessionId: arm.sessionId,
        partyId: arm.partyId,
        steps: arm.steps,
        events: arm.events,
      };
    }
  } else {
    const settle = Number.isFinite(delayMs) ? delayMs : 700;
    arm.log(`fixed trigger: settling ${settle}ms before play`);
    await sleep(settle);
    arm.recordEvent("playback.cue", { trigger, delayMs: settle });
  }

  arm.log(`inbound rtp before stream: ${arm.inbound} -- starting paced send (${buf.length} bytes mulaw/8000)`);
  arm.recordEvent("playback.start", { inboundRtpSeen: arm.inbound, bytes: buf.length });
  const t0 = Date.now();
  const tailMs = 400;
  let releaseDone = null;
  const releasePromise = new Promise((resolve) => { releaseDone = resolve; });
  sendAudioPaced(arm.callSession, buf, {
    log: arm.log,
    onFinished: async () => {
      arm.recordEvent("playback.finished", { elapsedMs: Date.now() - t0, tailMs });
      await sleep(tailMs);
      try {
        await arm.callSession.hangup();
        arm.log("message done -> hung up armed barge leg; softphone stays REGISTERED (dormant, ready for next)");
        arm.released = true;
        arm.releasedAt = new Date().toISOString();
        arm.recordEvent("call.release.success", { releasedAt: arm.releasedAt });
      } catch (e) {
        arm.log(`hangup error: ${e && e.message}`);
        arm.releaseError = e && e.message;
        arm.recordEvent("call.release.error", { error: arm.releaseError });
      } finally {
        armedBarges.delete(arm.key);
        if (releaseDone) releaseDone();
      }
    },
  });

  if (waitForRelease) {
    // Never await the release forever: if sendAudioPaced never reports finished or the
    // leg never disposes, force a hangup + release at the hard cap so the handler returns.
    let capTimer = null;
    const cap = new Promise((resolve) => {
      capTimer = setTimeout(async () => {
        if (!arm.released) {
          arm.log(`play hard-cap ${PLAY_HARD_CAP_MS}ms hit -> forcing hangup`);
          try { await arm.callSession.hangup(); } catch {}
          arm.released = true;
          arm.releasedAt = new Date().toISOString();
          armedBarges.delete(arm.key);
          if (releaseDone) releaseDone();
        }
        resolve();
      }, PLAY_HARD_CAP_MS);
    });
    await Promise.race([releasePromise, cap]);
    if (capTimer) clearTimeout(capTimer);
  } else {
    await sleep(1500);
  }

  return {
    ok: true,
    armed: true,
    played: true,
    released: Boolean(arm.released),
    releasedAt: arm.releasedAt || null,
    inboundRtpSeen: arm.inbound,
    dial: arm.dial,
    sessionId: arm.sessionId,
    partyId: arm.partyId,
    steps: arm.steps,
    events: arm.events,
  };
}

async function releaseArmedBarge(arm, reason = "release-request") {
  if (!arm) return { ok: true, released: false, reason: "not-armed" };
  if (arm.released || arm.callSession?.disposed) {
    armedBarges.delete(arm.key);
    return { ok: true, released: false, reason: "already-released", arm: summarizeArmedBarge(arm) };
  }
  try {
    arm.recordEvent("call.release.request", { reason });
    await arm.callSession.hangup();
    arm.released = true;
    arm.releasedAt = new Date().toISOString();
    return { ok: true, released: true, reason, arm: summarizeArmedBarge(arm) };
  } catch (e) {
    return { ok: false, released: false, reason, error: e && e.message, arm: summarizeArmedBarge(arm) };
  } finally {
    // Always drop the entry -- even if hangup threw -- so a failed release can't leak/stale-reuse.
    armedBarges.delete(arm.key);
  }
}

// Wait for the moment to start talking: watch inbound audio energy and fire once the
// far end (the machine's greeting + beep) has gone SILENT for silenceHoldMs after we
// actually heard activity. minWaitMs floors it (ignore the connect gap); maxWaitMs is
// the safety fallback (play anyway if it never goes quiet).
async function waitForPlayCue(callSession, { log, silenceRms = 700, silenceHoldMs = 1200, minWaitMs = 1500, maxWaitMs = 15000 } = {}) {
  let lastVoiceTs = 0;
  let sawActivity = false;
  let peak = 0;
  const start = Date.now();
  const onAudio = (pkt) => {
    const rms = muLawRms(pkt && pkt.payload);
    if (rms > peak) peak = rms;
    if (rms >= silenceRms) { lastVoiceTs = Date.now(); sawActivity = true; }
  };
  callSession.on("audioPacket", onAudio);
  try {
    for (;;) {
      const now = Date.now();
      const elapsed = now - start;
      if (callSession.disposed) return "disposed";
      if (elapsed >= maxWaitMs) { if (log) log(`play cue: maxWait ${maxWaitMs}ms hit (sawActivity=${sawActivity} peakRms=${Math.round(peak)}) -> play anyway`); return "timeout"; }
      if (elapsed >= minWaitMs && sawActivity && lastVoiceTs && now - lastVoiceTs >= silenceHoldMs) {
        if (log) log(`play cue: ${now - lastVoiceTs}ms of silence after activity (peakRms=${Math.round(peak)}) -> play (elapsed ${elapsed}ms)`);
        return "silence";
      }
      await sleep(40);
    }
  } finally {
    try { (callSession.off || callSession.removeListener).call(callSession, "audioPacket", onAudio); } catch {}
  }
}

async function barge(softphone, { agentExtNumber, code, wavPath, delayMs, trigger = "silence", silenceRms = 700, silenceHoldMs = 1200, minWaitMs = 1500, cueMaxWaitMs = 15000, waitForRelease = true }) {
  if (!softphone) throw new Error("no registered monitor softphone for this barge");
  const _entry = entryForSoftphone(softphone);
  if (_entry) _entry.lastBargeAt = Date.now(); // keep the health loop from re-warming mid-drop
  const dial = `${code}${agentExtNumber}`; // *82101 (barge) | *81101 (whisper)
  const steps = [];
  const events = [];
  const log = (m) => { steps.push(m); console.log(`[barge] ${m}`); };
  const recordEvent = (type, extra = {}) => {
    const event = { type, at: new Date().toISOString(), ...extra };
    events.push(event);
    console.log(`[barge:event] ${JSON.stringify(event)}`);
    return event;
  };

  log(`dialing ${dial}`);
  recordEvent("dial.start", { dial });
  const callSession = await dialWithTimeout(softphone, dial);
  log(`call set up sessionId=${callSession.sessionId || "?"} partyId=${callSession.partyId || "?"}`);
  recordEvent("call.setup", {
    sessionId: callSession.sessionId || null,
    partyId: callSession.partyId || null,
  });

  // Is media actually flowing on this leg? If we RECEIVE inbound RTP, the path is up and our
  // outbound streamAudio should be heard. Zero inbound = the barge leg has no media (the real bug).
  let inbound = 0;
  let firstPt = null;
  const onPkt = (pkt) => {
    inbound += 1;
    if (firstPt === null) {
      firstPt = (pkt && pkt.header && pkt.header.payloadType);
      log(`first INBOUND rtp (payloadType=${firstPt}) -> media path UP`);
      recordEvent("media.firstInboundRtp", { payloadType: firstPt, inboundRtpSeen: inbound });
    }
  };
  try { callSession.on("audioPacket", onPkt); } catch {}
  try { callSession.on("rtpPacket", onPkt); } catch {}
  callSession.once("answered", (...args) => {
    log("event: answered");
    recordEvent("call.answered", { args: summarizeEventArgs(args) });
  });
  callSession.once("busy", (...args) => {
    log("event: busy (486) -- target unreachable/invalid");
    recordEvent("call.busy", { args: summarizeEventArgs(args) });
    try { callSession.hangup?.(); } catch {}
  });
  callSession.once("disposed", (...args) => {
    log(`event: disposed (inbound rtp seen=${inbound})`);
    recordEvent("call.disposed", {
      inboundRtpSeen: inbound,
      args: summarizeEventArgs(args),
    });
  });

  const result = { ok: true, dial, sessionId: callSession.sessionId || null, partyId: callSession.partyId || null, played: false, steps, events };

  if (wavPath) {
    let buf;
    try {
      buf = fs.readFileSync(wavPath);
    } catch (e) {
      // Missing/unreadable WAV: tear down the leg instead of leaving it open on the agent.
      try { await callSession.hangup(); } catch {}
      throw new Error(`voicemail file unreadable (${wavPath}): ${e.message}`);
    }
    recordEvent("playback.loaded", { wavPath, bytes: buf.length });
    // 1) Wait for the media path to actually come up (first inbound RTP).
    const mediaCapMs = 5000;
    const mStart = Date.now();
    while (firstPt === null && Date.now() - mStart < mediaCapMs) await sleep(25);
    log(`media ${firstPt === null ? "NOT up after cap" : `up after ${Date.now() - mStart}ms`}`);
    recordEvent("media.ready", { mediaUp: firstPt !== null, payloadType: firstPt, waitMs: Date.now() - mStart });

    // 2) Decide WHEN to start talking.
    if (trigger === "silence") {
      log(`waiting for play cue: silence>=${silenceHoldMs}ms after activity (rms<${silenceRms}, min ${minWaitMs}ms, max ${cueMaxWaitMs}ms)`);
      const cue = await waitForPlayCue(callSession, { log, silenceRms, silenceHoldMs, minWaitMs, maxWaitMs: cueMaxWaitMs });
      recordEvent("playback.cue", { trigger, cue });
      if (cue === "disposed" || callSession.disposed) {
        result.released = true;
        result.releasedAt = result.releasedAt || new Date().toISOString();
        result.reason = "disposed-before-playback";
        return result;
      }
    } else {
      const settle = Number.isFinite(delayMs) ? delayMs : 700;
      log(`fixed trigger: settling ${settle}ms before play`);
      await sleep(settle);
      recordEvent("playback.cue", { trigger, delayMs: settle });
    }
    log(`inbound rtp before stream: ${inbound} -- starting paced send (${buf.length} bytes mulaw/8000)`);
    recordEvent("playback.start", { inboundRtpSeen: inbound, bytes: buf.length });
    const t0 = Date.now();
    // Use our catch-up-paced sender instead of callSession.streamAudio(): the SDK's
    // setTimeout(20) loop under-delivers on Windows (~31ms/packet) and starves the
    // receiver. sendAudioPaced() keeps a constant lead so cadence stays realtime.
    const tailMs = 400; // let the last frames drain before we send BYE
    let releaseDone = null;
    const releasePromise = new Promise((resolve) => { releaseDone = resolve; });
    const streamHandle = sendAudioPaced(callSession, buf, {
      log,
      onFinished: async () => {
        recordEvent("playback.finished", { elapsedMs: Date.now() - t0, tailMs });
        await sleep(tailMs);
        try {
          await callSession.hangup();
          log("message done -> hung up barge leg; softphone stays REGISTERED (dormant, ready for next)");
          result.released = true;
          result.releasedAt = new Date().toISOString();
          recordEvent("call.release.success", { releasedAt: result.releasedAt });
        } catch (e) {
          log(`hangup error: ${e && e.message}`);
          result.releaseError = e && e.message;
          recordEvent("call.release.error", { error: result.releaseError });
        } finally {
          if (releaseDone) releaseDone();
        }
      },
    });
    void streamHandle; // (could .stop() on demand; left running to completion here)
    result.played = true;
    if (waitForRelease) {
      // Hard cap so a never-finishing send / non-disposing leg can't hang the handler.
      let capTimer = null;
      const cap = new Promise((resolve) => {
        capTimer = setTimeout(async () => {
          if (!result.released) {
            log(`play hard-cap ${PLAY_HARD_CAP_MS}ms hit -> forcing hangup`);
            try { await callSession.hangup(); } catch {}
            result.released = true;
            result.releasedAt = new Date().toISOString();
          }
          if (releaseDone) releaseDone();
          resolve();
        }, PLAY_HARD_CAP_MS);
      });
      await Promise.race([releasePromise, cap]);
      if (capTimer) clearTimeout(capTimer);
    } else {
      // Let it run briefly; don't block the response. Capture media evidence for the report.
      await sleep(1500);
    }
    result.inboundRtpSeen = inbound;
  }
  recordEvent("barge.result", {
    played: Boolean(result.played),
    released: Boolean(result.released),
    inboundRtpSeen: inbound,
  });
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const port = Number(readFlag(argv, "--port", env("EX_BARGE_PORT", "7335"))) || 7335;
  const supervisorExtNumber = readFlag(argv, "--supervisor-ext", env("EX_LIVE_MONITOR_SUPERVISOR_EXT", "987"));
  const agentExtDefault = readFlag(argv, "--agent-ext", env("EX_LIVE_MONITOR_AGENT_EXT", "101"));
  const deviceId = readFlag(argv, "--supervisor-device-id", env("EX_LIVE_MONITOR_SUPERVISOR_DEVICE_ID", ""));
  const region = readFlag(argv, "--proxy-region", "NA");
  const wavDefault = readFlag(argv, "--wav", env("EX_BARGE_WAV", ""));
  const triggerDefault = readFlag(argv, "--trigger", env("EX_BARGE_TRIGGER", "silence")); // silence | fixed
  const silenceRmsDefault = Number(readFlag(argv, "--silence-rms", env("EX_BARGE_SILENCE_RMS", "700")));
  const silenceHoldDefault = Number(readFlag(argv, "--silence-hold-ms", env("EX_BARGE_SILENCE_HOLD_MS", "1200")));
  const minWaitDefault = Number(readFlag(argv, "--min-wait-ms", env("EX_BARGE_MIN_WAIT_MS", "1500")));
  const cueMaxWaitDefault = Number(readFlag(argv, "--cue-max-wait-ms", env("EX_BARGE_CUE_MAX_WAIT_MS", "15000")));

  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/barge") {
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", async () => {
        let o = {}; try { o = raw ? JSON.parse(raw) : {}; } catch {}
        const monitorExt = String(o.monitorExt || defaultMonitorExt || supervisorExtNumber).trim();
        const params = {
          agentExtNumber: String(o.agentExt || agentExtDefault).trim(),
          code: o.code === "*81" ? "*81" : "*82",
          wavPath: (o.wav != null ? String(o.wav) : wavDefault).trim() || null,
          delayMs: Number.isFinite(Number(o.delayMs)) && o.delayMs !== "" ? Number(o.delayMs) : undefined,
          trigger: o.trigger === "fixed" || o.trigger === "silence" ? o.trigger : triggerDefault,
          silenceRms: Number.isFinite(Number(o.silenceRms)) && o.silenceRms !== "" ? Number(o.silenceRms) : silenceRmsDefault,
          silenceHoldMs: Number.isFinite(Number(o.silenceHoldMs)) && o.silenceHoldMs !== "" ? Number(o.silenceHoldMs) : silenceHoldDefault,
          minWaitMs: Number.isFinite(Number(o.minWaitMs)) && o.minWaitMs !== "" ? Number(o.minWaitMs) : minWaitDefault,
          cueMaxWaitMs: Number.isFinite(Number(o.cueMaxWaitMs)) && o.cueMaxWaitMs !== "" ? Number(o.cueMaxWaitMs) : cueMaxWaitDefault,
          waitForRelease: o.waitForRelease !== false,
        };
        try {
          const sp = await getMonitorSoftphone(monitorExt, { region });
          const r = await barge(sp, params);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ monitorExt, ...r }, null, 2));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message, monitorExt, ...params }, null, 2));
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/warm") {
      // Register a monitor softphone WITHOUT dialing (no *82, no beep). Called at
      // agent login so the first barge press skips the registration latency.
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", async () => {
        let o = {}; try { o = raw ? JSON.parse(raw) : {}; } catch {}
        const monitorExt = String(o.monitorExt || "").trim();
        try {
          if (!monitorExt) throw new Error("monitorExt required");
          await getMonitorSoftphone(monitorExt, { region });
          const entry = monitors.get(monitorExt);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, monitorExt, registered: Boolean(entry?.registered), deviceId: entry?.meta?.deviceId || null }, null, 2));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, monitorExt, error: e.message }, null, 2));
        }
      });
      return;
    }
    if (req.method === "POST" && (req.url === "/arm" || req.url === "/play" || req.url === "/release")) {
      let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on("end", async () => {
        let o = {}; try { o = raw ? JSON.parse(raw) : {}; } catch {}
        const monitorExt = String(o.monitorExt || defaultMonitorExt || supervisorExtNumber).trim();
        const agentExtNumber = String(o.agentExt || agentExtDefault).trim();
        const code = o.code === "*81" ? "*81" : "*82";
        const key = bargeArmKey(monitorExt, code, agentExtNumber);
        try {
          if (req.url === "/arm") {
            const sp = await getMonitorSoftphone(monitorExt, { region });
            const arm = await armBarge(sp, { monitorExt, agentExtNumber, code });
            // Only report armed:true once the *82 leg has joined a CONNECTED call
            // (first inbound RTP). A reused live arm already has media; a fresh dial
            // into a still-ringing target gets 486/no-media -- tear that dead leg
            // down so it can't be falsely reused, and tell the caller to retry.
            await waitForArmedMedia(arm, ARM_MEDIA_CONFIRM_MS);
            const mediaUp = arm.firstPt !== null && !arm.released && !arm.callSession?.disposed;
            if (!mediaUp && !arm.reused) {
              try { arm.callSession?.hangup?.(); } catch {}
              if (!arm.released) { arm.released = true; arm.releasedAt = new Date().toISOString(); }
              armedBarges.delete(arm.key);
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
              ok: true,
              armed: mediaUp,
              reused: Boolean(arm.reused),
              arm: summarizeArmedBarge(arm),
            }, null, 2));
            return;
          }

          if (req.url === "/release") {
            const released = await releaseArmedBarge(armedBarges.get(key), String(o.reason || "release-request"));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ monitorExt, key, ...released }, null, 2));
            return;
          }

          const params = {
            wavPath: (o.wav != null ? String(o.wav) : wavDefault).trim() || null,
            delayMs: Number.isFinite(Number(o.delayMs)) && o.delayMs !== "" ? Number(o.delayMs) : undefined,
            trigger: o.trigger === "fixed" || o.trigger === "silence" ? o.trigger : triggerDefault,
            silenceRms: Number.isFinite(Number(o.silenceRms)) && o.silenceRms !== "" ? Number(o.silenceRms) : silenceRmsDefault,
            silenceHoldMs: Number.isFinite(Number(o.silenceHoldMs)) && o.silenceHoldMs !== "" ? Number(o.silenceHoldMs) : silenceHoldDefault,
            minWaitMs: Number.isFinite(Number(o.minWaitMs)) && o.minWaitMs !== "" ? Number(o.minWaitMs) : minWaitDefault,
            cueMaxWaitMs: Number.isFinite(Number(o.cueMaxWaitMs)) && o.cueMaxWaitMs !== "" ? Number(o.cueMaxWaitMs) : cueMaxWaitDefault,
            waitForRelease: o.waitForRelease !== false,
          };
          const requireArmed = o.requireArmed === true || String(o.requireArmed || "").toLowerCase() === "true";
          const armWaitMs = boundedMs(o.armWaitMs, requireArmed ? 2000 : 0, { min: 0, max: 15000 });
          let arm = armedBarges.get(key) || (requireArmed ? await waitForArmedBarge(key, armWaitMs) : null);
          // Never play through a stale leg: released, disposed, or older than
          // ARM_MAX_AGE_MS means it joined a PREVIOUS call — purge and fall to
          // the one-shot barge (or arm-not-ready when requireArmed).
          if (arm && armIsStale(arm)) {
            armedBarges.delete(key);
            arm = null;
          }
          if (!arm) {
            if (requireArmed) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({
                ok: false,
                error: `armed barge leg not ready after ${armWaitMs}ms`,
                reason: "arm-not-ready",
                monitorExt,
                key,
                agentExtNumber,
                code,
                requireArmed: true,
                armWaitMs,
                armed: monitorsStatus().armed,
              }, null, 2));
              return;
            }
            const sp = await getMonitorSoftphone(monitorExt, { region });
            const r = await barge(sp, { agentExtNumber, code, ...params });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ monitorExt, key, fallbackOneShot: true, ...r }, null, 2));
            return;
          }

          const result = await playArmedBarge(arm, params);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ monitorExt, key, ...result }, null, 2));
        } catch (e) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: e.message, monitorExt, key, agentExtNumber, code }, null, 2));
        }
      });
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(monitorsStatus(), null, 2));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html({ supervisorExtNumber, agentExtDefault, wavDefault }));
  });

  // Optional pre-warm list of monitor extensions (so production starts with all
  // bargers registered, no first-click latency). e.g. --monitors 987,1101,1102
  const warmList = readFlag(argv, "--monitors", env("EX_BARGE_MONITORS", ""))
    .split(",").map((s) => s.trim()).filter(Boolean);

  server.listen(port, "127.0.0.1", async () => {
    console.log(`EX barge button: http://127.0.0.1:${port}/`);
    defaultMonitorExt = String(supervisorExtNumber).trim();
    // WARM-AT-BOOT GATE: the monitor extensions' SIP registrations are owned
    // by the VM ANSWERER fleet in disposition mode — a barge warm pool that
    // registers the SAME OtherPhone devices steals the contact binding from
    // the answerer (most recent REGISTER wins) and inbound drops ring a
    // service that cannot answer them. Barge is the legacy fallback: with
    // warm-at-boot off, monitors register ON DEMAND at first barge use
    // (getMonitorSoftphone → registerMonitor) and the health loop maintains
    // only what's actually in use.
    const warmAtBoot = !["0", "false", "no", "off"].includes(String(env("EX_BARGE_WARM_AT_BOOT", "true")).trim().toLowerCase());
    if (warmAtBoot) {
      const toRegister = Array.from(new Set([defaultMonitorExt, ...warmList]));
      console.log(`  registering monitor softphone(s): ${toRegister.join(", ")} ...`);
      for (const m of toRegister) {
        try {
          await registerMonitor(m, { deviceId: m === defaultMonitorExt ? deviceId : "", region });
        } catch (e) {
          console.error(`  monitor ${m} registration error: ${e.message}`);
        }
      }
      const ok = monitorsStatus().monitors.filter((x) => x.registered).map((x) => x.ext);
      console.log(`  ready: monitors registered=[${ok.join(",")}]  default=${defaultMonitorExt}`);
    } else {
      console.log(`  warm-at-boot OFF (EX_BARGE_WARM_AT_BOOT=false): monitors register on demand; answerer fleet owns the registrations`);
    }
    startMonitorHealthLoop({ region }); // self-heal dropped registrations while idle
    console.log(`  health loop: re-warm downed monitors every ${env("EX_BARGE_HEALTH_MS", "30000")}ms`);
  });

  // Graceful shutdown: hang up any in-flight barge legs and revoke softphone
  // registrations so a restart never orphans a *82 leg on an agent's live call.
  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${sig}: hanging up ${armedBarges.size} armed leg(s), revoking ${monitors.size} monitor(s)`);
    for (const arm of armedBarges.values()) { try { arm.callSession?.hangup?.(); } catch {} }
    for (const e of monitors.values()) { try { e.softphone?.revoke?.(); } catch {} }
    try { server.close(); } catch {}
    setTimeout(() => process.exit(0), 600);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function html({ supervisorExtNumber, agentExtDefault, wavDefault }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>EX Barge</title>
<style>
  :root { color-scheme: dark; font-family: Inter, "Segoe UI", Arial, sans-serif; background:#0b0f14; color:#e6edf3; }
  body { margin:0; display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { width:600px; max-width:94vw; background:#0f151d; border:1px solid #26313d; border-radius:12px; padding:22px; }
  h1 { font-size:16px; margin:0 0 4px; } .sub { color:#7d8590; font-size:11.5px; margin-bottom:14px; }
  .row { display:flex; gap:10px; margin-bottom:12px; }
  label { font-size:11px; color:#9da7b3; display:block; margin-bottom:4px; text-transform:uppercase; letter-spacing:.04em; }
  input, select { width:100%; background:#111923; color:#e6edf3; border:1px solid #2c3a48; border-radius:7px; padding:8px 9px; font-size:13px; }
  button { width:100%; padding:13px; font-size:15px; font-weight:700; border:0; border-radius:9px; background:#f78166; color:#190a06; cursor:pointer; }
  button:disabled { opacity:.6; cursor:wait; }
  pre { margin-top:14px; background:#0b1118; border:1px solid #24303b; border-radius:8px; padding:11px; font-size:11.5px; white-space:pre-wrap; max-height:46vh; overflow:auto; color:#9da7b3; }
  .ok { color:#3fb950; } .err { color:#f85149; }
  #reg { font-size:11px; }
</style></head><body>
<div class="card">
  <h1>Barge monitor into agent call</h1>
  <div class="sub">supervisor ext ${supervisorExtNumber} dials a star code into the agent's live call. *82 = barge (all hear), *81 = whisper (agent only).</div>
  <div id="reg" class="sub">checking softphone registration...</div>
  <div class="row">
    <div style="flex:1"><label>Agent ext</label><input id="agent" value="${agentExtDefault}"/></div>
    <div style="flex:1"><label>Code</label><select id="code"><option value="*82">*82 Barge</option><option value="*81">*81 Whisper</option></select></div>
    <div style="flex:2"><label>WAV (raw PCMU/8000, optional)</label><input id="wav" value="${wavDefault}" placeholder="leave blank = just barge (silent)"/></div>
  </div>
  <button id="go" type="button">Barge in</button>
  <pre id="out">Ready once the softphone is registered. Start a live call on the agent ext, then click.</pre>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  fetch("/status").then((r)=>r.json()).then((s)=>{ $("reg").innerHTML = s.registered ? '<span class="ok">softphone registered</span> (device '+s.monitorMeta.deviceId+')' : '<span class="err">softphone NOT registered</span> '+(s.regError||''); });
  $("go").addEventListener("click", async () => {
    const b = $("go"), out = $("out"); b.disabled = true; out.textContent = "Barging...";
    try {
      const r = await fetch("/barge", { method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({ agentExt: $("agent").value, code: $("code").value, wav: $("wav").value }) });
      const j = await r.json();
      out.innerHTML = (j.ok ? '<span class="ok">BARGED</span>' : '<span class="err">FAILED</span>') + "\\n\\n" + JSON.stringify(j, null, 2);
    } catch (e) { out.innerHTML = '<span class="err">ERROR</span>\\n' + (e && e.message); }
    finally { b.disabled = false; }
  });
</script></body></html>`;
}

if (require.main === module) main();
module.exports = { barge };
