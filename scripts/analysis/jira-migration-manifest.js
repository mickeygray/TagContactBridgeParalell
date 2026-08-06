"use strict";

/**
 * jira-migration-manifest — plan the whole Jira -> Logics migration on paper.
 *
 * WRITES NOTHING. Not to Logics, not to Jira. It produces a JSON file describing
 * every task that WOULD be created, so the wording and the exceptions can be
 * argued about before anything lands in a system with no update or delete route.
 *
 * ── THE REVIEW IS SMALL, ON PURPOSE ─────────────────────────────────────────
 *
 * A Logics task's Subject is the Jira STATUS, and there are only about ten
 * distinct statuses across the three projects. So reviewing the language means
 * reviewing ten strings, not 809 rows. Those ten live in `subjectVocabulary` at
 * the top of the output, each with a count, a proposed subject and a confidence.
 * Fix a word there and every issue carrying that status inherits it.
 *
 * `items` underneath is the per-issue detail so any single row can be audited,
 * and `review` collects the individual exceptions that need a human.
 *
 * ── WHAT IS UNCERTAIN, STATED UP FRONT ──────────────────────────────────────
 *
 * Some statuses are a STATE, not an action. "ROADBLOCK" and "To Do" describe
 * where a case is stuck, not what to do about it — and a Logics task titled
 * ROADBLOCK, with a due date, tells whoever opens it nothing they can act on.
 * Those are flagged `needsWording` rather than quietly migrated, because guessing
 * a better phrase is exactly the call that should not be made unilaterally.
 *
 *   node scripts/analysis/jira-migration-manifest.js
 *   node scripts/analysis/jira-migration-manifest.js --limit 50
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const fs = require("fs");
const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsFacade } = require(path.join(__dirname, "../../packages/shared-services/src/logicsFacadeService"));
const { resolveLogicsUser } = require(path.join(__dirname, "../../packages/shared-data/src/jiraLogicsUserMap"));

const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};
const OUT = path.join(__dirname, "jira-migration-manifest.json");
const SPRINT_FIELD = "customfield_10020";
const ORDER = ["TAG", "AMITY", "WYNN"];
const CASE_RE = /\b(\d{5,7})\b/;
const TENANT_RE = /\b(TAG|WYNN|AMITY)\b/i;
const NOISE = /\b(TAG|WYNN|AMITY|TEST|PROBE|IRS|STATE|POA|RE|FOR|THE|AND|MO|SENT|HOLD|READY|FILE)\b/gi;

/**
 * My read on each Jira status as a Logics task Subject.
 *
 * `confidence: "high"` means the phrase is already an instruction and, in several
 * cases, already in use on the Logics side — harvested Logics subjects include
 * "run Ths" and "RUN THS AND BUSNIESS", which is the same vocabulary these
 * projects use. Those need no decision.
 *
 * `confidence: "needs-wording"` means the status names a STATE and would make a
 * poor instruction. A suggestion is offered but is explicitly a proposal.
 */
const SUBJECT_RULES = {
  "HOLD FOR A/S": { subject: "HOLD FOR A/S", confidence: "high", note: "Already an instruction. Matches Logics phrasing." },
  "SENT FOR SIGNATURES": { subject: "SENT FOR SIGNATURES", confidence: "high", note: "Clear and actionable as-is." },
  "READY TO FILE": { subject: "READY TO FILE", confidence: "high", note: "Clear and actionable as-is." },
  "run ths": { subject: "RUN THS", confidence: "high", note: "Logics already uses 'run Ths' / 'RUN THS AND BUSNIESS'. Uppercased for consistency only — say if you want it left lowercase." },
  "RED LINES/CHECK IF PAID MO $$$": { subject: "RED LINES — CHECK IF PAID", confidence: "medium", note: "Shortened; the '$$$' and 'MO' read as emphasis rather than meaning. Confirm nothing is lost." },
  "ID THEFT IDENTIFIED-PRAC CALL": { subject: "ID THEFT IDENTIFIED — PRAC CALL", confidence: "medium", note: "Only spacing changed. Confirm 'PRAC CALL' is the right term for the person doing it." },
  "ROADBLOCK": { subject: "ROADBLOCK", confidence: "needs-wording", note: "A STATE, not an action. A task saying ROADBLOCK with a due date is not actionable. Options: skip these entirely, or retitle e.g. 'CLEAR ROADBLOCK'. Most of these read 'missing tax years - waiting on poa'." },
  "roadblock": { subject: "ROADBLOCK", confidence: "needs-wording", note: "Same as ROADBLOCK — a separate lowercase Jira status. Should almost certainly be treated identically." },
  "To Do": { subject: "To Do", confidence: "needs-wording", note: "Says nothing. The description carries the real work ('Draft rtns for 2018, 2020-2025 pls'). Consider using the description as the subject for these, or skipping them." },
  "TO DO'S": { subject: "To Do", confidence: "needs-wording", note: "POAREQ's variant of To Do. Same problem." },
  "STATE": { subject: "STATE", confidence: "needs-wording", note: "RESO only, 2 issues. Too vague to act on." },
  "IRS": { subject: "IRS", confidence: "needs-wording", note: "RESO only, 1 issue. Too vague to act on." },
};

const adfText = (n) => (!n || typeof n !== "object") ? ""
  : n.type === "text" ? (n.text || "") : (n.content || []).map(adfText).join(" ");
const unwrap = (r) => { const d = r?.data ?? r; return Array.isArray(d) ? d[0] : d; };

function parseSummary(s) {
  s = String(s || "");
  return {
    caseId: s.match(CASE_RE) ? Number(s.match(CASE_RE)[1]) : null,
    statedTenant: s.match(TENANT_RE) ? s.match(TENANT_RE)[1].toUpperCase() : null,
    words: s.replace(CASE_RE, " ").replace(NOISE, " ").replace(/[^A-Za-z\s'-]/g, " ")
      .split(/\s+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3),
  };
}

async function resolveTenant(parsed, facades) {
  const order = parsed.statedTenant
    ? [parsed.statedTenant, ...ORDER.filter((t) => t !== parsed.statedTenant)] : ORDER;
  for (const tenant of order) {
    let body;
    try { body = unwrap(await facades(tenant).fetchCaseInfo(parsed.caseId)); } catch { continue; }
    if (!body || !body.CaseID) continue;
    const name = `${body.FirstName || ""} ${body.MiddleName || ""} ${body.LastName || ""}`.toLowerCase();
    if (parsed.words.some((w) => name.includes(w))) return { tenant, client: name.replace(/\s+/g, " ").trim() };
  }
  return { tenant: null, client: null };
}

function dueDateFor(f, now) {
  if (f.duedate) return { due: `${f.duedate}T17:00:00.000Z`, dateSource: "Jira duedate", synthetic: false };
  const sprints = (f[SPRINT_FIELD] || []).filter((s) => s && s.endDate);
  if (sprints.length) {
    const best = sprints.reduce((a, b) => (Date.parse(b.endDate) > Date.parse(a.endDate) ? b : a));
    return { due: best.endDate, dateSource: `sprint "${best.name}" (${best.state})`, synthetic: false };
  }
  return { due: new Date(now + 7 * 86400000).toISOString(), dateSource: "none — invented +7d", synthetic: true };
}

/** Bounded concurrency; Logics is a shared production API, not a load target. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i; i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf("--limit");
  const cap = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;

  await connectMongo(getSharedConfig());
  const cache = new Map();
  const facades = (t) => { if (!cache.has(t)) cache.set(t, createLogicsFacade(t)); return cache.get(t); };

  // Every OPEN issue. Done issues are history, not work to migrate.
  const issues = [];
  let token = null;
  do {
    const page = await (await fetch(`${BASE}/rest/api/3/search/jql`, {
      method: "POST", headers: AUTH,
      body: JSON.stringify({
        jql: "project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done ORDER BY created DESC",
        maxResults: 100,
        fields: ["summary", "status", "assignee", "duedate", "description", "project", "updated", SPRINT_FIELD],
        ...(token ? { nextPageToken: token } : {}),
      }),
    })).json();
    issues.push(...(page.issues || []));
    token = page.nextPageToken || null;
  } while (token && issues.length < cap);

  const work = issues.slice(0, cap === Infinity ? issues.length : cap);
  console.log(`  planning ${work.length} open issues (resolving tenant for each)...`);

  const now = Date.parse("2026-08-05T17:00:00Z");
  let done = 0;
  const items = await mapLimit(work, 5, async (issue) => {
    const f = issue.fields;
    const parsed = parseSummary(f.summary);
    const blockers = [];
    let tenant = null; let client = null;

    if (!parsed.caseId) blockers.push("no-case-id-in-summary");
    else {
      const r = await resolveTenant(parsed, facades);
      tenant = r.tenant; client = r.client;
      if (!tenant) blockers.push("tenant-unresolved");
    }
    if (!f.assignee) blockers.push("no-assignee");

    const who = (tenant && f.assignee)
      ? resolveLogicsUser({ accountId: f.assignee.accountId, displayName: f.assignee.displayName }, tenant)
      : null;
    if (tenant && f.assignee && !who) blockers.push("assignee-not-mapped");
    if (who && who.verified !== "confirmed") blockers.push(`userid-${who.verified}`);

    const statusName = f.status?.name || "(none)";
    const rule = SUBJECT_RULES[statusName]
      || { subject: statusName, confidence: "needs-wording", note: "Status not seen during planning — no rule written for it." };
    if (rule.confidence === "needs-wording") blockers.push("subject-needs-wording");

    const { due, dateSource, synthetic } = dueDateFor(f, now);
    if (synthetic) blockers.push("synthetic-due-date");

    const detail = adfText(f.description).trim().replace(/\s+/g, " ");
    if (!detail) blockers.push("no-description");

    done += 1;
    if (done % 100 === 0) console.log(`    ${done}/${work.length}`);

    return {
      jiraKey: issue.key,
      project: f.project?.key,
      status: statusName,
      jiraSummary: f.summary,
      assignee: f.assignee?.displayName || null,
      tenant,
      caseId: parsed.caseId,
      logicsClient: client,
      logicsUserId: who?.userId ?? null,
      userIdVerified: who?.verified ?? null,
      proposed: {
        Subject: rule.subject,
        DueDate: due,
        Reminder: new Date(Date.parse(due) - 86400000).toISOString(),
        TaskType: 1,
        Comments: [
          detail || "(no detail on the Jira issue)",
          "",
          synthetic ? "DUE DATE IS A PLACEHOLDER — no due date and no sprint on the Jira issue."
            : `Due date from ${dateSource}.`,
          `Migrated from Jira ${issue.key} — ${BASE}/browse/${issue.key}`,
          `Assignee ${f.assignee?.displayName}. Source project ${f.project?.key}.`,
        ].join("\n"),
      },
      dateSource,
      subjectConfidence: rule.confidence,
      blockers,
      ready: blockers.length === 0,
    };
  });

  // ── roll up ──────────────────────────────────────────────────────────────
  const tally = (fn) => items.reduce((m, i) => { const k = fn(i); m[k] = (m[k] || 0) + 1; return m; }, {});
  const blockerCounts = {};
  for (const i of items) for (const b of i.blockers) blockerCounts[b] = (blockerCounts[b] || 0) + 1;

  const vocab = {};
  for (const i of items) {
    const v = vocab[i.status] || (vocab[i.status] = {
      jiraStatus: i.status, count: 0, projects: new Set(),
      proposedSubject: i.proposed.Subject,
      confidence: i.subjectConfidence,
      note: (SUBJECT_RULES[i.status] || {}).note || "",
      exampleDescriptions: [],
    });
    v.count += 1;
    v.projects.add(i.project);
    const d = i.proposed.Comments.split("\n")[0];
    if (v.exampleDescriptions.length < 4 && d && !d.startsWith("(no detail")) v.exampleDescriptions.push(d);
  }
  const subjectVocabulary = Object.values(vocab)
    .map((v) => ({ ...v, projects: [...v.projects] }))
    .sort((a, b) => b.count - a.count);

  const manifest = {
    generatedAt: new Date().toISOString(),
    writesNothing: true,
    scope: {
      jql: "project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done",
      openIssues: items.length,
      ready: items.filter((i) => i.ready).length,
      needsReview: items.filter((i) => !i.ready).length,
    },
    subjectVocabulary,
    counts: {
      byProject: tally((i) => i.project),
      byTenant: tally((i) => i.tenant || "UNRESOLVED"),
      byAssignee: tally((i) => i.assignee || "(unassigned)"),
      byBlocker: blockerCounts,
      byDateSource: tally((i) => i.dateSource.startsWith("sprint") ? "sprint endDate" : i.dateSource),
    },
    items,
  };

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));

  console.log(`\n  wrote ${OUT}`);
  console.log(`\n  ${items.length} open issues -> ${manifest.scope.ready} ready, ${manifest.scope.needsReview} need review\n`);
  console.log(`  SUBJECT VOCABULARY — the whole language review is these rows:\n`);
  console.log(`  ${"count".padStart(5)}  ${"Jira status".padEnd(32)}${"proposed subject".padEnd(34)}confidence`);
  for (const v of subjectVocabulary) {
    console.log(`  ${String(v.count).padStart(5)}  ${v.jiraStatus.slice(0, 30).padEnd(32)}`
      + `${v.proposedSubject.slice(0, 32).padEnd(34)}${v.confidence}`);
  }
  console.log(`\n  BLOCKERS:`);
  for (const [k, n] of Object.entries(blockerCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }
  console.log(`\n  BY TENANT: ${JSON.stringify(manifest.counts.byTenant)}`);
  console.log(`  BY DATE SOURCE: ${JSON.stringify(manifest.counts.byDateSource)}\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
