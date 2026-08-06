"use strict";

/**
 * probe-jira-open-owners — who holds the OPEN work, per project.
 *
 * READ ONLY. The full sweep answered "how many have an assignee"; this answers
 * "which crew is on the issues a sync would actually have to map right now".
 * Only ~809 issues are open, so this is 9 pages, not 46.
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const TOKEN = process.env.JIRA_API_TOKEN;
const EMAIL = "mgray@taxadvocategroup.com";
const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

async function fetchAll(jql, fields) {
  const out = [];
  let token = null;
  do {
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ jql, maxResults: 100, fields, ...(token ? { nextPageToken: token } : {}) }),
    });
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status} from Jira — stopping, not retrying`);
    }
    const page = JSON.parse(await res.text());
    if (page.errorMessages) throw new Error(JSON.stringify(page.errorMessages).slice(0, 200));
    out.push(...(page.issues || []));
    token = page.nextPageToken || null;
  } while (token);
  return out;
}

(async () => {
  const issues = await fetchAll(
    "project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done ORDER BY created ASC",
    ["assignee", "reporter", "project", "status", "created", "updated", "summary"],
  );
  console.log(`\n  OPEN issues: ${issues.length}\n`);

  const grid = new Map();     // "person|project" -> {a, r}
  const statuses = new Map(); // status name -> n
  const unassignedByStatus = new Map();
  const unassignedByProject = new Map();
  const pairSame = { same: 0, diff: 0, noAssignee: 0 };
  let oldestOpen = null, newestOpen = null;
  const staleByAssignee = new Map(); // updated older than 90d

  const NOW = Date.now();
  for (const i of issues) {
    const f = i.fields || {};
    const proj = f.project?.key || "(none)";
    const st = f.status?.name || "(none)";
    statuses.set(st, (statuses.get(st) || 0) + 1);

    const a = f.assignee?.displayName || null;
    const r = f.reporter?.displayName || null;
    if (a) {
      const k = `${a}|${proj}`;
      const g = grid.get(k) || grid.set(k, { person: a, proj, a: 0 }).get(k);
      g.a += 1;
    } else {
      unassignedByStatus.set(st, (unassignedByStatus.get(st) || 0) + 1);
      unassignedByProject.set(proj, (unassignedByProject.get(proj) || 0) + 1);
    }

    if (!a) pairSame.noAssignee += 1;
    else if (a === r) pairSame.same += 1;
    else pairSame.diff += 1;

    const c = f.created ? Date.parse(f.created) : null;
    if (c) {
      if (!oldestOpen || c < oldestOpen.t) oldestOpen = { t: c, key: i.key, proj };
      if (!newestOpen || c > newestOpen.t) newestOpen = { t: c, key: i.key, proj };
    }
    const u = f.updated ? Date.parse(f.updated) : null;
    if (a && u && NOW - u > 90 * 864e5) staleByAssignee.set(a, (staleByAssignee.get(a) || 0) + 1);
  }

  console.log("  OPEN assignee x project");
  const people = [...new Set([...grid.values()].map((g) => g.person))];
  const projs = ["ASSIGNMENT", "POAREQ", "RESO"];
  console.log(`  ${"person".padEnd(26)}${projs.map((p) => p.padEnd(13)).join("")}total`);
  const rows = people.map((p) => {
    const cells = projs.map((pr) => grid.get(`${p}|${pr}`)?.a || 0);
    return { p, cells, total: cells.reduce((a, b) => a + b, 0) };
  }).sort((x, y) => y.total - x.total);
  for (const row of rows) {
    console.log(`  ${row.p.padEnd(26)}${row.cells.map((c) => String(c || "-").padEnd(13)).join("")}${row.total}`);
  }
  const colTot = projs.map((pr) => rows.reduce((s, r) => s + (grid.get(`${r.p}|${pr}`)?.a || 0), 0));
  console.log(`  ${"ASSIGNED TOTAL".padEnd(26)}${colTot.map((c) => String(c).padEnd(13)).join("")}`
    + `${colTot.reduce((a, b) => a + b, 0)}`);
  console.log(`  ${"UNASSIGNED".padEnd(26)}`
    + `${projs.map((pr) => String(unassignedByProject.get(pr) || 0).padEnd(13)).join("")}`
    + `${[...unassignedByProject.values()].reduce((a, b) => a + b, 0)}`);

  console.log(`\n  open status names: ${[...statuses.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`  unassigned-open by status: ${[...unassignedByStatus.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
  console.log(`\n  assignee === reporter on open: same=${pairSame.same}  different=${pairSame.diff}  `
    + `no assignee=${pairSame.noAssignee}`);
  if (oldestOpen) console.log(`  oldest open: ${oldestOpen.key} (${oldestOpen.proj}) created `
    + `${new Date(oldestOpen.t).toISOString().slice(0, 10)}`);
  if (newestOpen) console.log(`  newest open: ${newestOpen.key} (${newestOpen.proj}) created `
    + `${new Date(newestOpen.t).toISOString().slice(0, 10)}`);
  console.log(`  open+assigned but untouched 90d+: ${[...staleByAssignee.entries()]
    .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}`);
  console.log("");
})().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
