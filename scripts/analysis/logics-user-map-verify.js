"use strict";

/**
 * logics-user-map-verify — check a hand-supplied Jira-person -> Logics UserID
 * table against what Logics actually says, before anything is built on it.
 *
 * WHY THIS EXISTS
 *
 * Logics exposes no user-directory route. Twelve plausible V4 routes (User/User,
 * Employee/Employee, Admin/Users, ...) return a ROUTER-level 404 — the ASP.NET
 * "No HTTP resource was found" message, meaning the route does not exist at all,
 * as distinct from a real route rejecting a bad id, which returns the Logics
 * application envelope. So the roster below cannot be looked up directly.
 *
 * It can, however, be HARVESTED. Task/GetTasksByDateRange returns, on every task
 * row, `Users: [{UserID, FullName}]` for the assignees and a `CreateBy` /
 * `CreatedByName` pair for the author. That is an id-to-name mapping issued by
 * Logics itself — not a guess, not a join on a stale local file.
 *
 * WHY IT MATTERS THAT WE CHECK
 *
 * User ids are PER TENANT, and the namespaces overlap. TAG 20 is Jonathan Haro;
 * WYNN 20 is Riley Mills. Passing a bare UserID without pinning its tenant does
 * not error — Logics accepts it and assigns the task to the wrong person, quietly.
 * A transposed digit in a hand-typed table fails exactly the same way. Since these
 * ids are non-contiguous there is nothing about a wrong one that looks wrong.
 *
 * A name that matches is real evidence. An id that harvests to a DIFFERENT name is
 * a hard stop. An id we simply never observed is neither — it means the person
 * assigned no task in the window, which is not the same as the id being wrong, and
 * this script reports those two outcomes separately on purpose.
 *
 *   node scripts/analysis/logics-user-map-verify.js [monthsBack]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

const TENANTS = ["TAG", "WYNN", "AMITY"];

/**
 * The table as supplied on 2026-08-05, verbatim. Nothing here is trusted until
 * the harvest confirms it; it is the CLAIM being tested, not a source of truth.
 *
 * `jiraName` is the Jira display name it must line up with — the only join key
 * available, since Atlassian hides every email but the caller's own.
 */
const CLAIMED = [
  { jiraName: "Monica Cazares", TAG: 398, WYNN: 32, AMITY: 139 },
  { jiraName: "Jacqueline Santos", TAG: 437, WYNN: 43, AMITY: 165 },
  { jiraName: "Riley Mills", TAG: 407, WYNN: 20, AMITY: 149 },
  { jiraName: "Jackie Rose", TAG: 440, WYNN: 46, AMITY: 168 },
  { jiraName: "Neyla Ramirez", TAG: 84, WYNN: 69, AMITY: 171 },
  { jiraName: "Leo Collins", TAG: 413, WYNN: 28, AMITY: 151 },
];

const pad = (v, n) => String(v ?? "").padEnd(n);
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/** Surnames beat full strings here: "Leo Collins" in Jira is "Leo Collins III" in Logics. */
function namesAgree(a, b) {
  const A = norm(a).split(" ").filter((w) => w.length >= 3);
  const B = norm(b).split(" ").filter((w) => w.length >= 3);
  if (!A.length || !B.length) return false;
  const overlap = A.filter((w) => B.includes(w));
  return overlap.length >= 2 || (overlap.length === 1 && overlap[0] === A[A.length - 1]);
}

const dayStr = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Walk back in 60-day windows. Logics caps what one range call will return, so a
 * single 12-month request silently under-reports; several windows do not.
 */
async function harvestTenant(tenant, months, log) {
  const client = createLogicsClient(tenant);
  const byId = new Map();
  let tasks = 0;
  const windows = Math.ceil(months / 2);
  const today = new Date("2026-08-05T00:00:00Z").getTime();

  for (let w = 0; w < windows; w += 1) {
    const end = today - w * 60 * 86400000;
    const start = end - 60 * 86400000;
    let res;
    try {
      res = await client.getTasksByDateRange(dayStr(start), dayStr(end));
    } catch (error) {
      log(`    ${tenant} window ${dayStr(start)}..${dayStr(end)} FAILED: ${String(error.message).slice(0, 70)}`);
      continue;
    }
    const rows = res?.Data ?? res?.data ?? res;
    if (!Array.isArray(rows)) continue;
    tasks += rows.length;
    for (const row of rows) {
      for (const u of row.Users || []) {
        if (u?.UserID == null) continue;
        const e = byId.get(u.UserID) || { name: u.FullName, seen: 0 };
        e.seen += 1;
        if (u.FullName) e.name = u.FullName;
        byId.set(u.UserID, e);
      }
      // The author pair is a second, independent sighting of the same namespace.
      if (row.CreateBy != null && row.CreatedByName) {
        const e = byId.get(row.CreateBy) || { name: row.CreatedByName, seen: 0 };
        e.seen += 1;
        e.name = e.name || row.CreatedByName;
        byId.set(row.CreateBy, e);
      }
    }
  }
  log(`    ${tenant}: ${tasks} tasks -> ${byId.size} distinct user ids`);
  return byId;
}

async function main() {
  const months = Number(process.argv[2]) || 12;
  // Optional tenant filter, so an id that went unobserved in a short window can be
  // chased over a much longer one without re-harvesting TAG's 5,000 tasks as well.
  const only = process.argv.slice(3).filter((a) => TENANTS.includes(a.toUpperCase()))
    .map((a) => a.toUpperCase());
  const tenants = only.length ? only : TENANTS;
  await connectMongo(getSharedConfig());
  const log = (s) => console.log(s);

  console.log(`\n  Harvesting Logics UserID -> FullName from Task/GetTasksByDateRange`);
  console.log(`  (${months} months, 60-day windows, GET only)\n`);

  const harvest = {};
  for (const t of tenants) harvest[t] = await harvestTenant(t, months, log);

  console.log(`\n  ${pad("Jira name", 20)}${pad("tenant", 8)}${pad("claimed", 9)}`
    + `${pad("Logics says", 26)}verdict`);
  console.log("  " + "-".repeat(76));

  const problems = [];
  const unobserved = [];
  let confirmed = 0;

  for (const person of CLAIMED) {
    for (const tenant of tenants) {
      const id = person[tenant];
      const hit = harvest[tenant].get(id);
      let verdict;
      if (!hit) {
        verdict = "not observed";
        unobserved.push(`${person.jiraName} ${tenant} ${id}`);
      } else if (namesAgree(person.jiraName, hit.name)) {
        verdict = `CONFIRMED (${hit.seen} sightings)`;
        confirmed += 1;
      } else {
        verdict = "*** MISMATCH ***";
        problems.push(`${person.jiraName} ${tenant} ${id} harvests as "${hit.name}"`);
      }
      console.log(`  ${pad(person.jiraName, 20)}${pad(tenant, 8)}${pad(id, 9)}`
        + `${pad(hit ? hit.name : "(no sighting)", 26)}${verdict}`);
    }
  }

  console.log(`\n  ${confirmed}/${CLAIMED.length * tenants.length} confirmed by name`
    + `   ${problems.length} mismatched   ${unobserved.length} not observed`);

  if (problems.length) {
    console.log(`\n  MISMATCHES — do not build on these:`);
    for (const p of problems) console.log(`    ${p}`);
  }
  if (unobserved.length) {
    console.log(`\n  NOT OBSERVED — the id assigned no task in the window. This is UNKNOWN,`);
    console.log(`  not wrong: it usually means the person does no work in that tenant.`);
    for (const u of unobserved) console.log(`    ${u}`);
  }

  // Reverse check. "Not observed" has two very different causes: the id is right
  // but dormant, or the id is wrong. Searching the harvest by NAME separates them —
  // if the person turns up under a DIFFERENT id in that tenant, the supplied one is
  // wrong and we can say what the right one is. If they appear nowhere at all, the
  // id is merely unexercised and stays unverified rather than becoming a defect.
  if (unobserved.length) {
    console.log(`\n  Reverse lookup — where do the unconfirmed people actually appear?`);
    for (const person of CLAIMED) {
      for (const tenant of tenants) {
        if (!unobserved.some((u) => u.startsWith(`${person.jiraName} ${tenant} `))) continue;
        const hits = [...harvest[tenant].entries()]
          .filter(([, e]) => namesAgree(person.jiraName, e.name))
          .sort((a, b) => b[1].seen - a[1].seen);
        if (hits.length) {
          console.log(`    ${person.jiraName} in ${tenant}: found under `
            + hits.map(([id, e]) => `id ${id} "${e.name}" (${e.seen})`).join(", ")
            + `  -> supplied ${person[tenant]} is WRONG`);
        } else {
          console.log(`    ${person.jiraName} in ${tenant}: name appears under NO id at all`
            + `  -> ${person[tenant]} is unexercised, not contradicted`);
        }
      }
    }
  }

  // Anyone active in Logics who is NOT in the claimed table — a sync keyed only on
  // the six names above would be blind to these, so they are worth naming.
  console.log(`\n  Active Logics users NOT in the supplied table:`);
  for (const tenant of tenants) {
    const claimedIds = new Set(CLAIMED.map((p) => p[tenant]));
    const extras = [...harvest[tenant].entries()]
      .filter(([id]) => !claimedIds.has(id))
      .sort((a, b) => b[1].seen - a[1].seen)
      .slice(0, 12);
    console.log(`    ${tenant}: ${harvest[tenant].size - claimedIds.size} others, busiest — `
      + extras.map(([id, e]) => `${e.name}(${id})`).join(", ").slice(0, 300));
  }
  console.log("");

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
