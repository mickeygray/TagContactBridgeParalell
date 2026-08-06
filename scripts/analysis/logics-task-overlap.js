"use strict";

/**
 * logics-task-overlap — before creating a task, ask whether Logics already has one.
 *
 * Mickey 2026-08-05: "Run THS is a current task, that's the follow up from File POA,
 * so you can kinda safely default to run ths unless there's another task for run ths
 * for the same case. So you can sorta triangulate because THS tasks and POA tasks are
 * already in logics a lot."
 *
 * This is a better duplicate guard than the one built earlier, and for a structural
 * reason. That one scanned for the Jira key we ourselves had stamped into the task
 * body — so it could only ever catch tasks THIS MIGRATION created. It was blind to the
 * work the firm has been tracking in Logics all along, which is most of it.
 *
 * Checking the destination instead catches the real duplicate: a case that already has
 * an open "Run Ths" task assigned to Riley does not need a second one because a Jira
 * ticket also mentions it. Creating that second task is worse than doing nothing —
 * Logics has no delete route, so it lands permanently in somebody's queue and the only
 * way to tell the two apart is to open both.
 *
 * MATCHING IS BY ACTION, NOT BY STRING. Logics subjects are hand-typed — "Run Ths",
 * "RUN THS AND BUSNIESS", "run ths" — so an exact comparison would miss nearly all of
 * them. Each proposed action carries a pattern for what an existing task about the
 * same work looks like.
 *
 * Deleted tasks are ignored. A task somebody removed on purpose is not a reason to
 * withhold a new one — the same soft-delete trap that broke the first guard, where
 * Logics keeps returning removed rows with Deleted=true rather than dropping them.
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
const MONTHS_BACK = 18;

/** What an existing Logics task about the same work looks like. */
const SAME_WORK = [
  { action: /^Run THS/i, existing: /\bths\b|transcript/i },
  { action: /^File .*POA|^Review Client Info For POA/i, existing: /\bpoa\b|2848/i },
  { action: /^Follow Up On Signed Returns|^Send Return For Signature/i, existing: /sign|8879/i },
  { action: /^Follow Up On Tax Organizer/i, existing: /\bt\.?o\.?\b|organizer|\bdocs?\b/i },
  { action: /^Follow Up On Billing/i, existing: /pay|billing|invoice|collect/i },
  { action: /^Prac Call|^Business Prac Call/i, existing: /\bprac\b|practitioner|\bppl\b/i },
  // Return work needs a TIGHT pattern. The first version used
  // /return|prep|file|tr|a\/s/ and matched "file CDP" (a collection due process
  // appeal), "ASK MONI TO FILE EXTENSION" and "A/S PITCH" (a sales pitch) as
  // duplicates of filing a tax return. Those share a word, not a job.
  //
  // THS and POA match cleanly because their subjects are distinctive. "file" and
  // "a/s" appear all over this queue, so they only count when paired with something
  // that pins the work to an actual return.
  {
    action: /^Hold For A\/S|^File .*Return|^Prep .*Return|^Amend .*Return/i,
    existing: /tax prep|\bprep\b[^.]{0,12}(20\d\d|return)|(20\d\d|return)[^.]{0,12}\bprep\b|file[d]?[^.]{0,12}(return|tr'?s)|(return|tr'?s)[^.]{0,12}\bfile[d]?\b|e-?file|\bamend/i,
  },
];

const unwrap = (res) => {
  const d = res?.data ?? res;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.Data)) return d.Data;
  return null;
};

const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Every live task on every case for a tenant, indexed by case.
 *
 * Range-native, so this is a handful of calls rather than one per case — the same
 * route already used to harvest the user directory.
 */
async function harvestTasks(tenant, months, log) {
  const client = createLogicsClient(tenant);
  const byCase = new Map();
  let total = 0; let deleted = 0; let closed = 0; let windows = 0; let failures = 0;

  // Mickey 2026-08-05: "this only applies to stuff that's outstanding based on date."
  //
  // Two corrections live in this loop. The route filters on DUE DATE, and the first
  // version only walked BACKWARDS from today — so it never fetched anything due in
  // the future, which is exactly what an outstanding task looks like. It was matching
  // against history and missing the live queue entirely.
  //
  // And a completed task is not a duplicate. A "Run Ths" finished fourteen months ago
  // is a reason to create a new one, not to withhold it. StatusID 0 is open (184 of
  // 190 future-dated TAG tasks carry it), 1 is done.
  const FORWARD = 4;                       // 8 months ahead
  const BACK = Math.ceil(months / 2);
  for (let w = -FORWARD; w < BACK; w += 1) {
    const end = NOW - w * 60 * 86400000;
    const start = end - 60 * 86400000;
    windows += 1;
    let res;
    try { res = await client.getTasksByDateRange(dayStr(start), dayStr(end)); }
    catch (e) { failures += 1; log(`    ${tenant} window failed: ${String(e.message).slice(0, 50)}`); continue; }
    const rows = unwrap(res);
    if (!rows) { failures += 1; continue; }
    for (const r of rows) {
      total += 1;
      if (r.Deleted) { deleted += 1; continue; }
      // Only an OPEN task blocks creating a new one.
      if (Number(r.StatusID) !== 0) { closed += 1; continue; }
      const id = Number(r.CaseID);
      if (!Number.isFinite(id)) continue;
      if (!byCase.has(id)) byCase.set(id, []);
      byCase.get(id).push({
        taskId: r.TaskID,
        subject: String(r.Subject || ""),
        due: r.DueDate ? String(r.DueDate).slice(0, 10) : null,
        users: (r.Users || []).map((u) => u.FullName).filter(Boolean),
        statusId: r.StatusID,
      });
    }
  }
  log(`    ${tenant}: ${total} rows (${deleted} deleted, ${closed} already done) -> `
    + `${byCase.size} cases with an OPEN task`
    + (failures ? `   ${failures}/${windows} WINDOWS FAILED` : ""));
  return { byCase, usable: failures < windows };
}

async function main() {
  const log = (s) => console.log(s);
  await connectMongo(getSharedConfig());

  const set = JSON.parse(fs.readFileSync(path.join(__dirname, "final-migration-set.json"), "utf8")).items;
  log(`\n  ${set.length} proposed tasks to check against Logics\n`);
  log(`  Harvesting existing Logics tasks (${MONTHS_BACK} months, range-native):`);

  const tenants = [...new Set(set.map((s) => s.tenant))].filter(Boolean);
  const have = {};
  for (const t of tenants) have[t] = await harvestTasks(t, MONTHS_BACK, log);

  let dupe = 0; let clear = 0; let unknown = 0;
  const byAction = {};
  for (const s of set) {
    const h = have[s.tenant];
    if (!h || !h.usable) { s.overlap = "UNKNOWN — could not read Logics tasks"; unknown += 1; continue; }
    const existing = h.byCase.get(Number(s.caseId)) || [];
    const rule = SAME_WORK.find((r) => r.action.test(s.subject));
    const hit = rule ? existing.find((e) => rule.existing.test(e.subject)) : null;
    if (hit) {
      s.overlap = `already in Logics: TaskID ${hit.taskId} "${hit.subject.slice(0, 40)}"`
        + (hit.users.length ? ` [${hit.users.join(", ")}]` : "");
      dupe += 1;
      const k = s.subject.replace(/ For The Years.*/, "");
      (byAction[k] || (byAction[k] = [])).push(s);
    } else { s.overlap = null; clear += 1; }
  }

  log(`\n  ${"=".repeat(68)}`);
  log(`  ALREADY IN LOGICS  ${dupe}      no existing task  ${clear}      unknown  ${unknown}`);
  log(`  ${"=".repeat(68)}\n`);

  for (const [k, v] of Object.entries(byAction).sort((a, b) => b[1].length - a[1].length)) {
    log(`  ${String(v.length).padStart(4)}  ${k}`);
    for (const s of v.slice(0, 3)) log(`          ${s.jiraKey.padEnd(15)}case ${String(s.caseId).padEnd(8)}${s.overlap.slice(0, 78)}`);
  }

  fs.writeFileSync(path.join(__dirname, "logics-task-overlap.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), writesNothing: true,
      counts: { proposed: set.length, alreadyInLogics: dupe, clear, unknown },
      items: set }, null, 2));
  log(`\n  after removing what Logics already tracks: ${clear} tasks would be new\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
