"use strict";

// METRICS WIRING CHECK — does everything that reports actually have its data?
//
//   node scripts/metrics-wiring-check.js            (today)
//   node scripts/metrics-wiring-check.js --month
//
// Written 2026-07-31 after a nightly email went out for weeks with nothing in
// it. The failure was never loud: a material came back empty, a block rendered
// a zero, and the mail looked like a quiet day. This asks every source the
// reports depend on whether it actually answered, and says plainly which did
// not — so "wired" is a thing you can check rather than assume.
//
// Read-only. Sends nothing, writes nothing.

require("dotenv").config();
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
};
const has = (n) => process.argv.includes(`--${n}`);
const pacificKey = (at = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(at);

const OK = "  ok   ";
const BAD = "  MISS ";
const WARN = "  warn ";

async function main() {
  const today = pacificKey();
  const from = arg("from") || (has("month") ? `${today.slice(0, 7)}-01` : today);
  const to = arg("to") || today;
  await connectMongo(getSharedConfig());
  const { gatherMaterial } = require("../packages/shared-services/src/reportComposerService");
  const blocks = require("../packages/shared-services/src/reportBlocksService");
  const problems = [];
  const note = (line) => { console.log(line); };

  console.log(`\n  METRICS WIRING — ${from}${to !== from ? ` to ${to}` : ""}\n`);

  // ── 1. every material the presets need, gathered once ────────────────────
  const presets = ["rollup", "vendor-ld"];
  const needed = new Set();
  for (const p of presets) {
    for (const b of blocks.resolveSelection([p]).blocks) for (const n of b.needs || []) needed.add(n);
  }
  console.log(`  materials the boards depend on: ${[...needed].sort().join(", ")}\n`);
  const material = await gatherMaterial({ needs: [...needed], from, to, domain: null, live: true });

  const size = (v) => (Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : (v ? 1 : 0)));
  const EXPECTED_NONEMPTY = new Set(["payments", "spend", "activity", "callsRange", "dials"]);
  // A `needs` name is not always the key the material lands under. Getting this
  // wrong makes the check cry wolf, which is worse than not having it: the
  // first run reported `activity` empty while the status block happily
  // returned six rows off material.events.
  const MATERIAL_KEY = {
    activity: "events",
    calls: "callsBySource",
    queue: "queueByAgent",
    caseContacts: "caseContacts",
  };
  for (const key of [...needed].sort()) {
    const alias = MATERIAL_KEY[key] || key;
    const value = material[alias] ?? material[key] ?? null;
    const n = size(value);
    const expected = EXPECTED_NONEMPTY.has(key);
    if (n > 0) note(`${OK}${key.padEnd(18)} ${n} row(s)/key(s)`);
    else if (expected) { note(`${BAD}${key.padEnd(18)} EMPTY — the boards will report zero`); problems.push(`${key} is empty`); }
    else note(`${WARN}${key.padEnd(18)} empty (may be normal for this range)`);
  }

  // ── 2. does every block compute without throwing ─────────────────────────
  console.log("");
  // EACH PRESET UNDER THE DOMAIN IT ACTUALLY RUNS WITH. Checking both with
  // domain:null meant the vendor path was never exercised — which is exactly
  // where the tenant leak lived (a WYNN board carrying TAG mail spend). The
  // two boards share every block; the domain is the only thing separating them,
  // so a check that ignores it checks the easier half twice.
  const PRESET_DOMAIN = { rollup: null, "vendor-ld": "WYNN" };
  for (const p of presets) {
    const dom = PRESET_DOMAIN[p] ?? null;
    for (const b of blocks.resolveSelection([p]).blocks) {
      try {
        const data = b.compute({ ...material, from, to, domain: dom });
        const rows = Array.isArray(data) ? data.length : size(data);
        note(`${rows ? OK : WARN}${(p + "/" + b.id).padEnd(26)} ${rows} row(s)${dom ? `  [${dom}]` : ""}`);
      } catch (error) {
        note(`${BAD}${(p + "/" + b.id).padEnd(26)} THREW ${String(error.message).slice(0, 60)}`);
        problems.push(`${p}/${b.id} threw`);
      }
    }
  }

  // ── 3. the things that carry metrics out ─────────────────────────────────
  console.log("");
  const ReportDefinition = require("../packages/shared-models/src/ReportDefinition");
  const defs = await ReportDefinition.find({ archivedAt: null }).lean();
  const scheduled = defs.filter((d) => d.schedule?.enabled);
  note(`${defs.length ? OK : BAD}saved report definitions: ${defs.length}, scheduled: ${scheduled.length}`);
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  // "Did last night's email actually go out?" was unanswerable here: the line
  // printed lastRunKey and never compared it to anything, so a definition
  // stuck three days back looked identical to one that ran an hour ago.
  const lastScheduledDayBefore = (def) => {
    const dows = def.schedule?.daysOfWeek?.length ? def.schedule.daysOfWeek : [0, 1, 2, 3, 4, 5, 6];
    for (let back = 1; back <= 14; back += 1) {
      const d = new Date(Date.parse(`${today}T12:00:00Z`) - back * 86400000);
      if (dows.includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
    }
    return null;
  };
  for (const d of defs) {
    const s = d.schedule || {};
    const dows = s.daysOfWeek?.length ? s.daysOfWeek.map((n) => DOW[n]).join(",") : "EVERY DAY";
    note(`         ${String(d.name).padEnd(34)} blocks=${(d.blocks || []).join(",")}`
      + `  ${s.enabled ? `at ${String(s.hour).padStart(2, "0")}:${String(s.minute ?? 0).padStart(2, "0")} ${dows}` : "not scheduled"}`
      + `  to=${(d.recipients || []).length}`
      + `  last=${d.lastRunKey || "never"}`);
    if (!s.enabled) continue;
    // A definition armed to send with nobody to send to used to file a clean,
    // successful, entirely imaginary run every night.
    if (d.sendEmail && !(d.recipients || []).filter(Boolean).length) {
      problems.push(`"${d.name}" is scheduled to send but has no recipients`);
    }
    // An empty daysOfWeek is not "weekdays", it is every day — the single
    // easiest thing to get wrong here, because it looks like "unset".
    if (!s.daysOfWeek?.length) {
      note(`${WARN}${"".padEnd(4)}"${d.name}" has no weekday rule — it will also send Saturday and Sunday`);
    }
    const owed = lastScheduledDayBefore(d);
    if (owed && (!d.lastRunKey || d.lastRunKey < owed)) {
      problems.push(`"${d.name}" last ran ${d.lastRunKey || "never"} but was due ${owed} — a night was missed`);
    }
    if (d.lastError) problems.push(`"${d.name}" last error: ${String(d.lastError).slice(0, 120)}`);
    if (d.lastAttemptKey === today && (d.attemptsToday || 0) >= 3) {
      problems.push(`"${d.name}" gave up today after ${d.attemptsToday} failed attempt(s)`);
    }
  }
  const runtimeFlags = {
    REPORT_SCHEDULER_ENABLED: process.env.REPORT_SCHEDULER_ENABLED,
    NIGHTLY_CLOSE_ENABLED: process.env.NIGHTLY_CLOSE_ENABLED,
    LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED: process.env.LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED,
  };
  console.log("");
  for (const [k, v] of Object.entries(runtimeFlags)) {
    const set = v !== undefined;
    note(`${set ? OK : WARN}${k.padEnd(40)} ${set ? v : "(unset)"}`);
  }
  if (String(runtimeFlags.REPORT_SCHEDULER_ENABLED) !== "true" && scheduled.length) {
    problems.push("definitions are scheduled but REPORT_SCHEDULER_ENABLED is not true — nothing will send");
  }

  // ── 4. the collection loop the metrics actually come from ────────────────
  console.log("");
  const cfg = getSharedConfig().logicsActivityReview || {};
  note(`${cfg.enabled ? OK : BAD}activity pull loop  enabled=${Boolean(cfg.enabled)} at `
    + `${String(cfg.hour).padStart(2, "0")}:${String(cfg.minute).padStart(2, "0")} ${cfg.timezone}`);
  if (!cfg.enabled) problems.push("the activity pull loop is off — status metrics will be empty");

  console.log("");
  if (!problems.length) {
    console.log("  WIRED — every source answered and every block computed.\n");
  } else {
    console.log(`  ${problems.length} PROBLEM(S):`);
    for (const p of problems) console.log(`    - ${p}`);
    console.log("");
  }
  process.exitCode = problems.length ? 1 : 0;
}

main().then(() => process.exit(process.exitCode || 0)).catch((error) => {
  console.error(`metrics-wiring-check failed: ${error.message}`);
  process.exit(1);
});
