"use strict";

/**
 * jira-to-logics-task — mirror one open Jira issue into Logics as a Task.
 *
 * This is the first real write of the Jira -> Logics migration, so it is built
 * around the two things that make that migration unforgiving:
 *
 * 1. LOGICS TASKS ARE CREATE-ONLY. There is no update route and no delete route
 *    in V4. A task written wrongly cannot be fixed through the API — someone has
 *    to go into the back office. So this script defaults to a DRY RUN and will not
 *    write unless --apply is passed.
 *
 * 2. A RE-RUN DUPLICATES, IT DOES NOT CORRECT. Because of (1), the only defence
 *    against double-posting is to look before writing. Every task this creates
 *    carries its Jira key in the Comments, and we scan existing tasks for that key
 *    before creating another. The guard is best-effort — see its own note — and it
 *    fails CLOSED: if the check cannot run, we do not write.
 *
 * Tenant comes from the case id + client name in the Jira summary, because case
 * ids collide across TAG/AMITY/WYNN (11330 is three different people). The
 * assignee's Logics UserID then has to come from that same tenant — ids are per
 * tenant and overlap, so TAG 20 and WYNN 20 are different humans.
 *
 *   node scripts/analysis/jira-to-logics-task.js --assignee "Monica Cazares"
 *   node scripts/analysis/jira-to-logics-task.js --assignee "Monica Cazares" --apply
 *   node scripts/analysis/jira-to-logics-task.js --issue ASSIGNMENT-2046 --apply
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsFacade } = require(path.join(__dirname, "../../packages/shared-services/src/logicsFacadeService"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));
const { resolveLogicsUser } = require(path.join(__dirname, "../../packages/shared-data/src/jiraLogicsUserMap"));

const BASE = "https://taxadvocategroup.atlassian.net";
const AUTH = {
  Authorization: `Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const ORDER = ["TAG", "AMITY", "WYNN"];
const CASE_RE = /\b(\d{5,7})\b/;
const TENANT_RE = /\b(TAG|WYNN|AMITY)\b/i;
const NOISE = /\b(TAG|WYNN|AMITY|TEST|PROBE|IRS|STATE|POA|RE|FOR|THE|AND|MO|SENT|HOLD|READY|FILE)\b/gi;

const unwrap = (r) => { const d = r?.data ?? r; return Array.isArray(d) ? d[0] : d; };

/** Jira's Sprint field is a customfield; its id is stable per site. */
const SPRINT_FIELD = "customfield_10020";

/**
 * Where a Logics DueDate legitimately comes from.
 *
 * Logics REQUIRES DueDate and Reminder. Jira sets an explicit due date on only
 * 124 of 809 open issues (15%), so for most issues something has to be chosen —
 * and a chosen date is a real hazard here, because it arrives in somebody's queue
 * looking exactly as authoritative as a real one, on a record that cannot be
 * edited afterwards.
 *
 * The honest source is the SPRINT. These projects run monthly sprints and 775 of
 * 809 open issues (96%) sit in one with a real endDate — a date a human actually
 * set, not one we made up. Preference order:
 *
 *   1. the issue's own duedate      — explicit intent, always wins
 *   2. its sprint's endDate         — real, human-set, covers 96%
 *   3. nothing genuine exists       — 22 issues (3%). We still must send a date,
 *                                     so it is marked synthetic and said out loud
 *                                     in the task comments, rather than passed off
 *                                     as a deadline somebody chose.
 *
 * Sprint choice is "latest endDate wins", not "the active one". POAREQ Sprint 1
 * is still flagged active but ended 2024-08-31 — an issue can sit in a stale
 * active sprint and a newer closed one, and the newer date is the truthful answer.
 */
function dueDateFor(f, now) {
  if (f.duedate) {
    return { due: Date.parse(`${f.duedate}T17:00:00Z`), dateSource: "Jira duedate", synthetic: false };
  }
  const sprints = (f[SPRINT_FIELD] || []).filter((s) => s && s.endDate);
  if (sprints.length) {
    const best = sprints.reduce((a, b) => (Date.parse(b.endDate) > Date.parse(a.endDate) ? b : a));
    return {
      due: Date.parse(best.endDate),
      dateSource: `sprint "${best.name}" (${best.state}) ends ${String(best.endDate).slice(0, 10)}`,
      synthetic: false,
    };
  }
  return { due: now + 7 * 86400000, dateSource: "NOTHING — invented, +7 days", synthetic: true };
}

/** Jira descriptions are Atlassian document format; flatten to the plain text. */
function adfText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text || "";
  return (node.content || []).map(adfText).join(" ");
}

function parseSummary(summary) {
  const s = String(summary || "");
  return {
    caseId: s.match(CASE_RE) ? Number(s.match(CASE_RE)[1]) : null,
    statedTenant: s.match(TENANT_RE) ? s.match(TENANT_RE)[1].toUpperCase() : null,
    words: s.replace(CASE_RE, " ").replace(NOISE, " ").replace(/[^A-Za-z\s'-]/g, " ")
      .split(/\s+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3),
  };
}

/** TAG -> AMITY -> WYNN, keeping the tenant whose client name matches the summary. */
async function resolveTenant(parsed, facades) {
  const order = parsed.statedTenant
    ? [parsed.statedTenant, ...ORDER.filter((t) => t !== parsed.statedTenant)]
    : ORDER;
  for (const tenant of order) {
    let body;
    try { body = unwrap(await facades(tenant).fetchCaseInfo(parsed.caseId)); } catch { continue; }
    if (!body || !body.CaseID) continue;
    const name = `${body.FirstName || ""} ${body.MiddleName || ""} ${body.LastName || ""}`.toLowerCase();
    if (parsed.words.some((w) => name.includes(w))) {
      return { tenant, client: name.replace(/\s+/g, " ").trim() };
    }
  }
  return { tenant: null, client: null };
}

const iso = (ms) => new Date(ms).toISOString();
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Has this Jira issue already been mirrored into this tenant?
 *
 * Best-effort by necessity: Logics has no get-tasks-by-case route, only a date
 * range, so we scan a recent window and look for the key. That cannot see a task
 * created outside the window — a real migration should keep its own ledger of
 * what it wrote rather than rely on this. It is here to stop the obvious mistake
 * (running this script twice) and it THROWS on failure so we never write blind.
 */
async function alreadyMirrored(client, issueKey, caseId, windowDays = 60) {
  const now = Date.parse("2026-08-05T00:00:00Z");
  const res = await client.getTasksByDateRange(
    dayStr(now - windowDays * 86400000), dayStr(now + windowDays * 86400000),
  );
  const rows = res?.Data ?? res?.data ?? res;
  if (!Array.isArray(rows)) throw new Error("duplicate check failed: task range returned no array");
  // Deleted tasks keep coming back from the range scan — the row carries a
  // `Deleted` flag rather than disappearing. Counting one as a duplicate would
  // permanently block re-mirroring an issue whose task someone removed on purpose,
  // which is exactly what happens when a bad task gets cleaned up by hand.
  const live = rows.filter((r) => !r.Deleted);
  const hit = live.find((r) => {
    const blob = `${r.Subject || ""} ${r.Comments || ""}`;
    return blob.includes(issueKey) && (r.CaseID == null || Number(r.CaseID) === Number(caseId));
  });
  return { scanned: rows.length, skippedDeleted: rows.length - live.length, hit: hit || null };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const apply = args.includes("--apply");
  const assignee = arg("--assignee") || "Monica Cazares";
  const wantIssue = arg("--issue");

  await connectMongo(getSharedConfig());
  const cache = new Map();
  const facades = (t) => {
    if (!cache.has(t)) cache.set(t, createLogicsFacade(t));
    return cache.get(t);
  };

  // ── 1. pick a real open issue ────────────────────────────────────────────
  const jql = wantIssue
    ? `key = ${wantIssue}`
    : `project = ASSIGNMENT AND assignee = "${assignee}" AND statusCategory != Done ORDER BY updated DESC`;
  const res = await fetch(`${BASE}/rest/api/3/search/jql`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      jql, maxResults: 5,
      fields: ["summary", "status", "assignee", "duedate", "priority", "created", "updated",
        "project", "description", SPRINT_FIELD],
    }),
  });
  const issues = JSON.parse(await res.text()).issues || [];
  if (!issues.length) throw new Error(`no issue found for: ${jql}`);

  // ── 2. take the first candidate that is fully resolvable AND not already
  //       mirrored. Skipping rather than failing is what a batch run needs: one
  //       issue with an unmappable assignee should not stop the queue behind it.
  let issue = null; let f = null; let parsed = null; let tenant = null;
  let clientName = null; let who = null; let logics = null;

  for (const candidate of issues) {
    const cf = candidate.fields;
    console.log(`\n  JIRA ${candidate.key}`);
    console.log(`    summary : ${cf.summary}`);
    console.log(`    status  : ${cf.status?.name}   assignee: ${cf.assignee?.displayName}`);
    console.log(`    due     : ${cf.duedate || "(none set)"}   updated: ${String(cf.updated).slice(0, 10)}`);

    const p = parseSummary(cf.summary);
    if (!p.caseId) { console.log(`    SKIP — no case id in the summary`); continue; }

    const r = await resolveTenant(p, facades);
    if (!r.tenant) { console.log(`    SKIP — no tenant matches case ${p.caseId} by name`); continue; }
    console.log(`    resolved: case ${p.caseId} -> ${r.tenant} ("${r.client}")`);

    const w = resolveLogicsUser(
      { accountId: cf.assignee?.accountId, displayName: cf.assignee?.displayName }, r.tenant,
    );
    if (!w) { console.log(`    SKIP — no Logics UserID for ${cf.assignee?.displayName} in ${r.tenant}`); continue; }
    console.log(`    assignee: ${cf.assignee?.displayName} -> ${r.tenant} UserID ${w.userId} (${w.verified})`);
    if (w.verified !== "confirmed") {
      console.log(`    NOTE: that id is "${w.verified}", not confirmed by harvest — check the result.`);
    }

    const lc = createLogicsClient(r.tenant);
    const dupe = await alreadyMirrored(lc, candidate.key, p.caseId);
    if (dupe.hit) {
      console.log(`    SKIP — already mirrored as TaskID ${dupe.hit.TaskID ?? "?"} `
        + `(scanned ${dupe.scanned} ${r.tenant} tasks)`);
      continue;
    }
    console.log(`    clean — no existing task carries ${candidate.key} `
      + `(scanned ${dupe.scanned} ${r.tenant} tasks)`);

    issue = candidate; f = cf; parsed = p; tenant = r.tenant;
    clientName = r.client; who = w; logics = lc;
    break;
  }

  if (!issue) throw new Error("no candidate issue was both resolvable and unmirrored");
  console.log(`\n  SELECTED ${issue.key} -> ${tenant} case ${parsed.caseId} (${clientName})`);

  // ── 4. build the payload ─────────────────────────────────────────────────
  const now = Date.parse("2026-08-05T17:00:00Z");
  const { due, dateSource, synthetic } = dueDateFor(f, now);
  console.log(`\n  DUE DATE  ${new Date(due).toISOString().slice(0, 10)}  from ${dateSource}`
    + (synthetic ? "   <-- SYNTHETIC, no real date exists on this issue" : ""));
  // THE SUBJECT IS THE JIRA STATUS, and nothing else.
  //
  // The Jira summary ("401656 - MICHAEL NIELSON") names the client, not the work,
  // and a Logics task already hangs off the case — so repeating the case id and
  // client name in the subject spends the whole line saying what the reader can
  // already see. The status is the part that says what to DO: HOLD FOR A/S,
  // SENT FOR SIGNATURES, READY TO FILE, RUN THS.
  //
  // That this is right is not a guess. Harvested Logics subjects are imperative
  // and short — "File CDP if client is current on payments", "RUN THS AND
  // BUSNIESS", "run Ths", "NEW CLIENT INTRO" — and POAREQ's Jira status is
  // literally "run ths". The two systems already share this vocabulary; we are
  // matching an existing convention, not imposing one.
  const workDetail = adfText(f.description).trim().replace(/\s+/g, " ");
  const payload = {
    CaseID: parsed.caseId,
    Subject: String(f.status?.name || "").slice(0, 200),
    Reminder: iso(due - 86400000),
    TaskType: 1,
    DueDate: iso(due),
    UserID: [who.userId],
    // Everything the subject deliberately drops lives here. The Jira description
    // carries the real detail — tax years ("23-25", "2020-2025") or a full
    // instruction ("Please prep 2025 return. Docs are in logics.") — so it leads.
    // The issue key must stay in this blob: it is the only dedupe handle we have,
    // and Logics has no update route to add one later.
    Comments: [
      workDetail || "(no detail on the Jira issue)",
      "",
      synthetic
        ? "DUE DATE IS A PLACEHOLDER — the Jira issue carries no due date and no sprint."
        : `Due date from ${dateSource}.`,
      `Migrated from Jira ${issue.key} — ${BASE}/browse/${issue.key}`,
      `Assignee ${f.assignee?.displayName}. Source project ${f.project?.key}.`,
    ].join("\n"),
    AllDayEvent: false,
  };

  console.log(`\n  PAYLOAD -> POST /publicapi/V4/Task/Task  (${tenant})`);
  console.log("  " + JSON.stringify(payload, null, 2).split("\n").join("\n  "));

  // The duplicate guard already ran in the picker above — an issue only reaches
  // here after being confirmed unmirrored, so re-checking would just cost a call.

  if (!apply) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply to create it.\n`);
    await disconnectMongo();
    return;
  }

  // ── 6. write ─────────────────────────────────────────────────────────────
  console.log(`\n  WRITING to ${tenant}...`);
  const created = await logics.createTask(payload);
  const body = created?.Data ?? created?.data ?? created;
  const taskId = body?.TaskID ?? body?.taskId ?? body?.ID ?? (Array.isArray(body) ? body[0]?.TaskID : undefined);
  console.log("  response: " + JSON.stringify(created).slice(0, 500));
  console.log(`\n  CREATED  ${tenant} TaskID ${taskId ?? "(none returned)"} `
    + `on case ${parsed.caseId} for ${f.assignee?.displayName} (UserID ${who.userId})`);
  console.log(`  Remember: Logics has no update or delete route. This cannot be edited via API.\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
