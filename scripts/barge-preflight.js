#!/usr/bin/env node
"use strict";

// Read-only BARGE PREFLIGHT. For each monitor->agent pair, verify the exact chain
// that made the Phil/987 combo work, so we know every pair is GO before a live round:
//   monitor ext exists -> has an OtherPhone ("Existing Phone") device -> sip-info
//     obtainable (registrable softphone) -> per-ext JWT present? (else shared-token)
//   agent ext exists (dialable) -> agent record has metadata.barge.monitorExtension
//     matching the monitor.
// Does NOT register softphones or place calls (no SIP, no floor impact).
//
//   node scripts/barge-preflight.js

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const RC_BASE = (process.env.RING_CENTRAL_SERVER_URL || "https://platform.ringcentral.com").replace(/\/$/, "");

const MONITOR_ASSIGNMENTS = [
  { monitorExt: "987", monitorName: "PHIL", email: "polson@taxadvocategroup.com" },
  { monitorExt: "1101", monitorName: "SEAN", email: "slucas@taxadvocategroup.com" },
  { monitorExt: "1102", monitorName: "BRUCE", email: "ballen@taxadvocategroup.com" },
  { monitorExt: "1103", monitorName: "ANTHONY", email: "acalloway@taxadvocategroup.com" },
  { monitorExt: "1104", monitorName: "CHRIS", email: "cbolt@taxadvocategroup.com" },
  { monitorExt: "1105", monitorName: "JAMES", email: "jsharp@taxadvocategroup.com" },
  { monitorExt: "1106", monitorName: "BRAD", email: "bhansen@taxadvocategroup.com" },
];
const MONITOR_JWT_ENV_ALIASES = new Map(MONITOR_ASSIGNMENTS.map((a) => [
  a.monitorExt,
  `${a.monitorName}_RING_CENTRAL_MONITOR_JWT_TOKEN`,
]));

async function token() {
  const id = process.env.RING_CENTRAL_CLIENT_ID, secret = process.env.RING_CENTRAL_CLIENT_SECRET, jwt = process.env.RING_CENTRAL_JWT_TOKEN;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch(`${RC_BASE}/restapi/oauth/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString() });
  const t = await r.text(); if (!r.ok) throw new Error(`oauth ${r.status}: ${t.slice(0, 160)}`); return JSON.parse(t).access_token;
}
async function get(tok, ep) { const r = await fetch(`${RC_BASE}${ep}`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/json" } }); if (!r.ok) { const t = await r.text(); const e = new Error(`${r.status}: ${t.slice(0, 120)}`); e.status = r.status; throw e; } return r.json(); }

function jwtConfigured(ext) {
  if (process.env[`EX_BARGE_JWT_${ext}`]) return true;
  const alias = MONITOR_JWT_ENV_ALIASES.get(String(ext));
  if (alias && process.env[alias]) return true;
  const file = process.env.EX_BARGE_JWT_MAP;
  if (file) { try { const j = JSON.parse(require("fs").readFileSync(file, "utf8")); return Boolean(j[ext]); } catch {} }
  return false;
}

(async () => {
  const tok = await token();
  // full ext index by number
  const byNum = new Map();
  for (let p = 1; p <= 20; p++) {
    const d = await get(tok, `/restapi/v1.0/account/~/extension?perPage=200&page=${p}`);
    for (const r of (d.records || [])) byNum.set(String(r.extensionNumber || ""), r);
    if ((d.records || []).length < 200) break;
  }

  await mongoose.connect(process.env.MONGO_URI, { dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel" });
  const col = mongoose.connection.db.collection("useraccounts");

  const rows = [];
  let go = 0;
  for (const a of MONITOR_ASSIGNMENTS) {
    const gaps = [];
    // --- monitor side ---
    const mon = byNum.get(a.monitorExt);
    let device = null, sipOk = false, monType = "";
    if (!mon) gaps.push("monitor-ext-not-in-RC");
    else {
      monType = mon.type;
      try {
        const dev = await get(tok, `/restapi/v1.0/account/~/extension/${mon.id}/device`);
        device = (dev.records || []).find((d) => d.type === "OtherPhone") || null;
        if (!device) gaps.push("no-OtherPhone-device");
        else {
          try { await get(tok, `/restapi/v1.0/account/~/device/${device.id}/sip-info`); sipOk = true; }
          catch (e) { gaps.push(`sip-info-${e.status || "err"}`); }
        }
      } catch (e) { gaps.push(`device-list-${e.status || "err"}`); }
    }
    const hasJwt = jwtConfigured(a.monitorExt);

    // --- agent side ---
    const doc = await col.findOne({ email: a.email.toLowerCase() }, { projection: { name: 1, extensionNumber: 1, "metadata.barge": 1 } });
    let agentExt = null;
    if (!doc) gaps.push("agent-no-UserAccount");
    else {
      agentExt = doc.extensionNumber || null;
      if (!agentExt) gaps.push("agent-no-extensionNumber");
      else if (!byNum.get(String(agentExt))) gaps.push("agent-ext-not-in-RC");
      const setMon = doc.metadata?.barge?.monitorExtension || null;
      if (setMon !== a.monitorExt) gaps.push(`monitorExtension-mismatch(set=${setMon || "none"})`);
    }

    const status = gaps.length === 0 ? "GO" : "NO-GO";
    if (status === "GO") go += 1;
    rows.push({
      monitor: `${a.monitorExt}/${a.monitorName}`,
      monType,
      device: device ? device.id : "-",
      sip: sipOk ? "ok" : "-",
      jwt: hasJwt ? "own" : "shared",
      agent: doc ? `${doc.name} (${agentExt || "?"})` : "MISSING",
      status,
      gaps: gaps.join("; ") || "-",
    });
  }
  await mongoose.disconnect();

  console.log(`BARGE PREFLIGHT  (${go}/${MONITOR_ASSIGNMENTS.length} pairs GO)\n`);
  for (const r of rows) {
    console.log(`[${r.status}] monitor ${r.monitor} type=${r.monType} dev=${r.device} sip=${r.sip} jwt=${r.jwt}  ->  agent ${r.agent}`);
    if (r.gaps !== "-") console.log(`        gaps: ${r.gaps}`);
  }
  console.log(`\nNote: 1:1 call-monitoring PERMISSION (monitor over agent) can't be read via API -- verify in RC admin. Everything else above is checked.`);
})().catch(async (e) => { console.error("preflight failed:", e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
