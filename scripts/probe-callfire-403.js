"use strict";

// Diagnostic: probe the CallFire 403 we hit when adding recipients to a
// freshly-created broadcast. Pulls the broadcast metadata, replays the
// recipients POST with a single dummy contact, and dumps every header
// + response body CallFire returns. Also lists recent broadcasts so we
// can compare a "good" broadcast (created via their UI) against ours
// to spot type / config mismatches.
//
// Usage:
//   node scripts/probe-callfire-403.js                         # uses 288635092003
//   node scripts/probe-callfire-403.js 288635092003            # explicit
//   node scripts/probe-callfire-403.js 288635092003 5551234567 # send a real-format dummy
//
// Throwaway — delete once we sort out the 403.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const BROADCAST_ID = String(process.argv[2] || "288635092003");
const DUMMY_PHONE = String(process.argv[3] || "5555550100"); // toll-free range, safe
const BASE_URL = (process.env.CALLFIRE_BASE_URL || "https://api.callfire.com/v2/")
  .replace(/\/+$/, "/") || "https://api.callfire.com/v2/";
const USER = process.env.CALLFIRE_USER || "";
const PASS = process.env.CALLFIRE_PASSWORD || "";

if (!USER || !PASS) {
  // eslint-disable-next-line no-console
  console.error("Missing CALLFIRE_USER / CALLFIRE_PASSWORD in .env");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

async function callfire(pathSuffix, init = {}) {
  const url = new URL(pathSuffix.replace(/^\//, ""), BASE_URL).toString();
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: AUTH,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return {
    url,
    method: init.method || "GET",
    status: response.status,
    ok: response.ok,
    elapsedMs: Date.now() - startedAt,
    headers: Object.fromEntries(response.headers.entries()),
    body: parsed,
    rawBodyTextLen: text ? text.length : 0,
  };
}

(async function main() {
  const out = {};

  // 1. Account / who-am-I — confirms credentials AND surfaces the
  //    permissions/role the API key carries.
  out.me = await callfire("me");
  out.meCredits = await callfire("me/credits").catch((error) => ({
    error: String(error?.message || error),
  }));

  // 2. Broadcast detail — see its type, state, sound config, etc.
  out.broadcast = await callfire(`calls/broadcasts/${encodeURIComponent(BROADCAST_ID)}`);

  // 3. Replay the failing add-recipients call with a single dummy. Use
  //    the same body shape outboundCallFireService uses (array of
  //    objects with phoneNumber). If CallFire wants a different shape
  //    we'll see that in the error response.
  out.addRecipientsAttempt = await callfire(
    `calls/broadcasts/${encodeURIComponent(BROADCAST_ID)}/recipients`,
    {
      method: "POST",
      body: JSON.stringify([{ phoneNumber: DUMMY_PHONE }]),
    },
  );

  // 4. Recent broadcasts list — pick a "good" one to compare type/state.
  out.recentBroadcasts = await callfire("calls/broadcasts?limit=5");

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2));
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
