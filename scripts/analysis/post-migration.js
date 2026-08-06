"use strict";

/**
 * post-migration — create the Logics tasks. THIS WRITES TO PRODUCTION.
 *
 * Mickey 2026-08-05: "lets not do the ths or assorted. but other than that lets do it."
 *
 * ── WHY THIS IS BUILT THE WAY IT IS ─────────────────────────────────────────
 *
 * Logics tasks are CREATE-ONLY. No update route, no delete route. Every task this
 * writes is permanent and can only be cleaned up by hand in the back office. At this
 * volume a mistake is not one awkward record, it is an afternoon of somebody undoing
 * things one at a time.
 *
 * So three properties matter more than speed:
 *
 * 1. THE LEDGER IS WRITTEN AFTER EVERY SINGLE CREATE, not at the end. If this dies
 *    halfway — network, rate limit, a thrown error — the record of what already
 *    exists survives, and a re-run skips it. Batching the ledger would mean a crash
 *    loses the only evidence of what was written, and the only safe response would be
 *    to check 400 cases by hand.
 *
 * 2. RE-RUNNING IS SAFE. Anything already in the ledger is skipped. That is the
 *    difference between a script you can retry and one you get exactly one attempt at.
 *
 * 3. IT STOPS ON REPEATED FAILURE. Five consecutive errors aborts the run. A dead
 *    credential or a changed contract should cost five bad calls, not four hundred.
 *
 * Concurrency is deliberately low. Logics is shared production and this is not a race.
 *
 *   node scripts/analysis/post-migration.js            # dry run, writes nothing
 *   node scripts/analysis/post-migration.js --apply    # creates the tasks
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

const LEDGER = path.join(__dirname, "migration-ledger.json");
const NOW = Date.parse("2026-08-05T17:00:00Z");

/**
 * The five subjects Mickey approved for this run, as an ALLOW-list.
 *
 * An earlier version listed what to EXCLUDE, and a subject slipped through it —
 * "Prep Personal Return For The Years 2018-2025" survived a pattern that matches
 * it in isolation. Rather than debug that in a script whose next action is 414
 * irreversible writes, the logic is inverted: nothing is created unless its action
 * is one of these five. A deny-list fails OPEN, which is the wrong direction here.
 * An allow-list fails closed, and the cost of wrongly excluding a task is only
 * that somebody asks for it again.
 *
 * "Run THS" and the one-off actions are deliberately absent, per instruction.
 */
const ALLOWED = [
  "Follow Up On Signed Returns",
  "Hold For A/S: File Return",
  "Prep Return",
  "File Return",
  "Follow Up On Tax Organizer",
];
const allowed = (subject) => {
  const s = String(subject || "");
  return ALLOWED.some((a) => s === a || s.startsWith(`${a} For The Years`));
};

const iso = (ms) => new Date(ms).toISOString();

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return {};
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return {}; }
}
function saveLedger(l) { fs.writeFileSync(LEDGER, JSON.stringify(l, null, 1)); }

async function main() {
  const apply = process.argv.includes("--apply");
  await connectMongo(getSharedConfig());

  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "MIGRATION-READY.json"), "utf8")).items;
  const items = all.filter((i) => allowed(i.subject));
  const ledger = loadLedger();
  const todo = items.filter((i) => !ledger[i.jiraKey]);

  const bySub = {};
  for (const i of items) bySub[i.subject.replace(/ For The Years.*/, "")] = (bySub[i.subject.replace(/ For The Years.*/, "")] || 0) + 1;
  console.log(`\n  ${all.length} ready  ->  ${items.length} after excluding THS and the one-offs`);
  console.log(`  already in the ledger: ${Object.keys(ledger).length}   to create now: ${todo.length}\n`);
  for (const [k, v] of Object.entries(bySub).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);

  const byT = {};
  for (const i of todo) byT[i.tenant] = (byT[i.tenant] || 0) + 1;
  console.log(`\n  by tenant: ${Object.entries(byT).map(([a, b]) => `${a}=${b}`).join("  ")}`);

  if (!apply) {
    console.log(`\n  DRY RUN — nothing written. Sample payload:\n`);
    const s = todo[0];
    console.log("  " + JSON.stringify({
      CaseID: s.caseId, Subject: s.subject, TaskType: 1,
      DueDate: s.dueDate, UserID: s.users.map((u) => u.id),
      Comments: s.body, AllDayEvent: false,
    }, null, 2).split("\n").join("\n  "));
    console.log(`\n  re-run with --apply to create ${todo.length} tasks.\n`);
    await disconnectMongo();
    return;
  }

  const clients = {};
  for (const t of [...new Set(todo.map((i) => i.tenant))]) clients[t] = createLogicsClient(t);

  let ok = 0; let fail = 0; let consecutive = 0;
  const failures = [];

  for (const item of todo) {
    const due = item.dueDate ? Date.parse(item.dueDate) : NOW + 7 * 86400000;
    const payload = {
      CaseID: Number(item.caseId),
      Subject: item.subject.slice(0, 200),
      Reminder: iso(due - 86400000),
      TaskType: 1,
      DueDate: iso(due),
      UserID: item.users.map((u) => Number(u.id)).filter(Number.isFinite),
      // The worker's own words, entire and unedited.
      Comments: item.body || "(no note on the Jira issue)",
      AllDayEvent: false,
    };
    try {
      const res = await clients[item.tenant].createTask(payload);
      const body = res?.Data ?? res?.data ?? res;
      const taskId = body?.TaskID ?? body?.taskId ?? null;
      // Written immediately — a crash after this point must not lose the record.
      ledger[item.jiraKey] = { taskId, tenant: item.tenant, caseId: item.caseId,
        subject: item.subject, at: new Date().toISOString() };
      saveLedger(ledger);
      ok += 1; consecutive = 0;
      if (ok % 25 === 0) console.log(`    ${ok}/${todo.length} created...`);
    } catch (error) {
      fail += 1; consecutive += 1;
      failures.push({ jiraKey: item.jiraKey, error: String(error.message).slice(0, 100) });
      console.log(`    FAILED ${item.jiraKey}: ${String(error.message).slice(0, 80)}`);
      if (consecutive >= 5) {
        console.log(`\n  ABORTING — 5 consecutive failures. ${ok} created so far, all in the ledger.`);
        break;
      }
    }
  }

  console.log(`\n  created ${ok}   failed ${fail}`);
  if (failures.length) {
    console.log(`  failures:`);
    for (const f of failures.slice(0, 10)) console.log(`    ${f.jiraKey}  ${f.error}`);
  }
  console.log(`  ledger: ${LEDGER} (${Object.keys(ledger).length} entries)`);
  console.log(`  Re-running is safe — anything in the ledger is skipped.\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
