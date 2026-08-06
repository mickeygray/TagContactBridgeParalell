"use strict";

// COMPARE THE TWO NIGHTLY PRODUCERS — live compose vs the stored day.
//
// Usage:
//   node scripts/analysis/compare-nightly-emails.js --from 2026-08-01 --to 2026-08-06
//
// READ-ONLY. It composes nothing and sends nothing; it reads the stored
// DailyReportFact for each day, renders it through the SAME renderer the
// record-sourced definition uses, and reports what that render can and cannot
// supply per section.
//
// ── WHY THIS SCRIPT REFUSES TO SAY "PARITY" EASILY ─────────────────────────
//
// The obvious version of this comparison certifies its own bug. `renderSource`
// lives on a strict mongoose schema; if the field is ever dropped (it was
// undeclared until 2026-08-06), the record-sourced definition silently keeps
// COMPOSING. Both emails then come from the same producer, agree perfectly
// every night, and a naive diff reports 100% parity for a renderer that never
// executed once.
//
// So this script asserts the two sides are actually DIFFERENT PRODUCERS before
// it compares anything: the record side must report source "record", and the
// definition must carry a readable renderSource. If it cannot prove that, it
// says NOT COMPARABLE and exits non-zero rather than printing a reassuring
// number.

require("dns").setServers(
  String(process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1").split(",").map((x) => x.trim()),
);
require("dotenv").config();

const { connectMongo } = require("../../packages/event-core/src");
const { getSharedConfig } = require("../../packages/shared-config/src");
const {
  renderReportFromRecord, ROLLUP,
} = require("../../packages/shared-services/src/dailyRecordRenderService");
const DailyReportFact = require("../../packages/shared-models/src/DailyReportFact");
const ReportDefinition = require("../../packages/shared-models/src/ReportDefinition");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function eachDay(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** How much of a section survived: rows the block would render, or UNKNOWN. */
function sectionVerdict(section) {
  if (section.error) return { state: "UNKNOWN", detail: section.error };
  let rows = null;
  try {
    const csv = section.block?.csv?.(section.data);
    rows = Array.isArray(csv?.rows) ? csv.rows.length : null;
  } catch (error) {
    return { state: "THREW", detail: String(error.message).slice(0, 120) };
  }
  return { state: "RENDERED", detail: rows === null ? "summary only" : `${rows} row(s)` };
}

(async () => {
  const to = arg("to", new Date().toISOString().slice(0, 10));
  const from = arg("from", to);

  await connectMongo(getSharedConfig());

  // ── the comparability gate ───────────────────────────────────────────────
  const defs = await ReportDefinition.find({ archivedAt: null }).lean();
  const recordSourced = defs.filter((d) => d.renderSource === "record");
  const schemaKnowsField = Boolean(ReportDefinition.schema.path("renderSource"));

  console.log("=== comparability ===");
  console.log(`  renderSource declared on the schema : ${schemaKnowsField ? "yes" : "NO"}`);
  console.log(`  definitions with renderSource=record: ${recordSourced.length}`
    + (recordSourced.length ? ` (${recordSourced.map((d) => d.name).join(", ")})` : ""));
  console.log(`  definitions composing live          : ${defs.length - recordSourced.length}`);

  if (!schemaKnowsField) {
    console.log("\nNOT COMPARABLE — renderSource is not on the schema, so any attempt to set it");
    console.log("was dropped in silence and BOTH definitions are still composing. Any agreement");
    console.log("you would see here is a producer agreeing with itself.");
    process.exit(2);
  }
  if (!recordSourced.length) {
    console.log("\nNOT YET COMPARABLE — no definition is pointed at the record, so there is only");
    console.log("one producer. This is the expected state until the flip is made deliberately.");
    console.log("Everything below is a DRY READ of what the record could supply if it were.");
  }

  // ── what the record can supply, per day, per section ─────────────────────
  console.log("\n=== what the stored day can render ===");
  const totals = new Map(ROLLUP.map((id) => [id, { RENDERED: 0, UNKNOWN: 0, THREW: 0 }]));
  let daysWithRecord = 0;

  for (const dateKey of eachDay(from, to)) {
    const fact = await DailyReportFact.findOne({ dateKey }).lean();
    if (!fact) {
      console.log(`  ${dateKey}  NO RECORD — the night was never captured`);
      continue;
    }
    daysWithRecord += 1;
    const report = await renderReportFromRecord({ dateKey });

    // The proof that this side is the record producer and not a stray compose.
    if (report.source !== "record") {
      console.log(`  ${dateKey}  ABORT — renderer returned source="${report.source}", expected "record"`);
      process.exit(3);
    }

    const parts = report.sections.map((s) => {
      const v = sectionVerdict(s);
      const bucket = totals.get(s.id);
      if (bucket) bucket[v.state] = (bucket[v.state] || 0) + 1;
      return `${s.id}:${v.state === "RENDERED" ? v.detail : v.state}`;
    });
    console.log(`  ${dateKey}  rev ${fact.revision ?? "?"}  ${parts.join("  ")}`);
  }

  console.log("\n=== per-section verdict across the range ===");
  for (const [id, counts] of totals) {
    const line = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(" · ");
    console.log(`  ${id.padEnd(11)} ${line || "(no days)"}`);
  }

  console.log(`\n${daysWithRecord} day(s) had a stored record out of ${eachDay(from, to).length}.`);
  console.log("A section reading UNKNOWN is not a renderer bug — it is the list of things the");
  console.log("record must start storing before it can stand in for a live gather.");
  process.exit(0);
})().catch((error) => {
  console.error("compare-nightly-emails FAILED:", error.message);
  process.exit(1);
});
