"use strict";

/**
 * probe-jira-counts-crosscheck — ask Jira to count the same things I tallied.
 *
 * READ ONLY, one call per line. If my client-side tally and Jira's own count
 * disagree, the tally is wrong and the report should not be trusted.
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

const P = "project in (ASSIGNMENT, POAREQ, RESO)";
const QUERIES = [
  ["all issues", P],
  ["statusCategory = Done", `${P} AND statusCategory = Done`],
  ['status = "Done" (exact status name)', `${P} AND status = "Done"`],
  ["statusCategory != Done (open)", `${P} AND statusCategory != Done`],
  ["assignee is EMPTY", `${P} AND assignee is EMPTY`],
  ["assignee is not EMPTY", `${P} AND assignee is not EMPTY`],
  ["open AND assignee is EMPTY", `${P} AND statusCategory != Done AND assignee is EMPTY`],
  ["reporter is EMPTY", `${P} AND reporter is EMPTY`],
  ["issuetype != Task", `${P} AND issuetype != Task`],
];

(async () => {
  console.log("");
  for (const [label, jql] of QUERIES) {
    const res = await fetch(`${BASE}/rest/api/3/search/approximate-count`, {
      method: "POST", headers: AUTH, body: JSON.stringify({ jql }),
    });
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      console.log(`  HTTP ${res.status} — stopping`); break;
    }
    const body = JSON.parse(await res.text());
    console.log(`  ${label.padEnd(38)} ${body.count ?? JSON.stringify(body).slice(0, 120)}`);
  }
  console.log("");
})().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
