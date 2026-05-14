"use strict";

// Speculative RingCX -> RingEX desk phone test harness.
//
// Goal:
//   Prove whether RingCX createManualAgentCall can ring an agent's
//   RingEX desk app/phone when we prepare the RingCX agent with that
//   EX number as its default login route.
//
// Safe default:
//   Without --patch-agent this only resolves identities and optionally
//   places a call against the existing RingCX agent session/config.
//
// Examples:
//   node scripts/rcx-ex-deskphone-test.js --agent-email mgray@taxadvocategroup.com --dry
//   node scripts/rcx-ex-deskphone-test.js --agent-email mgray@taxadvocategroup.com --to 8185551212 --dry
//   node scripts/rcx-ex-deskphone-test.js --agent-email mgray@taxadvocategroup.com --to 8185551212 --patch-agent

const path = require("path");
const readline = require("readline");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { createRingCentralClient } = require("../packages/shared-integrations/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { findExShellsForEmail } = require("../packages/shared-data/src/exShellDirectory");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : null;
}

function toE164(value) {
  const ten = normalizeDigits(value);
  return ten ? `+1${ten}` : null;
}

function toElevenDigits(value) {
  const ten = normalizeDigits(value);
  return ten ? `1${ten}` : null;
}

function logHeader(label) {
  console.log(`\n== ${label}`);
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(30)} ${value == null || value === "" ? "(none)" : value}`);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

function pickDeskPhone({ explicitPhone, rcPhoneNumbers, exShells }) {
  const candidates = [];
  if (explicitPhone) candidates.push(explicitPhone);
  for (const record of Array.isArray(rcPhoneNumbers?.records) ? rcPhoneNumbers.records : []) {
    candidates.push(record.phoneNumber);
  }
  for (const shell of Array.isArray(exShells) ? exShells : []) {
    candidates.push(shell.primaryPhone);
    for (const phone of Array.isArray(shell.loginPhones) ? shell.loginPhones : []) {
      candidates.push(phone);
    }
  }
  candidates.push(process.env.RING_CENTRAL_RINGOUT_CALLER);
  const seen = new Set();
  for (const candidate of candidates) {
    const ten = normalizeDigits(candidate);
    if (!ten || seen.has(ten)) continue;
    seen.add(ten);
    return ten;
  }
  return null;
}

function buildDefaultLoginDest({ deskPhone, extensionNumber, mainNumber, format }) {
  const mode = String(format || "direct").trim().toLowerCase();
  const eleven = toElevenDigits(deskPhone);
  if (!eleven) return null;
  if (mode === "rc-softphone") return `${eleven}@RC_SOFTPHONE`;
  if (mode === "main-extension") {
    const main = toElevenDigits(mainNumber);
    const ext = String(extensionNumber || "").trim();
    return main && ext ? `${main}*${ext}@RC_SOFTPHONE` : null;
  }
  return eleven;
}

async function resolveRcExtensionByEmail(rc, email) {
  const target = String(email || "").trim().toLowerCase();
  const payload = await rc.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];
  return records.find((record) =>
    String(record?.contact?.email || "").trim().toLowerCase() === target
  ) || null;
}

async function findRingcxAgent(client, { username, rcUserId, agentGroupId: explicitAgentGroupId } = {}) {
  const target = String(username || "").trim().toLowerCase();
  const targetRcUserId = rcUserId == null ? null : String(rcUserId).trim();
  const groups = await client.listAgentGroups();
  for (const group of groups || []) {
    const agentGroupId = group.agentGroupId || group.id;
    if (!agentGroupId) continue;
    if (explicitAgentGroupId && String(agentGroupId) !== String(explicitAgentGroupId)) continue;
    let agents = [];
    try {
      agents = await client.listAgents(agentGroupId);
    } catch {
      continue;
    }
    const hit = (agents || []).find((agent) => {
      const cxUsername = String(agent.username || agent.email || "").trim().toLowerCase();
      const cxRcUserId = agent.rcUserId == null ? null : String(agent.rcUserId).trim();
      return (target && cxUsername === target) || (targetRcUserId && cxRcUserId === targetRcUserId);
    });
    if (!hit) continue;
    let full = hit;
    try {
      full = await client.getAgent(hit.agentId || hit.id, agentGroupId);
    } catch {
      // The list shape is enough for read-only output.
    }
    return { agent: full, agentGroupId };
  }
  return null;
}

async function createRingcxAgent(client, { email, rcExtension, agentGroupId, defaultLoginDest, callerId }) {
  const contact = rcExtension?.contact || {};
  return client.createAgent({
    agentExternId: email,
    username: email,
    email,
    firstName: contact.firstName || "CX",
    lastName: contact.lastName || "Agent",
    rcUserId: rcExtension?.id ? Number(rcExtension.id) : undefined,
    isActive: 1,
    agentType: "AGENT",
    initLoginBaseState: "AVAILABLE",
    allowInbound: true,
    allowOutbound: true,
    allowManualCalls: true,
    allowCallControl: true,
    allowHangup: true,
    allowLoginControl: true,
    allowLoginUpdates: true,
    allowOffHook: true,
    defaultLoginDest: defaultLoginDest || undefined,
    manualOutboundDefaultCallerId: callerId || undefined,
    manualOutboundDefaultCallerIdE164: callerId ? toE164(callerId) : undefined,
  }, agentGroupId);
}

async function patchRingcxAgent(client, { agent, agentGroupId, rcExtension, defaultLoginDest, callerId }) {
  const patch = {
    rcUserId: rcExtension?.id ? Number(rcExtension.id) : agent.rcUserId,
    isActive: true,
    active: true,
    allowOutbound: true,
    allowManualCalls: true,
    allowCallControl: true,
    allowHangup: true,
    allowLoginControl: true,
    allowLoginUpdates: true,
    allowOffHook: true,
    defaultLoginDest: defaultLoginDest || agent.defaultLoginDest || "",
    manualOutboundDefaultCallerId: callerId || agent.manualOutboundDefaultCallerId || "",
    manualOutboundDefaultCallerIdE164: callerId ? toE164(callerId) : agent.manualOutboundDefaultCallerIdE164 || "",
  };
  const payload = { ...agent, ...patch };
  return client.updateAgent(agent.agentId || agent.id, payload, agentGroupId);
}

async function main() {
  const argv = process.argv.slice(2);
  const dry = hasFlag(argv, "--dry");
  const patchAgent = hasFlag(argv, "--patch-agent");
  const createAgent = hasFlag(argv, "--create-agent");
  const noPrompt = hasFlag(argv, "--no-prompt");
  const agentEmail = String(
    readFlag(argv, "--agent-email")
    || process.env.RINGCX_VOICE_AGENT_EMAIL
    || process.env.RINGCX_VOICE_RC_USER_EMAIL
    || "mgray@taxadvocategroup.com",
  ).trim().toLowerCase();
  const to = readFlag(argv, "--to");
  const explicitDeskPhone = readFlag(argv, "--desk-phone");
  const loginDestFormat = readFlag(argv, "--login-dest-format") || "direct";
  const explicitDefaultLoginDest = readFlag(argv, "--default-login-dest");
  const explicitCallerId = readFlag(argv, "--caller-id");
  const explicitAgentGroupId = readFlag(argv, "--agent-group-id");
  const mainNumber = readFlag(argv, "--main-number") || process.env.RING_CENTRAL_MAIN_NUMBER;
  const ringDuration = Number(readFlag(argv, "--ring-duration") || 15);

  logHeader("EX desk phone CX call test");
  logKv("agent email", agentEmail);
  logKv("destination", to || "(not provided; plan only)");
  logKv("patch agent", patchAgent);
  logKv("create agent", createAgent);
  logKv("dry run", dry);

  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "rcx-ex-deskphone-test" });
  const rcExtension = await resolveRcExtensionByEmail(rc, agentEmail);
  const rcPhoneNumbers = rcExtension?.id
    ? await rc.listExtensionPhoneNumbers(rcExtension.id).catch((error) => ({ error: error.message, records: [] }))
    : { records: [] };
  const exShells = findExShellsForEmail(agentEmail);
  const deskPhone = pickDeskPhone({ explicitPhone: explicitDeskPhone, rcPhoneNumbers, exShells });
  const callerId = normalizeDigits(explicitCallerId || deskPhone);
  const defaultLoginDest = String(explicitDefaultLoginDest || "").trim()
    || buildDefaultLoginDest({
      deskPhone,
      extensionNumber: rcExtension?.extensionNumber || exShells[0]?.extensionNumber,
      mainNumber,
      format: loginDestFormat,
    });

  logHeader("RingEX identity");
  logKv("rc extension id", rcExtension?.id || "(not found)");
  logKv("rc extension number", rcExtension?.extensionNumber);
  logKv("rc name", rcExtension?.name || [rcExtension?.contact?.firstName, rcExtension?.contact?.lastName].filter(Boolean).join(" "));
  logKv("selected desk phone", deskPhone ? toE164(deskPhone) : null);
  logKv("caller id", callerId ? toE164(callerId) : null);
  logKv("defaultLoginDest", defaultLoginDest);
  if (rcPhoneNumbers?.error) logKv("phone-number warning", rcPhoneNumbers.error);

  const client = createRingcxVoiceClient();
  const who = await client.auth.whoami();
  logHeader("RingCX auth");
  logKv("auth rc user", who.rcUser?.email);
  logKv("account id", who.accountId);

  let agentLookup = await findRingcxAgent(client, {
    username: agentEmail,
    rcUserId: rcExtension?.id,
    agentGroupId: explicitAgentGroupId,
  });
  if (!agentLookup && createAgent) {
    const groups = await client.listAgentGroups();
    const agentGroupId = explicitAgentGroupId
      || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
      || groups?.[0]?.agentGroupId
      || groups?.[0]?.id
      || null;
    if (!agentGroupId) throw new Error("No RingCX agent group is available for --create-agent");
    if (dry) {
      agentLookup = {
        agentGroupId,
        agent: {
          username: agentEmail,
          agentId: "(dry-created)",
        },
      };
    } else {
      const created = await createRingcxAgent(client, {
        email: agentEmail,
        rcExtension,
        agentGroupId,
        defaultLoginDest,
        callerId,
      });
      agentLookup = {
        agent: created,
        agentGroupId,
      };
    }
  }
  if (!agentLookup) {
    throw new Error(`RingCX agent not found for ${agentEmail}; rerun with --create-agent if this user should be created`);
  }

  logHeader("RingCX agent");
  logKv("agent id", agentLookup.agent.agentId || agentLookup.agent.id);
  logKv("agent group id", agentLookup.agentGroupId);
  logKv("username", agentLookup.agent.username || agentLookup.agent.email);
  logKv("current defaultLoginDest", agentLookup.agent.defaultLoginDest);
  logKv("current allowManualCalls", agentLookup.agent.allowManualCalls);
  logKv("current allowOutbound", agentLookup.agent.allowOutbound);
  logKv("current allowOffHook", agentLookup.agent.allowOffHook);

  if (patchAgent) {
    logHeader("Agent phone-settings patch");
    if (dry) {
      logKv("would set defaultLoginDest", defaultLoginDest);
      logKv("would set caller id", callerId ? toE164(callerId) : null);
      logKv("would enable", "allowOutbound/allowManualCalls/allowOffHook/login control");
    } else {
      const patched = await patchRingcxAgent(client, {
        agent: agentLookup.agent,
        agentGroupId: agentLookup.agentGroupId,
        rcExtension,
        defaultLoginDest,
        callerId,
      });
      agentLookup.agent = { ...agentLookup.agent, ...patched };
      logKv("patched", "yes");
      logKv("new defaultLoginDest", patched.defaultLoginDest || defaultLoginDest);
    }
  }

  const destination = normalizeDigits(to);
  const manualCallUsername = agentLookup.agent.username || agentLookup.agent.email || agentEmail;
  if (!destination) {
    logHeader("No call placed");
    console.log("  Provide --to <phone> when you want to fire the live manual CX call.");
    return;
  }

  logHeader("Manual CX call");
  logKv("username", manualCallUsername);
  logKv("destination", toE164(destination));
  logKv("callerId", callerId ? toE164(callerId) : null);
  logKv("ringDuration", ringDuration);
  if (dry) {
    console.log("  Dry run only; no RingCX call was placed.");
    return;
  }

  const response = await client.placeManualCall({
    agentEmail: manualCallUsername,
    destination,
    callerId: callerId || undefined,
    ringDuration,
  });
  const uii = response?.uii || response?.UII || response?.callId || response?.callID || response?.activeCallId || null;
  logKv("placed", "yes");
  logKv("uii", uii);
  logKv("raw response", JSON.stringify(response).slice(0, 500));

  if (uii && !noPrompt) {
    await ask("\nPress ENTER after the test call is done to try hangup cleanup...");
    try {
      await client.hangupCall(uii);
      logKv("hangup", "sent");
    } catch (error) {
      logKv("hangup warning", error.message);
    }
  }
}

main().catch((error) => {
  console.error(`\nfatal: ${error.message}`);
  if (error?.details?.responseBody) {
    console.error(JSON.stringify(error.details.responseBody, null, 2));
  }
  process.exit(1);
});
