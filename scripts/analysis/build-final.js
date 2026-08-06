"use strict";

/**
 * build-final — the migration set, under every rule Mickey has settled.
 *
 * 2026-08-05, in his words:
 *   "tax prep stuff is monica and jacqueline"
 *   "older than 3 months we won't touch it"
 *   "check activities and tasks for something that could satisfy the task"
 *   "keep in mind we will run ths for a client more than once as that data changes,
 *    so let's say within the last month there"
 *   "resolve subject using the preapproved titles"
 *   "keep entire jira notes"
 *   "mostly let's do the tax prep only stuff primarily"
 *
 * ── WHY THE THS WINDOW IS DIFFERENT FROM THE REST ───────────────────────────
 *
 * Every other kind of evidence is permanent. A POA filed in January is still filed
 * in August — the authorisation does not lapse, so finding it at any point in the
 * case history satisfies a File POA ticket forever.
 *
 * Transcripts are not like that. They are a snapshot of what the IRS held on the day
 * they were pulled, and the firm re-runs them precisely because that changes. So a
 * THS run eight months ago does NOT satisfy a Run THS task today — it satisfies a
 * question nobody is asking any more. Only a recent pull counts, and one month is the
 * window Mickey set.
 *
 * Getting this backwards in either direction is expensive: too wide and real work is
 * silently skipped because of a stale pull; too narrow and Riley gets a duplicate.
 *
 * ── THE THREE-MONTH CUT IS A HARD STOP ──────────────────────────────────────
 *
 * Earlier versions carried expired work across with a one-week due date. That is now
 * gone. Anything untouched for three months is not migrated at all, on the reasoning
 * that a queue nobody has looked at in a quarter should be reviewed by a person
 * rather than silently reanimated into somebody's task list.
 *
 * WRITES NOTHING.
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const fs = require("fs");
const path = require("path");
const { connectMongo, disconnectMongo } = require(path.join(__dirname, "../../packages/event-core/src"));
const { getSharedConfig } = require(path.join(__dirname, "../../packages/shared-config/src"));
const { createLogicsClient } = require(path.join(__dirname, "../../packages/shared-integrations/src"));

const NOW = Date.parse("2026-08-05");
const THREE_MONTHS = NOW - 92 * 86400000;
const ONE_MONTH = NOW - 31 * 86400000;

/** Default owners where Jira names nobody. Both go on the task, per the firm's own convention. */
const DEFAULTS = {
  ASSIGNMENT: {
    TAG: [{ name: "Monica Cazares", id: 398 }, { name: "Jacqueline Santos", id: 437 }],
    WYNN: [{ name: "Monica Cazares", id: 32 }, { name: "Jacqueline Santos", id: 43 }],
    AMITY: [{ name: "Monica Cazares", id: 139 }, { name: "Jacqueline Santos", id: 165 }],
  },
  POAREQ: {
    TAG: [{ name: "Riley Mills", id: 407 }, { name: "Jackie Rose", id: 440 }],
    WYNN: [{ name: "Riley Mills", id: 20 }, { name: "Jackie Rose", id: 46 }],
    AMITY: [{ name: "Riley Mills", id: 149 }, { name: "Jackie Rose", id: 168 }],
  },
};

/** What in a case's history or task list could already satisfy each action. */
const SATISFIED_BY = [
  { action: /^Run THS/i,
    activity: /\bran ths\b|\bths\b (run|pulled|complete)|transcripts? (pulled|received|downloaded)/i,
    task: /\bths\b|transcript/i,
    // Transcripts go stale — only a recent pull counts.
    activityWindow: ONE_MONTH },
  { action: /^File .*POA|^Review Client Info For POA/i,
    activity: /\bfiled\b[^.]{0,20}\bpoa\b|\bpoa\b[^.]{0,20}\bfiled\b|2848 (filed|accepted)/i,
    task: /\bpoa\b|2848/i, activityWindow: 0 },
  { action: /^Follow Up On Signed Returns|^Send Return For Signature/i,
    activity: /signed (return|copy)|8879 (received|signed)|return (accepted|transmitted)|e-?filed/i,
    task: /sign|8879/i, activityWindow: 0 },
  { action: /^Follow Up On Tax Organizer/i,
    activity: /organizer (received|returned)|\bt\.?o\.? (received|back|returned)|document has been uploaded/i,
    task: /\bt\.?o\.?\b|organizer|\bdocs?\b/i, activityWindow: ONE_MONTH },
  { action: /^Follow Up On Billing/i,
    activity: /payment made|payment (received|posted)|paid in full/i,
    task: /pay|billing|invoice|collect/i, activityWindow: ONE_MONTH },
  { action: /^Prac Call|^Business Prac Call/i,
    activity: /prac call (made|complete)|called irs|spoke (with|to) irs/i,
    task: /\bprac\b|practitioner|\bppl\b/i, activityWindow: ONE_MONTH },
  { action: /^Hold For A\/S|^File .*Return|^Prep .*Return|^Amend .*Return/i,
    activity: /return (filed|accepted|transmitted)|e-?filed|1040 (filed|accepted)/i,
    task: /tax prep|\bprep\b[^.]{0,12}(20\d\d|return)|(20\d\d|return)[^.]{0,12}\bprep\b|file[d]?[^.]{0,12}(return|tr'?s)|e-?file|\bamend/i,
    activityWindow: 0 },
];

/** Never counts as done — someone being asked, or a failure. */
const NOT_DONE = /new task assigned|task updated|failed|rejected|unable|can'?t|mismatch|waiting|need/i;

const unwrap = (res) => {
  const d = res?.data ?? res;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.Data)) return d.Data;
  return null;
};
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i; i += 1; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function openTasks(tenant, log) {
  const client = createLogicsClient(tenant);
  const byCase = new Map();
  let failures = 0; let windows = 0;
  for (let w = -4; w < 9; w += 1) {
    const end = NOW - w * 60 * 86400000;
    windows += 1;
    let res;
    try { res = await client.getTasksByDateRange(dayStr(end - 60 * 86400000), dayStr(end)); }
    catch { failures += 1; continue; }
    const rows = unwrap(res);
    if (!rows) { failures += 1; continue; }
    for (const r of rows) {
      if (r.Deleted || Number(r.StatusID) !== 0) continue;
      const id = Number(r.CaseID);
      if (!Number.isFinite(id)) continue;
      if (!byCase.has(id)) byCase.set(id, []);
      byCase.get(id).push({ taskId: r.TaskID, subject: String(r.Subject || "") });
    }
  }
  log(`    ${tenant}: ${byCase.size} cases with an open task`
    + (failures ? `   ${failures}/${windows} windows failed` : ""));
  return { byCase, usable: failures < windows };
}

async function main() {
  const log = (s) => console.log(s);
  await connectMongo(getSharedConfig());

  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rubric-subjects-final.json"), "utf8"));
  const dates = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "jira-dates.json"), "utf8")).map((d) => [d.k, d]));
  const manifest = require(path.join(__dirname, "jira-migration-manifest.json"));
  const man = new Map(manifest.items.map((i) => [i.jiraKey, i]));
  const conflicts = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "conflict-keys.json"), "utf8")));
  let notes = [];
  for (let i = 0; i < 14; i += 1) notes = notes.concat(JSON.parse(fs.readFileSync(path.join(__dirname, `notes-batch-${i}.json`), "utf8")));
  const noteBy = new Map(notes.map((n) => [n.jiraKey, n]));

  const drop = {};
  const skip = (k, why) => { drop[why] = (drop[why] || 0) + 1; };
  const candidates = [];

  for (const r of rows) {
    const m = man.get(r.jiraKey) || {};
    const d = dates.get(r.jiraKey);
    const project = r.jiraKey.split("-")[0];

    if (!r.subject || r.outsideRubric) { skip(r, "no subject from the approved titles"); continue; }
    if (!d) { skip(r, "no Jira date"); continue; }
    // Hard stop, no one-week reprieve.
    if (d.u < THREE_MONTHS) { skip(r, "untouched for 3+ months — not migrated"); continue; }
    if (!m.tenant || !m.caseId) { skip(r, "case or tenant unresolved"); continue; }
    if (conflicts.has(r.jiraKey)) { skip(r, "note contradicts the status-derived subject"); continue; }
    if (r.jiraKey === "ASSIGNMENT-2048") { skip(r, "integration probe"); continue; }

    let users;
    if (m.assignee && m.logicsUserId != null) {
      users = [{ name: m.assignee, id: m.logicsUserId }];
      if (m.userIdVerified && m.userIdVerified !== "confirmed") { skip(r, "unconfirmed Logics UserID"); continue; }
    } else {
      const def = (DEFAULTS[project] || {})[m.tenant];
      if (!def) { skip(r, "unassigned and no default owner for this project"); continue; }
      users = def;
    }

    candidates.push({
      jiraKey: r.jiraKey, project, tenant: m.tenant, caseId: m.caseId,
      subject: r.subject,
      body: String((noteBy.get(r.jiraKey) || {}).note || "").trim(),
      users, assignedBy: m.assignee ? "jira" : "project default",
      dueDate: (m.proposed && m.proposed.DueDate) || null,
      daysQuiet: Math.round((NOW - d.u) / 86400000),
    });
  }

  log(`\n  ${candidates.length} candidates after the 3-month cut and subject rules\n`);
  log(`  Reading Logics tasks and activities to see what is already satisfied:`);
  const tenants = [...new Set(candidates.map((c) => c.tenant))];
  const tasks = {}; const clients = {};
  for (const t of tenants) { clients[t] = createLogicsClient(t); tasks[t] = await openTasks(t, log); }

  let satisfied = 0; let unknown = 0;
  await mapLimit(candidates, 5, async (c) => {
    const rule = SATISFIED_BY.find((s) => s.action.test(c.subject));
    const tk = tasks[c.tenant];
    if (tk && tk.usable && rule) {
      const hit = (tk.byCase.get(Number(c.caseId)) || []).find((e) => rule.task.test(e.subject));
      if (hit) { c.satisfied = `open Logics task ${hit.taskId} "${hit.subject.slice(0, 36)}"`; satisfied += 1; return; }
    }
    if (!rule) return;
    let list;
    try { list = unwrap(await clients[c.tenant].getActivities(c.caseId)); } catch { list = null; }
    if (list === null) { c.unknown = true; unknown += 1; return; }
    const hit = list.map((a) => ({
      when: Date.parse(a.Created || a.CreatedDate || a.ActivityDate || a.Date || "") || 0,
      subject: String(a.ActivitySubject || a.Subject || ""),
    })).find((a) => rule.activity.test(a.subject) && !NOT_DONE.test(a.subject)
      && a.when >= rule.activityWindow);
    if (hit) {
      c.satisfied = `activity ${hit.when ? dayStr(hit.when) : "?"} "${hit.subject.slice(0, 36)}"`;
      satisfied += 1;
    }
  });

  const post = candidates.filter((c) => !c.satisfied && !c.unknown);
  log(`\n  ${"=".repeat(62)}`);
  log(`  WOULD POST ${post.length}      already satisfied ${satisfied}      unknown ${unknown}`);
  log(`  ${"=".repeat(62)}\n`);

  const byProj = {};
  for (const p of post) byProj[p.project] = (byProj[p.project] || 0) + 1;
  log(`  by project: ${Object.entries(byProj).map(([a, b]) => `${a}=${b}`).join("  ")}`);

  for (const proj of Object.keys(byProj).sort()) {
    const of = post.filter((p) => p.project === proj);
    const s = {};
    for (const p of of) s[p.subject.replace(/ For The Years.*/, "")] = (s[p.subject.replace(/ For The Years.*/, "")] || 0) + 1;
    log(`\n  ${proj} (${of.length}):`);
    for (const [k, v] of Object.entries(s).sort((a, b) => b[1] - a[1])) log(`    ${String(v).padStart(4)}  ${k}`);
    const byDef = of.filter((p) => p.assignedBy === "project default").length;
    log(`    (${of.length - byDef} assigned in Jira, ${byDef} to the project default pair)`);
  }

  log(`\n  held back:`);
  for (const [k, v] of Object.entries(drop).sort((a, b) => b[1] - a[1])) log(`    ${String(v).padStart(4)}  ${k}`);

  fs.writeFileSync(path.join(__dirname, "MIGRATION-READY.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), writesNothing: true,
      rules: { staleCutDays: 92, thsSatisfactionWindowDays: 31 },
      counts: { wouldPost: post.length, satisfied, unknown, heldBack: drop },
      items: post }, null, 2));
  log(`\n  wrote MIGRATION-READY.json\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
