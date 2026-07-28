"use strict";

// SAVED REPORTS — set one up, look at it, put it on a clock.
//
//   node scripts/report-schedule.js --list
//   node scripts/report-schedule.js --save "morning board" --pick daily --range yesterday --at 07:00 --to mgray@taxadvocategroup.com
//   node scripts/report-schedule.js --save "post dates" --pick pipeline --range last30 --at 08:00 --dow 1 --to mgray@taxadvocategroup.com
//   node scripts/report-schedule.js --show "morning board"
//   node scripts/report-schedule.js --run "morning board"            (composes, prints, sends NOTHING)
//   node scripts/report-schedule.js --run "morning board" --send     (actually emails it)
//   node scripts/report-schedule.js --enable "morning board"   /  --disable  /  --archive
//   node scripts/report-schedule.js --due                            (what would fire right now)
//
// --run defaults to DRY: it composes the real report and prints it, but never
// sends. Arming a schedule and emailing a person are separate decisions.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig, getInternalFromEmail } = require("../packages/shared-config/src");
const { sendMail } = require("../packages/shared-services/src/mailerService");
const { BLOCKS, PRESETS, resolveSelection } = require("../packages/shared-services/src/reportBlocksService");
const {
  ReportDefinition, dueDefinitions, isDue, resolveRange, runDefinition,
} = require("../packages/shared-services/src/reportDefinitionService");

const NEWLINE = String.fromCharCode(10);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    if (v && !v.startsWith("--")) out.push(v);
  }
  return out;
}
const has = (name) => process.argv.includes(`--${name}`);
// Drop empty segments BEFORE Number(): "".split(",") is [""], and Number("")
// is 0 — so an unspecified --dow silently became [0] = "Sundays only", and an
// unspecified --dom became [0] = "the last day of the month". Together that
// scheduled a daily report for Sundays that fall on a month end.
const nums = (raw) => String(raw || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map(Number)
  .filter((n) => Number.isFinite(n));

function describe(d) {
  const s = d.schedule || {};
  const when = s.enabled
    ? `${String(s.hour).padStart(2, "0")}:${String(s.minute || 0).padStart(2, "0")} PT`
      + (s.daysOfWeek?.length ? ` on ${s.daysOfWeek.map((n) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n]).join(",")}` : "")
      + (s.daysOfMonth?.length ? ` day ${s.daysOfMonth.map((n) => (n === 0 ? "last" : n)).join(",")}` : "")
    : "not scheduled";
  const r = resolveRange(d.range);
  return [
    `  ${d.name}${d.archivedAt ? "  [ARCHIVED]" : ""}`,
    `      blocks    ${(d.blocks || []).join(", ") || "daily"}`,
    `      range     ${d.range}  →  ${r.from}${r.to !== r.from ? ` → ${r.to}` : ""} (today)`,
    d.filters?.length ? `      filters   ${d.filters.join(" · ")}` : null,
    d.domain ? `      domain    ${d.domain}` : null,
    `      to        ${(d.recipients || []).join(", ") || "(nobody)"}${d.attachCsv ? "  +csv" : ""}`,
    `      schedule  ${when}`,
    d.lastRunAt ? `      last run  ${d.lastRunKey} (${Math.round((d.lastDurationMs || 0) / 1000)}s, ${d.runCount} total)` : "      last run  never",
    d.lastError ? `      LAST ERROR ${d.lastError}` : null,
  ].filter(Boolean).join(NEWLINE);
}

async function main() {
  await connectMongo(getSharedConfig());

  if (has("blocks")) {
    console.log(NEWLINE + "BLOCKS");
    for (const b of BLOCKS) console.log(`  ${b.id.padEnd(12)} ${b.label.padEnd(30)} ${b.hint}`);
    console.log(NEWLINE + "PRESETS");
    for (const [k, v] of Object.entries(PRESETS)) console.log(`  ${k.padEnd(12)} ${v.join(", ")}`);
    return;
  }

  const saveName = arg("save");
  if (saveName && saveName !== true) {
    const picks = String(arg("pick", "daily")).split(",").map((x) => x.trim()).filter(Boolean);
    const sel = resolveSelection(picks);
    if (sel.unknown.length) {
      console.error(`unknown block(s): ${sel.unknown.join(", ")}`);
      console.error(`valid: ${BLOCKS.map((b) => b.id).join(", ")} | presets: ${Object.keys(PRESETS).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const at = String(arg("at", "07:00"));
    const [hour, minute] = at.split(":").map(Number);
    const doc = await ReportDefinition.findOneAndUpdate(
      { name: saveName },
      {
        $set: {
          name: saveName,
          description: arg("description", null) || null,
          blocks: picks,
          filters: args("where"),
          domain: arg("domain", null) || null,
          range: String(arg("range", "yesterday")),
          recipients: args("to"),
          attachCsv: has("csv"),
          sendEmail: !has("no-email"),
          "schedule.enabled": has("enable"),
          "schedule.hour": Number.isFinite(hour) ? hour : 7,
          "schedule.minute": Number.isFinite(minute) ? minute : 0,
          "schedule.daysOfWeek": nums(arg("dow", "")),
          "schedule.daysOfMonth": nums(arg("dom", "")),
          archivedAt: null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(NEWLINE + "saved:" + NEWLINE + describe(doc));
    if (!has("enable")) console.log(NEWLINE + "  (not armed — re-save with --enable when you want it on a clock)");
    return;
  }

  for (const [flag, patch, label] of [
    ["enable", { "schedule.enabled": true }, "armed"],
    ["disable", { "schedule.enabled": false }, "disarmed"],
    ["archive", { archivedAt: new Date() }, "archived"],
  ]) {
    const name = arg(flag);
    if (name && name !== true) {
      const doc = await ReportDefinition.findOneAndUpdate({ name }, { $set: patch }, { new: true });
      if (!doc) { console.error(`no definition named "${name}"`); process.exitCode = 1; return; }
      console.log(`${label}: ${doc.name}`);
      console.log(describe(doc));
      return;
    }
  }

  const showName = arg("show");
  if (showName && showName !== true) {
    const doc = await ReportDefinition.findOne({ name: showName });
    if (!doc) { console.error(`no definition named "${showName}"`); process.exitCode = 1; return; }
    console.log(NEWLINE + describe(doc));
    return;
  }

  const runName = arg("run");
  if (runName && runName !== true) {
    const doc = await ReportDefinition.findOne({ name: runName });
    if (!doc) { console.error(`no definition named "${runName}"`); process.exitCode = 1; return; }
    const send = has("send");
    console.log(NEWLINE + `running "${doc.name}"${send ? " and SENDING" : " (dry — nothing will be sent)"}...` + NEWLINE);
    const result = await runDefinition(doc, {
      dryRun: !send,
      logger: { info: (m) => console.log(m) },
      sendMail, fromEmail: getInternalFromEmail(),
    });
    console.log(result.text);
    console.log(NEWLINE + `  ${result.range.from} → ${result.range.to} · ${result.sections} section(s) · ${Math.round(result.durationMs / 1000)}s`
      + (result.delivered ? ` · SENT to ${(doc.recipients || []).join(", ")}` : " · not sent"));
    for (const e of result.errors) console.log(`  BLOCK ERROR ${e}`);
    return;
  }

  if (has("due")) {
    const due = await dueDefinitions();
    console.log(NEWLINE + (due.length ? `${due.length} definition(s) due right now:` : "nothing is due right now."));
    for (const d of due) console.log(describe(d));
    if (!due.length) {
      const all = await ReportDefinition.find({ "schedule.enabled": true, archivedAt: null });
      for (const d of all) console.log(`  ${d.name}: ${isDue(d).reason}`);
    }
    return;
  }

  const all = await ReportDefinition.find({ archivedAt: null }).sort({ name: 1 });
  console.log(NEWLINE + (all.length ? `${all.length} saved report(s):` : "no saved reports yet."));
  for (const d of all) console.log(describe(d) + NEWLINE);
  if (!all.length) {
    console.log('  try:  node scripts/report-schedule.js --save "morning board" --pick daily --range yesterday --at 07:00 --to you@example.com');
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("report-schedule failed:", e.stack || e.message); process.exit(1); });
