"use strict";

// FAC-based headless monitor capture (the no-REST-supervise path).
//
// The REST supervise API requires the API caller to OWN the supervisor device
// (TAS-120 otherwise), and our JWT authenticates as the agent being monitored.
// This variant sidesteps REST entirely: the headless softphone registered on a
// monitor extension DIALS the RingCentral Monitoring feature access code
// (*80 + agent extension) like a human supervisor would, and captures whatever
// audio comes back - monitoring audio on success, or the rejection announcement
// if the Monitoring group is not configured (also informative: it proves the
// audio path and names the blocker).
//
//   node scripts/rc-ex-fac-monitor-capture.js --sup-ext 1102 --agent-ext 101 --timeout-sec 45
//   node scripts/rc-ex-fac-monitor-capture.js --sup-ext 1102 --dial "*80101"   # explicit dial string
//
// Output: raw PCMU/8000 capture + a per-second energy timeline and a machine
// verdict (AUDIO / SILENT). Play back with: ffplay -f mulaw -ar 8000 <file>

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

function energyEnvelope(pcmuBuffer) {
  const seconds = Math.floor(pcmuBuffer.length / SAMPLE_RATE);
  const envelope = [];
  for (let s = 0; s < seconds; s += 1) {
    let totalAbs = 0;
    let maxAbs = 0;
    const base = s * SAMPLE_RATE;
    for (let i = 0; i < SAMPLE_RATE; i += 1) {
      const abs = Math.abs(ulawToLinearSample(pcmuBuffer[base + i]));
      totalAbs += abs;
      if (abs > maxAbs) maxAbs = abs;
    }
    envelope.push({ mean: Math.round(totalAbs / SAMPLE_RATE), max: maxAbs });
  }
  return envelope;
}

function envelopeBar(envelope) {
  const glyphs = " .:-=+*#";
  return envelope.map((row) => {
    const level = Math.min(glyphs.length - 1, Math.floor((row.mean / 2000) * (glyphs.length - 1)));
    return glyphs[level];
  }).join("");
}

async function rcAccessToken() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RING_CENTRAL_JWT_TOKEN,
  });
  const basic = Buffer.from(
    `${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`,
  ).toString("base64");
  const response = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`RC OAuth failed: ${response.status}`);
  return json.access_token;
}

async function rcGet(token, endpoint) {
  const response = await fetch(`${RC_BASE}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await response.json();
  if (!response.ok) throw new Error(`GET ${endpoint} failed: ${response.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function resolveExtension(token, extensionNumber) {
  for (let page = 1; page <= 20; page += 1) {
    const data = await rcGet(token, `/restapi/v1.0/account/~/extension?perPage=200&page=${page}`);
    const records = Array.isArray(data?.records) ? data.records : [];
    const hit = records.find((record) => String(record.extensionNumber || "") === String(extensionNumber));
    if (hit) return hit;
    if (records.length < 200) break;
  }
  return null;
}

function pickProxy(sipInfo, region = "NA") {
  const proxies = Array.isArray(sipInfo?.outboundProxies) ? sipInfo.outboundProxies : [];
  const desired = String(region || "NA").trim().toUpperCase();
  const hit = proxies.find((proxy) => String(proxy.region || "").toUpperCase() === desired && proxy.proxyTLS)
    || proxies.find((proxy) => proxy.proxyTLS)
    || null;
  if (!hit?.proxyTLS) return "sip10.ringcentral.com:5096";
  return hit.proxyTLS;
}

async function main() {
  const argv = process.argv.slice(2);
  const supExtNumber = readFlag(argv, "--sup-ext", "1102");
  const agentExtNumber = readFlag(argv, "--agent-ext", "101");
  const requestedDeviceId = readFlag(argv, "--device-id", "");
  const fac = readFlag(argv, "--fac", "*80");
  const dial = readFlag(argv, "--dial", `${fac}${agentExtNumber}`);
  const timeoutSec = Math.max(15, Math.min(600, Number(readFlag(argv, "--timeout-sec", "45")) || 45));
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ex-monitor-captures")));

  fs.mkdirSync(outDir, { recursive: true });

  const token = await rcAccessToken();
  const supExt = await resolveExtension(token, supExtNumber);
  if (!supExt) throw new Error(`Could not resolve supervisor extension ${supExtNumber}`);

  const devices = await rcGet(token, `/restapi/v1.0/account/~/extension/${supExt.id}/device`);
  const deviceRows = (Array.isArray(devices?.records) ? devices.records : []).filter((row) => row.type !== "WebRTC");
  const device = requestedDeviceId
    ? deviceRows.find((row) => String(row.id) === String(requestedDeviceId))
    : deviceRows[0];
  if (!device?.id) throw new Error(`No SIP-registrable (non-WebRTC) device on extension ${supExtNumber}`);

  const sipInfo = await rcGet(token, `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
  const softphone = new Softphone({
    domain: sipInfo.domain,
    outboundProxy: pickProxy(sipInfo),
    username: sipInfo.userName,
    password: sipInfo.password,
    authorizationId: sipInfo.authorizationId,
    codec: "PCMU/8000",
  });

  console.log("FAC headless monitor capture");
  console.log(`  supervisor: ${supExt.name} ext=${supExt.extensionNumber} device=${device.id}`);
  console.log(`  dialing:    ${dial}  (monitor FAC toward ext ${agentExtNumber})`);
  console.log(`  window:     ${timeoutSec}s`);

  await softphone.register();
  console.log("[register] headless monitor phone registered");

  const outputPath = path.join(outDir, `ex-fac-monitor-${timestampForFile()}.pcmu`);
  const writeStream = fs.createWriteStream(outputPath, { flags: "a" });
  let packetCount = 0;
  let byteCount = 0;

  const callSession = await softphone.call(dial);
  console.log(`[dial] outbound FAC call placed to ${dial}`);
  callSession.on("audioPacket", (rtpPacket) => {
    packetCount += 1;
    byteCount += rtpPacket.payload.length;
    writeStream.write(rtpPacket.payload);
    if (packetCount % 250 === 0) console.log(`[audio] packets=${packetCount} bytes=${byteCount}`);
  });
  let disposed = false;
  callSession.once("disposed", () => { disposed = true; });

  const stopAt = Date.now() + timeoutSec * 1000;
  while (Date.now() < stopAt && !disposed) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!disposed) {
    console.log("[timeout] hanging up FAC monitor call");
    await callSession.hangup().catch((error) => console.error(`[timeout] hangup failed: ${error.message}`));
  } else {
    console.log("[done] far end disposed the call (rejection or hangup)");
  }
  writeStream.end();
  softphone.revoke();

  const buffer = fs.readFileSync(outputPath);
  const envelope = energyEnvelope(buffer);
  const activeSeconds = envelope.filter((row) => row.mean >= ACTIVE_MEAN_ABS).length;
  const maxOverall = envelope.reduce((max, row) => Math.max(max, row.max), 0);
  console.log(JSON.stringify({
    verdict: packetCount === 0 ? "NO_RTP" : (activeSeconds >= 1 || maxOverall >= 1000 ? "AUDIO" : "SILENT"),
    packets: packetCount,
    bytes: byteCount,
    seconds: envelope.length,
    activeSeconds,
    maxSample: maxOverall,
    timeline: envelopeBar(envelope),
    outputPath,
    note: "AUDIO = monitoring (or an announcement - transcribe/play to confirm which); NO_RTP = call never carried media (FAC likely rejected pre-answer)",
  }, null, 2));
}

// Force exit: softphone SIP keepalive timers otherwise keep this process (and
// its live monitor call) alive indefinitely after revoke().
main().then(() => process.exit(0)).catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
