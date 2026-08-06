"use strict";

/**
 * probe-jira-assignee-sweep — do Jira issues actually have PEOPLE on them?
 *
 * READ ONLY. Pages every issue in ASSIGNMENT, POAREQ and RESO with nextPageToken
 * and tallies assignee vs reporter, split by project and by open/Done, because a
 * sync only has to map the OPEN subset.
 *
 *   node scripts/analysis/probe-jira-assignee-sweep.js
 */

require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.JIRA_API_TOKEN;
const EMAIL = "mgray@taxadvocategroup.com";
const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const PROJECTS = ["ASSIGNMENT", "POAREQ", "RESO"];

/** first 2 chars + domain, so a coworker is identifiable without dumping the address */
function maskEmail(addr) {
  if (!addr) return null;
  const at = String(addr).indexOf("@");
  if (at < 1) return "(masked)";
  return `${String(addr).slice(0, 2)}***${String(addr).slice(at)}`;
}

async function fetchAll(jql, fields) {
  const out = [];
  let token = null;
  let pages = 0;
  do {
    const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ jql, maxResults: 100, fields, ...(token ? { nextPageToken: token } : {}) }),
    });
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status} from Jira — stopping, not retrying`);
    }
    const text = await res.text();
    let page;
    try { page = JSON.parse(text); } catch { throw new Error(`unparseable page: ${text.slice(0, 200)}`); }
    if (page.errorMessages || page.errors) {
      throw new Error(`Jira error: ${JSON.stringify(page.errorMessages || page.errors).slice(0, 200)}`);
    }
    out.push(...(page.issues || []));
    token = page.nextPageToken || null;
    pages += 1;
    process.stderr.write(`    page ${pages}: +${(page.issues || []).length} (total ${out.length})\n`);
  } while (token);
  return out;
}

function personKey(p) {
  if (!p) return null;
  return p.accountId || p.displayName || null;
}

function main() {
  return (async () => {
    const jql = `project in (${PROJECTS.join(", ")}) ORDER BY created ASC`;
    const fields = ["assignee", "reporter", "summary", "project", "status", "created", "updated"];
    console.log(`\n  JQL: ${jql}`);
    const issues = await fetchAll(jql, fields);
    console.log(`\n  ISSUES RETRIEVED: ${issues.length}\n`);

    const byProject = {};
    const assignees = new Map();
    const reporters = new Map();
    const statusCats = new Map();
    let missingStatusCat = 0;
    const openNoAssigneeSample = [];

    for (const issue of issues) {
      const f = issue.fields || {};
      const proj = f.project?.key || "(none)";
      const cat = f.status?.statusCategory?.key || null; // "done" | "indeterminate" | "new"
      if (!cat) missingStatusCat += 1;
      const catName = f.status?.statusCategory?.name || "(unknown)";
      statusCats.set(catName, (statusCats.get(catName) || 0) + 1);
      const isOpen = cat !== "done";

      const b = byProject[proj] || (byProject[proj] = {
        project: proj, issues: 0, open: 0,
        withAssignee: 0, openWithAssignee: 0,
        withReporter: 0, openWithReporter: 0,
        assigneeSet: new Set(), reporterSet: new Set(),
      });
      b.issues += 1;
      if (isOpen) b.open += 1;

      const a = f.assignee;
      const r = f.reporter;
      if (a) {
        b.withAssignee += 1;
        if (isOpen) b.openWithAssignee += 1;
        const k = personKey(a);
        b.assigneeSet.add(k);
        const rec = assignees.get(k) || (assignees.set(k, {
          accountId: a.accountId || null,
          displayName: a.displayName || "(no display name)",
          emailAddress: a.emailAddress || null,
          active: typeof a.active === "boolean" ? a.active : null,
          accountType: a.accountType || null,
          count: 0, open: 0, projects: {},
        }).get(k));
        rec.count += 1;
        if (isOpen) rec.open += 1;
        rec.projects[proj] = (rec.projects[proj] || 0) + 1;
        if (a.emailAddress && !rec.emailAddress) rec.emailAddress = a.emailAddress;
      } else if (isOpen && openNoAssigneeSample.length < 8) {
        openNoAssigneeSample.push(`${issue.key} [${proj}] ${f.status?.name}`);
      }

      if (r) {
        b.withReporter += 1;
        if (isOpen) b.openWithReporter += 1;
        const k = personKey(r);
        b.reporterSet.add(k);
        const rec = reporters.get(k) || (reporters.set(k, {
          accountId: r.accountId || null,
          displayName: r.displayName || "(no display name)",
          emailAddress: r.emailAddress || null,
          active: typeof r.active === "boolean" ? r.active : null,
          accountType: r.accountType || null,
          count: 0, open: 0, projects: {},
        }).get(k));
        rec.count += 1;
        if (isOpen) rec.open += 1;
        rec.projects[proj] = (rec.projects[proj] || 0) + 1;
        if (r.emailAddress && !rec.emailAddress) rec.emailAddress = r.emailAddress;
      }
    }

    const pct = (a, b) => `${a} (${((a / Math.max(b, 1)) * 100).toFixed(1)}%)`;

    console.log("  status categories seen: "
      + [...statusCats.entries()].map(([k, v]) => `${k}=${v}`).join("  "));
    console.log(`  issues with NO statusCategory field returned: ${missingStatusCat}\n`);

    console.log(`  ${"project".padEnd(12)}${"issues".padEnd(9)}${"open".padEnd(8)}`
      + `${"assignee".padEnd(17)}${"open+assignee".padEnd(17)}${"reporter".padEnd(17)}`
      + `${"open+reporter".padEnd(17)}${"#asgn".padEnd(7)}#rptr`);
    const tot = { issues: 0, open: 0, withAssignee: 0, openWithAssignee: 0, withReporter: 0, openWithReporter: 0 };
    for (const b of Object.values(byProject)) {
      for (const f of Object.keys(tot)) tot[f] += b[f];
      console.log(`  ${b.project.padEnd(12)}${String(b.issues).padEnd(9)}${String(b.open).padEnd(8)}`
        + `${pct(b.withAssignee, b.issues).padEnd(17)}${pct(b.openWithAssignee, b.open).padEnd(17)}`
        + `${pct(b.withReporter, b.issues).padEnd(17)}${pct(b.openWithReporter, b.open).padEnd(17)}`
        + `${String(b.assigneeSet.size).padEnd(7)}${b.reporterSet.size}`);
    }
    console.log(`  ${"ALL".padEnd(12)}${String(tot.issues).padEnd(9)}${String(tot.open).padEnd(8)}`
      + `${pct(tot.withAssignee, tot.issues).padEnd(17)}${pct(tot.openWithAssignee, tot.open).padEnd(17)}`
      + `${pct(tot.withReporter, tot.issues).padEnd(17)}${pct(tot.openWithReporter, tot.open).padEnd(17)}`
      + `${String(assignees.size).padEnd(7)}${reporters.size}`);

    const dump = (label, map) => {
      console.log(`\n  ── ${label} (${map.size} distinct) ──`);
      const rows = [...map.values()].sort((x, y) => y.count - x.count);
      let cum = 0;
      const grand = rows.reduce((s, r) => s + r.count, 0);
      for (const r of rows) {
        cum += r.count;
        console.log(`  ${String(r.count).padStart(5)}  open ${String(r.open).padStart(4)}  `
          + `${((cum / Math.max(grand, 1)) * 100).toFixed(1).padStart(5)}% cum  `
          + `${(r.displayName || "").padEnd(26)}`
          + `${(r.active === null ? "active?" : r.active ? "active" : "INACTIVE").padEnd(9)}`
          + `${(r.accountType || "-").padEnd(9)}`
          + `${(maskEmail(r.emailAddress) || "(no email visible)").padEnd(28)}`
          + `${Object.entries(r.projects).map(([k, v]) => `${k}:${v}`).join(" ")}`);
      }
      return rows;
    };

    const aRows = dump("ASSIGNEES", assignees);
    const rRows = dump("REPORTERS", reporters);

    if (openNoAssigneeSample.length) {
      console.log(`\n  sample OPEN issues with no assignee:`);
      for (const s of openNoAssigneeSample) console.log(`    ${s}`);
    }

    const out = {
      totalIssues: issues.length,
      byProject: Object.values(byProject).map((b) => ({
        project: b.project, issues: b.issues, open: b.open,
        withAssignee: b.withAssignee, openWithAssignee: b.openWithAssignee,
        withReporter: b.withReporter, openWithReporter: b.openWithReporter,
        distinctAssignees: b.assigneeSet.size, distinctReporters: b.reporterSet.size,
      })),
      totals: tot,
      assignees: aRows.map((r) => ({ ...r, emailAddress: maskEmail(r.emailAddress) })),
      reporters: rRows.map((r) => ({ ...r, emailAddress: maskEmail(r.emailAddress) })),
      statusCategories: Object.fromEntries(statusCats),
    };
    const p = path.join(__dirname, "probe-jira-assignee-sweep.out.json");
    fs.writeFileSync(p, JSON.stringify(out, null, 2));
    console.log(`\n  wrote ${p}\n`);
  })();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
