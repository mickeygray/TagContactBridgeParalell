"use strict";

/**
 * probe-logics-user-emit — READ ONLY. Merges the Task-endpoint harvest with the
 * hand-maintained logicsAgents seed and emits one JSON directory per tenant.
 *
 *   node scripts/analysis/probe-logics-user-emit.js
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const path = require("path");
const fs = require("fs");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));
const { flattenByCompany } = require(path.join(__dirname, "../../packages/shared-data/src/logicsAgents"));

function unwrap(res) {
  let v = res;
  for (let i = 0; i < 4; i += 1) {
    if (typeof v === "string") { try { v = JSON.parse(v); } catch { return v; } continue; }
    if (v && typeof v === "object" && !Array.isArray(v) && (v.data !== undefined || v.Data !== undefined)) {
      v = v.data !== undefined ? v.data : v.Data; continue;
    }
    break;
  }
  return v;
}
const fmt = (d) => d.toISOString().slice(0, 10);
function maskEmail(e) {
  const s = String(e || "").trim();
  if (!s.includes("@")) return null;
  const [l, d] = s.split("@");
  return `${l.slice(0, 2)}***@${d}`;
}

async function main() {
  await connectMongo(getSharedConfig());
  const out = [];

  for (const tenant of ["TAG", "WYNN", "AMITY"]) {
    const client = createLogicsClient(tenant);
    const dir = new Map();
    const now = Date.now();
    const CHUNK = 60 * 86400000;
    for (let i = 0; i < 6; i += 1) {
      const end = new Date(now - i * CHUNK);
      const start = new Date(now - (i + 1) * CHUNK);
      try {
        const rows = unwrap(await client.getTasksByDateRange(fmt(start), fmt(end)));
        for (const row of Array.isArray(rows) ? rows : []) {
          for (const u of Array.isArray(row?.Users) ? row.Users : []) {
            const id = Number(u?.UserID); const nm = String(u?.FullName || "").trim();
            if (Number.isFinite(id) && id > 0 && nm) {
              const r = dir.get(id) || { id, name: nm, hits: 0 }; r.hits += 1; dir.set(id, r);
            }
          }
          const cid = Number(row?.CreateBy); const cnm = String(row?.CreatedByName || "").trim();
          if (Number.isFinite(cid) && cid > 0 && cnm) {
            const r = dir.get(cid) || { id: cid, name: cnm, hits: 0 }; r.hits += 1; dir.set(cid, r);
          }
        }
      } catch (e) {
        const st = e?.details?.responseStatus ?? "?";
        if (st === 401 || st === 429) { console.error(`STOP ${tenant} HTTP ${st}`); break; }
      }
    }

    const seed = flattenByCompany().filter((s) => s.company === tenant);
    const seedById = new Map(seed.map((s) => [s.logicsId, s]));
    const ids = new Set([...dir.keys(), ...seedById.keys()]);
    for (const id of [...ids].sort((a, b) => a - b)) {
      const obs = dir.get(id);
      const s = seedById.get(id);
      out.push({
        tenant,
        id: String(id),
        displayName: obs?.name || s?.name || "(unknown)",
        maskedEmail: maskEmail(s?.email) || undefined,
        role: s?.roles || undefined,
        active: Boolean(obs),
        _hits: obs?.hits || 0,
        _src: obs && s ? "harvest+seed" : obs ? "harvest-only" : "seed-only",
      });
    }
  }

  const dest = path.join(__dirname, "../../../logics-users.json");
  const p = process.env.TEMP ? path.join(process.env.TEMP, "logics-users.json") : dest;
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log(`wrote ${out.length} rows -> ${p}`);
  console.log(JSON.stringify(out));
  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
