"use strict";

// RingEX supervision probe for the CX-audio workaround.
//
// Read-only by default:
//   - resolves an agent extension (the call being monitored)
//   - resolves a supervisor extension/device (the listener)
//   - lists current active calls for the agent
//
// Add --supervise during a live call to POST the RingEX supervise request:
//   node scripts/rc-ex-supervision-probe.js --agent-ext 101 --supervisor-ext 3202 --supervise
//
// This does not capture audio. It proves that RingEX can programmatically
// attach a supervisor device. Audio capture comes next by replacing the
// supervisor's physical phone with a headless RingCentral softphone SDK device.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

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

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function summarizeParty(party = {}) {
  return {
    phoneNumber: maskPhone(party.phoneNumber),
    name: party.name || null,
    extensionId: party.extensionId || null,
    extensionNumber: party.extensionNumber || null,
  };
}

function summarizeCall(record = {}) {
  return {
    id: record.id || null,
    sessionId: record.sessionId || null,
    telephonySessionId: record.telephonySessionId || null,
    partyId: record.partyId || null,
    result: record.result || null,
    direction: record.direction || null,
    startTime: record.startTime || null,
    from: summarizeParty(record.from),
    to: summarizeParty(record.to),
    legs: Array.isArray(record.legs)
      ? record.legs.map((leg) => ({
        type: leg.type || null,
        direction: leg.direction || null,
        action: leg.action || null,
        result: leg.result || null,
        from: summarizeParty(leg.from),
        to: summarizeParty(leg.to),
      }))
      : [],
  };
}

function summarizeDevice(device = {}) {
  return {
    id: String(device.id || ""),
    type: device.type || null,
    name: device.name || null,
    status: device.status || null,
    phoneLines: Array.isArray(device.phoneLines)
      ? device.phoneLines.map((line) => ({
        lineType: line.lineType || null,
        phoneNumber: maskPhone(line.phoneInfo?.phoneNumber),
        usageType: line.phoneInfo?.usageType || null,
        extensionId: line.extension?.id || null,
        extensionNumber: line.extension?.extensionNumber || null,
      }))
      : [],
  };
}

function pickSupervisorDevice(devices, requestedId = "") {
  if (requestedId) {
    return devices.find((device) => String(device.id) === String(requestedId)) || null;
  }
  return devices.find((device) => device.status === "Online")
    || devices.find((device) => device.type === "HardPhone")
    || devices[0]
    || null;
}

function pickActiveCall(records) {
  return records.find((record) => String(record.result || "").toLowerCase() === "in progress")
    || records.find((record) => record.telephonySessionId)
    || records[0]
    || null;
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
  if (!response.ok) {
    throw new Error(`RC OAuth failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return json.access_token;
}

async function rcRequest(token, method, endpoint, body) {
  const response = await fetch(`${RC_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "TagContactBridgeParallel-ex-supervision-probe/0.1",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(`${method} ${endpoint} failed: ${response.status} ${text.slice(0, 500)}`);
    error.status = response.status;
    error.body = json || text;
    throw error;
  }
  return json;
}

async function resolveExtension(token, extensionNumber) {
  for (let page = 1; page <= 20; page += 1) {
    const data = await rcRequest(
      token,
      "GET",
      `/restapi/v1.0/account/~/extension?perPage=200&page=${page}`,
    );
    const records = Array.isArray(data?.records) ? data.records : [];
    const hit = records.find((record) => String(record.extensionNumber || "") === String(extensionNumber));
    if (hit) return hit;
    if (records.length < 200) break;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const agentExtNumber = readFlag(argv, "--agent-ext", "101");
  const supervisorExtNumber = readFlag(argv, "--supervisor-ext", "3202");
  const supervisorDeviceId = readFlag(argv, "--supervisor-device-id", "");
  const doSupervise = hasFlag(argv, "--supervise");
  const view = readFlag(argv, "--view", "Detailed");

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

  const [devices, activeCalls, presence] = await Promise.all([
    rcRequest(token, "GET", `/restapi/v1.0/account/~/extension/${supervisorExt.id}/device`),
    rcRequest(token, "GET", `/restapi/v1.0/account/~/extension/${agentExt.id}/active-calls?view=${encodeURIComponent(view)}`),
    rcRequest(token, "GET", `/restapi/v1.0/account/~/extension/${agentExt.id}/presence?detailedTelephonyState=true&sipData=true`),
  ]);

  const deviceRows = Array.isArray(devices?.records) ? devices.records : [];
  const activeRows = Array.isArray(activeCalls?.records) ? activeCalls.records : [];
  const pickedDevice = pickSupervisorDevice(deviceRows, supervisorDeviceId);
  const pickedCall = pickActiveCall(activeRows);

  const summary = {
    mode: doSupervise ? "supervise" : "read-only",
    agent: {
      id: String(agentExt.id),
      extensionNumber: agentExt.extensionNumber,
      name: agentExt.name,
      email: agentExt.contact?.email || null,
      presenceStatus: presence?.presenceStatus || null,
      telephonyStatus: presence?.telephonyStatus || null,
    },
    supervisor: {
      id: String(supervisorExt.id),
      extensionNumber: supervisorExt.extensionNumber,
      name: supervisorExt.name,
      email: supervisorExt.contact?.email || null,
      pickedDevice: pickedDevice ? summarizeDevice(pickedDevice) : null,
      devices: deviceRows.map(summarizeDevice),
    },
    activeCallCount: activeRows.length,
    pickedCall: pickedCall ? summarizeCall(pickedCall) : null,
  };

  if (doSupervise) {
    if (!pickedDevice?.id) throw new Error("No supervisor device found. Use --supervisor-device-id if needed.");
    if (!pickedCall?.telephonySessionId) {
      throw new Error("No active agent telephonySessionId found. Start a live call/hold session first.");
    }
    const body = {
      mode: "Listen",
      supervisorDeviceId: String(pickedDevice.id),
      agentExtensionId: String(agentExt.id),
    };
    summary.superviseRequest = {
      path: `/restapi/v1.0/account/~/telephony/sessions/${pickedCall.telephonySessionId}/supervise`,
      body,
    };
    summary.superviseAuth = {
      usesMonitorJwt: Boolean(process.env.RING_CENTRAL_MONITOR_JWT_TOKEN),
    };
    summary.superviseResponse = await rcRequest(
      monitorToken,
      "POST",
      `/restapi/v1.0/account/~/telephony/sessions/${encodeURIComponent(pickedCall.telephonySessionId)}/supervise`,
      body,
    );
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  if (error.body) console.error(JSON.stringify(error.body, null, 2));
  process.exit(1);
});
