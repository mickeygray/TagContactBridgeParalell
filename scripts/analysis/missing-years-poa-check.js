"use strict";

/**
 * missing-years-poa-check — ask Logics directly whether the POA these tickets are
 * waiting on actually exists.
 *
 * Mickey 2026-08-05: "go check those cases that are missing tax years waiting on poa
 * and see how many have a poa filed activity."
 *
 * This settles a question that has been open all session. Roughly 40 tax-prep tickets
 * say some version of "missing tax years - waiting on poa" and nothing else. Their
 * notes are near-identical, so the text cannot distinguish a case where the POA is
 * genuinely outstanding from one where it landed months ago and nobody told tax prep.
 *
 * Two weaker signals were tried first and both fall short:
 *   - the POAREQ ticket's status: POAREQ has ONE Done status with ONE resolution
 *     across all 1,406 closed issues, so "closed" carries no outcome at all.
 *   - the case's Logics status: it is a pipeline tier ("[TIER 1]-ACTIVE"), and
 *     Case/CaseInfo has no POA field. There is no document-listing route either.
 *
 * The activity log is the one place Logics records the act itself — "Filed Poa",
 * "Filed State Poa(Business)". That is a fact about the work, not about somebody's
 * ticket hygiene, so it answers the question the other two could not.
 *
 * Also checks for transcript activity, because that is the NEXT step: if the POA is
 * filed and the transcripts were already pulled, the missing years are already known
 * and the ticket may be finished rather than merely unblocked.
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

const MISSING_YEARS = /missing (tax )?years?|midding tax years|all missing years/i;

/** "Filed Poa", "FILED POA ", "Filed State Poa(Business)" — the act, in past tense. */
const POA_FILED = /\bfiled\b[^.]{0,20}\bpoa\b|\bpoa\b[^.]{0,20}\bfiled\b|2848 (filed|accepted)|poa (accepted|approved|on file)/i;
/** Someone being ASKED to file is not the same as it being filed. */
const NOT_FILED = /new task assigned|task updated|failed|rejected|unable|can'?t|mismatch|need(s)? poa|waiting/i;
/** The next step after the POA — transcripts, which is how the years get read. */
const THS_RUN = /\bran ths\b|\bths\b (run|pulled|complete)|transcripts? (pulled|received|downloaded|complete)/i;

const unwrap = (res) => {
  const d = res?.data ?? res;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.Data)) return d.Data;
  return null;
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i; i += 1; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  await connectMongo(getSharedConfig());

  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rubric-subjects-final.json"), "utf8"));
  const manifest = require(path.join(__dirname, "jira-migration-manifest.json"));
  const man = new Map(manifest.items.map((i) => [i.jiraKey, i]));
  let notes = [];
  for (let i = 0; i < 14; i += 1) notes = notes.concat(JSON.parse(fs.readFileSync(path.join(__dirname, `notes-batch-${i}.json`), "utf8")));
  const noteBy = new Map(notes.map((n) => [n.jiraKey, n]));

  const targets = rows.filter((r) => MISSING_YEARS.test((noteBy.get(r.jiraKey) || {}).note || ""))
    .map((r) => {
      const m = man.get(r.jiraKey) || {};
      return {
        jiraKey: r.jiraKey, tenant: m.tenant, caseId: m.caseId,
        note: (noteBy.get(r.jiraKey) || {}).note, status: (noteBy.get(r.jiraKey) || {}).status,
        subject: r.subject,
      };
    });

  console.log(`\n  ${targets.length} tickets whose note says the tax years are missing\n`);

  const clients = {};
  for (const t of ["TAG", "WYNN", "AMITY"]) clients[t] = createLogicsClient(t);

  await mapLimit(targets, 5, async (t) => {
    if (!t.tenant || !t.caseId) { t.verdict = "case/tenant unresolved"; return; }
    let list;
    try { list = unwrap(await clients[t.tenant].getActivities(t.caseId)); } catch { list = null; }
    // A failed read is UNKNOWN. Reporting it as "no POA" would be the same
    // unknown-as-zero error this whole check exists to correct.
    if (list === null) { t.verdict = "UNKNOWN — could not read Logics"; return; }
    t.activityCount = list.length;

    const acts = list.map((r) => ({
      when: Date.parse(r.Created || r.CreatedDate || r.ActivityDate || r.Date || "") || 0,
      subject: String(r.ActivitySubject || r.Subject || ""),
    }));
    const filed = acts.filter((a) => POA_FILED.test(a.subject) && !NOT_FILED.test(a.subject))
      .sort((a, b) => b.when - a.when)[0];
    const ths = acts.filter((a) => THS_RUN.test(a.subject)).sort((a, b) => b.when - a.when)[0];

    if (filed) {
      t.poaFiled = filed.subject.slice(0, 44);
      t.poaFiledOn = filed.when ? new Date(filed.when).toISOString().slice(0, 10) : "?";
    }
    if (ths) {
      t.thsRun = ths.subject.slice(0, 44);
      t.thsRunOn = ths.when ? new Date(ths.when).toISOString().slice(0, 10) : "?";
    }
    t.verdict = filed
      ? (ths ? "POA FILED and transcripts already pulled" : "POA FILED — ready to run THS")
      : (list.length ? "no POA-filed activity on this case" : "no activity at all");
  });

  const by = {};
  for (const t of targets) by[t.verdict] = (by[t.verdict] || 0) + 1;
  console.log(`  ${"=".repeat(66)}`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`  ${"=".repeat(66)}\n`);

  for (const t of targets.filter((x) => x.poaFiled).sort((a, b) => String(a.poaFiledOn).localeCompare(String(b.poaFiledOn)))) {
    console.log(`  ${t.jiraKey.padEnd(16)}${String(t.tenant).padEnd(6)}case ${String(t.caseId).padEnd(8)}`
      + `POA filed ${t.poaFiledOn}   "${t.poaFiled}"`);
    if (t.thsRun) console.log(`  ${"".padEnd(16)}   THS ${t.thsRunOn}  "${t.thsRun}"`);
  }

  const none = targets.filter((x) => x.verdict && x.verdict.startsWith("no POA"));
  if (none.length) {
    console.log(`\n  no POA-filed activity (${none.length}) — genuinely still waiting:`);
    for (const t of none) {
      console.log(`    ${t.jiraKey.padEnd(16)}${String(t.tenant).padEnd(6)}case ${String(t.caseId).padEnd(8)}`
        + `${t.activityCount} activities  "${String(t.note).slice(0, 34)}"`);
    }
  }

  fs.writeFileSync(path.join(__dirname, "missing-years-poa-check.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), writesNothing: true, items: targets }, null, 2));
  console.log(`\n  wrote missing-years-poa-check.json\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
