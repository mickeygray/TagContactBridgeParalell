"use strict";

/**
 * jira-roadblock-routing — turn blocked tax-prep issues into work that has an owner.
 *
 * Mickey 2026-08-05: "if there's a roadblock about wait for POA you would assign a
 * file POA to Jackie or Riley... some roadblocks in tax prep would have a POA filing
 * request of the same case in POAREQ."
 *
 * THE IDEA
 *
 * ROADBLOCK and To Do issues in ASSIGNMENT looked unmigratable — 205 of the 230
 * unassigned open issues sit in those two statuses, because nobody picks up work
 * that is not yet actionable. But "waiting on POA" is not the absence of work. It
 * is work that belongs to a DIFFERENT TEAM: POAREQ, staffed by Riley Mills and
 * Jackie Rose.
 *
 * So the question for each blocked issue is not "what should this task say" but
 * "does the thing it is waiting on already exist somewhere":
 *
 *   - an OPEN POAREQ issue for the same case  -> already owned. Do not migrate the
 *     roadblock; it would duplicate work Riley or Jackie is already doing.
 *   - a CLOSED POAREQ issue                   -> the two teams DISAGREE. See below.
 *   - NO POAREQ issue at all                  -> nobody is working it. THIS is the
 *     one worth creating, as a FILE POA task for the POAREQ crew.
 *
 * ── WHAT "CLOSED" DOES AND DOES NOT MEAN ────────────────────────────────────
 *
 * It is tempting to read a closed POAREQ as "the POA was filed" and treat the
 * roadblock as stale. That is not supported and this code does not claim it.
 *
 * POAREQ has exactly ONE status in the Done category, named "Done", with exactly
 * ONE resolution, also "Done", across all 1,406 closed issues. There is no
 * distinction between filed, cancelled, duplicated, rejected, or client-left. The
 * only fact available is that somebody closed the ticket.
 *
 * Nor can Logics settle it. Case/CaseInfo carries no POA field — the nearest thing
 * is a pipeline status like "[TIER 1]-ACTIVE" — and there is no route that lists a
 * case's documents (Documents/CaseDocument is POST-only and answers GET with 405;
 * the plausible alternatives 404). There is no reachable system of record for
 * whether a power of attorney exists.
 *
 * So this bucket is a DISAGREEMENT, not a verdict: the POA side considers its work
 * finished while the tax-prep side is still blocked waiting on it. That is worth
 * surfacing — it is exactly the handoff gap that leaves a case stuck for months —
 * but it must go to a human to resolve. Migrating these as "FILE POA" would send
 * someone to file a document that may already exist; auto-closing them would
 * discard a real blocker on the strength of a status that means nothing.
 *
 * LINKING IS FREE. Case ids match across projects directly, so no Logics call is
 * needed to relate two Jira issues — tenant only matters later, when writing.
 *
 * This reads every issue including CLOSED ones, deliberately: a finished POAREQ is
 * the evidence that a roadblock is stale, and looking only at open issues would
 * make "already done" indistinguishable from "never existed".
 *
 * WRITES NOTHING.
 *
 *   node scripts/analysis/jira-roadblock-routing.js
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const fs = require("fs");
const path = require("path");

const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};
const OUT = path.join(__dirname, "jira-roadblock-routing.json");
const CASE_RE = /\b(\d{5,7})\b/;

const adfText = (n) => (!n || typeof n !== "object") ? ""
  : n.type === "text" ? (n.text || "") : (n.content || []).map(adfText).join(" ");

/**
 * What is this blocked issue actually waiting on?
 *
 * Ordered: the first match wins, so the more specific patterns come first. These
 * were written against the real descriptions, not invented — "waiting on poa" and
 * its several spellings dominate the ROADBLOCK set.
 */
const WAITING_ON = [
  // POA leads deliberately: "2023-2025 WAITING FOR DOCS AND POA" is POA work even
  // though it also mentions docs and years.
  { key: "POA", re: /\bpoa\b|power of attorney/i, route: "POAREQ",
    action: "FILE POA", note: "Blocked on a power of attorney — POAREQ's work." },
  { key: "MISSING_YEARS", re: /missing (tax )?years?|all missing years|midding tax years/i, route: "POAREQ",
    action: "FILE POA", note: "Missing tax years — in this shop that means the POA is not in yet." },
  { key: "THS", re: /\bths\b|transcript/i, route: "POAREQ",
    action: "RUN THS", note: "Blocked on transcripts, which follow the POA." },
  // An explicit instruction to prepare or file a return. This is ASSIGNMENT's own
  // work, so it routes to itself — the issue IS the task, it was just titled badly.
  { key: "RETURN", re: /\brtns?\b|\breturns?\b|\bprep\b|\bamm?end\b|\bsfr\b|\bfile \d{4}/i, route: "ASSIGNMENT",
    action: "PREP RETURN", note: "An instruction to prepare or file a return." },
  { key: "CLIENT", re: /client|customer|taxpayer|wife|husband|spouse/i, route: null,
    action: null, note: "Waiting on the client — not a task for staff." },
  { key: "DOCS", re: /\bdocs?\b|document|w-?2|1099|paperwork/i, route: null,
    action: null, note: "Waiting on documents." },
  { key: "SIGNATURE", re: /signature|\bsign\b|8879/i, route: null,
    action: null, note: "Waiting on a signature." },
  { key: "PAYMENT", re: /paid|payment|invoice|balance/i, route: null,
    action: null, note: "Waiting on money." },
];

/**
 * A description that is NOTHING BUT tax years — "2025", "2020-2025",
 * "2015, 17, 18, 19", "24-25". Seventy of these were sitting in the UNCLEAR pile
 * looking like missing information when they are in fact the commonest and
 * clearest instruction in the system: prepare these years' returns.
 */
const YEARS_ONLY = /^[\s\d,&/–—-]*(\d{2,4})[\s\d,&/–—-]*$/;

/**
 * The years for the subject line — taken VERBATIM, never derived.
 *
 * An earlier version computed a min-max span from every year-shaped token in the
 * text. On a years-only description that was harmless, but on prose it invented
 * work: "2020-2025 (2023 is an SFR) balances assessed in June of 2026" became
 * "2020-2026", pulling a date out of a sentence and turning it into a tax year.
 * Worse, "he's up to date with filing" yielded "2003-2024" from the stray tokens
 * "03" and "24". And a span silently fills gaps — "2019 & 2021 PREP 2022-2024"
 * spans to 2019-2024, quietly adding 2020.
 *
 * Wrong years on a PREP RETURN task means somebody prepares a return that was not
 * asked for, or misses one that was. So there is no derivation left: when the
 * description is ONLY years, it is already a clean expression of exactly the years
 * a human wrote, and we repeat it unchanged. When it is prose, we say nothing
 * about years in the subject and let the description speak for itself in the body.
 */
function yearsVerbatim(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function classify(text) {
  const t = String(text || "").trim();
  if (!t) {
    return { key: "EMPTY", route: null, action: null, note: "No description at all — a human has to say what this is." };
  }
  for (const w of WAITING_ON) if (w.re.test(t)) return w;
  if (YEARS_ONLY.test(t) && /\d/.test(t)) {
    return {
      key: "YEARS_ONLY", route: "ASSIGNMENT", action: "PREP RETURN",
      note: "Description is only tax years, which in this shop means prepare those returns.",
    };
  }
  return { key: "UNCLEAR", route: null, action: null, note: "No recognisable instruction in the description." };
}

async function fetchAll(jql, fields) {
  const out = [];
  let token = null;
  do {
    const page = await (await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({ jql, maxResults: 100, fields, ...(token ? { nextPageToken: token } : {}) }),
    })).json();
    out.push(...(page.issues || []));
    token = page.nextPageToken || null;
  } while (token);
  return out;
}

async function main() {
  // EVERY issue, open and closed. A finished POAREQ is the evidence that a
  // roadblock is stale; excluding Done would hide that.
  const all = await fetchAll(
    "project in (ASSIGNMENT, POAREQ, RESO) ORDER BY created DESC",
    ["summary", "status", "statuscategorychangedate", "assignee", "description", "project", "resolutiondate", "updated"],
  );
  console.log(`  read ${all.length} issues (all statuses)`);

  // Index every issue by case id so a blocked one can look up its siblings.
  const byCase = new Map();
  for (const i of all) {
    const m = String(i.fields.summary || "").match(CASE_RE);
    if (!m) continue;
    const id = Number(m[1]);
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id).push(i);
  }
  console.log(`  ${byCase.size} distinct case ids across all projects`);

  const multi = [...byCase.values()].filter((v) => new Set(v.map((i) => i.fields.project.key)).size > 1);
  console.log(`  ${multi.length} cases appear in more than one project\n`);

  // The blocked population: open ASSIGNMENT issues in a state-y status.
  const BLOCKED = new Set(["ROADBLOCK", "roadblock", "To Do", "TO DO'S"]);
  const blocked = all.filter((i) => BLOCKED.has(i.fields.status?.name)
    && i.fields.status?.statusCategory?.key !== "done");

  const buckets = { isWork: [], covered: [], stale: [], create: [], notPoa: [], noCase: [] };
  const waitTally = {};

  for (const issue of blocked) {
    const f = issue.fields;
    const detail = adfText(f.description).trim().replace(/\s+/g, " ");
    const what = classify(detail);
    waitTally[what.key] = (waitTally[what.key] || 0) + 1;

    const m = String(f.summary || "").match(CASE_RE);
    if (!m) { buckets.noCase.push({ key: issue.key, summary: f.summary, detail }); continue; }
    const caseId = Number(m[1]);

    const row = {
      jiraKey: issue.key, project: f.project.key, status: f.status?.name,
      caseId, summary: f.summary, description: detail,
      waitingOn: what.key, note: what.note,
      assignee: f.assignee?.displayName || null,
    };

    if (!what.route) { buckets.notPoa.push(row); continue; }

    // If the blocked issue is ALREADY in the project that owns this kind of work,
    // there is nothing to look up — the issue IS the task, it was just titled with
    // a status instead of an instruction. A POAREQ issue reading "file poa" does
    // not need a POAREQ sibling created for it; it needs migrating as FILE POA.
    if (f.project.key === what.route) {
      row.verdict = "is-the-work";
      // Only a years-only description earns its years in the subject; prose does
      // not, because we cannot tell a tax year from a date mentioned in passing.
      row.proposedSubject = (what.action === "PREP RETURN" && what.key === "YEARS_ONLY")
        ? `PREP RETURN ${yearsVerbatim(detail)}`.trim()
        : what.action;
      buckets.isWork.push(row);
      continue;
    }

    const siblings = (byCase.get(caseId) || []).filter((s) => s.key !== issue.key
      && s.fields.project.key === what.route);
    const open = siblings.filter((s) => s.fields.status?.statusCategory?.key !== "done");
    const done = siblings.filter((s) => s.fields.status?.statusCategory?.key === "done");

    row.siblings = siblings.map((s) => ({
      key: s.key, status: s.fields.status?.name,
      done: s.fields.status?.statusCategory?.key === "done",
      assignee: s.fields.assignee?.displayName || null,
      resolved: s.fields.resolutiondate ? String(s.fields.resolutiondate).slice(0, 10) : null,
    }));

    if (open.length) {
      row.verdict = "already-owned";
      row.owner = open[0].fields.assignee?.displayName || "(unassigned)";
      buckets.covered.push(row);
    } else if (done.length) {
      row.verdict = "poa-already-filed";
      row.resolvedOn = done.map((d) => d.fields.resolutiondate).filter(Boolean).sort().pop();
      buckets.stale.push(row);
    } else {
      row.verdict = "needs-new-task";
      row.proposedSubject = what.action;
      row.routeTo = what.route;
      buckets.create.push(row);
    }
  }

  console.log(`  ${blocked.length} open BLOCKED issues (ROADBLOCK / To Do / TO DO'S)\n`);
  console.log(`  what they are waiting on:`);
  for (const [k, n] of Object.entries(waitTally).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }

  console.log(`\n  ROUTING for the POA/THS-blocked ones:`);
  console.log(`    ${String(buckets.covered.length).padStart(4)}  already owned — an OPEN ${"POAREQ"} issue exists. DO NOT migrate.`);
  console.log(`    ${String(buckets.stale.length).padStart(4)}  POA already filed (POAREQ is Done) — roadblock looks STALE, ask a human.`);
  console.log(`    ${String(buckets.create.length).padStart(4)}  nothing exists — CREATE a task for the POAREQ crew.`);
  console.log(`    ${String(buckets.notPoa.length).padStart(4)}  blocked on something else (client/docs/money) — not routable.`);
  console.log(`    ${String(buckets.noCase.length).padStart(4)}  no case id in the summary.`);

  console.log(`\n  SAMPLE — "already owned" (migrating these would duplicate live work):`);
  for (const r of buckets.covered.slice(0, 6)) {
    console.log(`    ${r.jiraKey.padEnd(16)}case ${String(r.caseId).padEnd(8)}-> ${r.siblings.filter((s) => !s.done).map((s) => `${s.key} ${s.status} [${s.assignee}]`).join(", ")}`);
  }
  console.log(`\n  SAMPLE — "POA already filed" (roadblock may be stale):`);
  for (const r of buckets.stale.slice(0, 6)) {
    console.log(`    ${r.jiraKey.padEnd(16)}case ${String(r.caseId).padEnd(8)}"${r.description.slice(0, 34)}" -> ${r.siblings.map((s) => `${s.key} done ${s.resolved}`).join(", ")}`);
  }
  console.log(`\n  SAMPLE — "needs a new task" (real, unowned work):`);
  for (const r of buckets.create.slice(0, 8)) {
    console.log(`    ${r.jiraKey.padEnd(16)}case ${String(r.caseId).padEnd(8)}${r.proposedSubject.padEnd(10)}"${r.description.slice(0, 40)}"`);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    writesNothing: true,
    totals: {
      blockedOpen: blocked.length,
      isTheWork: buckets.isWork.length,
      alreadyOwned: buckets.covered.length,
      poaAlreadyFiled: buckets.stale.length,
      needsNewTask: buckets.create.length,
      blockedOnSomethingElse: buckets.notPoa.length,
      noCaseId: buckets.noCase.length,
    },
    waitingOn: waitTally,
    buckets,
  }, null, 2));
  console.log(`\n  wrote ${OUT}\n`);
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
