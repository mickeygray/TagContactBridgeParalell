"use strict";

/**
 * create-jira-template — post a worked example of a Jira request that reads 1:1.
 *
 * Mickey 2026-08-05: "i'm trying to give them guidelines for the best way to fill out
 * a jira request... so basically post a jira at the top of to do that you would be
 * able to read 1:1."
 *
 * ── WHAT ACTUALLY BLOCKS A CLEAN READ ───────────────────────────────────────
 *
 * Measured across all 809 open issues: 38% are already fully deterministic, 23% more
 * need only the years read out of prose, 35% need the ACTION inferred from prose, and
 * 4% cannot be read at all. The template targets the 39% that is not clean, and each
 * of its three parts fixes a specific measured failure:
 *
 *   DATABASE  — 37% of summaries never name the tenant, and case ids COLLIDE across
 *               TAG/AMITY/WYNN (11330 is three different people). Today that is
 *               resolved by matching the client name against each tenant in turn,
 *               which costs a lookup per issue and fails on 1.1%.
 *
 *   SUBJECT   — the single biggest cost. Where the status carries the verb the read
 *               is exact; where it does not, the action has to be inferred, and that
 *               is where "Biz POA in logics" (a statement) was read as a request to
 *               file a POA. Naming the action removes the inference entirely.
 *
 *   NOTES     — already good. Tax years lead, prose follows, and that convention is
 *               why year extraction survived audit. The template just makes it
 *               explicit so it keeps happening.
 *
 * The example is deliberately WELL FORMED rather than a row of empty brackets, so it
 * doubles as a live test: it should parse to exactly the task it describes.
 *
 * THIS CREATES A REAL JIRA ISSUE.
 *
 *   node scripts/analysis/create-jira-template.js           # dry run
 *   node scripts/analysis/create-jira-template.js --apply
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const p = (text, marks) => (marks ? { type: "text", text, marks } : { type: "text", text });
const bold = (text) => p(text, [{ type: "strong" }]);
const code = (text) => p(text, [{ type: "code" }]);
const para = (...content) => ({ type: "paragraph", content });
const rule = () => ({ type: "rule" });
const bullets = (items) => ({
  type: "bulletList",
  content: items.map((c) => ({ type: "listItem", content: [para(...(Array.isArray(c) ? c : [p(c)]))] })),
});

const SUBJECTS = [
  "Prep Return", "File Return", "Amend Return",
  "Follow Up On Signed Returns", "Follow Up On Tax Organizer",
  "File POA", "Run THS", "Review Client Info For POA",
  "Prac Call", "Follow Up On Billing",
];

const description = {
  type: "doc",
  version: 1,
  content: [
    para(bold("Use this shape for the summary line:")),
    para(code("DATABASE | CASE ID | SUBJECT")),
    para(p("The summary above this description is a real, correctly-formed example. "),
      p("Everything below explains why each part is there.")),
    rule(),

    para(bold("1. DATABASE"), p("  —  TAG, WYNN or AMITY.")),
    para(p("Case numbers repeat across the three databases. Case 11330 is a different "),
      p("person in each one. Without the database named, the case number alone does not "),
      p("identify a client, and we have to guess by matching the name.")),

    para(bold("2. CASE ID"), p("  —  the Logics case number, digits only.")),
    para(p("Already done well. Keep it as its own field between the dividers rather than "),
      p("buried in a sentence.")),

    para(bold("3. SUBJECT"), p("  —  what needs doing. Pick one:")),
    bullets(SUBJECTS.map((s) => [code(s)])),
    para(p("This is the one that matters most. When the subject is not named we have to "),
      p("work it out from the note, and notes are ambiguous in ways that are easy to miss. "),
      p("\"Biz POA in logics\" means the POA is ALREADY THERE — but it reads at a glance "),
      p("like a request to file one. Naming the subject removes the guess.")),
    rule(),

    para(bold("4. NOTES"), p("  —  this description field. Free text, no format required.")),
    para(p("Lead with the tax years, then anything else. That convention already works: ")),
    bullets([
      [code("2023-2025"), p("  then the detail")],
      [code("2018, 2020-2025"), p("  — gaps are fine, list them exactly")],
      [code("23-25"), p("  — short form is fine")],
    ]),
    para(p("Years buried mid-sentence are risky. \"balances assessed in June of 2026\" is a "),
      p("date, not a tax year, and anything reading the note has to tell those apart.")),
    rule(),

    para(bold("If something is already done, say so plainly.")),
    para(p("\"POA on file\" or \"docs received\" tells us the work is finished. A note that "),
      p("only mentions a POA is indistinguishable from a request for one.")),

    para(bold("Assign the ticket.")),
    para(p("An unassigned ticket cannot become a Logics task at all — Logics requires a "),
      p("person. 216 of 809 open tickets currently have nobody on them.")),
    rule(),

    para(bold("Worked example"), p("  —  this ticket.")),
    para(code("TAG | 401656 | Prep Return")),
    para(p("Notes: "), code("2023-2025"), p("  client sending W-2s this week.")),
    para(p("Reads unambiguously as: prepare 2023-2025 returns on TAG case 401656.")),
  ],
};

async function main() {
  const apply = process.argv.includes("--apply");
  const payload = {
    fields: {
      project: { key: "ASSIGNMENT" },
      issuetype: { name: "Task" },
      summary: "TEMPLATE | HOW TO FILL THIS OUT | TAG | 401656 | Prep Return",
      description,
      // Required on every ASSIGNMENT issue. Zero on a template.
      customfield_10032: 0,
    },
  };

  console.log(`\n  summary: ${payload.fields.summary}`);
  console.log(`  project: ASSIGNMENT   type: Task`);
  if (!apply) {
    console.log(`\n  DRY RUN — re-run with --apply to create it.\n`);
    return;
  }

  const res = await fetch(`${BASE}/rest/api/3/issue`, {
    method: "POST", headers: AUTH, body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) { console.log(`  FAILED ${res.status}: ${text.slice(0, 400)}`); return; }
  const made = JSON.parse(text);
  console.log(`\n  CREATED ${made.key}  ->  ${BASE}/browse/${made.key}`);

  // Rank it to the top of the backlog so it is the first thing anyone sees.
  const rank = await fetch(`${BASE}/rest/agile/1.0/issue/rank`, {
    method: "PUT", headers: AUTH,
    body: JSON.stringify({ issues: [made.key], rankBeforeIssue: "ASSIGNMENT-1" }),
  });
  console.log(`  rank to top: ${rank.status === 204 ? "ok" : `HTTP ${rank.status} — set it by hand`}`);
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
