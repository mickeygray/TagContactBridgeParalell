"use strict";

// RingCX Digital — capture the actual record shapes from the four
// confirmed-good GET endpoints, plus probe a wider list of endpoints
// to learn the full surface area available on this account.
//
// Output goes to stdout AND to ./out/rcx/<endpoint>.json so we can
// reference real payloads while building the client.
//
// Usage:
//   node scripts/rcx-shapes.js
//   node scripts/rcx-shapes.js --probe-only      # don't write files
//   node scripts/rcx-shapes.js --endpoint /1.0/users  # single endpoint

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const BASE_URL = String(process.env.RCX_API_URL || "").replace(/\/$/, "");
const API_KEY = String(process.env.RCX_API_KEY || "");
if (!BASE_URL || !API_KEY) {
  console.error("RCX_API_URL or RCX_API_KEY not set in .env");
  process.exit(1);
}
const OUT_DIR = path.join(__dirname, "..", "out", "rcx");

const KNOWN_GOOD = ["/1.0/users", "/1.0/channels", "/1.0/categories", "/1.0/interventions"];

// Comprehensive probe list — Engage Digital documented + likely
// surface. Each is a safe GET with per_page=3 to keep payloads small.
const PROBES = [
  // Identity
  "/1.0/users",
  "/1.0/users/permissions",

  // Routing config
  "/1.0/categories",
  "/1.0/channels",
  "/1.0/folders",
  "/1.0/labels",
  "/1.0/intervention_actions",
  "/1.0/intervention_response_validation_workflows",

  // Agent state & assignments
  "/1.0/presence_states",
  "/1.0/permissions",
  "/1.0/teams",

  // Work items
  "/1.0/interventions",
  "/1.0/messages",
  "/1.0/private_messages",

  // Contact / identity records
  "/1.0/identities",
  "/1.0/identity_groups",

  // Content libraries
  "/1.0/canned_messages",
  "/1.0/content_templates",
  "/1.0/dialogs",

  // Reports
  "/1.0/reports",
  "/1.0/report_templates",

  // Webhooks / outgoing
  "/1.0/webhooks",
  "/1.0/external_data",
];

function summarize(value, depth = 0) {
  if (value == null) return "null";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) {
    return `Array(${value.length})${value[0] ? ` of ${summarize(value[0], depth + 1)}` : ""}`;
  }
  const keys = Object.keys(value);
  if (depth >= 3) return `Object{${keys.length}}`;
  return "{" + keys.slice(0, 10).map((k) => `${k}: ${summarize(value[k], depth + 1)}`).join(", ") + (keys.length > 10 ? ", …" : "") + "}";
}

function describeRecord(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = summarize(v, 1);
  }
  return out;
}

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

async function probe(endpoint) {
  const url = `${BASE_URL}${endpoint}?per_page=3`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
        "User-Agent": "TagContactBridgeParallel-rcx-shapes/0.1",
      },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { endpoint, status: res.status, ms: Date.now() - t0, json, text };
  } catch (e) {
    return { endpoint, status: 0, ms: Date.now() - t0, error: e.message };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const single = readFlag(argv, "--endpoint");
  const probeOnly = hasFlag(argv, "--probe-only");

  if (!probeOnly) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const list = single ? [single] : PROBES;
  console.log(`probing ${list.length} endpoints against ${BASE_URL}\n`);

  const surface = [];
  for (const endpoint of list) {
    const r = await probe(endpoint);
    const ok = r.status >= 200 && r.status < 300;
    const flag = ok ? "✅" : r.status === 404 ? "—" : r.status === 403 ? "🔒" : "❌";
    console.log(`${flag} ${r.status || "ERR"}  ${r.ms}ms  ${endpoint}`);
    if (ok && r.json && typeof r.json === "object") {
      const records = Array.isArray(r.json.records) ? r.json.records : [];
      if (records.length > 0) {
        console.log(`     records[0] keys (${Object.keys(records[0]).length}):`);
        for (const [k, v] of Object.entries(records[0])) {
          console.log(`       ${k}: ${summarize(v, 1)}`);
        }
      } else if (Array.isArray(r.json)) {
        console.log(`     bare Array(${r.json.length})`);
      } else {
        console.log(`     shape: ${summarize(r.json)}`);
      }
      surface.push({ endpoint, count: r.json.count ?? records.length, sample: records[0] || r.json });
      if (!probeOnly) {
        const filename = endpoint.replace(/^\/+/, "").replace(/\//g, "_") + ".json";
        fs.writeFileSync(path.join(OUT_DIR, filename), JSON.stringify(r.json, null, 2));
      }
    }
  }

  console.log("");
  console.log(`available surface (${surface.length} endpoints):`);
  for (const s of surface) {
    console.log(`  ${s.endpoint}  →  ${s.count} records`);
  }
  if (!probeOnly) {
    console.log(`\nartifacts written to ${OUT_DIR}`);
  }
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
