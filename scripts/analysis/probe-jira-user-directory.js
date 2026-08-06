"use strict";

/**
 * probe-jira-user-directory — who EXISTS as a user in the Jira site.
 *
 * Distinct from who is assigned to issues. Read-only: GET only, no writes.
 *
 *   node scripts/analysis/probe-jira-user-directory.js
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

function mask(email) {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0) return "(malformed)";
  return `${email.slice(0, 2)}***${email.slice(at)}`;
}

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: AUTH });
  const text = await res.text();
  if (res.status === 429 || res.status === 401 || res.status === 403) {
    throw new Error(`HTTP ${res.status} on ${pathAndQuery} :: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    return { __error: `HTTP ${res.status}`, __body: text.slice(0, 300) };
  }
  try { return JSON.parse(text); } catch { return { __error: "unparseable", __body: text.slice(0, 200) }; }
}

/** /users/search is startAt/maxResults paged and returns EVERY account, incl. apps. */
async function fetchDirectory() {
  const out = [];
  let startAt = 0;
  const PAGE = 200;
  for (let guard = 0; guard < 25; guard += 1) {
    const page = await get(`/rest/api/3/users/search?maxResults=${PAGE}&startAt=${startAt}`);
    if (page && page.__error) { console.log(`  users/search ERROR ${page.__error} ${page.__body}`); break; }
    if (!Array.isArray(page)) { console.log("  users/search returned non-array:", JSON.stringify(page).slice(0, 200)); break; }
    out.push(...page);
    if (page.length < PAGE) break;
    startAt += PAGE;
  }
  return out;
}

async function fetchAssignable(projectKey) {
  const out = [];
  let startAt = 0;
  const PAGE = 200;
  for (let guard = 0; guard < 15; guard += 1) {
    const page = await get(
      `/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=${PAGE}&startAt=${startAt}`);
    if (page && page.__error) { console.log(`  assignable ${projectKey} ERROR ${page.__error} ${page.__body}`); break; }
    if (!Array.isArray(page)) { console.log(`  assignable ${projectKey} non-array:`, JSON.stringify(page).slice(0, 200)); break; }
    out.push(...page);
    if (page.length < PAGE) break;
    startAt += PAGE;
  }
  return out;
}

const BOTISH = /(bot|automation|jira|atlassian|addon|connect|service|integration|sync|webhook|system|proforma|opsgenie|assist|migrat|analytics|marketplace|trello|slack|github|zapier)/i;

async function main() {
  if (!TOKEN) { console.log("  NO JIRA_API_TOKEN in env — cannot look."); return; }

  console.log("\n=== 1. SITE USER DIRECTORY  (GET /rest/api/3/users/search) ===\n");
  const all = await fetchDirectory();
  console.log(`  raw accounts returned: ${all.length}`);

  const byType = {};
  for (const u of all) byType[u.accountType || "(none)"] = (byType[u.accountType || "(none)"] || 0) + 1;
  console.log(`  by accountType: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  // --- email exposure ---------------------------------------------------
  const withEmail = all.filter((u) => u.emailAddress);
  console.log(`\n  emailAddress present on ${withEmail.length}/${all.length} accounts from users/search`);

  const humans = all.filter((u) => u.accountType === "atlassian");
  const apps = all.filter((u) => u.accountType !== "atlassian");

  // /user/bulk can carry email where search does not, depending on scopes.
  let bulkEmails = 0;
  let bulkChecked = 0;
  const bulkEmailById = new Map();
  const ids = humans.map((u) => u.accountId);
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const q = chunk.map((id) => `accountId=${encodeURIComponent(id)}`).join("&");
    const page = await get(`/rest/api/3/user/bulk?maxResults=50&${q}`);
    if (page && page.__error) { console.log(`  user/bulk ERROR ${page.__error} ${page.__body}`); break; }
    for (const u of page.values || []) {
      bulkChecked += 1;
      if (u.emailAddress) { bulkEmails += 1; bulkEmailById.set(u.accountId, u.emailAddress); }
    }
  }
  console.log(`  /user/bulk: ${bulkEmails}/${bulkChecked} human accounts carried an emailAddress`);

  // /user/email needs its own scope; try one to name the failure precisely.
  if (humans.length) {
    const probe = await get(`/rest/api/3/user/email?accountId=${encodeURIComponent(humans[0].accountId)}`);
    console.log(`  /user/email probe: ${probe && probe.__error ? `${probe.__error} ${String(probe.__body).slice(0, 120)}` : (probe.email ? "email RETURNED" : JSON.stringify(probe).slice(0, 120))}`);
  }

  // --- assignable per project ------------------------------------------
  console.log("\n=== 2. ASSIGNABLE PER PROJECT  (GET /rest/api/3/user/assignable/search) ===\n");
  const assignable = {};
  for (const p of PROJECTS) {
    const list = await fetchAssignable(p);
    assignable[p] = new Set(list.map((u) => u.accountId));
    const h = list.filter((u) => u.accountType === "atlassian").length;
    console.log(`  ${p.padEnd(12)} ${String(list.length).padEnd(5)} assignable  (${h} atlassian / ${list.length - h} other)`);
  }

  // --- the roster -------------------------------------------------------
  console.log("\n=== 3. HUMAN ROSTER (accountType=atlassian) ===\n");
  console.log(`  ${"displayName".padEnd(28)}${"active".padEnd(8)}${"email".padEnd(34)}${"ASSIGN".padEnd(8)}${"POAREQ".padEnd(8)}${"RESO".padEnd(7)}accountId`);
  const sorted = [...humans].sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  const rows = [];
  for (const u of sorted) {
    const email = u.emailAddress || bulkEmailById.get(u.accountId) || null;
    const flags = PROJECTS.map((p) => (assignable[p].has(u.accountId) ? "yes" : "-"));
    rows.push({
      displayName: u.displayName,
      accountId: u.accountId,
      active: !!u.active,
      email,
      maskedEmail: mask(email),
      assignable: { ASSIGNMENT: flags[0] === "yes", POAREQ: flags[1] === "yes", RESO: flags[2] === "yes" },
      botish: BOTISH.test(String(u.displayName)),
    });
    console.log(`  ${String(u.displayName).slice(0, 27).padEnd(28)}${(u.active ? "yes" : "NO").padEnd(8)}`
      + `${String(mask(email) || "(hidden)").padEnd(34)}${flags[0].padEnd(8)}${flags[1].padEnd(8)}${flags[2].padEnd(7)}${u.accountId.slice(0, 30)}`);
  }

  console.log("\n=== 4. NON-HUMAN / APP ACCOUNTS ===\n");
  for (const u of apps.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)))) {
    console.log(`  ${String(u.displayName).slice(0, 40).padEnd(42)}${String(u.accountType).padEnd(12)}`
      + `${(u.active ? "active" : "INACTIVE").padEnd(10)}${u.accountId.slice(0, 40)}`);
  }

  console.log("\n=== 5. HEADLINE ===\n");
  const activeHumans = humans.filter((u) => u.active);
  console.log(`  human (atlassian) accounts : ${humans.length}   active: ${activeHumans.length}   inactive: ${humans.length - activeHumans.length}`);
  console.log(`  app/other accounts         : ${apps.length}`);
  const flagged = rows.filter((r) => r.botish);
  console.log(`  human accounts with bot-ish display names: ${flagged.length}${flagged.length ? " → " + flagged.map((f) => f.displayName).join(", ") : ""}`);

  // assignable coverage of the human roster
  for (const p of PROJECTS) {
    const n = rows.filter((r) => r.assignable[p]).length;
    console.log(`  humans assignable on ${p.padEnd(11)}: ${n}/${humans.length}`);
  }
  const noneAssignable = rows.filter((r) => !r.assignable.ASSIGNMENT && !r.assignable.POAREQ && !r.assignable.RESO);
  console.log(`  humans assignable on NO project: ${noneAssignable.length}`
    + (noneAssignable.length ? ` → ${noneAssignable.map((r) => r.displayName).join(", ")}` : ""));

  // Cross-check: is anyone assignable who did NOT come back from users/search?
  const dirIds = new Set(all.map((u) => u.accountId));
  const extra = new Set();
  for (const p of PROJECTS) for (const id of assignable[p]) if (!dirIds.has(id)) extra.add(id);
  console.log(`  assignable accountIds NOT present in users/search: ${extra.size}`);

  require("fs").writeFileSync(
    require("path").join(__dirname, "probe-jira-user-directory.out.json"),
    JSON.stringify({ rows, apps: apps.map((a) => ({ displayName: a.displayName, accountId: a.accountId, accountType: a.accountType, active: a.active })) }, null, 2),
  );
  console.log("\n  (roster written to scripts/analysis/probe-jira-user-directory.out.json)\n");
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
