"use strict";

// Quick deeper probe — try every candidate accountId from the
// /admin/accounts list and a wider set of endpoints to figure out
// where our permissions actually let us read.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

async function rcAuth() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RINGCX_PLATFORM_JWT_TOKEN || process.env.RING_CENTRAL_JWT_TOKEN2,
  });
  const basic = Buffer.from(
    `${process.env.RINGCX_PLATFORM_CLIENT_ID || process.env.RING_CENTRAL_CLIENT_ID2}:${
      process.env.RINGCX_PLATFORM_CLIENT_SECRET || process.env.RING_CENTRAL_CLIENT_SECRET2
    }`,
  ).toString("base64");
  const r = await fetch("https://platform.ringcentral.com/restapi/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return r.json();
}

async function rcxAuth(rcTok) {
  const body = new URLSearchParams({ rcAccessToken: rcTok, rcTokenType: "Bearer" });
  const r = await fetch(
    "https://ringcx.ringcentral.com/api/auth/login/rc/accesstoken?includeRefresh=true",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  return r.json();
}

async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

(async () => {
  const rcTok = await rcAuth();
  const v = await rcxAuth(rcTok.access_token);

  console.log("=== /admin/accounts ===");
  const accts = await get("https://ringcx.ringcentral.com/voice/api/v1/admin/accounts", v.accessToken);
  console.log(`status: ${accts.status}`);
  console.log(JSON.stringify(accts.json, null, 2));
  console.log("");

  console.log("=== Try every accountId field against /dialGroups ===");
  console.log(`mainAccountId from token: ${v.mainAccountId}`);
  if (Array.isArray(accts.json)) {
    for (const acct of accts.json) {
      console.log("");
      console.log(`-- account row keys: ${Object.keys(acct).join(", ")}`);
      for (const idField of ["accountId", "mainAccountId"]) {
        const id = acct[idField];
        if (!id || id === "null") continue;
        const r = await get(
          `https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/${id}/dialGroups`,
          v.accessToken,
        );
        console.log(`  ${idField}=${id} → dialGroups: ${r.status}  ${(r.text || "").slice(0, 160)}`);
      }
    }
  }

  console.log("");
  console.log("=== Wider probe with SUB accountId (the right one) ===");
  // Pick the first sub-account from the /admin/accounts response.
  // mainAccountId is the umbrella; every resource lives under the sub.
  const subAcct = (Array.isArray(accts.json) ? accts.json[0] : null) || {};
  const id = subAcct.accountId || v.mainAccountId;
  console.log(`using accountId=${id}`);
  const endpoints = [
    "dialGroups",
    "agentGroups",
    "users",
    "queues",
    "auxStates",
    "auxStates?activeOnly=true",
    "campaignDispositions",
    "campaignSchedules",
    "userGroups",
    "supervisors",
    "ringoutAccess",
    "skills",
    "rcUsers",
    "subAccounts",
    "ivrs",
    "broadcasts",
  ];
  for (const ep of endpoints) {
    const r = await get(
      `https://ringcx.ringcentral.com/voice/api/v1/admin/accounts/${id}/${ep}`,
      v.accessToken,
    );
    const flag = r.status >= 200 && r.status < 300 ? "✅" : r.status === 403 ? "🔒" : r.status === 500 ? "💥" : "—";
    console.log(`${flag} ${r.status}  /${ep}`);
  }
})().catch(e => { console.error("ERR", e); process.exit(1); });
