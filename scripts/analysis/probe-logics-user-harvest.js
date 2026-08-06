"use strict";

/**
 * probe-logics-user-harvest — READ ONLY.
 *
 * Pass A confirmed there is no /User route. But Task/GetTasksByDateRange
 * returns, per task, a `Users: [{UserID, FullName}]` array plus a
 * CreateBy / CreatedByName pair. That is an enumerable directory by
 * harvest. This script measures how complete that harvest is, per tenant.
 *
 * Also dumps the CaseInfo field NAMES (names only, no values) so we can
 * state with certainty whether a case carries staff identity.
 *
 *   node scripts/analysis/probe-logics-user-harvest.js
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));
const { flattenByCompany } = require(path.join(__dirname, "../../packages/shared-data/src/logicsAgents"));

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

const fmt = (d) => d.toISOString().slice(0, 10);

async function harvestTenant(tenant, monthsBack) {
  const out = { tenant, ok: false, error: null, tasks: 0, dir: new Map(), windows: [] };
  let client;
  try {
    client = createLogicsClient(tenant);
  } catch (e) {
    out.error = `client init failed: ${e.message}`;
    return out;
  }

  const now = Date.now();
  const CHUNK = 60 * 86400000;
  for (let i = 0; i < monthsBack; i += 1) {
    const end = new Date(now - i * CHUNK);
    const start = new Date(now - (i + 1) * CHUNK);
    try {
      const res = await client.getTasksByDateRange(fmt(start), fmt(end));
      const arr = unwrap(res);
      const rows = Array.isArray(arr) ? arr : [];
      out.ok = true;
      out.tasks += rows.length;
      out.windows.push(`${fmt(start)}..${fmt(end)}=${rows.length}`);
      for (const row of rows) {
        // assignees
        const users = Array.isArray(row?.Users) ? row.Users : [];
        for (const u of users) {
          const id = Number(u?.UserID);
          const nm = String(u?.FullName || "").trim();
          if (Number.isFinite(id) && id > 0 && nm) {
            const rec = out.dir.get(id) || { id, name: nm, asAssignee: 0, asCreator: 0 };
            rec.asAssignee += 1;
            out.dir.set(id, rec);
          }
        }
        // creator
        const cid = Number(row?.CreateBy);
        const cnm = String(row?.CreatedByName || "").trim();
        if (Number.isFinite(cid) && cid > 0 && cnm) {
          const rec = out.dir.get(cid) || { id: cid, name: cnm, asAssignee: 0, asCreator: 0 };
          rec.asCreator += 1;
          if (!rec.name) rec.name = cnm;
          out.dir.set(cid, rec);
        }
      }
    } catch (e) {
      const st = e?.details?.responseStatus ?? "?";
      if (st === 401 || st === 429) { out.error = `HTTP ${st} — STOPPED`; return out; }
      out.windows.push(`${fmt(start)}..${fmt(end)}=ERR(${st})`);
      if (!out.ok) out.error = `${st}: ${String(e?.details?.responseBody ?? e.message).slice(0, 160)}`;
    }
  }
  return out;
}

async function main() {
  await connectMongo(getSharedConfig());

  // --- CaseInfo field names, to settle "does a case name its officer?" ---
  console.log("=== CaseInfo FIELD NAMES (TAG, names only) ===");
  try {
    const c = createLogicsClient("TAG");
    const mongoose = require("mongoose");
    const doc = await mongoose.connection.db
      .collection("caseprofiles").find({}, { projection: { caseId: 1 } })
      .sort({ _id: -1 }).limit(1).toArray();
    const cid = Number(doc?.[0]?.caseId);
    const rec0 = unwrap(await c.getCaseInfo(cid));
    const rec = Array.isArray(rec0) ? rec0[0] : rec0;
    console.log(`  case ${cid} -> ${Object.keys(rec).length} fields:`);
    console.log(`  ${Object.keys(rec).sort().join(", ")}`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }

  // --- Harvest per tenant ---
  for (const tenant of ["TAG", "WYNN", "AMITY"]) {
    console.log(`\n=== HARVEST ${tenant} (Task/GetTasksByDateRange, 6x60d ~ 1yr) ===`);
    const r = await harvestTenant(tenant, 6);
    if (r.error && !r.ok) { console.log(`  UNAVAILABLE: ${r.error}`); continue; }
    console.log(`  windows: ${r.windows.join(", ")}`);
    console.log(`  tasks scanned: ${r.tasks}`);
    const rows = [...r.dir.values()].sort((a, b) => a.id - b.id);
    console.log(`  DISTINCT USERS DISCOVERED: ${rows.length}`);
    const seed = flattenByCompany().filter((s) => s.company === tenant);
    const seedById = new Map(seed.map((s) => [s.logicsId, s]));
    for (const u of rows) {
      const s = seedById.get(u.id);
      const flag = s ? (s.name === u.name ? "seed-match" : `seed-NAME-DIFF(${s.name})`) : "NOT-IN-SEED";
      console.log(`    ${String(u.id).padStart(5)}  ${u.name.padEnd(24)} assignee=${String(u.asAssignee).padStart(4)} creator=${String(u.asCreator).padStart(4)}  ${flag}`);
    }
    const discovered = new Set(rows.map((u) => u.id));
    const missed = seed.filter((s) => !discovered.has(s.logicsId));
    console.log(`  seed rows for ${tenant}: ${seed.length}; seed users NOT observed in tasks: ${missed.length}`);
    if (missed.length) console.log(`    ${missed.map((m) => `${m.logicsId}:${m.name}`).join(", ")}`);
  }

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); console.error(e.stack); process.exitCode = 1; });
