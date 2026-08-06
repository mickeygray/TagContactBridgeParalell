"use strict";

/**
 * probe-logics-user-directory — READ ONLY.
 *
 * Question: does Logics V4 expose a user directory we can enumerate per tenant?
 *
 * Three passes, all GET:
 *   A. Route probe — try plausible user/employee routes, record exact status.
 *      Includes a CONTROL (a route we know exists, called with no params) so we
 *      can tell "route does not exist" from "route exists, resource not found".
 *   B. Task/GetTasksByDateRange — tasks carry UserID; do they carry user NAMES?
 *   C. Case/CaseInfo on real cases — dump user-shaped fields only, PII masked.
 *
 * No POST. Nothing is created, updated or deleted.
 *
 *   node scripts/analysis/probe-logics-user-directory.js [TENANT]
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

const TENANT = (process.argv[2] || "TAG").toUpperCase();

// Field names that are the CUSTOMER, not a staff user. Never printed.
const PII = /first|last|middle|name(?!.*(user|officer|created|modified|assigned|worker|manager|preparer|opener))|email|phone|address|city|state|zip|ssn|dob|birth|spouse|company|fax|cell/i;
// Field names that look like they name or id a STAFF USER.
const USERISH = /user|officer|agent|employee|assign|createdby|modifiedby|owner|worker|manager|preparer|opener|attorney|salesrep|rep\b/i;

function mask(v) {
  const s = String(v ?? "");
  if (!s) return "";
  if (s.includes("@")) {
    const [l, d] = s.split("@");
    return `${l.slice(0, 2)}***@${d}`;
  }
  return s.length > 40 ? `${s.slice(0, 40)}...` : s;
}

function unwrap(res) {
  let v = res;
  for (let i = 0; i < 4; i += 1) {
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v; } continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && (v.data !== undefined || v.Data !== undefined)) {
      v = v.data !== undefined ? v.data : v.Data;
      continue;
    }
    break;
  }
  return v;
}

async function probe(client, label, routePath) {
  try {
    const res = await client.request(routePath);
    const body = JSON.stringify(res ?? null);
    return { label, routePath, status: 200, ok: true, note: body.slice(0, 300) };
  } catch (e) {
    const status = e?.details?.responseStatus ?? null;
    let body = e?.details?.responseBody;
    if (body && typeof body === "object") body = JSON.stringify(body);
    return {
      label,
      routePath,
      status,
      ok: false,
      note: String(body ?? e.message).slice(0, 220),
    };
  }
}

async function main() {
  await connectMongo(getSharedConfig());
  const client = createLogicsClient(TENANT);

  console.log(`\n=== LOGICS USER DIRECTORY PROBE — tenant ${TENANT} ===`);

  // ---------- PASS A: route probe ----------
  console.log("\n--- A. ROUTE PROBE (GET only) ---");
  const candidates = [
    ["CONTROL known-good route, no params", "Case/CaseInfo"],
    ["CONTROL known-good route, absurd id", "Case/CaseInfo?CaseID=1"],
    ["User/User", "User/User"],
    ["User/Users", "User/Users"],
    ["User/GetUsers", "User/GetUsers"],
    ["User/UserInfo", "User/UserInfo"],
    ["Users/Users", "Users/Users"],
    ["Employee/Employee", "Employee/Employee"],
    ["Employee/Employees", "Employee/Employees"],
    ["Admin/Users", "Admin/Users"],
    ["Settings/Users", "Settings/Users"],
    ["Lookup/Users", "Lookup/Users"],
    ["Task/TaskUser", "Task/TaskUser"],
    ["Case/CaseUsers", "Case/CaseUsers"],
  ];
  const routeResults = [];
  for (const [label, p] of candidates) {
    const r = await probe(client, label, p);
    routeResults.push(r);
    console.log(`  [${String(r.status ?? "ERR").padEnd(4)}] ${label.padEnd(38)} ${r.note.replace(/\s+/g, " ").slice(0, 130)}`);
  }

  // ---------- PASS B: tasks ----------
  console.log("\n--- B. Task/GetTasksByDateRange (do tasks name their user?) ---");
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const res = await client.getTasksByDateRange(fmt(start), fmt(end));
    const rows = unwrap(res);
    const arr = Array.isArray(rows) ? rows : [];
    console.log(`  rows: ${arr.length}`);
    if (arr.length) {
      console.log(`  keys on row 0: ${Object.keys(arr[0]).join(", ")}`);
      const userish = {};
      for (const [k, v] of Object.entries(arr[0])) {
        if (USERISH.test(k)) userish[k] = mask(typeof v === "object" ? JSON.stringify(v) : v);
      }
      console.log(`  user-shaped fields: ${JSON.stringify(userish)}`);
      // Distinct user identifiers across the window.
      const ids = new Set();
      const names = new Set();
      for (const row of arr) {
        for (const [k, v] of Object.entries(row)) {
          if (!USERISH.test(k)) continue;
          if (v == null || v === "") continue;
          if (/id$/i.test(k)) {
            if (Array.isArray(v)) v.forEach((x) => ids.add(`${k}=${x}`));
            else ids.add(`${k}=${v}`);
          } else if (typeof v === "string") names.add(`${k}=${v}`);
        }
      }
      console.log(`  distinct user ids seen: ${[...ids].slice(0, 40).join(" | ") || "(none)"}`);
      console.log(`  distinct user names seen: ${[...names].slice(0, 40).join(" | ") || "(none)"}`);
    }
  } catch (e) {
    console.log(`  FAILED status=${e?.details?.responseStatus ?? "?"} ${String(e?.details?.responseBody ?? e.message).slice(0, 200)}`);
  }

  // ---------- PASS C: case info ----------
  console.log("\n--- C. Case/CaseInfo — user-shaped fields on real cases ---");
  const mongoose = require("mongoose");
  const db = mongoose.connection.db;
  let caseIds = [];
  try {
    const docs = await db
      .collection("caseprofiles")
      .find({ domain: TENANT }, { projection: { caseId: 1 } })
      .sort({ _id: -1 })
      .limit(6)
      .toArray();
    caseIds = docs.map((d) => Number(d.caseId)).filter(Number.isFinite);
  } catch (e) {
    console.log(`  (could not read caseprofiles: ${e.message})`);
  }
  if (!caseIds.length) {
    try {
      const docs = await db
        .collection("leaddeliveryitems")
        .find({}, { projection: { caseId: 1 } })
        .sort({ _id: -1 })
        .limit(6)
        .toArray();
      caseIds = docs.map((d) => Number(d.caseId)).filter(Number.isFinite);
    } catch (e) {
      console.log(`  (could not read leaddeliveryitems: ${e.message})`);
    }
  }
  console.log(`  probing case ids: ${caseIds.slice(0, 4).join(", ") || "(none found)"}`);

  const allUserKeys = new Map();
  for (const cid of caseIds.slice(0, 4)) {
    try {
      const res = await client.getCaseInfo(cid);
      const body = unwrap(res);
      const rec = Array.isArray(body) ? body[0] : body;
      if (!rec || typeof rec !== "object") { console.log(`  case ${cid}: unexpected shape`); continue; }
      const keys = Object.keys(rec);
      const userish = {};
      for (const k of keys) {
        if (!USERISH.test(k)) continue;
        if (PII.test(k) && !USERISH.test(k)) continue;
        const v = rec[k];
        userish[k] = v == null || v === "" ? null : mask(typeof v === "object" ? JSON.stringify(v) : v);
        allUserKeys.set(k, (allUserKeys.get(k) || 0) + (v == null || v === "" ? 0 : 1));
      }
      console.log(`  case ${cid}: ${keys.length} fields total`);
      console.log(`    user-shaped: ${JSON.stringify(userish)}`);
    } catch (e) {
      console.log(`  case ${cid}: FAILED status=${e?.details?.responseStatus ?? "?"} ${String(e.message).slice(0, 120)}`);
    }
  }
  console.log(`\n  user-shaped CaseInfo keys (populated count): ${JSON.stringify(Object.fromEntries(allUserKeys))}`);

  console.log("\n=== END ===");
  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); console.error(e.stack); process.exitCode = 1; });
