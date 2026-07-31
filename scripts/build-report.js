"use strict";

// THE REPORT BUILDER — tick calculations, pick a range, choose an output.
//
//   node scripts/build-report.js --blocks                     (list them)
//   node scripts/build-report.js --pick money,net --today
//   node scripts/build-report.js --pick daily --from 2026-07-24 --to 2026-07-28
//   node scripts/build-report.js --pick source,cohort --month --csv
//   node scripts/build-report.js --pick daily --today --email
//
// Live from the authoritative services by default. --cached reads the
// nightly persistence instead. Ticked blocks share ONE gather.

require("dotenv").config();
// See scripts/report.js — a stale c-ares nameserver breaks only the SRV
// lookup behind mongodb+srv://, so this fails as ECONNREFUSED. Opt-in.
if (process.env.DNS_SERVERS) {
  try { require("dns").setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean)); }
  catch (error) { console.warn(`DNS_SERVERS ignored — ${error.message}`); }
}

const fs = require("fs");
const path = require("path");

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig, ROOT_DIR, getInternalFromEmail } = require("../packages/shared-config/src");
const { BLOCKS, PRESETS, resolveSelection } = require("../packages/shared-services/src/reportBlocksService");
const { composeReport, renderHtml, renderText, renderCsvs } = require("../packages/shared-services/src/reportComposerService");
const { sendMail } = require("../packages/shared-services/src/mailerService");

const NEWLINE = String.fromCharCode(10);

/** Repeatable --where flags: --where cohort=2024 --where minutes>10 */
function args(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    if (v && !v.startsWith("--")) out.push(v);
  }
  return out;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

function pacificDateKey(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

function resolveRange() {
  if (process.argv.includes("--today")) { const t = pacificDateKey(); return { from: t, to: t }; }
  if (process.argv.includes("--yesterday")) { const y = pacificDateKey(-1); return { from: y, to: y }; }
  if (process.argv.includes("--week")) return { from: pacificDateKey(-6), to: pacificDateKey() };
  if (process.argv.includes("--month")) {
    const t = pacificDateKey();
    return { from: `${t.slice(0, 7)}-01`, to: t };
  }
  return { from: arg("from"), to: arg("to") };
}

/** One CSV per ticked block — a block is a table, and jamming unrelated
 * tables into one sheet is what makes a CSV useless.
 *
 * The building is `renderCsvs` in the composer, shared with the scheduler's
 * --csv attachment. It used to be written out twice, and this repo has twice
 * paid for a second copy of a shared rule drifting from the first. This half
 * only decides where the bytes land. */
function writeCsvs(report, outDir) {
  const written = [];
  for (const csv of renderCsvs(report)) {
    const file = path.join(outDir, csv.filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, csv.content);
    written.push({ file, rows: csv.rows });
  }
  return written;
}

async function main() {
  if (process.argv.includes("--blocks") || process.argv.length < 3) {
    console.log(`${NEWLINE}CALCULATIONS — tick any combination with --pick${NEWLINE}`);
    for (const b of BLOCKS) console.log(`  [ ] ${b.id.padEnd(12)} ${b.label.padEnd(26)} ${b.hint}`);
    console.log(`${NEWLINE}PRESETS`);
    const w = Math.max(...Object.keys(PRESETS).map((k) => k.length)) + 2;
    for (const [k, v] of Object.entries(PRESETS)) console.log(`      ${k.padEnd(w)}${v.join(", ")}`);
    console.log(`${NEWLINE}RANGE   --today · --yesterday · --week · --month · --from X --to Y`);
    console.log(`OUTPUT  (console) · --csv [--out <dir>] · --html [--out <dir>] · --email [--to addr] · --json`);
    console.log(`SOURCE  live by default · --cached for instant repeats${NEWLINE}`);
    process.exit(0);
  }

  const range = resolveRange();
  if (!range.from) { console.error("need a range: --today, --week, --month, or --from/--to"); process.exit(1); }

  const selection = arg("pick", "daily");
  const quiet = process.argv.includes("--csv") || process.argv.includes("--json") || process.argv.includes("--html");
  await connectMongo(getSharedConfig());

  const report = await composeReport({
    selection, ...range,
    domain: arg("domain"),
    where: args("where"),
    live: !process.argv.includes("--cached"),
    logger: quiet ? null : { info: (m) => console.error(`  ${m}`), warn: () => {} },
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 1));
  } else if (process.argv.includes("--html")) {
    const dir = arg("out", null) && arg("out") !== true
      ? String(arg("out"))
      : path.join(ROOT_DIR, "runtime", "reports");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `report-${report.from}_${report.to}.html`);
    fs.writeFileSync(file, renderHtml(report));
    console.log(file);
  } else if (process.argv.includes("--csv")) {
    const outDir = arg("out") && arg("out") !== true
      ? String(arg("out"))
      : path.join(ROOT_DIR, "runtime", "reports");
    const written = writeCsvs(report, outDir);
    for (const w of written) console.log(`wrote ${w.file}  (${w.rows} row(s))`);
    if (!written.length) console.log("no rows in the ticked calculations");
  } else {
    const text = renderText(report);
    console.log(`${NEWLINE}${text}${NEWLINE}`);
    if (process.argv.includes("--email")) {
      const to = String(arg("to-addr", process.env.REPORT_RECIPIENTS || "mgray@taxadvocategroup.com"));
      const from = getInternalFromEmail();
      const res = await sendMail("TAG", {
        to,
        subject: `Report ${report.from}${report.to !== report.from ? `–${report.to}` : ""} · ${report.selection.join(", ")}`,
        text,
        from: `Parallel Reports <${from}>`,
        replyTo: `Parallel Reports <${from}>`,
        transportDomain: "TAG",
      });
      console.log(`emailed → ${to} (${res?.messageId || "?"})`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error("build-report failed:", e.message); process.exit(1); });
