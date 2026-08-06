"use strict";

/**
 * final-migration-set — apply every rule we settled on and count what is left.
 *
 * Mickey's guidelines, 2026-08-05:
 *   1. Do not post stale work unless Logics has no evidence it already happened.
 *   2. Build subjects from the approved segmentation.
 *   3. Keep the subject on the task to do, but carry disclaimers — Follow Up, Hold For A/S.
 *   4. When in doubt check activities and eliminate what is already done.
 *   5. Post the entire Jira note in the task body.
 *   6. Anything expired with no proof of activity gets a week to do it.
 *
 * A task is only counted here if EVERY one of these holds. The bar is deliberately
 * high in one specific direction: Logics tasks cannot be updated or deleted through
 * the API, so a record written wrongly has to be cleaned up by hand in the back
 * office. Skipping a task that should have been written costs a follow-up
 * conversation. Writing one that should not have been costs somebody's afternoon,
 * or worse, sends them to redo finished work.
 *
 *   node scripts/analysis/final-migration-set.js
 */

const fs = require("fs");
const path = require("path");

const NOW = Date.parse("2026-08-05");
const CUT = NOW - 61 * 86400000;
const WEEK = 7 * 86400000;

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rubric-subjects-final.json"), "utf8"));
const dates = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "jira-dates.json"), "utf8")).map((d) => [d.k, d]));
const stale = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "stale-worksheet.json"), "utf8"))
  .items.map((i) => [i.jiraKey, i]));
const manifest = require(path.join(__dirname, "jira-migration-manifest.json"));
const man = new Map(manifest.items.map((i) => [i.jiraKey, i]));
let notes = [];
for (let i = 0; i < 14; i += 1) notes = notes.concat(JSON.parse(fs.readFileSync(path.join(__dirname, `notes-batch-${i}.json`), "utf8")));
const noteBy = new Map(notes.map((n) => [n.jiraKey, n]));

/**
 * Individual records the adversarial audit found materially wrong. Each would create
 * a task instructing work the note does not support, so they are named rather than
 * filtered by a rule — a rule general enough to catch them would catch good records too.
 */
const AUDIT_HOLD = {
  "ASSIGNMENT-1639": "merges two different year sets — would order 5 business returns the note never asked for",
  "ASSIGNMENT-1969": "'revise' became Amend on a return that was never filed",
  "ASSIGNMENT-1978": "note hedges scope ('not all years appear to have a filing requirement'); subject asserts all 7",
  "ASSIGNMENT-2048": "integration probe — not real work",
};

const keep = []; const drop = {};
const skip = (r, why) => { (drop[why] || (drop[why] = [])).push(r.jiraKey); };

for (const r of rows) {
  const m = man.get(r.jiraKey) || {};
  const n = noteBy.get(r.jiraKey) || {};
  const d = dates.get(r.jiraKey);
  const isStale = d && d.u < CUT;
  const st = stale.get(r.jiraKey);

  if (AUDIT_HOLD[r.jiraKey]) { skip(r, `audit hold: ${AUDIT_HOLD[r.jiraKey]}`); continue; }
  // Rule 2: no approved subject, nothing to write.
  if (r.outsideRubric || !r.subject) { skip(r, "no subject from the approved segmentation"); continue; }
  // Logics REQUIRES a UserID. An unassigned Jira issue has nobody to give it to.
  if (!m.assignee) { skip(r, "no assignee in Jira — Logics requires a UserID"); continue; }
  if (!m.tenant || !m.caseId) { skip(r, "case or tenant unresolved"); continue; }
  if (m.logicsUserId == null) { skip(r, "assignee has no mapped Logics UserID"); continue; }

  // Rule 1 + 4: stale work is dropped only where Logics shows the work actually happened.
  if (isStale) {
    if (st && st.verdict && st.verdict.startsWith("DONE")) {
      skip(r, "stale AND Logics shows the work was done"); continue;
    }
    if (st && st.verdict && st.verdict.startsWith("UNKNOWN")) {
      skip(r, "stale and Logics could not be read — unknown, not safe either way"); continue;
    }
  }

  // Rule 6: expired with no proof gets a week. Live work keeps its real date.
  const due = isStale ? new Date(NOW + WEEK).toISOString()
    : (m.proposed && m.proposed.DueDate) || new Date(NOW + WEEK).toISOString();

  keep.push({
    jiraKey: r.jiraKey, tenant: m.tenant, caseId: m.caseId,
    assignee: m.assignee, userId: m.logicsUserId, userIdVerified: m.userIdVerified,
    subject: r.subject,                       // rule 2 + 3
    body: String(n.note || "").trim(),        // rule 5 — their words, entire, nothing added
    dueDate: due,
    stale: !!isStale,
    dueFrom: isStale ? "expired — one week to action" : (m.dateSource || "unknown"),
    staleVerdict: st ? st.verdict : null,
  });
}

const pct = (a) => `${((a / rows.length) * 100).toFixed(0)}%`;
console.log(`\n  ${rows.length} open Jira issues considered\n`);
console.log(`  WOULD POST: ${keep.length}  (${pct(keep.length)})`);
console.log(`    live work        ${keep.filter((k) => !k.stale).length}`);
console.log(`    expired, 1 week  ${keep.filter((k) => k.stale).length}`);

console.log(`\n  HELD BACK: ${rows.length - keep.length}`);
for (const [why, list] of Object.entries(drop).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`    ${String(list.length).padStart(4)}  ${why}`);
}

const bySub = {};
for (const k of keep) bySub[k.subject.replace(/ For The Years.*/, "")] = (bySub[k.subject.replace(/ For The Years.*/, "")] || 0) + 1;
console.log(`\n  WHAT WOULD BE POSTED:`);
for (const [k, v] of Object.entries(bySub).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);

const byT = {}; const byA = {};
for (const k of keep) { byT[k.tenant] = (byT[k.tenant] || 0) + 1; byA[k.assignee] = (byA[k.assignee] || 0) + 1; }
console.log(`\n  by tenant: ${Object.entries(byT).map(([a, b]) => `${a}=${b}`).join("  ")}`);
console.log(`  by person: ${Object.entries(byA).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a}=${b}`).join("  ")}`);

const unproven = keep.filter((k) => k.userIdVerified && k.userIdVerified !== "confirmed");
if (unproven.length) console.log(`\n  ${unproven.length} would go to a Logics UserID we could not confirm by harvest`);

fs.writeFileSync(path.join(__dirname, "final-migration-set.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), writesNothing: true,
    counts: { considered: rows.length, wouldPost: keep.length,
      live: keep.filter((k) => !k.stale).length, expired: keep.filter((k) => k.stale).length },
    heldBack: Object.fromEntries(Object.entries(drop).map(([k, v]) => [k, v.length])),
    items: keep }, null, 2));
console.log(`\n  wrote final-migration-set.json\n`);
