"use strict";

/**
 * probe-logics-user-fields — READ ONLY. Two narrow questions:
 *   1. What are the CaseInfo field NAMES? (does a case name its staff owner?)
 *   2. What keys does a task's Users[] entry carry? (id+name only, or email too?)
 *
 *   node scripts/analysis/probe-logics-user-fields.js
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

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

async function main() {
  await connectMongo(getSharedConfig());
  const c = createLogicsClient("TAG");

  console.log("=== 1. CaseInfo field NAMES (TAG case 138929) ===");
  try {
    const rec0 = unwrap(await c.getCaseInfo(138929));
    const rec = Array.isArray(rec0) ? rec0[0] : rec0;
    const keys = Object.keys(rec).sort();
    console.log(`  ${keys.length} fields:`);
    for (const k of keys) {
      const v = rec[k];
      const populated = v == null || v === "" ? "empty" : "populated";
      console.log(`    ${k.padEnd(26)} ${populated}`);
    }
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }

  console.log("\n=== 2. Task Users[] entry shape (TAG, last 14d) ===");
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 14 * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const rows = unwrap(await c.getTasksByDateRange(fmt(start), fmt(end)));
    const arr = Array.isArray(rows) ? rows : [];
    const withUsers = arr.find((r) => Array.isArray(r.Users) && r.Users.length);
    if (withUsers) {
      console.log(`  Users[] entry keys: ${Object.keys(withUsers.Users[0]).join(", ")}`);
      console.log(`  sample entry: ${JSON.stringify(withUsers.Users[0])}`);
      const multi = arr.find((r) => Array.isArray(r.Users) && r.Users.length > 1);
      console.log(`  multi-assignee example: ${multi ? JSON.stringify(multi.Users) : "(none in window)"}`);
      console.log(`  CreateBy/CreatedByName pair: ${withUsers.CreateBy} / ${withUsers.CreatedByName}`);
      console.log(`  top-level UserID field value: ${JSON.stringify(withUsers.UserID)}`);
    } else {
      console.log("  no task in window carried a populated Users[]");
    }
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
