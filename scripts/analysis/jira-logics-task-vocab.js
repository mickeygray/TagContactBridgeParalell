"use strict";

/**
 * jira-logics-task-vocab — find out what a task IS on each side, so a migrated
 * task says what needs doing instead of just naming the client.
 *
 * The problem this exists to fix: the Jira summary is not the work. Summaries in
 * these projects are "401656 - MICHAEL NIELSON" — a case id and a client name. A
 * Logics task carrying that as its Subject tells the person who opens it nothing
 * about what to do. The actionable part lives somewhere else in the issue, and
 * this script finds out where.
 *
 * Two halves, deliberately:
 *
 *  JIRA SIDE — which fields actually carry the work? Status looks like the answer
 *  (HOLD FOR A/S, SENT FOR SIGNATURES, READY TO FILE) but components, labels, a
 *  custom category field, or the description could carry it too. Guessing status
 *  and being wrong would bake a bad Subject into records that CANNOT BE EDITED
 *  afterwards, so this counts how often each candidate field is actually populated
 *  rather than assuming.
 *
 *  LOGICS SIDE — Task/Task accepts TaskCategoryID, StatusID, PriorityID and
 *  TaskType, all optional and all undocumented as to their valid values. There is
 *  no lookup route for any of them. But existing task rows come back from
 *  Task/GetTasksByDateRange, so the vocabulary in live use can be harvested the
 *  same way the user directory was.
 *
 *   node scripts/analysis/jira-logics-task-vocab.js
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const pct = (a, b) => `${a} (${((a / Math.max(b, 1)) * 100).toFixed(0)}%)`;

/** Flatten Atlassian document format down to plain text so we can see if it says anything. */
function adfText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text || "";
  return (node.content || []).map(adfText).join(" ");
}

async function jiraSide() {
  // One issue in full, to see the complete field inventory including customfields.
  const one = await (await fetch(
    `${BASE}/rest/api/3/issue/ASSIGNMENT-2040?expand=names`, { headers: AUTH },
  )).json();

  console.log(`\n  === JIRA: every POPULATED field on ASSIGNMENT-2040 ===\n`);
  const names = one.names || {};
  for (const [k, v] of Object.entries(one.fields || {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length) continue;
    let shown;
    if (typeof v === "object") {
      shown = v.name || v.value || v.displayName || v.key
        || (Array.isArray(v) ? v.map((x) => x?.name || x?.value || x).join(", ") : null)
        || (v.type === "doc" ? `[doc] ${adfText(v).slice(0, 90)}` : JSON.stringify(v).slice(0, 90));
    } else shown = String(v).slice(0, 90);
    if (shown === "" || shown === "[doc] ") continue;
    console.log(`    ${String(names[k] || k).slice(0, 26).padEnd(28)}${String(shown).slice(0, 78)}`);
  }

  // Now: across the OPEN backlog, which of the candidate work-carrying fields are
  // actually filled in? A field populated on one issue proves nothing.
  const issues = [];
  let token = null;
  do {
    const page = await (await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        jql: "project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done",
        maxResults: 100,
        fields: ["summary", "status", "components", "labels", "description",
          "priority", "duedate", "project", "parent", "issuetype"],
        ...(token ? { nextPageToken: token } : {}),
      }),
    })).json();
    issues.push(...(page.issues || []));
    token = page.nextPageToken || null;
  } while (token);

  const has = { components: 0, labels: 0, description: 0, duedate: 0, priority: 0, parent: 0 };
  const statusByProject = {};
  for (const i of issues) {
    const f = i.fields;
    if (f.components?.length) has.components += 1;
    if (f.labels?.length) has.labels += 1;
    if (adfText(f.description).trim()) has.description += 1;
    if (f.duedate) has.duedate += 1;
    if (f.priority?.name && f.priority.name !== "Medium") has.priority += 1;
    if (f.parent) has.parent += 1;
    const p = f.project.key;
    (statusByProject[p] || (statusByProject[p] = {}));
    const s = f.status?.name || "(none)";
    statusByProject[p][s] = (statusByProject[p][s] || 0) + 1;
  }

  console.log(`\n  === JIRA: what carries the WORK across ${issues.length} open issues ===\n`);
  for (const [k, v] of Object.entries(has)) {
    console.log(`    ${k.padEnd(14)}${pct(v, issues.length)}`);
  }
  console.log(`\n  STATUS is the candidate — distinct values per project:`);
  for (const [p, counts] of Object.entries(statusByProject)) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    console.log(`\n    ${p} (${sorted.length} distinct):`);
    for (const [s, n] of sorted) console.log(`      ${String(n).padStart(4)}  ${s}`);
  }
  return issues.length;
}

async function logicsSide() {
  console.log(`\n\n  === LOGICS: task vocabulary in live use (harvested) ===`);
  const now = Date.parse("2026-08-05T00:00:00Z");
  for (const tenant of ["TAG"]) {
    const client = createLogicsClient(tenant);
    const cat = new Map();
    const type = new Map();
    const status = new Map();
    const prio = new Map();
    const subjects = [];
    let rows = 0;
    let shape = null;

    for (let w = 0; w < 6; w += 1) {
      const end = now - w * 60 * 86400000;
      let res;
      try {
        res = await client.getTasksByDateRange(dayStr(end - 60 * 86400000), dayStr(end));
      } catch (e) { console.log(`    window failed: ${String(e.message).slice(0, 60)}`); continue; }
      const list = res?.Data ?? res?.data ?? res;
      if (!Array.isArray(list)) continue;
      rows += list.length;
      if (!shape && list[0]) shape = Object.keys(list[0]);
      for (const r of list) {
        const bump = (m, k, label) => { if (k == null) return; const e = m.get(k) || { n: 0, label }; e.n += 1; if (label) e.label = label; m.set(k, e); };
        bump(cat, r.TaskCategoryID, r.TaskCategoryName || r.CategoryName);
        bump(type, r.TaskType, r.TaskTypeName);
        bump(status, r.StatusID, r.StatusName);
        bump(prio, r.PriorityID, r.PriorityName);
        if (r.Subject && subjects.length < 24) subjects.push(r.Subject);
      }
    }

    console.log(`\n    ${tenant}: ${rows} task rows`);
    console.log(`    row fields: ${(shape || []).join(", ").slice(0, 400)}`);
    const dump = (name, m) => {
      const sorted = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
      console.log(`\n    ${name} (${sorted.length} distinct in use):`);
      for (const [k, e] of sorted.slice(0, 20)) {
        console.log(`      ${String(k).padStart(5)}  ${String(e.label || "(no name returned)").padEnd(34)}${e.n}`);
      }
    };
    dump("TaskCategoryID", cat);
    dump("TaskType", type);
    dump("StatusID", status);
    dump("PriorityID", prio);

    console.log(`\n    How humans actually word a Logics task Subject:`);
    for (const s of subjects.slice(0, 18)) console.log(`      ${String(s).slice(0, 92)}`);
  }
}

async function main() {
  await connectMongo(getSharedConfig());
  await jiraSide();
  await logicsSide();
  console.log("");
  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
