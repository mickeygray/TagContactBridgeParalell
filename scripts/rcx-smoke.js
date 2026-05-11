"use strict";

// RingCX Digital API smoke test.
//
// Hits a handful of safe GET endpoints against the account's RingCX
// Digital API and reports status + a redacted response shape so we
// can confirm the key is good and learn the actual response payloads
// before writing a real client.
//
// Usage:
//   node scripts/rcx-smoke.js
//   node scripts/rcx-smoke.js --endpoint /1.0/users
//   node scripts/rcx-smoke.js --raw          # dump full response bodies
//
// Reads from .env:
//   RCX_API_KEY  — static bearer token
//   RCX_API_URL  — account-specific base, e.g.
//                  https://krlwaujtqq.api.digital.ringcentral.com
//   RCX_API_ID   — application id (informational, not used in the auth header)

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const BASE_URL = String(process.env.RCX_API_URL || "").replace(/\/$/, "");
const API_KEY = String(process.env.RCX_API_KEY || "");
const APP_ID = String(process.env.RCX_API_ID || "");

if (!BASE_URL) {
  console.error("RCX_API_URL not set in .env");
  process.exit(1);
}
if (!API_KEY) {
  console.error("RCX_API_KEY not set in .env");
  process.exit(1);
}

const ENDPOINTS_TO_HIT = [
  // Identity / who-am-i — confirms the key is active and tied to an
  // account. Different vendor docs spell this differently so try a few.
  "/1.0/me",
  "/1.0/account",

  // Users / agents — list the operators on this account.
  "/1.0/users?per_page=3",

  // Channels — the digital intake routes (chat, email, social, etc).
  "/1.0/sources?per_page=3",
  "/1.0/channels?per_page=3",

  // Categories — the routing/intent buckets a contact can fall into.
  "/1.0/categories?per_page=3",

  // Interventions — actual customer-facing work items (chat sessions,
  // email threads, social DMs). Most reliable "is the key alive" probe
  // per the Engage docs.
  "/1.0/interventions?per_page=3",

  // Contacts — the customer records.
  "/1.0/contacts?per_page=3",

  // Threads — interaction containers.
  "/1.0/threads?per_page=3",
];

function readFlag(argv, name) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

function previewBody(text, max = 600) {
  if (!text) return "(empty)";
  if (text.length <= max) return text;
  return text.slice(0, max) + `… <${text.length - max} more chars>`;
}

function summarizeJson(value, depth = 0) {
  if (value == null) return "null";
  if (typeof value !== "object") return `${typeof value}`;
  if (Array.isArray(value)) {
    return `Array(${value.length})${value[0] ? ` of ${summarizeJson(value[0], depth + 1)}` : ""}`;
  }
  const keys = Object.keys(value);
  if (depth >= 2) return `Object{${keys.length} keys}`;
  return "{" + keys.slice(0, 8).map((k) => `${k}: ${summarizeJson(value[k], depth + 1)}`).join(", ") + (keys.length > 8 ? ", …" : "") + "}";
}

async function probe(endpoint, { raw = false } = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const started = Date.now();
  let status = 0;
  let bodyText = "";
  let json = null;
  let err = null;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        "User-Agent": "TagContactBridgeParallel-rcx-smoke/0.1",
      },
    });
    status = res.status;
    bodyText = await res.text();
    try { json = bodyText ? JSON.parse(bodyText) : null; } catch { /* not JSON */ }
  } catch (e) {
    err = e.message;
  }
  const ms = Date.now() - started;

  const ok = status >= 200 && status < 300;
  const flag = ok ? "✅" : status > 0 ? "❌" : "💥";
  console.log(`${flag} ${status || "ERR"}  ${ms}ms  GET ${endpoint}`);
  if (err) {
    console.log(`     network: ${err}`);
    return { endpoint, ok: false, status: 0, error: err };
  }
  if (json && typeof json === "object") {
    console.log(`     shape: ${summarizeJson(json)}`);
  }
  if (!ok || raw) {
    console.log(`     body: ${previewBody(bodyText)}`);
  }
  return { endpoint, ok, status, ms, json, bodyText };
}

async function main() {
  const argv = process.argv.slice(2);
  const single = readFlag(argv, "--endpoint");
  const raw = hasFlag(argv, "--raw");

  console.log(`base: ${BASE_URL}`);
  console.log(`appId: ${APP_ID || "(not set)"}`);
  console.log(`key: ${API_KEY.slice(0, 6)}…${API_KEY.slice(-4)} (${API_KEY.length} chars)`);
  console.log("");

  const list = single ? [single] : ENDPOINTS_TO_HIT;
  const results = [];
  for (const endpoint of list) {
    const result = await probe(endpoint, { raw });
    results.push(result);
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log("");
  console.log(`summary: ${ok}/${results.length} 200s, ${fail} failures`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
