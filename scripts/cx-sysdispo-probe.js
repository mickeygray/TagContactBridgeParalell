"use strict";

require("dotenv").config();

// SYS-DISPO VOCABULARY PROBE (Mickey's one-dial experiment, 2026-07-07): after a test call,
// pull the lead's RAW disposition fields straight from RingCX leadSearch — no restart, no
// flag, read-only. This is how we learn what RingCX actually calls an answered call.
//
//   node scripts/cx-sysdispo-probe.js                      -> probe the latest bulk session's
//                                                             current + completed externs
//   node scripts/cx-sysdispo-probe.js --extern cxbl-...    -> probe one extern directly
//   node scripts/cx-sysdispo-probe.js --campaign 2306      -> override the campaign id

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxBulkLoadSession } = require("../packages/shared-models/src");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src");

const args = { extern: null, campaign: null };
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--extern") args.extern = process.argv[++i] || null;
  else if (process.argv[i] === "--campaign") args.campaign = process.argv[++i] || null;
}

const PII_FIELDS = /phone|number|address|email|firstname|lastname|name$/i;
function maskLead(lead = {}) {
  const out = {};
  for (const [key, value] of Object.entries(lead)) {
    if (PII_FIELDS.test(key) && typeof value === "string" && value.length > 4) {
      out[key] = `***${value.slice(-4)}`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

const KNOWN_NEVER = ["CONGESTION", "BUSY", "INTERCEPT", "NOANSWER", "MACHINE", "ABANDON"];
const KNOWN_ANSWERED_GUESSES = ["ANSWER", "ANSWERED", "CONNECT", "CONNECTED", "LIVE", "AGENT", "OPERATOR", "HUMAN"];

async function probeExtern(client, campaignId, externId, label) {
  const res = await client.searchLeads({ campaignId, externIds: [externId] }).catch((err) => ({ error: err.message }));
  if (res?.error) {
    console.log(`  ${label} ${externId}: search FAILED — ${res.error}`);
    return;
  }
  const leads = Array.isArray(res) ? res : res?.leads || res?.records || [];
  const lead = leads.find((row) => String(row?.externId || "") === externId) || leads[0] || null;
  if (!lead) {
    console.log(`  ${label} ${externId}: NO LEAD FOUND (consumed/cancelled leads may drop out of search)`);
    return;
  }
  console.log(`  ${label} ${externId} — FULL RAW LEAD (PII masked):`);
  console.log("   ", JSON.stringify(maskLead(lead), null, 2).split("\n").join("\n    "));
  const dispoish = Object.entries(lead).filter(([k]) => /disposition|result|state|status|pass|outcome/i.test(k));
  console.log("    disposition-flavored fields:", JSON.stringify(Object.fromEntries(dispoish)));
  for (const [key, value] of dispoish) {
    const token = String(value || "").trim().toUpperCase();
    if (KNOWN_NEVER.includes(token)) console.log(`    >>> ${key}=${token} — KNOWN never-connect token`);
    else if (KNOWN_ANSWERED_GUESSES.includes(token)) console.log(`    >>> ${key}=${token} — matches an ANSWERED guess! THE TOKEN.`);
    else if (token) console.log(`    >>> ${key}=${token} — UNKNOWN token (candidate vocabulary — report this)`);
  }
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const client = createRingcxVoiceClient();
    if (args.extern) {
      const campaignId = args.campaign || "2306";
      await probeExtern(client, campaignId, args.extern, "extern");
      return;
    }
    const session = await CxBulkLoadSession.findOne({}).sort({ updatedAt: -1 }).lean();
    if (!session) { console.log("No bulk session found."); return; }
    const campaignId = args.campaign || session.ringcx?.campaignId || "2306";
    console.log(`latest session ${session.sessionId} (${session.status}) campaign=${campaignId}`);
    const targets = [];
    if (session.current?.externId || session.current?.ringcx?.externId) {
      targets.push({ label: "current", externId: session.current.externId || session.current.ringcx.externId });
    }
    for (const c of (session.completed || []).slice(-5)) {
      const externId = c.externId || c.ringcx?.externId;
      if (externId) targets.push({ label: `completed(${c.outcome || "?"})`, externId });
    }
    if (!targets.length) { console.log("No externs on the session yet — dial first, then re-run."); return; }
    for (const t of targets) await probeExtern(client, campaignId, t.externId, t.label);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
