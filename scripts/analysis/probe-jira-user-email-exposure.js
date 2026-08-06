"use strict";

/**
 * probe-jira-user-email-exposure — is emailAddress hidden by Atlassian privacy,
 * or genuinely absent? And which non-human accounts are assignable?
 *
 * "We could not look" and "there is nothing" are different answers. This tells
 * them apart: it asks three different endpoints for the SAME account and reports
 * exactly what each one said.
 *
 *   node scripts/analysis/probe-jira-user-email-exposure.js
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const TOKEN = process.env.JIRA_API_TOKEN;
const EMAIL = "mgray@taxadvocategroup.com";
const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`,
  Accept: "application/json",
};
const PROJECTS = ["ASSIGNMENT", "POAREQ", "RESO"];

async function get(p) {
  const res = await fetch(`${BASE}${p}`, { headers: AUTH });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: res.status, body };
}

function mask(e) {
  if (!e) return "(none)";
  const at = e.indexOf("@");
  return at < 0 ? "(malformed)" : `${e.slice(0, 2)}***${e.slice(at)}`;
}

async function main() {
  // Who is calling, and what does the site's privacy setting look like from here?
  const me = await get("/rest/api/3/myself");
  console.log(`\n  caller: ${me.body.displayName}  email ${mask(me.body.emailAddress)}  `
    + `accountType ${me.body.accountType}`);

  // Am I an admin? Admin rights are what would let email through.
  const perms = await get("/rest/api/3/mypermissions?permissions=ADMINISTER,BROWSE_PROJECTS,ASSIGN_ISSUE");
  const p = (me && perms.body && perms.body.permissions) || {};
  console.log(`  my permissions: ${Object.entries(p).map(([k, v]) => `${k}=${v.havePermission}`).join("  ")}`);

  // Pick two humans who are NOT me and ask three endpoints for their email.
  const dir = await get("/rest/api/3/users/search?maxResults=200&startAt=0");
  const humans = (dir.body || []).filter((u) => u.accountType === "atlassian"
    && u.accountId !== me.body.accountId);
  const sample = humans.slice(0, 3);

  console.log("\n  same account, three endpoints:\n");
  for (const u of sample) {
    const single = await get(`/rest/api/3/user?accountId=${encodeURIComponent(u.accountId)}`);
    const bulk = await get(`/rest/api/3/user/bulk?accountId=${encodeURIComponent(u.accountId)}`);
    const dedicated = await get(`/rest/api/3/user/email?accountId=${encodeURIComponent(u.accountId)}`);
    const bulkUser = (bulk.body && bulk.body.values && bulk.body.values[0]) || {};
    console.log(`  ${String(u.displayName).padEnd(22)}`);
    console.log(`      /user            HTTP ${single.status}  emailAddress field ${"emailAddress" in (single.body || {}) ? `PRESENT=${mask(single.body.emailAddress)}` : "ABSENT FROM PAYLOAD"}`);
    console.log(`      /user/bulk       HTTP ${bulk.status}  emailAddress field ${"emailAddress" in bulkUser ? `PRESENT=${mask(bulkUser.emailAddress)}` : "ABSENT FROM PAYLOAD"}`);
    console.log(`      /user/email      HTTP ${dedicated.status}  ${typeof dedicated.body === "object" ? JSON.stringify(dedicated.body).slice(0, 130) : String(dedicated.body).slice(0, 130)}`);
  }

  // Which non-human accounts can legally be assigned work?
  console.log("\n  non-human accounts that are ASSIGNABLE:\n");
  for (const proj of PROJECTS) {
    const a = await get(`/rest/api/3/user/assignable/search?project=${proj}&maxResults=200`);
    const nonHuman = (a.body || []).filter((u) => u.accountType !== "atlassian");
    console.log(`  ${proj.padEnd(12)} ${nonHuman.map((u) => `${u.displayName} [${u.accountType}${u.active ? "" : ", INACTIVE"}]`).join("  |  ") || "(none)"}`);
  }

  // Cross-check the roster against who actually holds issues today — an assignee
  // who is not in the directory would mean users/search is not the whole truth.
  console.log("\n  distinct assignees actually on issues (JQL, all three projects):\n");
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify({
      jql: "project in (ASSIGNMENT, POAREQ, RESO) ORDER BY created DESC",
      maxResults: 100, fields: ["assignee", "reporter", "project"],
    }),
  });
  const first = JSON.parse(await res.text());
  const seen = new Map();
  const reporters = new Map();
  let token = first.nextPageToken || null;
  let pages = 0;
  const take = (page) => {
    for (const i of page.issues || []) {
      const a = i.fields.assignee;
      if (a) seen.set(a.accountId, a.displayName);
      const r = i.fields.reporter;
      if (r) reporters.set(r.accountId, r.displayName);
    }
  };
  take(first);
  while (token && pages < 60) {
    const r2 = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({
        jql: "project in (ASSIGNMENT, POAREQ, RESO) ORDER BY created DESC",
        maxResults: 100, fields: ["assignee", "reporter", "project"], nextPageToken: token,
      }),
    });
    const page = JSON.parse(await r2.text());
    take(page);
    token = page.nextPageToken || null;
    pages += 1;
  }
  const dirIds = new Set((dir.body || []).map((u) => u.accountId));
  console.log(`  pages walked: ${pages + 1}`);
  console.log(`  distinct ASSIGNEES: ${seen.size} → ${[...seen.values()].join(", ") || "(none)"}`);
  for (const [id, name] of seen) if (!dirIds.has(id)) console.log(`      ${name} is NOT in users/search`);
  console.log(`  distinct REPORTERS: ${reporters.size} → ${[...reporters.values()].join(", ") || "(none)"}`);
  for (const [id, name] of reporters) if (!dirIds.has(id)) console.log(`      ${name} is NOT in users/search`);
  console.log("");
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
