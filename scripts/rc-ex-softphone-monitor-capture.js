"use strict";

// Headless RingEX monitor capture.
//
// This is the EX workaround for live CX transcription:
//   1. register a RingCentral "Existing Phone" device as a headless SIP phone
//   2. optionally ask RingEX Supervision API to listen to an agent's live call
//   3. auto-answer the supervision call
//   4. write incoming audio packets to a raw PCMU/8000 file
//
// The raw output is intentionally PCMU/8000 because OpenAI Realtime
// transcription accepts G.711 u-law directly as audio/pcmu, so the
// next step can stream these packets without transcoding.
//
// Default dry-ish usage: register and wait for a manually started monitor call.
//   node scripts/rc-ex-softphone-monitor-capture.js --supervisor-ext 3202
//
// During a live Mickey EX/CX call, attach automatically:
//   node scripts/rc-ex-softphone-monitor-capture.js --agent-ext 101 --supervisor-ext 3202 --supervise
//
// Important: do not use Matt's real device for production. Reusing an
// Existing Phone's SIP credentials can steal that device's inbound audio
// path while the script is running. For production, create a dedicated
// "AI Monitor" extension/device and use that device id here.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const Softphone = require("ringcentral-softphone");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
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

function summarizeDevice(device = {}) {
  return {
    id: String(device.id || ""),
    type: device.type || null,
    name: device.name || null,
    status: device.status || null,
    lines: Array.isArray(device.phoneLines)
      ? device.phoneLines.map((line) => ({
        lineType: line.lineType || null,
        phoneNumber: maskPhone(line.phoneInfo?.phoneNumber),
        usageType: line.phoneInfo?.usageType || null,
      }))
      : [],
  };
}

function pickSupervisorDevice(devices, requestedId = "") {
  if (requestedId) {
    return devices.find((device) => String(device.id) === String(requestedId)) || null;
  }
  return devices.find((device) => device.status === "Online" && device.type === "HardPhone")
    || devices.find((device) => device.status === "Online")
    || devices[0]
    || null;
}

function pickActiveCall(records, mode = "first") {
  const candidates = records.filter((record) => record.telephonySessionId);
  const source = candidates.length ? candidates : records;
  if (mode === "newest") {
    return [...source].sort((a, b) => {
      const bt = Date.parse(b.startTime || b.creationTime || b.enqueueTime || "") || 0;
      const at = Date.parse(a.startTime || a.creationTime || a.enqueueTime || "") || 0;
      return bt - at;
    })[0] || null;
  }
  return source.find((record) => String(record.result || "").toLowerCase() === "in progress")
    || source[0]
    || null;
}

function pickParty(session, agentExtensionId, mode = "remote") {
  const parties = Array.isArray(session?.parties) ? session.parties : [];
  const active = parties.filter((party) => {
    const code = String(party.status?.code || party.status || "").toLowerCase();
    return code && !["disconnected", "gone"].includes(code);
  });
  const agentId = String(agentExtensionId || "");
  if (mode === "agent") {
    return active.find((party) => String(party.extensionId || party.owner?.extensionId || "") === agentId)
      || active.find((party) => String(party.from?.extensionId || "") === agentId)
      || active.find((party) => String(party.to?.extensionId || "") === agentId && party.to?.deviceId)
      || null;
  }
  if (mode === "remote" || mode === "client" || mode === "customer") {
    return active.find((party) => String(party.extensionId || party.owner?.extensionId || "") !== agentId)
      || active.find((party) => String(party.from?.extensionId || "") !== agentId)
      || active[0]
      || null;
  }
  return active.find((party) => String(party.id || "") === String(mode)) || null;
}

async function pickActiveCallWithLiveAgentParty(records, {
  lookupToken,
  agentExtensionId,
  preferredMode = "first",
}) {
  const source = records.filter((record) => record.telephonySessionId);
  const sorted = [...source].sort((a, b) => {
    const bt = Date.parse(b.startTime || b.creationTime || b.enqueueTime || "") || 0;
    const at = Date.parse(a.startTime || a.creationTime || a.enqueueTime || "") || 0;
    return preferredMode === "newest" ? bt - at : at - bt;
  });
  for (const record of sorted) {
    try {
      const session = await rcRequest(
        lookupToken,
        "GET",
        `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(record.telephonySessionId)}`,
      );
      const party = pickParty(session, agentExtensionId, "agent");
      if (party?.id) return { call: record, session, agentParty: party };
    } catch {
      // Keep scanning; active-calls can include stale sessions.
    }
  }
  return { call: pickActiveCall(records, preferredMode), session: null, agentParty: null };
}

function summarizePartyForLog(party = {}) {
  return {
    id: party.id || null,
    status: party.status?.code || party.status || null,
    direction: party.direction || null,
    extensionId: party.extensionId || party.owner?.extensionId || null,
    from: {
      name: party.from?.name || null,
      phoneNumber: maskPhone(party.from?.phoneNumber),
      extensionId: party.from?.extensionId || null,
    },
    to: {
      name: party.to?.name || null,
      phoneNumber: maskPhone(party.to?.phoneNumber),
      extensionId: party.to?.extensionId || null,
    },
  };
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

function summarizeRtpExtension(extension = {}) {
  return {
    id: extension.id,
    bytes: extension.payload ? Buffer.from(extension.payload).toString("hex") : "",
  };
}

function updateRtpStats(statsBySsrc, rtpPacket, packetNumber) {
  const header = rtpPacket.header || {};
  const key = String(header.ssrc ?? "unknown");
  let row = statsBySsrc.get(key);
  if (!row) {
    row = {
      ssrc: key,
      packets: 0,
      bytes: 0,
      payloadTypes: new Set(),
      csrc: new Set(),
      extensionProfiles: new Set(),
      extensionIds: new Set(),
      firstPacketNumber: packetNumber,
      lastPacketNumber: packetNumber,
      firstSequenceNumber: header.sequenceNumber ?? null,
      lastSequenceNumber: header.sequenceNumber ?? null,
      firstRtpTimestamp: header.timestamp ?? null,
      lastRtpTimestamp: header.timestamp ?? null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      markerPackets: 0,
      extensionPackets: 0,
      totalAbs: 0,
      maxAbs: 0,
      samples: 0,
      activeSamplesOver500: 0,
      sampleExtensions: [],
    };
    statsBySsrc.set(key, row);
  }

  row.packets += 1;
  row.bytes += rtpPacket.payload?.length || 0;
  row.lastPacketNumber = packetNumber;
  row.lastSequenceNumber = header.sequenceNumber ?? null;
  row.lastRtpTimestamp = header.timestamp ?? null;
  row.lastSeenAt = new Date().toISOString();
  if (header.payloadType != null) row.payloadTypes.add(header.payloadType);
  if (Array.isArray(header.csrc)) header.csrc.forEach((csrc) => row.csrc.add(csrc));
  if (header.extensionProfile != null) row.extensionProfiles.add(header.extensionProfile);
  if (header.marker) row.markerPackets += 1;
  if (header.extension) row.extensionPackets += 1;
  if (Array.isArray(header.extensions) && header.extensions.length) {
    for (const extension of header.extensions) {
      row.extensionIds.add(extension.id);
      if (row.sampleExtensions.length < 10) row.sampleExtensions.push(summarizeRtpExtension(extension));
    }
  }

  for (const byte of rtpPacket.payload || []) {
    const abs = Math.abs(ulawToLinearSample(byte));
    row.totalAbs += abs;
    row.samples += 1;
    if (abs > row.maxAbs) row.maxAbs = abs;
    if (abs > 500) row.activeSamplesOver500 += 1;
  }
  return row;
}

function serializeRtpStats(statsBySsrc) {
  return [...statsBySsrc.values()].map((row) => ({
    ssrc: row.ssrc,
    packets: row.packets,
    bytes: row.bytes,
    payloadTypes: [...row.payloadTypes],
    csrc: [...row.csrc],
    extensionProfiles: [...row.extensionProfiles],
    extensionIds: [...row.extensionIds],
    firstPacketNumber: row.firstPacketNumber,
    lastPacketNumber: row.lastPacketNumber,
    firstSequenceNumber: row.firstSequenceNumber,
    lastSequenceNumber: row.lastSequenceNumber,
    firstRtpTimestamp: row.firstRtpTimestamp,
    lastRtpTimestamp: row.lastRtpTimestamp,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    markerPackets: row.markerPackets,
    extensionPackets: row.extensionPackets,
    meanAbs: row.samples ? Number((row.totalAbs / row.samples).toFixed(2)) : 0,
    maxAbs: row.maxAbs,
    activePctOver500: row.samples ? Number(((row.activeSamplesOver500 / row.samples) * 100).toFixed(3)) : 0,
    sampleExtensions: row.sampleExtensions,
  }));
}

async function rcAccessToken({
  jwtToken = process.env.RING_CENTRAL_JWT_TOKEN,
  clientId = process.env.RING_CENTRAL_CLIENT_ID,
  clientSecret = process.env.RING_CENTRAL_CLIENT_SECRET,
} = {}) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwtToken,
  });
  const basic = Buffer.from(
    `${clientId}:${clientSecret}`,
  ).toString("base64");
  const response = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`RC OAuth failed: ${response.status} ${text.slice(0, 300)}`);
  return json.access_token;
}

async function rcRequest(token, method, endpoint, body) {
  const response = await fetch(`${RC_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "TagContactBridgeParallel-ex-softphone-monitor/0.1",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} failed: ${response.status} ${text.slice(0, 500)}`);
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

async function superviseActiveCall({
  lookupToken,
  superviseToken,
  agentExtensionId,
  supervisorDeviceId,
  partyMode = "session",
  callPickMode = "first",
}) {
  const active = await rcRequest(
    lookupToken,
    "GET",
    `/restapi/v1.0/account/~/extension/${agentExtensionId}/active-calls?view=Detailed`,
  );
  const records = Array.isArray(active?.records) ? active.records : [];
  const picked = callPickMode === "agent-live"
    ? await pickActiveCallWithLiveAgentParty(records, {
      lookupToken,
      agentExtensionId,
      preferredMode: "newest",
    })
    : { call: pickActiveCall(records, callPickMode), session: null, agentParty: null };
  const call = picked.call;
  if (!call?.telephonySessionId) {
    throw new Error("No active agent telephonySessionId found. Start a live call/hold session first.");
  }
  let endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}/supervise`;
  let pickedParty = null;
  if (partyMode && partyMode !== "session" && partyMode !== "mixed") {
    const session = picked.session || await rcRequest(
      lookupToken,
      "GET",
      `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}`,
    );
    pickedParty = partyMode === "agent" && picked.agentParty
      ? picked.agentParty
      : pickParty(session, agentExtensionId, partyMode);
    if (!pickedParty?.id) {
      throw new Error(`No ${partyMode} party found on telephonySessionId ${call.telephonySessionId}`);
    }
    endpoint = `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(call.telephonySessionId)}/parties/${encodeURIComponent(pickedParty.id)}/supervise`;
  }
  const body = {
    mode: "Listen",
    supervisorDeviceId: String(supervisorDeviceId),
    agentExtensionId: String(agentExtensionId),
  };
  let response;
  let usedBody = body;
  try {
    response = await rcRequest(
      superviseToken,
      "POST",
      endpoint,
      body,
    );
  } catch (error) {
    const isPartySupervise = endpoint.includes("/parties/");
    const agentExtensionRejected = /agentExtensionId|CMN-102/i.test(String(error?.message || ""));
    if (!isPartySupervise || !agentExtensionRejected) throw error;

    // RingCentral's docs list agentExtensionId as required for both session
    // and party supervise. In the CX bridge, the remote party can be a carrier/
    // bridge leg with no extension ownership, and the API may reject the agent
    // extension even though the party id is valid. Retry the party-specific call
    // with the supervisor device only; keep the session supervise path strict.
    usedBody = {
      mode: "Listen",
      supervisorDeviceId: String(supervisorDeviceId),
    };
    response = await rcRequest(
      superviseToken,
      "POST",
      endpoint,
      usedBody,
    );
  }
  return {
    telephonySessionId: call.telephonySessionId,
    pickedCall: {
      id: call.id || null,
      startTime: call.startTime || call.creationTime || null,
      result: call.result || null,
      direction: call.direction || null,
    },
    partyMode,
    pickedParty: pickedParty ? summarizePartyForLog(pickedParty) : null,
    request: usedBody,
    response,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const agentExtNumber = readFlag(argv, "--agent-ext", "101");
  const supervisorExtNumber = readFlag(argv, "--supervisor-ext", "3202");
  const requestedDeviceId = readFlag(argv, "--supervisor-device-id", "");
  const proxyRegion = readFlag(argv, "--proxy-region", "NA");
  const timeoutSec = Math.max(10, Math.min(60 * 60, Number(readFlag(argv, "--timeout-sec", "300")) || 300));
  const partyMode = readFlag(argv, "--party", "session");
  const callPickMode = readFlag(argv, "--call", "first");
  const doSupervise = hasFlag(argv, "--supervise");
  const debug = hasFlag(argv, "--debug");
  const outDir = path.resolve(readFlag(argv, "--out-dir", path.join("runtime", "ex-monitor-captures")));
  const rtpLogEvery = Math.max(0, Number(readFlag(argv, "--rtp-log-every", "0")) || 0);
  const writeRtpSidecar = !hasFlag(argv, "--no-rtp-sidecar");

  fs.mkdirSync(outDir, { recursive: true });

  const token = await rcAccessToken();
  const monitorToken = await rcAccessToken({
    jwtToken: process.env.RING_CENTRAL_MONITOR_JWT_TOKEN || process.env.RING_CENTRAL_JWT_TOKEN,
    clientId: process.env.RING_CENTRAL_MONITOR_CLIENT_ID || process.env.RING_CENTRAL_CLIENT_ID,
    clientSecret: process.env.RING_CENTRAL_MONITOR_CLIENT_SECRET || process.env.RING_CENTRAL_CLIENT_SECRET,
  });
  const [agentExt, supervisorExt] = await Promise.all([
    resolveExtension(token, agentExtNumber),
    resolveExtension(token, supervisorExtNumber),
  ]);
  if (!agentExt) throw new Error(`Could not resolve agent extension ${agentExtNumber}`);
  if (!supervisorExt) throw new Error(`Could not resolve supervisor extension ${supervisorExtNumber}`);

  const devices = await rcRequest(token, "GET", `/restapi/v1.0/account/~/extension/${supervisorExt.id}/device`);
  const deviceRows = Array.isArray(devices?.records) ? devices.records : [];
  const device = pickSupervisorDevice(deviceRows, requestedDeviceId);
  if (!device?.id) throw new Error(`No supervisor device found for extension ${supervisorExtNumber}`);

  const sipInfo = await rcRequest(token, "GET", `/restapi/v1.0/account/~/device/${device.id}/sip-info`);
  const outboundProxy = pickProxy(sipInfo, proxyRegion);
  const softphone = new Softphone({
    domain: sipInfo.domain,
    outboundProxy,
    username: sipInfo.userName,
    password: sipInfo.password,
    authorizationId: sipInfo.authorizationId,
    codec: "PCMU/8000",
  });
  if (debug) softphone.enableDebugMode();

  let activeSession = null;
  let packetCount = 0;
  let byteCount = 0;
  let writeStream = null;
  let outputPath = "";
  let rtpStatsPath = "";
  const rtpStatsBySsrc = new Map();

  function closeOutput() {
    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }
  }

  function writeRtpStatsSidecar() {
    if (!writeRtpSidecar || !rtpStatsPath) return;
    fs.writeFileSync(rtpStatsPath, `${JSON.stringify({
      outputPath,
      totalPackets: packetCount,
      totalBytes: byteCount,
      sources: serializeRtpStats(rtpStatsBySsrc),
    }, null, 2)}\n`);
  }

  softphone.on("registrationError", (error) => {
    console.error(`registration refresh failed: ${error.message}`);
  });

  softphone.on("invite", async (inviteMessage) => {
    try {
      console.log(`[invite] inbound monitor call ${inviteMessage.getHeader("Call-ID") || ""}`);
      activeSession = await softphone.answer(inviteMessage);
      outputPath = path.join(outDir, `ex-monitor-${timestampForFile()}-${activeSession.callId.replace(/[^a-z0-9-]/gi, "_")}.pcmu`);
      rtpStatsPath = outputPath.replace(/\.pcmu$/i, ".rtp.json");
      writeStream = fs.createWriteStream(outputPath, { flags: "a" });
      console.log(`[answer] writing PCMU/8000 audio to ${outputPath}`);
      activeSession.on("audioPacket", (rtpPacket) => {
        packetCount += 1;
        byteCount += rtpPacket.payload.length;
        const rtpSource = updateRtpStats(rtpStatsBySsrc, rtpPacket, packetCount);
        writeStream.write(rtpPacket.payload);
        if (rtpLogEvery > 0 && packetCount % rtpLogEvery === 0) {
          console.log(`[rtp] packet=${packetCount} ssrc=${rtpSource.ssrc} sources=${rtpStatsBySsrc.size} payloadType=${rtpPacket.header?.payloadType ?? ""} csrc=${JSON.stringify(rtpPacket.header?.csrc || [])}`);
        }
        if (packetCount % 250 === 0) {
          console.log(`[audio] packets=${packetCount} bytes=${byteCount} ssrcs=${[...rtpStatsBySsrc.keys()].join(",") || "none"}`);
        }
      });
      activeSession.once("disposed", () => {
        console.log(`[done] call disposed packets=${packetCount} bytes=${byteCount} file=${outputPath || "(none)"}`);
        closeOutput();
        writeRtpStatsSidecar();
      });
    } catch (error) {
      console.error(`[invite] answer failed: ${error.message}`);
    }
  });

  console.log("RingEX headless monitor capture");
  console.log(`  agent:      ${agentExt.name} ext=${agentExt.extensionNumber} id=${agentExt.id}`);
  console.log(`  supervisor: ${supervisorExt.name} ext=${supervisorExt.extensionNumber} id=${supervisorExt.id}`);
  console.log(`  device:     ${JSON.stringify(summarizeDevice(device))}`);
  console.log(`  sip proxy:  ${outboundProxy}`);
  console.log(`  codec:      PCMU/8000`);
  console.log(`  timeout:    ${timeoutSec}s`);
  console.log(`  party:      ${partyMode}`);
  console.log(`  call pick:  ${callPickMode}`);
  console.log(`  auth:       supervise=${process.env.RING_CENTRAL_MONITOR_JWT_TOKEN ? "monitor jwt" : "default jwt"}`);

  await softphone.register();
  console.log("[register] headless monitor phone registered");

  if (doSupervise) {
    const result = await superviseActiveCall({
      lookupToken: token,
      superviseToken: monitorToken,
      agentExtensionId: agentExt.id,
      supervisorDeviceId: device.id,
      partyMode,
      callPickMode,
    });
    console.log(`[supervise] requested listen on telephonySessionId=${result.telephonySessionId}`);
    console.log(`[supervise] picked call ${JSON.stringify(result.pickedCall)}`);
    if (result.pickedParty) console.log(`[supervise] picked party ${JSON.stringify(result.pickedParty)}`);
    console.log(`[supervise] response ${JSON.stringify(result.response)}`);
  } else {
    console.log("[wait] waiting for a supervisor call/invite. Add --supervise to attach automatically.");
  }

  const stopAt = Date.now() + timeoutSec * 1000;
  while (Date.now() < stopAt) {
    await sleep(1000);
    if (activeSession?.disposed) break;
  }

  if (activeSession && !activeSession.disposed) {
    console.log("[timeout] hanging up active monitor call");
    await activeSession.hangup().catch((error) => console.error(`[timeout] hangup failed: ${error.message}`));
  }
  closeOutput();
  writeRtpStatsSidecar();
  softphone.revoke();

  console.log(JSON.stringify({
    ok: true,
    packets: packetCount,
    bytes: byteCount,
    outputPath: outputPath || null,
    rtpStatsPath: rtpStatsPath || null,
    rtpSources: serializeRtpStats(rtpStatsBySsrc),
    note: outputPath ? "raw PCMU/8000; play with ffplay -f mulaw -ar 8000 <file>" : "no call audio captured",
  }, null, 2));
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
