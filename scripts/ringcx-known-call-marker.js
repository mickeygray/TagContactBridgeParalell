#!/usr/bin/env node
"use strict";

// One-off known-call marker for RingCX recording/debug work.
//
// What it does:
//   1. Captures RingCX account, agent, dial group, campaign, login/off-hook,
//      active-call, and optional RingEX presence/call-log context.
//   2. Places a manual outbound call with createManualAgentCall.
//   3. Polls activeCalls while the call is live and records any matching rows.
//   4. Writes a JSON artifact that can be used later to search
//      interaction-metadata / recording segment data for the exact call window.
//
// Example:
//   node scripts/ringcx-known-call-marker.js
//
// Later, after the call has been ended for 20+ minutes:
//   node scripts/ringcx-known-call-marker.js --metadata-only --marker runtime/ringcx-probe/known-call-....json

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createRingcxVoiceClient,
  normalizeRingcxPhone,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");
const { createRingCentralClient } = require("../packages/shared-integrations/src");

function readFlag(argv, name, fallback = null) {
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

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeUsPhone(value) {
  const raw = digits(value);
  if (!raw) return "";
  if (raw.length === 11 && raw.startsWith("1")) return raw.slice(1);
  return raw.slice(-10);
}

function maskPhone(value) {
  const raw = digits(value);
  if (!raw) return null;
  return `${"*".repeat(Math.max(raw.length - 4, 0))}${raw.slice(-4)}`;
}

function maskEmail(value) {
  const raw = String(value || "");
  const at = raw.indexOf("@");
  if (at < 0) return raw;
  return `${raw.slice(0, 3)}***${raw.slice(at)}`;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalTs(date, timeZone = "America/Los_Angeles") {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || "00";
  const hour = pick("hour") === "24" ? "00" : pick("hour");
  return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")}`;
}

function logKv(key, value) {
  // eslint-disable-next-line no-console
  console.log(`  ${String(key).padEnd(30, " ")} ${value == null || value === "" ? "(none)" : value}`);
}

function logHeader(value) {
  // eslint-disable-next-line no-console
  console.log(`\n== ${value} ==`);
}

function errorToObject(error) {
  return {
    name: error?.name || "Error",
    code: error?.code || error?.details?.code || null,
    status: error?.status || error?.details?.responseStatus || null,
    message: error?.message || String(error),
    responseBody: error?.details?.responseBody || null,
    retryAfter: error?.details?.retryAfter || error?.details?.rateLimitHeaders?.retryAfter || null,
  };
}

async function safe(label, fn) {
  const startedAt = new Date();
  const startMs = Date.now();
  try {
    const value = await fn();
    return {
      label,
      ok: true,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startMs,
      value,
    };
  } catch (error) {
    return {
      label,
      ok: false,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startMs,
      error: errorToObject(error),
    };
  }
}

function callId(row = {}) {
  return String(
    row.uii
      || row.UII
      || row.callId
      || row.callID
      || row.activeCallId
      || row.interactionId
      || row.id
      || "",
  );
}

function extractRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.content)) return value.content;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function summarizeCall(row = {}) {
  return {
    id: callId(row) || null,
    callState: row.callState || row.state || row.status || row.dialState || null,
    uii: row.uii || row.UII || null,
    ani: maskPhone(row.ani || row.callerId || row.sourcePhone),
    dnis: maskPhone(row.dnis || row.destination || row.leadPhone || row.customerPhone),
    campaignId: row.campaignId || row.campaign?.campaignId || null,
    dialGroupId: row.dialGroupId || row.dialGroup?.dialGroupId || null,
    agentId: row.agentId || row.agent?.agentId || row.agent?.id || null,
    agentName: row.agentName || row.agent?.name || null,
    agentUsername: maskEmail(row.agentUsername || row.username || row.agent?.username || ""),
    destinationName: row.destinationName || null,
    rawKeys: Object.keys(row || {}).slice(0, 60),
  };
}

function rowMatches(row, needles = []) {
  const text = JSON.stringify(row || "").toLowerCase();
  return needles.some((needle) => {
    const raw = String(needle || "").trim().toLowerCase();
    if (!raw) return false;
    const phone = normalizeUsPhone(raw);
    return (phone && text.includes(phone)) || text.includes(raw);
  });
}

function findFields(obj, pattern, basePath = "", hits = []) {
  if (!obj || typeof obj !== "object") return hits;
  if (Array.isArray(obj)) {
    obj.slice(0, 8).forEach((item, index) =>
      findFields(item, pattern, `${basePath}[${index}]`, hits));
    return hits;
  }
  for (const [key, value] of Object.entries(obj)) {
    const nextPath = basePath ? `${basePath}.${key}` : key;
    if (pattern.test(key)) {
      hits.push({ path: nextPath, value });
    }
    if (value && typeof value === "object") {
      findFields(value, pattern, nextPath, hits);
    }
  }
  return hits;
}

function flattenValues(value, prefix = "", out = {}) {
  if (value == null) return out;
  if (typeof value !== "object") {
    out[prefix || "value"] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenValues(item, `${prefix}[${index}]`, out));
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
  if (!login || login.error) {
    return {
      present: Boolean(login),
      connected: false,
      error: login?.error || null,
      reason: login?.error ? "login-endpoint-error" : "login-endpoint-empty",
      fields: {},
    };
  }

  const flat = flattenValues(login);
  const entries = Object.entries(flat);
  const text = entries.map(([key, value]) => `${key}=${String(value)}`).join(" ").toLowerCase();
  const hasOffhookSession = entries.some(([key, value]) => (
    /offhook/i.test(key)
    && value !== null
    && value !== undefined
    && value !== false
    && String(value).trim() !== ""
    && String(value).trim() !== "0"
  ));
  const connected = /\bconnected\b/.test(text) || /\boff\s*-?\s*hook\b/.test(text) || hasOffhookSession;
  const interesting = {};
  for (const [key, value] of entries) {
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
    available: /\bavailable\b/.test(text),
    loggedIn: entries.some(([key, value]) => /loggedin$/i.test(key) && value === true),
    hasSession: entries.some(([key, value]) => /sessionid$/i.test(key) && value),
    hasOffhookSession,
    hasIq: entries.some(([key, value]) => /iqserverid$/i.test(key) && value),
    reason: connected ? "connected-like-state-found" : "no-connected-like-state-found",
    fields: interesting,
  };
}

function summarizeAgent(agent = {}) {
  const username = agent.username || agent.email || "";
  const at = String(username).indexOf("@");
  const local = at >= 0 ? String(username).slice(0, at) : String(username);
  const plus = local.indexOf("+");
  return {
    agentId: agent.agentId || agent.id || null,
    username: maskEmail(username),
    usernameRaw: username,
    hasPlusAlias: plus >= 0,
    plusAlias: plus >= 0 ? local.slice(plus + 1) : "",
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
  };
}

function summarizeGate(gate) {
  if (!gate) return null;
  if (typeof gate !== "object") return String(gate);
  const id = gate.id || gate.gateId || null;
  const description = gate.description || gate.name || gate.gateName || null;
  return id && description ? `${id} (${description})` : id || description || null;
}

function redactLarge(value) {
  if (Array.isArray(value)) return value.slice(0, 10).map(redactLarge);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) {
      out[key] = "[redacted]";
    } else if (/phone|ani|dnis|caller|destination/i.test(key) && typeof child !== "object") {
      out[key] = maskPhone(child);
    } else if (typeof child === "object") {
      out[key] = redactLarge(child);
    } else {
      out[key] = child;
    }
  }
  return out;
}

async function discoverAgent(client, { agentEmail, rcUserId, agentGroupId }) {
  const groups = agentGroupId
    ? [{ agentGroupId }]
    : await client.listAgentGroups();
  const targetEmail = String(agentEmail || "").trim().toLowerCase();
  const targetPrefix = targetEmail.split("@")[0];
  const targetRcUserId = String(rcUserId || "").trim();

  for (const group of groups || []) {
    const groupId = group.agentGroupId || group.id;
    if (!groupId) continue;
    const agents = await client.listAgents(groupId).catch(() => []);
    const hit = (agents || []).find((agent) => {
      const username = String(agent.username || agent.email || "").trim().toLowerCase();
      const email = String(agent.email || "").trim().toLowerCase();
      const agentRcUserId = String(agent.rcUserId || "").trim();
      return (
        (targetEmail && (username === targetEmail || email === targetEmail || username.startsWith(`${targetPrefix}+`)))
        || (targetRcUserId && agentRcUserId === targetRcUserId)
      );
    });
    if (!hit) continue;
    const agentId = hit.agentId || hit.id;
    const full = await client.getAgent(agentId, groupId).catch(() => hit);
    return { agent: full, agentGroupId: groupId, group };
  }
  return null;
}

function routeEnvForRcUserId(rcUserId) {
  const suffix = String(rcUserId || "").trim();
  if (!suffix) return {};
  return {
    dialGroupId: process.env[`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`] || null,
    campaignId: process.env[`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`] || null,
    executionMode: process.env[`RINGCX_AGENT_ROUTE_${suffix}_EXECUTION_MODE`] || null,
    callerId: process.env[`RINGCX_AGENT_ROUTE_${suffix}_CALLER_ID`] || null,
  };
}

async function activeSnapshot(client, label, { accountId, agentId, destination, callerId, username }) {
  const account = await safe(`${label}.activeCalls.ACCOUNT`, async () => {
    const value = await client.listActiveCalls({ product: "ACCOUNT", productId: accountId });
    const rows = extractRows(value);
    return {
      count: rows.length,
      matches: rows.filter((row) => rowMatches(row, [destination, callerId, username])).map(summarizeCall),
      rows: rows.slice(0, 10).map(summarizeCall),
    };
  });

  const agent = agentId
    ? await safe(`${label}.activeCalls.AGENT`, async () => {
        const value = await client.listActiveCalls({ product: "AGENT", productId: agentId });
        const rows = extractRows(value);
        return {
          count: rows.length,
          matches: rows.filter((row) => rowMatches(row, [destination, callerId, username])).map(summarizeCall),
          rows: rows.slice(0, 10).map(summarizeCall),
        };
      })
    : { label: `${label}.activeCalls.AGENT`, ok: false, skipped: true, reason: "no-agent-id" };

  return { account, agent };
}

async function exSnapshot(label, { extensionId, destination, from, to }) {
  if (!extensionId) {
    return { label, ok: false, skipped: true, reason: "no-extension-id" };
  }
  const suspended = /^(1|true|yes|on)$/i.test(String(process.env.PARALLEL_RC_SUSPENDED || ""));
  if (suspended) {
    return { label, ok: false, skipped: true, reason: "PARALLEL_RC_SUSPENDED" };
  }
  const rc = createRingCentralClient();
  return safe(label, async () => {
    await rc.reinitializePlatform?.({ force: false, reason: "ringcx-known-call-marker" }).catch(() => null);
    const [presence, extensionLog, accountLog] = await Promise.all([
      rc.getPresence(extensionId).catch((error) => ({ error: errorToObject(error) })),
      rc.getExtensionCallLog(extensionId, {
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
        perPage: 20,
      }).catch((error) => ({ error: errorToObject(error) })),
      rc.getAccountCallLog({
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
        perPage: 20,
      }).catch((error) => ({ error: errorToObject(error) })),
    ]);
    const needle = normalizeUsPhone(destination);
    function summarizeLog(payload) {
      const rows = Array.isArray(payload?.records) ? payload.records : [];
      return {
        count: rows.length,
        matches: rows
          .filter((row) => !needle || JSON.stringify(row).includes(needle))
          .slice(0, 10)
          .map((row) => ({
            id: row.id || null,
            sessionId: row.sessionId || row.telephonySessionId || null,
            startTime: row.startTime || null,
            duration: row.duration || null,
            direction: row.direction || null,
            result: row.result || null,
            type: row.type || null,
            from: maskPhone(row.from?.phoneNumber || row.from?.extensionNumber),
            to: maskPhone(row.to?.phoneNumber || row.to?.extensionNumber),
            recording: row.recording
              ? {
                  id: row.recording.id || null,
                  type: row.recording.type || null,
                  contentUri: row.recording.contentUri ? "[present]" : null,
                }
              : null,
          })),
      };
    }
    return {
      presence: redactLarge(presence),
      extensionCallLog: summarizeLog(extensionLog),
      accountCallLog: summarizeLog(accountLog),
    };
  });
}

async function rawReportFallback(client, { start, end }) {
  return safe("reportsStreaming.GLOBAL_CALL_TYPE_DELIMITED", async () => {
    const bearer = await client.auth.ensureToken();
    const accountId = client.config.accountId;
    const base = (process.env.RINGCX_VOICE_BASE_URL || "https://ringcx.ringcentral.com").replace(/\/$/, "");
    const url = `${base}/voice/api/v1/admin/accounts/${accountId}/reportsStreaming`;
    const body = {
      reportType: "GLOBAL_CALL_TYPE_DELIMITED",
      reportCriteria: {
        criteriaType: "GLOBAL_CALL_TYPE_CRITERIA",
        startDate: start.toISOString().replace("Z", "+0000"),
        endDate: end.toISOString().replace("Z", "+0000"),
        containGates: true,
        containCampaigns: true,
        containIvrStudios: true,
        containCloudProfiles: true,
        containTracNumbers: true,
        containAgents: true,
        includeNoAnswers: false,
      },
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `${bearer.tokenType} ${bearer.accessToken}`,
        Accept: "*/*",
        "Content-Type": "application/json;charset=UTF-8",
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      bodyPreview: text.slice(0, 2000),
      hasRecordingUrl: /recordingUrl/i.test(text),
    };
  });
}

function buildMetadataWindows(marker) {
  const started = toDate(marker?.call?.requestStartedAt || marker?.startedAt) || new Date();
  const firstSeen = toDate(marker?.call?.firstSeenAt);
  const lastSeen = toDate(marker?.call?.lastSeenAt);
  const ended = toDate(marker?.call?.operatorEndedAt || marker?.completedAt);
  const centerStart = firstSeen || started;
  const centerEnd = ended || lastSeen || new Date(centerStart.getTime() + 5 * 60 * 1000);
  return [
    {
      label: "tight-known-call-window",
      start: new Date(centerStart.getTime() - 5 * 60 * 1000),
      end: new Date(centerEnd.getTime() + 10 * 60 * 1000),
    },
    {
      label: "wide-known-call-window",
      start: new Date(started.getTime() - 15 * 60 * 1000),
      end: new Date((ended || centerEnd).getTime() + 30 * 60 * 1000),
    },
  ];
}

async function runMetadataSearch({ markerPath, outDir }) {
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  const client = createRingcxVoiceClient();
  const windows = buildMetadataWindows(marker);
  const result = {
    type: "ringcx-known-call-metadata-search",
    markerPath,
    searchedAt: new Date().toISOString(),
    destination: marker.private?.destination || null,
    callerId: marker.private?.callerId || null,
    windows: [],
  };
  for (const window of windows) {
    const metadata = await safe(`interactionMetadata.${window.label}`, async () => {
      const value = await client.fetchInteractionMetadata({
        startTime: window.start,
        endTime: window.end,
      });
      const rows = extractRows(value);
      const needles = [
        marker.private?.destination,
        marker.private?.callerId,
        ...(marker.call?.observedIds || []),
      ].filter(Boolean);
      return {
        request: {
          startTime: window.start.toISOString(),
          endTime: window.end.toISOString(),
          segmentEndTime: formatLocalTs(window.end),
          timeInterval: Math.max(1, Math.round((window.end.getTime() - window.start.getTime()) / 1000)),
          timeZone: "America/Los_Angeles",
        },
        count: rows.length,
        matches: rows.filter((row) => rowMatches(row, needles)).slice(0, 20),
        keys: value && typeof value === "object" ? Object.keys(value) : [],
      };
    });
    result.windows.push({
      label: window.label,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      metadata,
    });
  }
  result.reportFallback = await rawReportFallback(client, {
    start: windows[1].start,
    end: windows[1].end,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `known-call-metadata-search-${stamp}.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  logHeader("metadata search");
  logKv("report", outPath);
  for (const row of result.windows) {
    logKv(row.label, row.metadata.ok ? `ok count=${row.metadata.value.count}` : `failed ${row.metadata.error.status} ${row.metadata.error.message}`);
  }
  logKv("report fallback", result.reportFallback.ok ? `ok status=${result.reportFallback.value.status}` : "failed");
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const outDir = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
  fs.mkdirSync(outDir, { recursive: true });

  if (hasFlag(argv, "--metadata-only")) {
    const markerPath = readFlag(argv, "--marker");
    if (!markerPath) throw new Error("--marker <known-call-json> is required with --metadata-only");
    await runMetadataSearch({ markerPath: path.resolve(markerPath), outDir });
    return;
  }

  const agentEmail = String(
    readFlag(argv, "--agent-email", process.env.RINGCX_VOICE_AGENT_EMAIL || "mgray@taxadvocategroup.com"),
  ).trim().toLowerCase();
  const rcUserId = readFlag(argv, "--rc-user-id", process.env.RINGCX_VOICE_AGENT_RC_USER_ID || process.env.RINGCX_VOICE_RC_USER_ID || "");
  const destination = normalizeRingcxPhone(
    readFlag(argv, "--to", process.env.PARALLEL_TEST_PHONE || process.env.DEPLOY_PANEL_PHONE || "3106665997"),
  );
  const callerId = normalizeRingcxPhone(
    readFlag(argv, "--caller-id", process.env.RING_CENTRAL_RINGOUT_CALLER || "18183345087"),
  );
  const usernameOverride = readFlag(argv, "--username", "");
  const explicitAgentGroupId = readFlag(argv, "--agent-group-id", "");
  const ringDuration = Math.max(5, Math.min(60, Number(readFlag(argv, "--ring-duration", "20")) || 20));
  const pollSeconds = Math.max(20, Math.min(600, Number(readFlag(argv, "--poll-sec", "180")) || 180));
  const pollMs = Math.max(1000, Math.min(10000, Number(readFlag(argv, "--poll-ms", "2000")) || 2000));
  const force = hasFlag(argv, "--force");
  const dryRun = hasFlag(argv, "--dry-run");
  const metadataPrecheck = !hasFlag(argv, "--skip-metadata-precheck");
  const exProbe = !hasFlag(argv, "--skip-ex");
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `known-call-${stamp}.json`);

  if (!destination) throw new Error("--to <phone> is required");
  if (!callerId) throw new Error("--caller-id <phone> is required");

  const client = createRingcxVoiceClient();
  const marker = {
    type: "ringcx-known-call-marker",
    startedAt: startedAt.toISOString(),
    completedAt: null,
    outPath,
    dryRun,
    env: {
      accountId: process.env.RINGCX_VOICE_ACCOUNT_ID || null,
      mainAccountId: process.env.RINGCX_VOICE_MAIN_ACCOUNT_ID || null,
      recordingRcAccountId: process.env.RINGCX_RECORDING_RC_ACCOUNT_ID || null,
      baseUrl: process.env.RINGCX_VOICE_BASE_URL || "https://ringcx.ringcentral.com",
    },
    request: {
      agentEmail,
      rcUserId,
      destinationMasked: maskPhone(destination),
      callerIdMasked: maskPhone(callerId),
      ringDuration,
      pollSeconds,
      pollMs,
    },
    private: {
      destination,
      callerId,
    },
    probes: {},
    call: null,
    followUp: {},
  };

  logHeader("known-call marker");
  logKv("agent", agentEmail);
  logKv("destination", maskPhone(destination));
  logKv("callerId", maskPhone(callerId));
  logKv("pollSeconds", pollSeconds);
  logKv("report", outPath);

  marker.probes.whoami = await safe("whoami", () => client.auth.whoami());
  const found = await discoverAgent(client, { agentEmail, rcUserId, agentGroupId: explicitAgentGroupId });
  if (!found) throw new Error(`RingCX agent not found for ${agentEmail}`);
  const agentId = found.agent.agentId || found.agent.id;
  const agentSummary = summarizeAgent(found.agent);
  const username = usernameOverride || agentSummary.usernameRaw || agentEmail;
  const route = routeEnvForRcUserId(agentSummary.rcUserId || rcUserId);

  marker.agent = {
    ...agentSummary,
    agentGroupId: found.agentGroupId,
    usernameForDialMasked: maskEmail(username),
    route,
  };
  marker.probes.accounts = await safe("listAccounts", async () => {
    const value = await client.listAccounts();
    return {
      count: extractRows(value).length || (Array.isArray(value) ? value.length : null),
      recordingFields: findFields(value, /record/i).slice(0, 30),
      keys: value && typeof value === "object" ? Object.keys(value).slice(0, 40) : [],
    };
  });
  marker.probes.agentGroups = await safe("listAgentGroups", async () => {
    const value = await client.listAgentGroups();
    return { count: extractRows(value).length, sample: extractRows(value).slice(0, 10).map((row) => ({ id: row.agentGroupId || row.id, name: row.name || row.description })) };
  });
  marker.probes.dialGroups = await safe("listDialGroups", async () => {
    const value = await client.listDialGroups();
    return {
      count: extractRows(value).length,
      recordingFields: findFields(value, /record/i).slice(0, 30),
      sample: extractRows(value).slice(0, 10).map((row) => ({
        id: row.dialGroupId || row.id,
        name: row.dialGroupName || row.name || row.description,
        dialMode: row.dialMode || row.dialModeType || null,
      })),
    };
  });
  if (route.dialGroupId) {
    marker.probes.routeDialGroup = await safe(`getDialGroup.${route.dialGroupId}`, () => client.getDialGroup(route.dialGroupId));
    marker.probes.routeCampaigns = await safe(`listCampaigns.${route.dialGroupId}`, async () => {
      const value = await client.listCampaigns(route.dialGroupId);
      return {
        count: extractRows(value).length,
        sample: extractRows(value).slice(0, 10).map((row) => ({
          id: row.campaignId || row.id,
          name: row.campaignName || row.name,
          active: row.active ?? row.isActive ?? null,
          callerId: maskPhone(row.callerId),
        })),
      };
    });
  }

  const login = await client.getAgentLogin(agentId, found.agentGroupId).catch((error) => ({
    error: error.message,
    details: error.details?.responseBody || null,
  }));
  marker.probes.agentLogin = {
    label: "getAgentLogin",
    ok: !login.error,
    value: summarizeLogin(login),
  };

  const now = new Date();
  marker.probes.activeBefore = await activeSnapshot(client, "before", {
    accountId: client.config.accountId,
    agentId,
    destination,
    callerId,
    username,
  });
  if (exProbe) {
    marker.probes.exBefore = await exSnapshot("ex.before", {
      extensionId: agentSummary.rcUserId || rcUserId,
      destination,
      from: new Date(now.getTime() - 10 * 60 * 1000),
      to: new Date(now.getTime() + 2 * 60 * 1000),
    });
  }
  if (metadataPrecheck) {
    const end = new Date(Date.now() - 20 * 60 * 1000);
    marker.probes.metadataPrecheck = await safe("interactionMetadata.precheck", () =>
      client.fetchInteractionMetadata({
        startTime: new Date(end.getTime() - 15 * 60 * 1000),
        endTime: end,
      }));
  }

  logHeader("agent");
  logKv("agentId", agentId);
  logKv("agentGroupId", found.agentGroupId);
  logKv("dial username", maskEmail(username));
  logKv("plus alias", agentSummary.hasPlusAlias ? agentSummary.plusAlias : "");
  logKv("manual gate", agentSummary.manualOutboundDefaultGate);
  logKv("login connected", marker.probes.agentLogin.value.connected);
  logKv("login reason", marker.probes.agentLogin.value.reason);
  logKv("route dialGroup", route.dialGroupId);
  logKv("route campaign", route.campaignId);

  if (!marker.probes.agentLogin.value.connected && !force) {
    marker.completedAt = new Date().toISOString();
    marker.refused = {
      reason: "agent-login-not-connected",
      hint: "Log into RingCX Agent portal, select the manual/dial group, and go Connected/off-hook. Rerun with --force only if deliberately testing failure behavior.",
    };
    fs.writeFileSync(outPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    logHeader("refused");
    logKv("reason", marker.refused.reason);
    logKv("report", outPath);
    process.exitCode = 2;
    return;
  }

  if (dryRun) {
    marker.completedAt = new Date().toISOString();
    fs.writeFileSync(outPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
    logHeader("dry run");
    logKv("report", outPath);
    return;
  }

  const requestStartedAt = new Date();
  const baselineIds = new Set([
    ...(marker.probes.activeBefore.account.value?.rows || []).map((row) => row.id).filter(Boolean),
    ...(marker.probes.activeBefore.agent.value?.rows || []).map((row) => row.id).filter(Boolean),
  ]);

  logHeader("placing manual call");
  const placed = await safe("createManualAgentCall", () =>
    client.placeManualCall({
      username,
      destination,
      callerId,
      ringDuration,
    }));
  const ackAt = new Date();
  marker.call = {
    requestStartedAt: requestStartedAt.toISOString(),
    ackAt: ackAt.toISOString(),
    ackMs: ackAt.getTime() - requestStartedAt.getTime(),
    placeResult: placed,
    firstSeenAt: null,
    lastSeenAt: null,
    observedIds: [],
    observations: [],
  };
  logKv("ACK ok", placed.ok);
  logKv("ACK ms", marker.call.ackMs);
  logKv("ACK", placed.ok ? JSON.stringify(placed.value) : placed.error.message);

  const deadline = Date.now() + pollSeconds * 1000;
  let observationCount = 0;
  while (Date.now() < deadline) {
    const observedAt = new Date();
    const snap = await activeSnapshot(client, `poll.${observationCount}`, {
      accountId: client.config.accountId,
      agentId,
      destination,
      callerId,
      username,
    });
    const matches = [
      ...(snap.account.value?.matches || []),
      ...(snap.agent.value?.matches || []),
    ].filter((row) => !row.id || !baselineIds.has(row.id));
    const unique = [];
    const seen = new Set();
    for (const row of matches) {
      const key = row.id || JSON.stringify(row);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(row);
      if (row.id && !marker.call.observedIds.includes(row.id)) {
        marker.call.observedIds.push(row.id);
      }
    }
    if (unique.length > 0) {
      marker.call.firstSeenAt = marker.call.firstSeenAt || observedAt.toISOString();
      marker.call.lastSeenAt = observedAt.toISOString();
      marker.call.observations.push({
        at: observedAt.toISOString(),
        elapsedMs: observedAt.getTime() - requestStartedAt.getTime(),
        matches: unique,
      });
      logKv("active match", `${unique.length} at +${observedAt.getTime() - requestStartedAt.getTime()}ms`);
    }
    observationCount += 1;
    await sleep(pollMs);
  }
  marker.call.pollCompletedAt = new Date().toISOString();
  marker.call.pollCount = observationCount;
  marker.probes.activeAfter = await activeSnapshot(client, "after", {
    accountId: client.config.accountId,
    agentId,
    destination,
    callerId,
    username,
  });
  if (exProbe) {
    marker.probes.exAfter = await exSnapshot("ex.after", {
      extensionId: agentSummary.rcUserId || rcUserId,
      destination,
      from: new Date(requestStartedAt.getTime() - 2 * 60 * 1000),
      to: new Date(Date.now() + 2 * 60 * 1000),
    });
  }

  marker.completedAt = new Date().toISOString();
  marker.followUp = {
    wait: "Wait 20+ minutes after the call ends before running metadata search.",
    metadataCommand: `node scripts/ringcx-known-call-marker.js --metadata-only --marker \"${outPath}\"`,
    recordingDownloadShape: "/voice/api/cx/integration/v1/accounts/{rcAccountId}/sub-accounts/{subAccountId}/recordings/dialogs/{dialogId}/segments/{segmentId}",
  };
  fs.writeFileSync(outPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");

  logHeader("summary");
  logKv("placed", placed.ok);
  logKv("active observed", Boolean(marker.call.firstSeenAt));
  logKv("first seen", marker.call.firstSeenAt);
  logKv("last seen", marker.call.lastSeenAt);
  logKv("observed ids", marker.call.observedIds.join(", "));
  logKv("report", outPath);
  logKv("later", marker.followUp.metadataCommand);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error.stack || error.message);
  process.exit(1);
});
