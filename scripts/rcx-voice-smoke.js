"use strict";

// RingCX VOICE API smoke test.
//
// Voice doesn't use a "generated API key" — it uses the RingCentral
// OAuth/JWT credentials you already have, then exchanges the RC
// access token for a RingCX Voice bearer token via:
//   POST https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken
//
// Steps:
//   1. JWT-auth to platform.ringcentral.com → RC access token
//   2. Trade the RC token for a RingCX Voice token + accountId
//   3. Hit a few safe Voice GET endpoints with the new token
//
// Reads from .env:
//   RING_CENTRAL_JWT_TOKEN
//   RING_CENTRAL_CLIENT_ID
//   RING_CENTRAL_CLIENT_SECRET
//   RING_CENTRAL_SERVER_URL  (default https://platform.ringcentral.com)

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const RC_CLIENT_ID = process.env.RING_CENTRAL_CLIENT_ID || "";
const RC_CLIENT_SECRET = process.env.RING_CENTRAL_CLIENT_SECRET || "";
const RC_JWT = process.env.RING_CENTRAL_JWT_TOKEN || "";
const RCX_VOICE_BASE = "https://ringcx.ringcentral.com";

if (!RC_JWT || !RC_CLIENT_ID || !RC_CLIENT_SECRET) {
  console.error("Missing RC creds in .env (need RING_CENTRAL_JWT_TOKEN + CLIENT_ID + CLIENT_SECRET)");
  process.exit(1);
}

function summarize(value, depth = 0) {
  if (value == null) return "null";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) {
    return `Array(${value.length})${value[0] ? ` of ${summarize(value[0], depth + 1)}` : ""}`;
  }
  const keys = Object.keys(value);
  if (depth >= 2) return `Object{${keys.length}}`;
  return "{" + keys.slice(0, 8).map((k) => `${k}: ${summarize(value[k], depth + 1)}`).join(", ") + (keys.length > 8 ? ", …" : "") + "}";
}

async function getRcAccessToken() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: RC_JWT,
  });
  const basic = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!res.ok) {
    throw new Error(`RC OAuth failed: ${res.status} ${text}`);
  }
  if (!json?.access_token) {
    throw new Error(`RC OAuth response missing access_token: ${text}`);
  }
  return json;
}

async function exchangeForRingcxToken(rcAccessToken, rcTokenType) {
  const body = new URLSearchParams({
    rcAccessToken: rcAccessToken,
    rcTokenType: rcTokenType || "Bearer",
  });
  const res = await fetch(`${RCX_VOICE_BASE}/api/auth/login/rc/accesstoken?includeRefresh=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    throw new Error(`RingCX exchange failed: ${res.status} ${text}`);
  }
  return json;
}

async function probe(label, url, token) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "TagContactBridgeParallel-rcx-voice-smoke/0.1",
      },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    const ms = Date.now() - t0;
    const ok = res.status >= 200 && res.status < 300;
    const flag = ok ? "✅" : res.status === 403 ? "🔒" : res.status === 404 ? "—" : "❌";
    console.log(`${flag} ${res.status}  ${ms}ms  ${label}`);
    if (json && typeof json === "object") {
      console.log(`     shape: ${summarize(json)}`);
    }
    if (!ok) {
      const preview = text.length > 400 ? text.slice(0, 400) + "…" : text;
      console.log(`     body: ${preview}`);
    }
    return { ok, status: res.status, json, text };
  } catch (e) {
    console.log(`💥 ERR ${label}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.log("=== Step 1: RC OAuth (JWT → access token) ===");
  let rcToken;
  try {
    rcToken = await getRcAccessToken();
    console.log(`✅ got RC access_token (expires_in ${rcToken.expires_in}s, scopes: ${rcToken.scope || "—"})`);
    console.log(`   owner_id: ${rcToken.owner_id || "?"} · token_type: ${rcToken.token_type || "?"}`);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  console.log("\n=== Step 2: Exchange for RingCX Voice token ===");
  let voice;
  try {
    voice = await exchangeForRingcxToken(rcToken.access_token, rcToken.token_type);
    // accountId resolution — different fields populated depending on
    // whether the SSO user is a Voice agent or an admin:
    //   - agentDetails[0].accountId  → set when logged in as an agent
    //   - mainAccountId              → set when logged in as admin/SSO
    //   - managedMainAccountIds[0]   → multi-account admins
    const accountId = voice.agentDetails?.[0]?.accountId
      || voice.agentDetails?.[0]?.account?.accountId
      || voice.mainAccountId
      || voice.managedMainAccountIds?.[0]
      || voice.accountId
      || null;
    console.log(`✅ got RingCX Voice token (${(voice.accessToken || "").length} chars)`);
    console.log(`   tokenType: ${voice.tokenType || "?"}`);
    console.log(`   refreshToken: ${voice.refreshToken ? "present" : "absent"}`);
    console.log(`   accountId: ${accountId || "(not in response)"}`);
    if (Array.isArray(voice.agentDetails) && voice.agentDetails[0]) {
      console.log(`   agentDetails[0] keys: ${Object.keys(voice.agentDetails[0]).join(", ")}`);
    } else {
      console.log(`   agentDetails: ${summarize(voice.agentDetails)}`);
    }
    if (!accountId) {
      console.log("\n⚠ accountId not found in response. Full token payload:");
      console.log(JSON.stringify(voice, null, 2));
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    console.error("\nThis usually means one of:");
    console.error("  1. The RingCentral app doesn't have the RingCX Voice scope/role attached");
    console.error("  2. RingCX Voice isn't provisioned on the account");
    console.error("  3. The user that minted the JWT isn't an RingCX Voice agent");
    process.exit(1);
  }

  const accountId = voice.agentDetails?.[0]?.accountId
    || voice.agentDetails?.[0]?.account?.accountId
    || voice.mainAccountId
    || voice.managedMainAccountIds?.[0]
    || voice.accountId;
  if (!accountId) {
    console.error("\nCan't continue without accountId");
    process.exit(1);
  }

  console.log("\n=== Step 3: Probe Voice API endpoints ===");
  const base = `${RCX_VOICE_BASE}/voice/api/v1/admin/accounts/${accountId}`;

  await probe(`GET /admin/accounts/{id}/dialGroups`, `${base}/dialGroups`, voice.accessToken);
  await probe(`GET /admin/accounts/{id}/agentGroups`, `${base}/agentGroups`, voice.accessToken);
  await probe(`GET /admin/accounts/{id}/queues`, `${base}/queues`, voice.accessToken);
  await probe(`GET /admin/accounts/{id}/auxStates`, `${base}/auxStates?activeOnly=true`, voice.accessToken);
  await probe(`GET /admin/accounts/{id}/dispositions`, `${base}/dispositions`, voice.accessToken);
  await probe(`GET /admin/accounts (no path)`, `${RCX_VOICE_BASE}/voice/api/v1/admin/accounts`, voice.accessToken);

  console.log("\n=== Done ===");
  console.log("If you see 200s above, Voice is provisioned and ready.");
  console.log("Capture this accountId for .env:");
  console.log(`   RINGCX_VOICE_ACCOUNT_ID=${accountId}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
