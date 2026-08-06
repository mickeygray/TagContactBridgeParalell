"use strict";

/**
 * unassigned-poa-release — give the ownerless POA and THS work to the POA crew.
 *
 * Mickey 2026-08-05: "ths and poa still required for unassigned can go to jackie or
 * riley if there's no evidence of it in activities."
 *
 * 215 tickets were held back purely because Jira has no assignee and Logics requires
 * a UserID. That is a hard block, not a judgement — but only for work whose owner is
 * genuinely unknown. POA and THS are not that: POAREQ is staffed by exactly two
 * people, Riley Mills and Jackie Rose, and 1,193 of their 1,193 Jira assignments are
 * POAREQ. They work nothing else and nobody else works it.
 *
 * BOTH names go on the task, not one. That is the firm's own convention — the live
 * Logics tasks read Users: [Riley Mills, Jackie Rose] on a single "Run Ths". Picking
 * one would invent a split that does not exist, and the UserID field is an array
 * precisely so it does not have to be picked.
 *
 * THREE GATES BEFORE ANY TICKET IS RELEASED, in increasing cost:
 *
 *   1. Is it POA or THS work at all? Otherwise it is not theirs.
 *   2. Does Logics ALREADY have an outstanding task for it? Then it is owned.
 *   3. Do the case's ACTIVITIES show the work was already done? Then it is finished.
 *
 * Gate 3 is the one Mickey named, and it is the reason this is not just a bulk
 * reassignment. A POA filed eight months ago means the ticket needs Run THS, not File
 * POA — and a case whose transcripts were already pulled needs neither.
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

/** The POA crew, per tenant. Both go on every task — the firm's own convention. */
const CREW = {
  TAG: [{ name: "Riley Mills", id: 407 }, { name: "Jackie Rose", id: 440 }],
  WYNN: [{ name: "Riley Mills", id: 20 }, { name: "Jackie Rose", id: 46 }],
  AMITY: [{ name: "Riley Mills", id: 149 }, { name: "Jackie Rose", id: 168 }],
};

const POA_WORK = /^(File .*POA|Run THS|Review Client Info For POA)/i;
const POA_FILED = /\bfiled\b[^.]{0,20}\bpoa\b|\bpoa\b[^.]{0,20}\bfiled\b|2848 (filed|accepted)/i;
const THS_RUN = /\bran ths\b|\bths\b (run|pulled|complete)|transcripts? (pulled|received|downloaded)/i;
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

/** Cases that already have an OPEN POA or THS task — gate 2. */
async function openPoaTasks(tenant, log) {
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
      if (!/\bths\b|\bpoa\b|transcript/i.test(String(r.Subject || ""))) continue;
      const id = Number(r.CaseID);
      if (!Number.isFinite(id)) continue;
      if (!byCase.has(id)) byCase.set(id, []);
      byCase.get(id).push({ taskId: r.TaskID, subject: String(r.Subject || "") });
    }
  }
  log(`    ${tenant}: ${byCase.size} cases already have an open POA/THS task`
    + (failures ? `   ${failures}/${windows} windows failed` : ""));
  return { byCase, usable: failures < windows };
}

async function main() {
  const log = (s) => console.log(s);
  await connectMongo(getSharedConfig());

  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "rubric-subjects-final.json"), "utf8"));
  const manifest = require(path.join(__dirname, "jira-migration-manifest.json"));
  const man = new Map(manifest.items.map((i) => [i.jiraKey, i]));
  let notes = [];
  for (let i = 0; i < 14; i += 1) notes = notes.concat(JSON.parse(fs.readFileSync(path.join(__dirname, `notes-batch-${i}.json`), "utf8")));
  const noteBy = new Map(notes.map((n) => [n.jiraKey, n]));

  // Gate 1 — unassigned, and the work is POA or THS.
  const candidates = rows.filter((r) => {
    const m = man.get(r.jiraKey) || {};
    return !m.assignee && m.tenant && m.caseId && r.subject && POA_WORK.test(r.subject);
  }).map((r) => {
    const m = man.get(r.jiraKey) || {};
    return { jiraKey: r.jiraKey, tenant: m.tenant, caseId: m.caseId, subject: r.subject,
      note: (noteBy.get(r.jiraKey) || {}).note || "" };
  });
  log(`\n  gate 1 — unassigned POA/THS work: ${candidates.length} tickets`);

  const tenants = [...new Set(candidates.map((c) => c.tenant))];
  log(`\n  gate 2 — cases with an open POA/THS task in Logics:`);
  const openTasks = {};
  for (const t of tenants) openTasks[t] = await openPoaTasks(t, log);

  const clients = {};
  for (const t of tenants) clients[t] = createLogicsClient(t);

  log(`\n  gate 3 — reading each case's activity for evidence the work is done...`);
  await mapLimit(candidates, 5, async (c) => {
    const ot = openTasks[c.tenant];
    if (ot && ot.usable) {
      const has = ot.byCase.get(Number(c.caseId));
      if (has) { c.verdict = `owned — Logics task ${has[0].taskId} "${has[0].subject.slice(0, 30)}"`; return; }
    }
    let list;
    try { list = unwrap(await clients[c.tenant].getActivities(c.caseId)); } catch { list = null; }
    if (list === null) { c.verdict = "UNKNOWN — could not read the case"; return; }
    const subs = list.map((r) => String(r.ActivitySubject || r.Subject || ""))
      .filter((s) => !NOT_DONE.test(s));
    const filed = subs.some((s) => POA_FILED.test(s));
    const ths = subs.some((s) => THS_RUN.test(s));

    if (ths) { c.verdict = "done — transcripts already pulled"; return; }
    // The POA landing is what turns a File POA ticket into a Run THS one.
    c.action = filed ? "Run THS" : "File POA";
    c.evidence = filed ? "POA on file, transcripts not yet pulled" : "no POA-filed activity";
    c.verdict = "RELEASE";
    c.assignTo = CREW[c.tenant];
  });

  const by = {};
  for (const c of candidates) by[c.verdict] = (by[c.verdict] || 0) + 1;
  log(`\n  ${"=".repeat(64)}`);
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k.startsWith("owned") ? "owned — already an open Logics task" : k}`);
  }
  log(`  ${"=".repeat(64)}\n`);

  const release = candidates.filter((c) => c.verdict === "RELEASE");
  const act = {};
  for (const r of release) act[r.action] = (act[r.action] || 0) + 1;
  log(`  RELEASED TO RILEY + JACKIE: ${release.length}`);
  for (const [k, v] of Object.entries(act)) log(`    ${String(v).padStart(4)}  ${k}`);
  const t = {};
  for (const r of release) t[r.tenant] = (t[r.tenant] || 0) + 1;
  log(`    tenant: ${Object.entries(t).map(([a, b]) => `${a}=${b}`).join("  ")}`);

  log(`\n  sample:`);
  for (const r of release.slice(0, 12)) {
    log(`    ${r.jiraKey.padEnd(16)}${r.tenant.padEnd(6)}case ${String(r.caseId).padEnd(8)}`
      + `${r.action.padEnd(10)}${r.evidence}`);
  }

  fs.writeFileSync(path.join(__dirname, "unassigned-poa-release.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), writesNothing: true,
      released: release.length, items: candidates }, null, 2));
  log(`\n  wrote unassigned-poa-release.json\n`);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
