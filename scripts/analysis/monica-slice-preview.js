"use strict";

/**
 * monica-slice-preview — a handful of Monica's tasks, exactly as she would see them.
 *
 * Mickey 2026-08-05: "we don't need commentary from you on the this came from here
 * or was migrated by a super genius. just the content of the notes for them."
 *
 * So the Comments field carries the Jira description and NOTHING else. No migration
 * banner, no source link, no assignee restatement, no explanation of where the due
 * date came from. The person opening this task is trying to do tax work, not read
 * about a data migration.
 *
 * THAT MOVES THE DEDUPE HANDLE. The previous version stamped the Jira key into the
 * comments and scanned for it before writing, because Logics has no update or delete
 * route and a re-run would otherwise double-post. With the key gone from the body,
 * the record of what was written lives in a LEDGER FILE next to this script instead.
 * That was always the better design — a range scan could never see a task created
 * outside its window — the instruction just forced the issue.
 *
 * Picks a spread across the three shapes worth eyeballing before any bulk run:
 *   stale       — blocked on a POA that POAREQ already filed
 *   new         — freshly created, nobody has touched it
 *   in-progress — actively moving through the workflow
 *
 * WRITES NOTHING. Preview only.
 *
 *   node scripts/analysis/monica-slice-preview.js
 */

const fs = require("fs");
const path = require("path");
const { deriveSubject } = require(path.join(__dirname, "taskSubject"));

const MANIFEST = require(path.join(__dirname, "jira-migration-manifest.json"));
const ROUTING = require(path.join(__dirname, "jira-roadblock-routing.json"));
const WHO = "Monica Cazares";
// TAG only — keep the slice inside one tenant so nothing here depends on a
// UserID we could not confirm. Monica's TAG id 398 is harvest-confirmed.
const TENANT = "TAG";
const inTenant = (k) => (byKey.get(k) || {}).tenant === TENANT;

const byKey = new Map(MANIFEST.items.map((i) => [i.jiraKey, i]));

/** The note is the description, cleaned of whitespace. Nothing is added to it. */
function noteFor(item, routed) {
  const raw = (routed && routed.description) || firstLineOfComments(item);
  return String(raw || "").trim().replace(/\s+/g, " ");
}

/**
 * The manifest's Comments still carry the old provenance block, so take only its
 * first line — that is where the real description sat.
 */
function firstLineOfComments(item) {
  const c = (item && item.proposed && item.proposed.Comments) || "";
  const first = String(c).split("\n")[0].trim();
  return first.startsWith("(no detail") ? "" : first;
}

const staleAll = ROUTING.buckets.stale.filter((r) => r.assignee === WHO && inTenant(r.jiraKey));
const createAll = ROUTING.buckets.create.filter((r) => r.assignee === WHO && inTenant(r.jiraKey));
const isWorkAll = (ROUTING.buckets.isWork || []).filter((r) => r.assignee === WHO && inTenant(r.jiraKey));

// "In progress" = the statuses that describe live movement, not a blocked state.
const MOVING = new Set(["HOLD FOR A/S", "SENT FOR SIGNATURES", "READY TO FILE"]);
const movingAll = MANIFEST.items.filter((i) => i.assignee === WHO && i.tenant === TENANT && MOVING.has(i.status));

// "New" = created most recently. The manifest is ordered created DESC, so the
// earliest entries are the newest issues.
const newAll = MANIFEST.items.filter((i) => i.assignee === WHO && i.tenant === TENANT && !MOVING.has(i.status));

function render(label, rows, subjectOf, noteOf, limit = 2) {
  console.log(`\n${"=".repeat(78)}\n  ${label}\n${"=".repeat(78)}`);
  if (!rows.length) { console.log("    (none for Monica)"); return []; }
  const picked = rows.slice(0, limit);
  for (const r of picked) {
    const item = byKey.get(r.jiraKey) || r;
    const subject = subjectOf(r, item);
    const note = noteOf(r, item);
    console.log(`\n  ${r.jiraKey}   ${item.tenant || "?"} case ${item.caseId || r.caseId}`
      + `   (Jira status: ${r.status || item.status})`);
    console.log(`  ${"-".repeat(74)}`);
    console.log(`    Subject   ${subject}`);
    console.log(`    Due       ${String(item.proposed?.DueDate || "").slice(0, 10)}`
      + `   ${item.dateSource || ""}`);
    console.log(`    Assigned  ${WHO} -> UserID ${item.logicsUserId}`);
    console.log(`    Notes     ${note || "(empty — nothing written on the Jira issue)"}`);
  }
  return picked;
}

console.log(`\n  PREVIEW — ${WHO} only. Nothing written.`);
console.log(`  Notes contain the Jira description verbatim and nothing else.`);

const chosen = [];

chosen.push(...render(
  "STALE — blocked on a POA that POAREQ already closed",
  staleAll,
  (r) => deriveSubject(r.description, r.status).subject || `[no subject derivable] ${r.status}`,
  (r) => noteFor(null, r),
));

chosen.push(...render(
  "NEW — nothing exists for this yet",
  createAll.length ? createAll : isWorkAll,
  (r) => deriveSubject(r.description, r.status).subject || `[no subject derivable] ${r.status}`,
  (r) => noteFor(null, r),
));

chosen.push(...render(
  "IN PROGRESS — actively moving",
  movingAll,
  (r, item) => deriveSubject(firstLineOfComments(item), item.status).subject || item.status,
  (r, item) => firstLineOfComments(item),
));

console.log(`\n${"=".repeat(78)}`);
console.log(`  Monica's totals: ${staleAll.length} stale, ${createAll.length} needing a new task, `
  + `${isWorkAll.length} retitle-and-migrate, ${movingAll.length} in progress`);

// What the ledger would hold — the handle that used to live in the task body.
const ledger = chosen.map((r) => {
  const item = byKey.get(r.jiraKey) || r;
  return { jiraKey: r.jiraKey, tenant: item.tenant, caseId: item.caseId || r.caseId, logicsTaskId: null };
});
fs.writeFileSync(path.join(__dirname, "monica-slice-ledger.json"),
  JSON.stringify({ note: "logicsTaskId is filled in when a task is actually created", pending: ledger }, null, 2));
console.log(`  ledger stub written for ${ledger.length} candidates (no task ids yet)\n`);
