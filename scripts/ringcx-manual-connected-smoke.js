"use strict";

// RingCX manual-call smoke test based on RC support guidance.
//
// What we are trying to prove:
//   1. RingCX can accept a one-off manual outbound call request for a real
//      RingCX agent, using the generated RingCX username with the plus alias.
//   2. The agent is actually logged into the RingCX Agent portal and has an
//      active Connected/off-hook session before we place the manual call.
//   3. The request includes a callerId, because support said callerId is
//      required for /createManualAgentCall.
//   4. After RingCX returns true, /activeCalls/list shows a call whose raw
//      payload contains the target destination phone. We intentionally do not
//      count any random new active call as success, because an earlier run
//      matched a different phone ending 2335 while the requested phone ending
//      5997 never rang.
//
// RingCX endpoints exercised:
//   - GET  /v1/admin/accounts/{accountId}/agentGroups/{agentGroupId}/agents/{agentId}/login
//        Used as the preflight check for Connected/off-hook state.
//   - POST /voice/api/v1/admin/accounts/{accountId}/activeCalls/createManualAgentCall
//        The one-shot manual dial. It returns boolean true/false, not a call id.
//   - GET  /voice/api/v1/admin/accounts/{accountId}/activeCalls/list
//        Polled after the ACK to verify the destination appears in active calls.
//
// Safe behavior:
//   - Refuses to dial unless the login endpoint looks Connected/off-hook.
//   - Requires an explicit callerId.
//   - Masks phone numbers and usernames in console output and audit logs.
//   - Writes JSONL audit evidence to runtime/ringcx-probe/.
//   - --dry-run performs every preflight check and active-call baseline read
//     without placing the call.
//   - --force bypasses the Connected/off-hook refusal, but should only be used
//     when deliberately reproducing RingCX behavior for support.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createRingcxVoiceClient,
  normalizeRingcxPhone,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name, fallback = null) {
  // Tiny CLI parser for both "--flag value" and "--flag=value" forms. We keep
  // this script dependency-light so it can be copied into support tickets or
  // run on a clean server without adding a CLI framework.
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
  // Keep enough digits to correlate what happened, while avoiding dumping full
  // customer/agent phone numbers into terminal logs or pasted support evidence.
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function maskUsername(value) {
  const raw = String(value || "");
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  const name = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  return `${name.slice(0, 3)}***@${domain}`;
}

function describeUsername(value) {
  // RingCX support specifically called out that manual calls should use the
  // generated RingCX username, e.g. local+account_suffix@domain, not only the
  // plain office email. This summary proves we are using that shape without
  // printing the whole username.
  const raw = String(value || "");
  if (!raw) return null;
  const at = raw.indexOf("@");
  const local = at >= 0 ? raw.slice(0, at) : raw;
  const domain = at >= 0 ? raw.slice(at + 1) : "";
  const plus = local.indexOf("+");
  return {
    masked: maskUsername(raw),
    hasPlusAlias: plus >= 0,
    localPrefix: plus >= 0 ? local.slice(0, plus) : local,
    aliasSuffix: plus >= 0 ? local.slice(plus + 1) : "",
    domain,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(32)} ${value == null || value === "" ? "(none)" : value}`);
}

function appendJsonl(file, payload) {
  // Each run writes machine-readable evidence. That gives us a clean artifact
  // to compare with RingCentral support: preflight state, ACK, and active-call
  // observations are separate events in chronological order.
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, "utf8");
}

function flattenValues(value, prefix = "", out = {}) {
  // RingCX payloads are not stable enough to trust one exact field name across
  // all tenants/views. Flattening lets the preflight scan for off-hook/session
  // evidence across nested objects like agentOffhookSessions[0].offhookUii.
  if (value == null) return out;
  if (typeof value !== "object") {
    out[prefix || "value"] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => flattenValues(item, `${prefix}[${idx}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object") flattenValues(child, next, out);
    else out[next] = child;
  }
  return out;
}

function summarizeLogin(login) {
  // This is the key safety gate. Support said "Available" alone is not enough;
  // the agent needs to be Connected/off-hook unless backend dynamic off-hook is
  // enabled. We therefore look for explicit connected/off-hook text and for
  // active off-hook session fields returned by the login endpoint.
  if (login == null) {
    return {
      present: false,
      connected: false,
      reason: "login-endpoint-returned-null",
      fields: {},
    };
  }

  const flat = flattenValues(login);
  const entries = Object.entries(flat);
  const text = entries
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ")
    .toLowerCase();
  const hasOffhookSession = entries.some(([key, value]) => (
    /offhook/i.test(key)
    && value !== null
    && value !== undefined
    && value !== false
    && String(value).trim() !== ""
    && String(value).trim() !== "0"
  ));
  const connected = /\bconnected\b/.test(text) || /\boff\s*-?\s*hook\b/.test(text) || hasOffhookSession;
  const available = /\bavailable\b/.test(text);
  const loggedIn = entries.some(([key, value]) => /loggedin$/i.test(key) && value === true);
  const hasSession = entries.some(([key, value]) => /sessionid$/i.test(key) && value);
  const hasIq = entries.some(([key, value]) => /iqserverid$/i.test(key) && value);
  const registeredPhone = entries.find(([key, value]) => /registeredphone$/i.test(key) && value)?.[1] || null;

  const interesting = {};
  for (const [key, value] of entries) {
    // Preserve the diagnostic fields most useful for support, while masking
    // phone values. These fields explain why we considered the agent connected:
    // agentState, agentPhone, iqServerId, agentOffhookSessions, etc.
    if (
      /status|state|logged|ghost|pending|phone|session|iq|connect|hook|login/i.test(key)
      && typeof value !== "object"
    ) {
      interesting[key] = /phone/i.test(key) ? maskPhone(value) : value;
    }
  }

  return {
    present: true,
    connected,
    available,
    loggedIn,
    hasSession,
    hasOffhookSession,
    hasIq,
    hasRegisteredPhone: Boolean(registeredPhone),
    reason: connected ? "connected-like-state-found" : "no-connected-like-state-found",
    fields: interesting,
  };
}

function summarizeAgent(agent = {}) {
  // Agent config tells us whether RingCX believes this user is allowed to place
  // manual calls and which manual queue/gate is configured. For Sean, the
  // important value was manualOutboundDefaultGate.id = 9981.
  return {
    agentId: agent.agentId || agent.id || null,
    username: maskUsername(agent.username || agent.email || ""),
    rcUserId: agent.rcUserId || null,
    active: agent.active ?? agent.isActive ?? null,
    agentType: agent.agentType || null,
    allowOutbound: agent.allowOutbound ?? null,
    allowManualCalls: agent.allowManualCalls ?? null,
    allowOffHook: agent.allowOffHook ?? null,
    defaultLoginDest: maskPhone(agent.defaultLoginDest),
    manualOutboundDefaultCallerId: maskPhone(agent.manualOutboundDefaultCallerId),
    manualOutboundDefaultCallerIdE164: maskPhone(agent.manualOutboundDefaultCallerIdE164),
    manualOutboundDefaultWorkflowId: agent.manualOutboundDefaultWorkflowId || null,
    manualOutboundDefaultGate: summarizeGate(agent.manualOutboundDefaultGate),
    allowManualOutboundGates: agent.allowManualOutboundGates ?? null,
  };
}

function summarizeGate(gate) {
  // RingCX represents the manual outbound default queue as a "gate" object on
  // the agent. The UI label may say queue, while the API field says gate.
  if (!gate) return null;
  if (typeof gate !== "object") return String(gate);
  const id = gate.id || gate.gateId || null;
  const description = gate.description || gate.name || gate.gateName || null;
  return id && description ? `${id} (${description})` : id || description || null;
}

function callId(row = {}) {
  return String(
    row.uii
      || row.UII
      || row.callId
      || row.callID
      || row.activeCallId
      || row.interactionId
      || "",
  );
}

function summarizeCall(row = {}) {
  // Normalize just enough of an activeCalls row to read the audit log. The full
  // raw rows can be noisy, so the JSONL keeps this reduced support-friendly
  // shape for any rows that match the requested destination.
  return {
    id: callId(row) || null,
    state: row.state || row.callState || row.status || row.dialState || null,
    agentState: row.agentState || row.agent?.state || null,
    leadState: row.leadState || row.customer?.state || null,
    agentId: row.agentId || row.agent?.agentId || row.agent?.id || null,
    username: maskUsername(row.username || row.agentUsername || row.agent?.username || ""),
    campaignId: row.campaignId || row.campaign?.campaignId || null,
    dialGroupId: row.dialGroupId || row.dialGroup?.dialGroupId || null,
    phone: maskPhone(row.phone || row.destination || row.leadPhone || row.customerPhone || row.dnis || row.ani),
  };
}

function extractRows(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.records)) return response.records;
  if (Array.isArray(response?.content)) return response.content;
  return [];
}

function rowMatches(row, { destination, username, baselineIds }) {
  // Verification is intentionally strict:
  //   - Ignore calls that were already active before the test started.
  //   - If a destination was requested, only count rows whose raw JSON contains
  //     that destination's last 10 digits.
  //   - Do not count "any new call" as success. We tried that once and got a
  //     false positive for a different call.
  const id = callId(row);
  if (id && baselineIds.has(id)) return false;
  const flatText = JSON.stringify(row).toLowerCase();
  const dest = String(destination || "").replace(/\D/g, "");
  const user = String(username || "").toLowerCase();
  if (dest) return flatText.includes(dest.slice(-10));
  return Boolean(user && flatText.includes(user));
}

async function discoverAgent(client, { agentEmail, rcUserId, agentGroupId }) {
  // Find the RingCX agent record across agent groups. The caller can pass
  // explicit ids, but for operational use we usually know the office email or
  // RingEX user id and need to discover RingCX's generated username.
  const groups = agentGroupId
    ? [{ agentGroupId }]
    : await client.listAgentGroups();

  for (const group of groups || []) {
    const groupId = group.agentGroupId || group.id;
    if (!groupId) continue;
    const agents = await client.listAgents(groupId).catch(() => []);
    const targetEmail = String(agentEmail || "").trim().toLowerCase();
    const targetRcUserId = String(rcUserId || "").trim();
    const hit = (agents || []).find((agent) => {
      const username = String(agent.username || agent.email || "").trim().toLowerCase();
      const email = String(agent.email || "").trim().toLowerCase();
      const agentRcUserId = String(agent.rcUserId || "").trim();
      return (
        (targetEmail && (username === targetEmail || email === targetEmail || username.startsWith(`${targetEmail.split("@")[0]}+`)))
        || (targetRcUserId && agentRcUserId === targetRcUserId)
      );
    });
    if (!hit) continue;
    const agentId = hit.agentId || hit.id;
    const full = await client.getAgent(agentId, groupId).catch(() => hit);
    return { agent: full, agentGroupId: groupId };
  }

  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  // Defaults are intentionally pointed at the current TAG manual-dial test:
  // Sean is the real RingCX agent, the destination default is Mickey's cell,
  // and callerId can be supplied from env or CLI. In real tests we pass all
  // three values explicitly so the audit log is unambiguous.
  const agentEmail = String(readFlag(argv, "--agent-email", process.env.RINGCX_VOICE_AGENT_EMAIL || "mgray@taxadvocategroup.com")).trim().toLowerCase();
  const rcUserId = readFlag(argv, "--rc-user-id", process.env.RINGCX_VOICE_AGENT_RC_USER_ID || process.env.RINGCX_VOICE_RC_USER_ID || "");
  const explicitAgentId = readFlag(argv, "--agent-id", "");
  const explicitAgentGroupId = readFlag(argv, "--agent-group-id", "");
  const usernameOverride = readFlag(argv, "--username", "");
  const destination = normalizeRingcxPhone(readFlag(argv, "--to", "13106665997"));
  const callerId = normalizeRingcxPhone(readFlag(argv, "--caller-id", process.env.RING_CENTRAL_RINGOUT_CALLER || ""));
  const ringDuration = Math.max(5, Math.min(60, Number(readFlag(argv, "--ring-duration", "20")) || 20));
  const timeoutMs = Math.max(5000, Math.min(120000, (Number(readFlag(argv, "--timeout-sec", "45")) || 45) * 1000));
  const pollMs = Math.max(1000, Math.min(10000, Number(readFlag(argv, "--poll-ms", "1000")) || 1000));
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");

  if (!destination) throw new Error("--to <phone> is required");
  if (!callerId) throw new Error("--caller-id <phone> is required by RingCentral support");

  const outDir = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = path.join(outDir, `manual-connected-${stamp}.jsonl`);

  console.log("RingCX manual connected smoke");
  logKv("agent email", agentEmail);
  logKv("destination", maskPhone(destination));
  logKv("callerId", maskPhone(callerId));
  logKv("ringDuration", ringDuration);
  logKv("dryRun", dryRun);
  logKv("audit", logFile);

  const client = createRingcxVoiceClient();
  // Phase 1: resolve the actual RingCX agent record. This is where we get
  // Sean's generated username, manual outbound queue/gate, and permissions.
  const found = explicitAgentId && explicitAgentGroupId
    ? {
        agentGroupId: explicitAgentGroupId,
        agent: await client.getAgent(explicitAgentId, explicitAgentGroupId),
      }
    : await discoverAgent(client, { agentEmail, rcUserId, agentGroupId: explicitAgentGroupId });

  if (!found) throw new Error(`RingCX agent not found for ${agentEmail}`);

  const agentId = found.agent.agentId || found.agent.id;
  const username = usernameOverride || found.agent.username || found.agent.email || agentEmail;
  const usernameSummary = describeUsername(username);
  // Phase 2: login/off-hook preflight via the session-admin login endpoint.
  // If this is null, RingCX does not currently see the agent as connected.
  const login = await client.getAgentLogin(agentId, found.agentGroupId).catch((error) => ({
    error: error.message,
    details: error.details?.responseBody || null,
  }));
  const loginSummary = summarizeLogin(login);
  const agentSummary = summarizeAgent(found.agent);

  console.log("\nAgent config");
  logKv("agentId", agentId);
  logKv("agentGroupId", found.agentGroupId);
  logKv("username", agentSummary.username);
  logKv("dial username has + alias", usernameSummary?.hasPlusAlias);
  logKv("dial username alias", usernameSummary?.aliasSuffix || null);
  logKv("allowOutbound", agentSummary.allowOutbound);
  logKv("allowManualCalls", agentSummary.allowManualCalls);
  logKv("allowOffHook", agentSummary.allowOffHook);
  logKv("defaultLoginDest", agentSummary.defaultLoginDest);
  logKv("manual callerId", agentSummary.manualOutboundDefaultCallerId);
  logKv("manual queue/gate", agentSummary.manualOutboundDefaultGate);

  console.log("\nLogin/off-hook state");
  logKv("present", loginSummary.present);
  logKv("connected", loginSummary.connected);
  logKv("available", loginSummary.available);
  logKv("loggedIn", loginSummary.loggedIn);
  logKv("hasSession", loginSummary.hasSession);
  logKv("hasOffhookSession", loginSummary.hasOffhookSession);
  logKv("hasIq", loginSummary.hasIq);
  logKv("reason", loginSummary.reason);

  appendJsonl(logFile, {
    type: "preflight",
    at: new Date().toISOString(),
    agent: agentSummary,
    dialUsername: usernameSummary,
    agentGroupId: found.agentGroupId,
    login: loginSummary,
    dryRun,
    force,
  });

  if (!loginSummary.connected && !force) {
    console.log("\nRefusing to dial: RingCX login endpoint does not show Connected/off-hook.");
    console.log("Log into RingCX Agent portal, make sure the agent is Connected, then rerun.");
    process.exitCode = 2;
    return;
  }

  // Phase 3: capture a baseline of existing active calls. We use the ids from
  // this snapshot to avoid confusing pre-existing calls with our manual dial.
  const before = extractRows(await client.listActiveCalls({
    product: "ACCOUNT",
    productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
  }));
  const baselineIds = new Set(before.map(callId).filter(Boolean));
  appendJsonl(logFile, {
    type: "active-before",
    at: new Date().toISOString(),
    count: before.length,
    rows: before.map(summarizeCall),
  });

  if (dryRun) {
    console.log("\nDry run only. No call placed.");
    return;
  }

  // Phase 4: place the one-shot manual call. RingCX returns boolean true/false,
  // so ACK=true only means the request was accepted. It does not prove the
  // customer leg rang, and it does not give us a uii/call id.
  console.log("\nPlacing manual call");
  const startedAt = Date.now();
  const result = await client.placeManualCall({
    username,
    destination,
    callerId,
    ringDuration,
  });
  const ackAt = Date.now();
  console.log(`  ACK in ${ackAt - startedAt}ms`);
  console.log(`  response type: ${Array.isArray(result) ? "array" : typeof result}`);
  console.log(`  response: ${JSON.stringify(result)}`);
  appendJsonl(logFile, {
    type: "manual-call-ack",
    at: new Date().toISOString(),
    ackMs: ackAt - startedAt,
    response: result,
  });

  let firstSeen = null;
  let lastSeen = null;
  let observations = 0;
  const deadline = startedAt + timeoutMs;
  // Phase 5: poll active calls for the requested destination. This is the
  // strongest observable proof available from the API after createManualAgentCall
  // returns true. If your phone does not ring and this stays false, support can
  // see that RingCX accepted the request but did not surface the target call.
  while (Date.now() < deadline) {
    const response = await client.listActiveCalls({
      product: "ACCOUNT",
      productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
    });
    const rows = extractRows(response);
    const matches = rows.filter((row) => rowMatches(row, { destination, username, baselineIds }));
    observations += 1;
    if (matches.length > 0) {
      const summarized = matches.map(summarizeCall);
      if (!firstSeen) {
        firstSeen = { atMs: Date.now() - startedAt, rows: summarized };
        console.log(`  first active-call match after ${firstSeen.atMs}ms`);
      }
      lastSeen = { atMs: Date.now() - startedAt, rows: summarized };
      appendJsonl(logFile, {
        type: "active-match",
        at: new Date().toISOString(),
        atMs: Date.now() - startedAt,
        rows: summarized,
      });
    }
    await sleep(pollMs);
  }

  const summary = {
    ok: Boolean(firstSeen),
    ackMs: ackAt - startedAt,
    firstSeen,
    lastSeen,
    observations,
    timeoutMs,
  };
  appendJsonl(logFile, {
    type: "summary",
    at: new Date().toISOString(),
    summary,
  });

  console.log("\nSummary");
  logKv("active call observed", summary.ok);
  logKv("firstSeenMs", firstSeen?.atMs ?? null);
  logKv("lastSeenMs", lastSeen?.atMs ?? null);
  logKv("observations", observations);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
