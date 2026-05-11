"use strict";

// RingCX Voice config discovery + .env block emitter.
//
// Walks every reachable resource on the sub-account and prints a
// clean .env block to paste in. Run after creating a dial group or
// new agent group in the RingCX admin UI to capture the new IDs.
//
//   node scripts/rcx-voice-discover.js              # print to stdout
//   node scripts/rcx-voice-discover.js --append     # also append to .env
//
// Reads:
//   RING_CENTRAL_JWT_TOKEN, RING_CENTRAL_CLIENT_ID, RING_CENTRAL_CLIENT_SECRET
//
// Writes (when --append):
//   RINGCX_VOICE_BASE_URL
//   RINGCX_VOICE_TOKEN_EXCHANGE_PATH
//   RINGCX_VOICE_TOKEN_REFRESH_PATH
//   RINGCX_VOICE_MAIN_ACCOUNT_ID
//   RINGCX_VOICE_ACCOUNT_ID                  (sub-account — use in resource paths)
//   RINGCX_VOICE_ACCOUNT_NAME
//   RINGCX_VOICE_DIGITAL_DOMAIN_ID
//   RINGCX_VOICE_ACCOUNT_TYPE
//   RINGCX_VOICE_HCI_DIALER_ENABLED
//   RINGCX_VOICE_RC_USER_ID                  (the RC user that minted the JWT)
//   RINGCX_VOICE_RC_USER_EMAIL
//   RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID      (first agentGroup, if any)
//   RINGCX_VOICE_DEFAULT_AGENT_GROUP_NAME
//   RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID       (first dialGroup, if any)
//   RINGCX_VOICE_DEFAULT_DIAL_GROUP_NAME
//   RINGCX_VOICE_AUX_AVAILABLE_STATE_ID      (the AVAILABLE state, agents must be here to dial)

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");
const RCX_VOICE_BASE = "https://ringcx.ringcentral.com";

async function rcAuth() {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: process.env.RING_CENTRAL_JWT_TOKEN,
  });
  const basic = Buffer.from(
    `${process.env.RING_CENTRAL_CLIENT_ID}:${process.env.RING_CENTRAL_CLIENT_SECRET}`,
  ).toString("base64");
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`RC OAuth failed: ${r.status} ${await r.text()}`);
  return r.json();
}

// Resolve an RC extension by email so we can capture its `id` and use
// it as the `rcUserId` field on a RingCX agent record. Walks the
// account's extensions list, filters by `contact.email`. Read scope
// `ReadAccounts` is required (mgray's JWT has it).
//
// Returns the FULL extension record so callers can also pick up
// firstName / lastName for the agent's display name (otherwise we'd
// have to guess and end up with "Bryce" vs "Bruce" mistakes).
async function resolveRcUserIdByEmail(rcAccessToken, email) {
  if (!email) return null;
  const target = String(email).trim().toLowerCase();
  let perPage = 200;
  let page = 1;
  while (page <= 10) {
    const url = `${RC_BASE}/restapi/v1.0/account/~/extension?perPage=${perPage}&page=${page}&type=User`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${rcAccessToken}`, Accept: "application/json" },
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`extension list page=${page}: ${r.status} ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    const records = Array.isArray(data.records) ? data.records : [];
    const hit = records.find(
      (ext) => String(ext?.contact?.email || "").toLowerCase() === target,
    );
    if (hit) {
      return {
        id: hit.id,
        extensionNumber: hit.extensionNumber,
        contact: hit.contact,
        firstName: hit.contact?.firstName || "",
        lastName: hit.contact?.lastName || "",
      };
    }
    if (records.length < perPage) return null;
    page += 1;
  }
  return null;
}

async function rcxAuth(rcTok) {
  const body = new URLSearchParams({ rcAccessToken: rcTok, rcTokenType: "Bearer" });
  const r = await fetch(`${RCX_VOICE_BASE}/api/auth/login/rc/accesstoken?includeRefresh=true`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`RingCX exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function get(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

function readFlag(argv, name) {
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}

(async () => {
  const argv = process.argv.slice(2);
  const append = argv.includes("--append");
  // Agent identity — separate from the admin/auth identity that
  // mints the JWT. Defaults to the existing env value, falls back to
  // ballen@taxadvocategroup.com (the dedicated agent license holder
  // per project notes), and any override flag wins.
  const agentEmail = readFlag(argv, "--agent-email")
    || process.env.RINGCX_VOICE_AGENT_EMAIL
    || "ballen@taxadvocategroup.com";

  console.log("=== Authenticating ===");
  const rcTok = await rcAuth();
  const v = await rcxAuth(rcTok.access_token);
  console.log(`✅ RC + RingCX tokens acquired (rcUser: ${v.rcUser?.email || "?"})`);
  console.log(`   admin/auth identity:  ${v.rcUser?.email}`);
  console.log(`   agent identity:       ${agentEmail}`);

  // Look up the agent's RC extension id + name so we can stamp them
  // on the RingCX agent record as `rcUserId` / `firstName` / `lastName`
  // (links Voice agent ↔ RC user for SSO + presence sync, and avoids
  // having to guess the display name).
  let agentRcUserId = "";
  let agentFirstName = "";
  let agentLastName = "";
  try {
    const ext = await resolveRcUserIdByEmail(rcTok.access_token, agentEmail);
    if (ext) {
      agentRcUserId = String(ext.id);
      agentFirstName = ext.firstName || "";
      agentLastName = ext.lastName || "";
      console.log(`   resolved agent rcUserId: ${agentRcUserId} (ext ${ext.extensionNumber || "?"})`);
      console.log(`   resolved agent name:     ${agentFirstName} ${agentLastName}`);
    } else {
      console.log(`   ⚠ no RC extension found for ${agentEmail} — leaving RINGCX_VOICE_AGENT_RC_USER_ID blank`);
    }
  } catch (e) {
    console.log(`   ⚠ rc user lookup failed: ${e.message}`);
  }
  console.log("");

  const accts = await get(`${RCX_VOICE_BASE}/voice/api/v1/admin/accounts`, v.accessToken);
  if (!Array.isArray(accts.json) || accts.json.length === 0) {
    throw new Error("No accounts visible to this user");
  }
  const sub = accts.json[0]; // pick the first sub-account (Tax Support has just one)
  const accountId = sub.accountId;
  console.log(`Using sub-account: ${sub.accountName} (id=${accountId}, main=${sub.mainAccountId})`);
  console.log(`  HCI dialer enabled: ${sub.enableHciDialer}`);
  console.log(`  Account type: ${sub.accountType}`);
  console.log("");

  const base = `${RCX_VOICE_BASE}/voice/api/v1/admin/accounts/${accountId}`;

  console.log("=== Walking resources ===");
  const dialGroups = await get(`${base}/dialGroups`, v.accessToken);
  console.log(`✅ ${dialGroups.status} /dialGroups → ${(dialGroups.json || []).length} entries`);
  for (const g of dialGroups.json || []) {
    console.log(`     - ${g.dialGroupId || g.id}  ${g.dialGroupName || g.name || ""}  mode=${g.dialMode || g.dialerMode || "?"}`);
  }

  const agentGroups = await get(`${base}/agentGroups`, v.accessToken);
  console.log(`✅ ${agentGroups.status} /agentGroups → ${(agentGroups.json || []).length} entries`);
  for (const g of agentGroups.json || []) {
    console.log(`     - ${g.agentGroupId || g.id}  ${g.agentGroupName || g.name || ""}`);
  }

  // auxStates field shape (confirmed from live response):
  //   stateId           — numeric id used in agent state-change calls
  //   agentAuxState     — display key (AVAILABLE, ON-BREAK, etc)
  //   baseAgentState.colKey  — canonical state code (same as agentAuxState
  //                            when not custom)
  const auxStates = await get(`${base}/auxStates?activeOnly=true`, v.accessToken);
  console.log(`✅ ${auxStates.status} /auxStates → ${(auxStates.json || []).length} entries`);
  let availableStateId = null;
  const auxStateIds = {};
  for (const s of auxStates.json || []) {
    const code = String(s.agentAuxState || s.baseAgentState?.colKey || "").toUpperCase();
    if (code === "AVAILABLE") availableStateId = s.stateId;
    if (code) auxStateIds[code] = s.stateId;
    console.log(`     - ${s.stateId}  ${code}  (${s.baseAgentState?.colLabel || "?"})${code === "AVAILABLE" ? "  ← AVAILABLE" : ""}`);
  }

  console.log("");
  console.log("=== Captured config ===");
  const lines = [
    "",
    "# ────────────────────────────────────────────────────────",
    "# RingCX Voice (outbound dialer) — captured by",
    "# scripts/rcx-voice-discover.js. Re-run that script after",
    "# creating new dial groups / agent groups in the RingCX",
    "# admin UI to refresh these IDs.",
    "# ────────────────────────────────────────────────────────",
    `RINGCX_VOICE_BASE_URL=${RCX_VOICE_BASE}`,
    "RINGCX_VOICE_TOKEN_EXCHANGE_PATH=/api/auth/login/rc/accesstoken",
    "RINGCX_VOICE_TOKEN_REFRESH_PATH=/api/auth/token/refresh",
    `RINGCX_VOICE_MAIN_ACCOUNT_ID=${sub.mainAccountId}`,
    `RINGCX_VOICE_ACCOUNT_ID=${accountId}`,
    `RINGCX_VOICE_ACCOUNT_NAME=${sub.accountName || ""}`,
    `RINGCX_VOICE_DIGITAL_DOMAIN_ID=${sub.digitalDomainId || ""}`,
    `RINGCX_VOICE_ACCOUNT_TYPE=${sub.accountType || ""}`,
    `RINGCX_VOICE_HCI_DIALER_ENABLED=${sub.enableHciDialer ? "true" : "false"}`,
    `# Admin / auth identity — the user that mints the JWT and hits the API`,
    `RINGCX_VOICE_RC_USER_ID=${rcTok.owner_id || ""}`,
    `RINGCX_VOICE_RC_USER_EMAIL=${v.rcUser?.email || ""}`,
    `# Agent identity — the user that takes calls (separate from admin)`,
    `RINGCX_VOICE_AGENT_EMAIL=${agentEmail}`,
    `RINGCX_VOICE_AGENT_RC_USER_ID=${agentRcUserId}`,
    `RINGCX_VOICE_AGENT_FIRST_NAME=${agentFirstName}`,
    `RINGCX_VOICE_AGENT_LAST_NAME=${agentLastName}`,
    `RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID=${(agentGroups.json?.[0]?.agentGroupId || agentGroups.json?.[0]?.id) || ""}`,
    `RINGCX_VOICE_DEFAULT_AGENT_GROUP_NAME=${agentGroups.json?.[0]?.agentGroupName || agentGroups.json?.[0]?.name || ""}`,
    `RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID=${(dialGroups.json?.[0]?.dialGroupId || dialGroups.json?.[0]?.id) || ""}`,
    `RINGCX_VOICE_DEFAULT_DIAL_GROUP_NAME=${dialGroups.json?.[0]?.dialGroupName || dialGroups.json?.[0]?.name || ""}`,
    `RINGCX_VOICE_AUX_AVAILABLE_STATE_ID=${availableStateId || ""}`,
    `RINGCX_VOICE_AUX_ON_BREAK_STATE_ID=${auxStateIds["ON-BREAK"] || ""}`,
    `RINGCX_VOICE_AUX_AWAY_STATE_ID=${auxStateIds["AWAY"] || ""}`,
    `RINGCX_VOICE_AUX_LUNCH_STATE_ID=${auxStateIds["LUNCH"] || ""}`,
    `RINGCX_VOICE_AUX_TRAINING_STATE_ID=${auxStateIds["TRAINING"] || ""}`,
    `RINGCX_VOICE_AUX_WORKING_STATE_ID=${auxStateIds["WORKING"] || ""}`,
    "",
  ];
  console.log(lines.join("\n"));

  if (append) {
    const envPath = path.resolve(__dirname, "..", ".env");
    const current = fs.readFileSync(envPath, "utf8");
    // Strip any prior block we'd previously appended (idempotent)
    const marker = "# RingCX Voice (outbound dialer)";
    let next = current;
    const idx = current.indexOf(marker);
    if (idx >= 0) {
      // Find the end of the block — next blank line followed by non-RINGCX_VOICE line
      const after = current.slice(idx);
      const blankAfter = after.search(/\n[ \t]*\n/);
      const cut = blankAfter > 0 ? blankAfter + 1 : after.length;
      next = current.slice(0, idx).replace(/\n+$/, "") + current.slice(idx + cut);
    }
    if (!next.endsWith("\n")) next += "\n";
    next += lines.join("\n").replace(/^\n/, "");
    fs.writeFileSync(envPath, next, "utf8");
    console.log(`✅ wrote block to ${envPath}`);
  } else {
    console.log("(re-run with --append to write the block to .env)");
  }
})().catch((e) => {
  console.error("fatal:", e.message);
  process.exit(1);
});
