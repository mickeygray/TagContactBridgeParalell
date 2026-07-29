"use strict";

// ON-DEMAND REPORTS — any report, any range, from persisted facts.
//
//   node scripts/report.js --list
//   node scripts/report.js officer-performance --from 2026-07-01 --to 2026-07-31
//   node scripts/report.js source-metrics --from 2026-07-27
//   node scripts/report.js deals --from 2026-07-01 --to 2026-07-31 --officer "Bruce Allen"
//   node scripts/report.js status-movement --from 2026-07-01 --to 2026-07-31 --json
//
// Reports read STORED facts (PaymentTruth / ActivityEvent), never live
// APIs — so a month report is a query, not 30 days of pulls. That also
// means a report can only cover days the nightly pass ran with --apply;
// every report prints its coverage so a thin answer is obvious.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const fs = require("fs");
const path = require("path");
const { ROOT_DIR } = require("../packages/shared-config/src");
const { generateReport, REPORTS } = require("../packages/shared-services/src/reportingService");

// ── CSV ─────────────────────────────────────────────────────────────────
// Clean means: real headers, no thousands separators or $ inside a cell
// (Excel reads those as text), ISO dates, quotes only where needed. A CSV
// is for a spreadsheet, not for reading — formatting belongs in the console
// renderer, never in the data.
const NEWLINE = String.fromCharCode(10);
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  const needsQuote = s.includes(",") || s.includes(String.fromCharCode(34)) || s.includes(NEWLINE);
  return needsQuote ? String.fromCharCode(34) + s.split(String.fromCharCode(34)).join(String.fromCharCode(34, 34)) + String.fromCharCode(34) : s;
}
function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(c.get(r))).join(",")).join(NEWLINE);
  return head + NEWLINE + body + NEWLINE;
}

// One table per report — the thing you would actually paste into a sheet.
const CSV_SHAPES = {
  "officer-performance": (r) => ({
    rows: r.officers,
    columns: [
      { header: "officer", get: (x) => x.officer },
      { header: "deals", get: (x) => x.deals },
      { header: "new_cash", get: (x) => x.initialCash },
      { header: "recurring_cash", get: (x) => x.recurringCash },
      { header: "total_cash", get: (x) => x.totalCash },
      { header: "avg_deal", get: (x) => x.avgDeal },
      { header: "chargebacks", get: (x) => x.chargebacks },
      { header: "chargeback_amount", get: (x) => x.chargebackAmount },
      { header: "cases", get: (x) => x.cases },
    ],
  }),
  "source-metrics": (r) => ({
    rows: r.sources,
    columns: [
      { header: "source", get: (x) => x.source },
      { header: "deals", get: (x) => x.deals },
      { header: "new_cash", get: (x) => x.initialCash },
      { header: "recurring_cash", get: (x) => x.recurringCash },
      { header: "total_cash", get: (x) => x.totalCash },
      { header: "spend", get: (x) => x.spend },
      { header: "responses", get: (x) => x.responses },
      { header: "leads", get: (x) => x.leads },
      { header: "cost_per", get: (x) => x.costPer },
      { header: "net", get: (x) => x.net },
      { header: "roi_pct", get: (x) => x.roi },
    ],
  }),
  deals: (r) => ({
    rows: r.deals,
    columns: [
      { header: "date", get: (x) => x.paymentDateKey },
      { header: "domain", get: (x) => x.domain },
      { header: "case_id", get: (x) => x.caseId },
      { header: "client", get: (x) => x.clientName },
      { header: "amount", get: (x) => x.amount },
      { header: "source", get: (x) => x.sourceAtSale },
      { header: "officer", get: (x) => x.officerAtSale },
      { header: "tag", get: (x) => x.tag?.name },
      { header: "case_payment_id", get: (x) => x.casePaymentId },
    ],
  }),
  cohort: (r) => ({
    rows: r.cohorts,
    columns: [
      { header: "client_since", get: (x) => x.cohort },
      { header: "cases", get: (x) => x.cases },
      { header: "payments", get: (x) => x.payments },
      { header: "new_cash", get: (x) => x.initialCash },
      { header: "recurring_cash", get: (x) => x.recurringCash },
      { header: "total_cash", get: (x) => x.cash },
      { header: "pct_of_revenue", get: (x) => x.pctOfRevenue },
    ],
  }),
  "status-movement": (r) => ({
    rows: [r.counts],
    columns: [
      { header: "dnc", get: (x) => x.dnc },
      { header: "postdate", get: (x) => x.postdate },
      { header: "suspended", get: (x) => x.suspended },
      { header: "converted", get: (x) => x.conversions },
      { header: "other_status", get: (x) => x.otherStatus },
    ],
  }),
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pad = (v, n) => String(v ?? "").padEnd(n);
const rpad = (v, n) => String(v ?? "").padStart(n);

function printCoverage(c) {
  if (!c) return;
  if (c.complete) { console.log(`\ncoverage: all ${c.daysInRange} day(s) have facts.`); return; }
  console.log(`\n⚠ coverage: ${c.daysWithFacts}/${c.daysInRange} day(s) have persisted facts.`);
  if (c.missingDays.length) {
    const show = c.missingDays.slice(0, 10).join(", ");
    console.log(`  missing: ${show}${c.missingDays.length > 10 ? ` … +${c.missingDays.length - 10} more` : ""}`);
    console.log("  (run: node scripts/run-night.js --date <day> --apply)");
  }
}

function render(type, r) {
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  ${type.toUpperCase()}   ${r.from}${r.to !== r.from ? ` → ${r.to}` : ""}   ${r.domain || ""}`);
  console.log(`${"═".repeat(66)}`);

  if (type === "officer-performance") {
    console.log(`\n${pad("OFFICER", 22)}${rpad("DEALS", 6)}${rpad("NEW $", 13)}${rpad("RECURRING $", 14)}${rpad("TOTAL $", 13)}${rpad("AVG DEAL", 11)}`);
    console.log("-".repeat(79));
    for (const o of r.officers) {
      console.log(pad(o.officer, 22) + rpad(o.deals, 6) + rpad(money(o.initialCash), 13)
        + rpad(money(o.recurringCash), 14) + rpad(money(o.totalCash), 13)
        + rpad(o.avgDeal != null ? money(o.avgDeal) : "—", 11)
        + (o.chargebacks ? `   (${o.chargebacks} CB ${money(o.chargebackAmount)})` : ""));
    }
    console.log("-".repeat(79));
    console.log(pad("TOTAL", 22) + rpad(r.totals.deals, 6) + rpad("", 13) + rpad("", 14) + rpad(money(r.totals.cash), 13));
  } else if (type === "source-metrics") {
    console.log(`\n${pad("SOURCE", 34)}${rpad("DEALS", 6)}${rpad("NEW $", 13)}${rpad("RECURRING $", 14)}${rpad("TOTAL $", 13)}`);
    console.log("-".repeat(80));
    for (const s of r.sources) {
      console.log(pad(String(s.source).slice(0, 33), 34) + rpad(s.deals, 6) + rpad(money(s.initialCash), 13)
        + rpad(money(s.recurringCash), 14) + rpad(money(s.totalCash), 13));
    }
  } else if (type === "deals") {
    console.log(`\n${r.totals.count} deal(s) · ${money(r.totals.amount)}\n`);
    for (const d of r.deals) {
      console.log(`  ${d.paymentDateKey}  ${pad(d.domain, 6)}${pad(d.caseId, 9)}${pad(String(d.clientName || "").slice(0, 22), 24)}${rpad(money(d.amount), 12)}`);
      console.log(`      source: ${d.sourceAtSale || "(unsourced)"}   officer: ${d.officerAtSale || "?"}`);
    }
  } else if (type === "cohort") {
    console.log(`
${pad("CLIENT SINCE", 16)}${rpad("CASES", 7)}${rpad("NEW $", 13)}${rpad("RECURRING $", 14)}${rpad("TOTAL $", 13)}${rpad("% OF REV", 10)}`);
    console.log("-".repeat(73));
    for (const c of r.cohorts) {
      console.log(pad(c.cohort, 16) + rpad(c.cases, 7) + rpad(money(c.initialCash), 13)
        + rpad(money(c.recurringCash), 14) + rpad(money(c.cash), 13)
        + rpad(c.pctOfRevenue != null ? `${c.pctOfRevenue}%` : "—", 10));
    }
    console.log("-".repeat(73));
    console.log(pad("TOTAL", 16) + rpad("", 7) + rpad("", 13) + rpad("", 14) + rpad(money(r.totals.cash), 13));
  } else if (type === "status-movement") {
    const c = r.counts;
    console.log(`\n  DNC              ${c.dnc}`);
    console.log(`  Post-dates       ${c.postdate}`);
    console.log(`  Suspended        ${c.suspended}`);
    console.log(`  Converted        ${c.conversions}`);
    console.log(`  Other status     ${c.otherStatus}`);
  }
  if (r.source === "live" && r.gathered) {
    console.log(`
live from Logics · ${r.gathered.activityRows ?? "?"} activity rows · ${r.gathered.casesConfirmed ?? "?"} case(s) confirmed · ${Math.round((r.gathered.durationMs || 0) / 1000)}s`);
    if (r.gathered.unconfirmed) console.log(`  ${r.gathered.unconfirmed} case(s) could not be confirmed`);
    for (const e of r.gathered.errors || []) console.log(`  ⚠ ${e}`);
  } else {
    printCoverage(r.coverage);
  }
  console.log("");
}

async function main() {
  if (process.argv.includes("--list") || process.argv.length < 3) {
    console.log(`\nreports: ${Object.keys(REPORTS).join(", ")}\n`);
    console.log("  node scripts/report.js officer-performance --from 2026-07-01 --to 2026-07-31");
    console.log("  node scripts/report.js source-metrics --from 2026-07-01 --to 2026-07-31");
    console.log("  node scripts/report.js deals --from 2026-07-01 --officer \"Bruce Allen\"");
    console.log("  node scripts/report.js status-movement --from 2026-07-01 --to 2026-07-31\n");
    console.log("  flags: --domain TAG  --source \"...\"  --officer \"...\"  --json\n");
    process.exit(0);
  }
  const type = process.argv[2];
  await connectMongo(getSharedConfig());
  // LIVE by default — the services are authoritative. --cached reads the
  // nightly persistence instead, for instant repeats.
  const live = !process.argv.includes("--cached");
  const quiet = process.argv.includes("--csv") || process.argv.includes("--json");
  const result = await generateReport(type, {
    from: arg("from"), to: arg("to"),
    domain: arg("domain"), source: arg("source"), officer: arg("officer"),
    live,
    logger: quiet ? null : { info: (m) => console.error(`  ${m}`), warn: () => {} },
  });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 1));
  } else if (process.argv.includes("--csv")) {
    const shape = CSV_SHAPES[type];
    if (!shape) throw new Error(`no CSV shape for "${type}"`);
    const { rows, columns } = shape(result);
    const csv = toCsv(rows || [], columns);
    const out = arg("out");
    if (out === true || out == null) {
      process.stdout.write(csv);
    } else {
      const file = String(out).endsWith(".csv") ? String(out)
        : path.join(ROOT_DIR, "runtime", "reports", `${type}-${result.from}_${result.to}.csv`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, csv);
      console.log(`wrote ${file}  (${(rows || []).length} row(s))`);
    }
    if (!result.coverage?.complete) {
      console.error(`⚠ coverage: ${result.coverage.daysWithFacts}/${result.coverage.daysInRange} day(s) have facts`);
    }
  } else {
    render(type, result);
  }
  process.exit(0);
}

main().catch((e) => { console.error("report failed:", e.message); process.exit(1); });
