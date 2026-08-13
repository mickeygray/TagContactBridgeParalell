"use strict";

/**
 * daily-entry-vs-email — build the day's entry with the new worker and compare
 * it, field by field, against the record the nightly EMAIL produced for the same
 * day.
 *
 * READ ONLY. Nothing is written; the worker runs with apply:false.
 *
 * This is the acceptance test for the record-creation system. Mickey 2026-08-04:
 * "when you have the entire record creation system ready ... I want to run what
 * that does and then pull up the email we sent yesterday and see if they match."
 *
 * The stored fact for a delivered day WAS produced by that email's own gather,
 * so it is the honest thing to compare against — not a re-render.
 *
 * A DIFFERENCE IS NOT AUTOMATICALLY A BUG. Two gathers minutes or hours apart can
 * legitimately differ: a late payment lands, a status flips. What matters is
 * whether the SHAPE matches and whether the numbers differ by more than the day
 * moved. The report says which, it does not guess.
 *
 *   node scripts/daily-entry-vs-email.js [YYYY-MM-DD]
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { composeReport } = require("../packages/shared-services/src/reportComposerService");
const { buildDailyEntry, gatherersFromReport } = require("../packages/shared-services/src/dailyEntryService");
const { gatherRecordingLinks } = require("../packages/shared-services/src/callRecordingIndexService");
const DailyReportFact = require("../packages/shared-models/src/DailyReportFact");
const ReportDefinition = require("../packages/shared-models/src/ReportDefinition");

const CANONICAL = "financial";
const pad = (s, n) => String(s).padEnd(n);

const pacificYesterday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() - 86400000));

/** Compare two section values and describe the difference in one line. */
function compare(name, mine, theirs) {
  const bothNull = mine == null && theirs == null;
  if (bothNull) return { name, verdict: "both absent", detail: "" };
  if (mine == null) return { name, verdict: "MISSING FROM ENTRY", detail: "the email's record has it" };
  if (theirs == null) return { name, verdict: "new in entry", detail: "the email's record had none" };

  const a = JSON.stringify(mine);
  const b = JSON.stringify(theirs);
  if (a === b) return { name, verdict: "IDENTICAL", detail: "" };

  // Same shape, different values is the interesting case — report which keys.
  if (typeof mine === "object" && typeof theirs === "object" && !Array.isArray(mine)) {
    const keys = [...new Set([...Object.keys(mine), ...Object.keys(theirs)])];
    const diffs = keys.filter((k) => JSON.stringify(mine[k]) !== JSON.stringify(theirs[k]));
    const shapeSame = keys.every((k) => k in mine && k in theirs);
    return {
      name,
      verdict: shapeSame ? "same shape, values differ" : "SHAPE DIFFERS",
      detail: diffs.slice(0, 6).map((k) => `${k}: ${JSON.stringify(mine[k])} vs ${JSON.stringify(theirs[k])}`).join("  |  "),
    };
  }
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    return { name, verdict: mine.length === theirs.length ? "same length, contents differ" : "LENGTH DIFFERS",
      detail: `${mine.length} vs ${theirs.length} row(s)` };
  }
  return { name, verdict: "differs", detail: `${a.slice(0, 60)} vs ${b.slice(0, 60)}` };
}

async function main() {
  const dateKey = process.argv[2] || pacificYesterday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error(`bad date ${dateKey}`);
  await connectMongo(getSharedConfig());

  const stored = await DailyReportFact.findOne({ dateKey }).lean();
  if (!stored) {
    console.log(`\nNo stored record for ${dateKey} — nothing to compare against.\n`);
    await disconnectMongo();
    return;
  }

  console.log(`\nDAILY ENTRY vs THE EMAIL'S RECORD — ${dateKey}\n`);
  console.log(`  the email's record: revision ${stored.revision}, definition "${stored.definitionName}"`);
  console.log(`  email accepted at : ${stored.emailAcceptedAt || "(none)"}\n`);

  const def = await ReportDefinition.findOne({ name: CANONICAL }).lean();
  if (!def) throw new Error(`no definition named "${CANONICAL}"`);

  console.log("  composing the day (one gather)…");
  const started = Date.now();
  const report = await composeReport({
    from: dateKey,
    to: dateKey,
    selection: def.blocks && def.blocks.length ? def.blocks : ["daily"],
    domain: def.domain || null,
    where: def.filters || [],
    live: true,
  });
  console.log(`  gathered in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  const entry = await buildDailyEntry({
    dateKey,
    apply: false,
    gatherers: {
      ...gatherersFromReport(report),
      calls: async () => (await gatherRecordingLinks({ dateKey, apply: false })).callFacts,
    },
  });

  console.log("  " + pad("SECTION", 18) + pad("VERDICT", 26) + "DETAIL");
  console.log("  " + "-".repeat(94));
  const names = ["financial", "spend", "bySource", "byAgent", "statusMovement", "calls", "activity"];
  const results = names.map((n) => compare(n, entry.facts[n], stored.facts?.[n]));
  for (const r of results) {
    console.log("  " + pad(r.name, 18) + pad(r.verdict, 26) + String(r.detail).slice(0, 70));
  }

  if (entry.errors.length) {
    console.log("\n  GATHER ERRORS:");
    for (const e of entry.errors) console.log("    " + e);
  }

  const identical = results.filter((r) => r.verdict === "IDENTICAL").length;
  const absent = results.filter((r) => r.verdict === "both absent").length;
  console.log(`\n  ${identical} identical · ${absent} absent from both · ${results.length - identical - absent} differing`);
  console.log("\n  Nothing was written.\n");

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
