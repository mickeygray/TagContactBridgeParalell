"use strict";

// RingCX manual dial smoke using the browser-session Cookie shape.
//
// This intentionally does NOT use createRingcxVoiceClient's bearer auth.
// The manual request that successfully rang Sean's outbound leg used:
//
//   POST https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/{accountId}/activeCalls/createManualAgentCall?...query...
//   Cookie: access_token=...; ev_acc=...; ev_plat=...; refresh_token=...
//   body: empty string
//
// Usage:
//   node scripts/ringcx-manual-cookie-smoke.js --username mgray+50810001_9702@taxadvocategroup.com --to 13106665997 --caller-id 8182728593 --cookie "access_token=...; ev_acc=50810000; ev_plat=eo-p07; refresh_token=..."
//
// Or pass pieces by env:
//   RINGCX_COOKIE_ACCESS_TOKEN=...
//   RINGCX_COOKIE_REFRESH_TOKEN=...
//   RINGCX_COOKIE_EV_ACC=50810000
//   RINGCX_COOKIE_EV_PLAT=eo-p07

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function maskCookie(cookie) {
  return String(cookie || "")
    .split(";")
    .map((part) => {
      const [key, ...rest] = part.trim().split("=");
      if (!key) return "";
      const value = rest.join("=");
      if (!value) return key;
      return `${key}=${value.slice(0, 6)}...${value.slice(-4)}`;
    })
    .filter(Boolean)
    .join("; ");
}

function cookieFromEnv() {
  const accessToken = process.env.RINGCX_COOKIE_ACCESS_TOKEN || "";
  const refreshToken = process.env.RINGCX_COOKIE_REFRESH_TOKEN || "";
  const evAcc = process.env.RINGCX_COOKIE_EV_ACC || "50810000";
  const evPlat = process.env.RINGCX_COOKIE_EV_PLAT || "eo-p07";
  if (!accessToken) return "";
  return [
    `access_token=${accessToken}`,
    `ev_acc=${evAcc}`,
    `ev_plat=${evPlat}`,
    refreshToken ? `refresh_token=${refreshToken}` : "",
  ].filter(Boolean).join("; ");
}

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

async function cookieFromExchange() {
  const client = createRingcxVoiceClient();
  const token = await client.auth.ensureToken();
  const claims = decodeJwtPayload(token.accessToken);
  const evAcc = process.env.RINGCX_COOKIE_EV_ACC || String(claims.acct || "50810000");
  const evPlat = process.env.RINGCX_COOKIE_EV_PLAT || String(claims.plat || "eo-p07");
  return [
    `access_token=${token.accessToken}`,
    `ev_acc=${evAcc}`,
    `ev_plat=${evPlat}`,
    token.refreshToken ? `refresh_token=${token.refreshToken}` : "",
  ].filter(Boolean).join("; ");
}

async function requestJson(url, cookie, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Cookie: cookie,
      Accept: "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 ringcx-browser-cookie-smoke",
    },
    body,
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text.
  }
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    body: parsed,
  };
}

function extractRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.content)) return value.content;
  return [];
}

function rowId(row = {}) {
  return String(row.uii || row.UII || row.callId || row.activeCallId || row.interactionId || "");
}

function rowMatchesPhone(row, phone) {
  const last10 = normalizePhone(phone).slice(-10);
  return Boolean(last10 && JSON.stringify(row || "").includes(last10));
}

function summarizeCall(row = {}) {
  return {
    id: rowId(row) || null,
    state: row.state || row.callState || row.status || row.dialState || null,
    phone: maskPhone(row.phone || row.destination || row.leadPhone || row.customerPhone || row.dnis || row.ani),
  };
}

function logKv(key, value) {
  console.log(`  ${String(key).padEnd(24)} ${value == null || value === "" ? "(none)" : value}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const base = (readFlag(argv, "--base", process.env.RINGCX_VOICE_BASE_URL || "https://ringcx.ringcentral.com") || "").replace(/\/$/, "");
  const accountId = readFlag(argv, "--account-id", process.env.RINGCX_VOICE_ACCOUNT_ID || "50810001");
  const username = readFlag(argv, "--username", "mgray+50810001_9702@taxadvocategroup.com");
  const destination = normalizePhone(readFlag(argv, "--to", "13106665997"));
  const callerId = normalizePhone(readFlag(argv, "--caller-id", "8182728593"));
  const ringDuration = Math.max(5, Math.min(60, Number(readFlag(argv, "--ring-duration", "20")) || 20));
  const timeoutMs = Math.max(5000, Math.min(120000, (Number(readFlag(argv, "--timeout-sec", "45")) || 45) * 1000));
  const pollMs = Math.max(1000, Math.min(10000, Number(readFlag(argv, "--poll-ms", "1000")) || 1000));
  const cookie = readFlag(argv, "--cookie", "") || cookieFromEnv() || await cookieFromExchange();

  if (!cookie) throw new Error("Missing browser cookie and exchanged RingCX token.");
  if (!username) throw new Error("--username is required");
  if (!destination) throw new Error("--to is required");
  if (!callerId) throw new Error("--caller-id is required");

  const qs = new URLSearchParams({
    username,
    destination,
    ringDuration: String(ringDuration),
    callerId,
  });
  const manualUrl = `${base}/voice/api/v1/admin/accounts/${accountId}/activeCalls/createManualAgentCall?${qs.toString()}`;
  const activeUrl = `${base}/voice/api/v1/admin/accounts/${accountId}/activeCalls/list?product=ACCOUNT&productId=${encodeURIComponent(accountId)}`;

  console.log("RingCX manual cookie smoke");
  logKv("username", username.replace(/^(.{3}).*(@.*)$/, "$1***$2"));
  logKv("destination", maskPhone(destination));
  logKv("callerId", maskPhone(callerId));
  logKv("cookie", maskCookie(cookie));
  logKv("manual path", `/voice/api/v1/admin/accounts/${accountId}/activeCalls/createManualAgentCall`);

  const before = await requestJson(activeUrl, cookie);
  const beforeRows = before.ok ? extractRows(before.body) : [];
  const baselineIds = new Set(beforeRows.map(rowId).filter(Boolean));
  logKv("active before status", before.status);
  logKv("active before count", beforeRows.length);

  const startedAt = Date.now();
  const placed = await requestJson(manualUrl, cookie, { method: "POST", body: "" });
  const ackMs = Date.now() - startedAt;
  logKv("POST status", `${placed.status} ${placed.statusText}`);
  logKv("ACK ms", ackMs);
  logKv("response", JSON.stringify(placed.body));

  let firstSeen = null;
  let observations = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const active = await requestJson(activeUrl, cookie);
    observations += 1;
    if (!active.ok) {
      logKv("active poll failed", `${active.status} ${JSON.stringify(active.body).slice(0, 180)}`);
      break;
    }
    const rows = extractRows(active.body);
    const matches = rows.filter((row) => {
      const id = rowId(row);
      return (!id || !baselineIds.has(id)) && rowMatchesPhone(row, destination);
    });
    if (matches.length > 0) {
      firstSeen = { atMs: Date.now() - startedAt, rows: matches.map(summarizeCall) };
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  console.log("\nSummary");
  logKv("active call observed", Boolean(firstSeen));
  logKv("firstSeenMs", firstSeen?.atMs || "");
  logKv("observations", observations);
  if (firstSeen) {
    console.log(JSON.stringify(firstSeen.rows, null, 2));
  }
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
