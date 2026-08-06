"use strict";

/**
 * stale-vs-logics — for the Jira tickets we are NOT migrating, ask Logics whether
 * the work quietly happened anyway.
 *
 * Mickey 2026-08-05: "lets not do stuff thats older than 2 months and then we will
 * make a list and look at logics activities and see what we can cross off."
 *
 * 105 of 809 open Jira issues have not been touched in two months, and the staleness
 * is almost entirely on the POA side — all 47 billing follow-ups, 28 of 29 File POA,
 * every Review Client Info ticket. Not one ASSIGNMENT ticket is stale. So this is not
 * a backlog spread evenly across the firm; it is one queue that stopped being worked.
 *
 * A stale Jira ticket is not evidence that nothing happened. It is evidence that
 * nobody updated JIRA. Logics is where the work actually gets recorded, so before
 * anyone hand-reviews 105 tickets it is worth asking Logics what it has seen on those
 * cases since the ticket went quiet. Three outcomes:
 *
 *   activity AFTER the ticket went quiet  -> somebody worked it. Candidate to close.
 *   no activity at all since then         -> genuinely abandoned. Needs a decision.
 *   case not found                        -> the case itself may be gone.
 *
 * WRITES NOTHING, and reads per case rather than by range.
 *
 * The first version used Report/ActivityReport, which is range-native — one call per
 * domain per window. That is the right tool when you want a whole day or month of the
 * firm's activity, but it is the wrong one here: to answer a question about 105
 * specific cases it dragged back every activity for every case in three tenants over
 * 240 days, then threw almost all of it away. CaseActivity/Activity?CaseID= answers
 * exactly the question asked, and it returns a case's COMPLETE history rather than
 * whatever happens to fall inside the window — so "no activity" stops being bounded
 * by an arbitrary lookback.
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
const CUT = NOW - 61 * 86400000;              // "older than 2 months"
const LOOKBACK_DAYS = 240;                    // far enough back to cover the stale tail

const unwrap = (res) => {
  const d = res?.data ?? res;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.Data)) return d.Data;
  return [];
};

/** Bounded concurrency — Logics is shared production, not a load target. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i; i += 1; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/**
 * One case's complete activity history.
 *
 * Returns `null` on failure rather than an empty list. The distinction is the whole
 * point of this script: a case we could not read is UNKNOWN, and reporting it as
 * having no activity would manufacture exactly the false "nothing happened" verdict
 * this cross-check exists to avoid.
 */
async function caseActivity(client, caseId) {
  let res;
  try { res = await client.getActivities(caseId); } catch { return null; }
  const list = unwrap(res);
  if (!Array.isArray(list)) return null;
  let last = 0;
  const rows = [];
  for (const r of list) {
    const when = Date.parse(r.Created || r.CreatedDate || r.ActivityDate || r.Date || "");
    if (Number.isFinite(when) && when > last) last = when;
    rows.push({ when: Number.isFinite(when) ? when : 0, subject: String(r.ActivitySubject || r.Subject || "") });
  }
  return {
    count: list.length,
    last,
    subjects: rows.slice(-3).map((r) => r.subject.slice(0, 46)).filter(Boolean),
    /** Only the activity recorded after the Jira ticket fell silent. */
    after: (t) => rows.filter((r) => r.when > t),
  };
}

/**
 * Does the case's own activity log say the thing the ticket was waiting for happened?
 *
 * Mickey 2026-08-05: "you'll see activities like filed poa or document uploaded."
 *
 * This is a much stronger signal than "the case moved". A case can accumulate payments
 * and status changes for months while the POA it is blocked on is still missing, so
 * liveness alone cannot close a ticket. A logged "POA filed", though, answers the
 * actual question.
 *
 * Deliberately conservative — an unmatched activity means NO EVIDENCE, never evidence
 * of absence. The ticket then falls back to the weaker "worked since" verdict rather
 * than being marked done or being marked dead.
 */
const EVIDENCE = [
  // "Filed Poa" / "Filed State Poa(Business)" — a completed filing, past tense.
  { when: /File .*POA/i, proof: /\bfiled\b.*\bpoa\b|\bpoa\b.*\bfiled\b|2848 (filed|accepted)|poa (approved|accepted|on file)/i },
  { when: /Review Client Info For POA/i, proof: /\bpoa\b.*(filed|accepted|approved)|mismatch (resolved|corrected|fixed)/i },
  { when: /Run THS/i, proof: /\bths\b (run|pulled|complete)|ran ths|transcripts? (pulled|received|downloaded)/i },
  { when: /Follow Up On Tax Organizer/i, proof: /organizer (received|returned|complete)|\bt\.?o\.? (received|back|returned)|document has been uploaded/i },
  { when: /Follow Up On Billing/i, proof: /payment made|payment (received|posted|successful)|paid in full|balance cleared/i },
  { when: /Follow Up On Signed Returns|Send Return For Signature/i, proof: /signed (return|copy)|8879 (received|signed)|e-?filed|return (accepted|transmitted)/i },
  { when: /Prep .*Return|File .*Return|Amend .*Return/i, proof: /return (filed|accepted|transmitted|e-?filed)|\be-?filed\b|1040 (filed|accepted)/i },
  { when: /Prac Call/i, proof: /prac call (made|complete|done)|called irs|spoke (with|to) irs|ppl call/i },
];

/**
 * Activity that says the work is STILL NEEDED, not that it is finished.
 *
 * These caught real false positives on the first run. "Payment Failed $100.00" and
 * "Payment deleted ($125.00)" both match a naive /payment/ test and read as proof a
 * billing follow-up is done, when they are proof it is not. "New task assigned to
 * 'Jackie Rose, Riley Mills' (Run Ths)" means somebody was ASKED to run transcripts,
 * which is the ticket being restated rather than resolved. And a note reading "TP IS
 * USING SSN THAT DOES NOT BELONG TO HIM - CAN'T GET THRU" is the diagnosis of why the
 * case is stuck, not its resolution.
 *
 * Matching the topic is not the same as matching the outcome, and on a queue this
 * stale the topic will nearly always match.
 */
const STILL_BLOCKED = /failed|declined|deleted|cancell?ed|reversed|new task assigned|can'?t get|unable|mismatch|no answer|default|suspended|rejected/i;

function evidenceFor(subject, activities) {
  if (!subject || !activities || !activities.length) return null;
  const rule = EVIDENCE.find((e) => e.when.test(subject));
  if (!rule) return null;
  const hit = activities.find((a) => rule.proof.test(a.subject) && !STILL_BLOCKED.test(a.subject));
  return hit ? hit.subject.slice(0, 60) : null;
}

/** Activity that positively indicates the ticket is still live work. */
function blockedEvidenceFor(activities) {
  if (!activities || !activities.length) return null;
  const hit = activities.find((a) => STILL_BLOCKED.test(a.subject));
  return hit ? hit.subject.slice(0, 60) : null;
}

async function main() {
  const log = (s) => console.log(s);
  await connectMongo(getSharedConfig());

  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rubric-subjects-final.json"), "utf8"));
  const dates = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "jira-dates.json"), "utf8"))
    .map((d) => [d.k, d]));
  const manifest = require(path.join(__dirname, "jira-migration-manifest.json"));
  const man = new Map(manifest.items.map((i) => [i.jiraKey, i]));

  const stale = rows.filter((r) => {
    const d = dates.get(r.jiraKey);
    return d && d.u < CUT;
  }).map((r) => {
    const d = dates.get(r.jiraKey);
    const m = man.get(r.jiraKey) || {};
    return {
      jiraKey: r.jiraKey, status: d.s, updated: new Date(d.u).toISOString().slice(0, 10),
      daysQuiet: Math.round((NOW - d.u) / 86400000),
      subject: r.subject || null, tenant: m.tenant || null, caseId: m.caseId || null,
      assignee: m.assignee || null, quietAt: d.u,
    };
  });

  log(`\n  ${stale.length} stale Jira issues (untouched since ${new Date(CUT).toISOString().slice(0, 10)})`);
  const byTenant = {};
  for (const s of stale) byTenant[s.tenant || "unresolved"] = (byTenant[s.tenant || "unresolved"] || 0) + 1;
  log(`  by tenant: ${Object.entries(byTenant).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  log(`\n  Reading Logics activity per case (${stale.length} cases, complete history each):`);
  const clients = {};
  for (const t of ["TAG", "WYNN", "AMITY"]) clients[t] = createLogicsClient(t);

  let worked = 0; let quiet = 0; let unknown = 0; let failed = 0; let direct = 0;
  await mapLimit(stale, 5, async (s) => {
    if (!s.tenant || !s.caseId) { s.verdict = "no case/tenant resolved"; unknown += 1; return; }
    const hit = await caseActivity(clients[s.tenant], s.caseId);
    if (hit === null) {
      s.verdict = "UNKNOWN — the Logics read failed for this case"; unknown += 1; failed += 1; return;
    }
    s.logicsActivity = hit.count;
    s.logicsLast = hit.last ? new Date(hit.last).toISOString().slice(0, 10) : null;
    s.logicsSubjects = hit.subjects;
    if (!hit.count) { s.verdict = "no Logics activity on this case at all"; quiet += 1; return; }

    // Mickey 2026-08-05: "you'll see activities like filed poa or document uploaded."
    // The activity SUBJECT is what makes this more than a liveness check — it can say
    // the specific thing the ticket was waiting for actually happened, which is a far
    // stronger reason to close a ticket than the case merely having moved.
    const since = hit.after(s.quietAt);
    const proof = evidenceFor(s.subject, since);
    if (proof) { s.evidence = proof; direct += 1; }
    else { const blk = blockedEvidenceFor(since); if (blk) s.stillBlocked = blk; }

    if (hit.last && hit.last > s.quietAt) {
      s.verdict = proof
        ? "DONE — Logics shows the work itself"
        : (s.stillBlocked ? "STILL LIVE — Logics shows it is not resolved"
          : "worked in Logics after Jira went quiet");
      worked += 1;
    } else { s.verdict = "Logics activity, but none since Jira went quiet"; quiet += 1; }
  });
  if (failed) log(`  ${failed} cases could not be read — reported as UNKNOWN, not quiet.`);
  if (failed === stale.length) {
    throw new Error("every per-case read failed — refusing to report any verdict");
  }
  log(`  of the ${worked} worked-since, ${direct} show the SPECIFIC work in an activity subject`);

  log(`\n  ${"=".repeat(70)}`);
  log(`  CROSS-OFF CANDIDATES  ${worked}   still quiet ${quiet}   unresolved ${unknown}`);
  log(`  ${"=".repeat(70)}\n`);

  const worksheet = stale.sort((a, b) => b.daysQuiet - a.daysQuiet);
  for (const s of worksheet.filter((x) => x.evidence).slice(0, 22)) {
    log(`  ${s.jiraKey.padEnd(15)}${String(s.tenant).padEnd(6)}case ${String(s.caseId).padEnd(8)}`
      + `quiet ${String(s.daysQuiet).padStart(3)}d   logics last ${s.logicsLast} (${s.logicsActivity} acts)`);
    log(`  ${"".padEnd(15)}ticket: ${String(s.subject || "(none)").slice(0, 34).padEnd(36)}`
      + `logics: "${s.evidence}"`);
  }

  const byVerdict = {};
  for (const s of stale) byVerdict[s.verdict] = (byVerdict[s.verdict] || 0) + 1;
  log(`\n  by verdict:`);
  for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) log(`    ${String(v).padStart(4)}  ${k}`);

  const bySubject = {};
  for (const s of stale.filter((x) => x.verdict.startsWith("worked"))) {
    const k = s.subject || "(outside rubric)";
    bySubject[k] = (bySubject[k] || 0) + 1;
  }
  log(`\n  cross-off candidates by subject:`);
  for (const [k, v] of Object.entries(bySubject).sort((a, b) => b[1] - a[1])) log(`    ${String(v).padStart(4)}  ${k}`);

  fs.writeFileSync(path.join(__dirname, "stale-worksheet.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    writesNothing: true,
    cutoff: new Date(CUT).toISOString().slice(0, 10),
    totals: { stale: stale.length, crossOffCandidates: worked, stillQuiet: quiet, unresolved: unknown },
    items: worksheet,
  }, null, 2));
  log(`\n  wrote stale-worksheet.json\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
