"use strict";

// ASK — the substrate x factor x function matrix, executable.
//
// Mickey 2026-07-29: "make some skills and a pool of node processes or tools
// ... that predefine the work to be done. so i can do like /generate-report
// and then describe what i want."
//
// This is the tool the skill drives. Every ad-hoc question that is really
// "these numbers, cut this way, with these ratios" answers here — no bespoke
// script, no new block, no invented arithmetic. If a question CANNOT be
// expressed in these parts, that is the signal to say so rather than
// improvise a number.
//
//   node scripts/ask.js --by source --measure deals,newCash --fn roas,roi --month
//   node scripts/ask.js --by officer --measure deals,cash --where source=LD --from 2026-07-01 --to 2026-07-28
//   node scripts/ask.js --by day --measure cash --fn profitMargin --month --csv
//   node scripts/ask.js --what                      (what can I ask for?)
//
// Read-only. It composes and prints; it never writes and never sends.

require("dotenv").config();

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { gatherMaterial, parseFilters, filterPayments } = require("../packages/shared-services/src/reportComposerService");
const ops = require("../packages/shared-services/src/reportOpsService");

const NEWLINE = String.fromCharCode(10);
const QUOTE = String.fromCharCode(34);

const has = (f) => process.argv.includes(`--${f}`);
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
function list(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    if (v && !v.startsWith("--")) out.push(...String(v).split(",").map((x) => x.trim()).filter(Boolean));
  }
  return out;
}

const pacificToday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const shift = (k, d) => new Date(Date.parse(`${k}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);

function resolveRange() {
  const today = pacificToday();
  if (has("today")) return { from: today, to: today };
  if (has("yesterday")) return { from: shift(today, -1), to: shift(today, -1) };
  if (has("week")) return { from: shift(today, -7), to: today };
  if (has("month")) return { from: `${today.slice(0, 7)}-01`, to: today };
  const from = arg("from");
  const to = arg("to");
  if (from && to) return { from: String(from), to: String(to) };
  return { from: shift(today, -7), to: today };
}

function printCatalogue() {
  console.log(`${NEWLINE}WHAT YOU CAN ASK FOR${NEWLINE}`);
  console.log("  --by        (factor: how to cut it)");
  for (const [material, dims] of Object.entries(ops.DIMENSIONS)) {
    console.log(`      ${material.padEnd(10)} ${dims.join(" · ")}`);
  }
  console.log(`${NEWLINE}  --measure   (substrate: what to add up)`);
  console.log(`      ${ops.MEASURES.join(" · ")}`);
  console.log(`${NEWLINE}  --fn        (function: what to work out)`);
  for (const [key, f] of Object.entries(ops.FUNCTIONS)) {
    console.log(`      ${key.padEnd(20)} ${f.hint}`);
  }
  console.log(`${NEWLINE}  --where     cohort · source · officer · domain · extension · minutes · outcome`);
  console.log(`  --from/--to · --today · --yesterday · --week · --month`);
  console.log(`  --csv       machine-readable instead of a table${NEWLINE}`);
}

/** Substrates a function needs, assembled from the bucket and the spend join. */
function substratesFor(bucket, measured, spendByKey) {
  const spend = Number(spendByKey?.[bucket.key]?.spend) || 0;
  return {
    cost: spend,
    initial: measured.newCash ?? 0,
    total: measured.cash ?? 0,
    deals: measured.deals ?? 0,
    calls: measured.responses ?? undefined,
    leads: spendByKey?.[bucket.key]?.leads ?? undefined,
  };
}

async function main() {
  if (has("what") || has("help")) return printCatalogue();

  const by = String(arg("by", "source"));
  const measures = list("measure").length ? list("measure") : ["deals", "newCash", "cash"];
  const fns = list("fn");
  const where = list("where");
  const range = resolveRange();

  // Fail LOUDLY on anything unrecognised. A silently-ignored factor or
  // function produces a table that looks like an answer to a different
  // question than the one asked.
  const validDims = new Set(Object.values(ops.DIMENSIONS).flat());
  if (!validDims.has(by)) {
    console.error(`unknown factor "${by}" — try: ${[...validDims].join(", ")}`);
    process.exitCode = 1;
    return;
  }
  for (const m of measures) {
    if (!ops.MEASURES.includes(m)) {
      console.error(`unknown measure "${m}" — try: ${ops.MEASURES.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }
  for (const f of fns) {
    if (!ops.FUNCTIONS[f]) {
      console.error(`unknown function "${f}" — try: ${Object.keys(ops.FUNCTIONS).join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  await connectMongo(getSharedConfig());

  const needs = ["payments", "caseContacts"];
  // Attribution needs the call pool. Without it the aged rule has no call
  // evidence to weigh and a live piece quietly loses deals to Aged — the
  // ask and the report then answer the same question differently.
  if (by === "source") needs.push("callsRange");
  if (fns.length || measures.includes("spend")) needs.push("spend");
  if (by === "agent" || by === "stream") needs.push("queue");

  const material = await gatherMaterial({
    ...range, needs, live: !has("cached"),
    logger: has("csv") ? null : { info: (m) => console.error(`  ${m}`) },
  });

  const { filters, unknown } = parseFilters(where);
  if (unknown.length) console.error(`ignored filter(s): ${unknown.join(", ")}`);
  let rows = (material.payments || []).filter((p) => !p.isChargeback);
  if (filters.length) rows = filterPayments(rows, filters);

  // The source view has rules that raw grouping does not know: alias
  // folding, catch-all buckets and the aged rule. Run raw, one mail piece
  // splits across every spelling it has ever had. Same resolver the report
  // block uses, so the ad-hoc answer and the report cannot disagree.
  if (by === "source") {
    const attributionDateFor = ops.attributionDateResolver(material.callsRange || []);
    rows = rows.map((p2) => ({
      ...p2,
      sourceAtSale: ops.resolveSourceRow(p2, {
        rangeStart: range.from,
        rangeEnd: range.to,
        attributionCallDate: attributionDateFor(p2),
      }),
      sourceOrigin: "resolved",
    }));
  }
  const buckets = ops.groupBy(rows, by);
  // Spend arrives under its own spelling of the piece. Fold it onto the row
  // the money landed on, or the cost sits on one row and the deals on
  // another and every ratio reads "—" next to an infinite return.
  const spendByKey = {};
  for (const [src, v] of Object.entries(material.spendBySource || {})) {
    const k = by === "source" ? ops.foldSourceKey(src) : src;
    if (!spendByKey[k]) spendByKey[k] = { spend: 0, leads: 0 };
    spendByKey[k].spend += Number(v.spend) || 0;
    spendByKey[k].leads += Number(v.leads) || 0;
  }

  // A source that COST money and produced nothing is the row a marketing
  // report exists to surface. Grouping payments can never produce it —
  // there are no payments to group — so it has to be seeded from spend, or
  // the worst performer silently disappears from its own report.
  if (by === "source") {
    const present = new Set(buckets.map((b) => b.key));
    for (const key of Object.keys(spendByKey)) {
      if (!present.has(key)) buckets.push({ key, rows: [] });
    }
  }

  const out = buckets.map((b) => {
    const measured = ops.measure(b, measures);
    const computed = fns.length
      ? ops.applyFunctions(substratesFor(b, measured, spendByKey), fns)
      : {};
    return {
      key: b.key,
      ...measured,
      spend: Number(spendByKey[b.key]?.spend) || 0,
      ...computed,
    };
  }).sort((a, b) => (b[measures[0]] || 0) - (a[measures[0]] || 0));

  const cols = ["key", ...measures, ...(fns.length ? ["spend", ...fns] : [])];

  if (has("csv")) {
    const esc = (v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? QUOTE + s.replace(/"/g, '""') + QUOTE : s;
    };
    console.log(cols.join(","));
    for (const r of out) console.log(cols.map((c) => esc(r[c])).join(","));
    return;
  }

  const money = (n) => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const MONEYISH = /cash|spend|amount|margin/i;
  const fmt = (col, v) => {
    if (v === null || v === undefined) return "—";
    if (ops.FUNCTIONS[col]) return ops.formatFunction(col, v);
    if (typeof v === "number") return MONEYISH.test(col) ? money(v) : String(v);
    return String(v);
  };
  const width = (c) => Math.max(c.length, ...out.map((r) => fmt(c, r[c]).length)) + 2;
  const widths = Object.fromEntries(cols.map((c) => [c, width(c)]));

  console.log(`${NEWLINE}${by.toUpperCase()} · ${range.from}${range.to !== range.from ? ` → ${range.to}` : ""}`
    + `${filters.length ? `  (${filters.map((f) => `${f.key}${f.op}${f.value}`).join(" · ")})` : ""}${NEWLINE}`);
  console.log(cols.map((c) => (c === "key" ? c.padEnd(widths[c]) : c.padStart(widths[c]))).join(""));
  console.log("-".repeat(cols.reduce((a, c) => a + widths[c], 0)));
  for (const r of out) {
    console.log(cols.map((c) => (c === "key"
      ? String(r[c]).slice(0, widths[c] - 2).padEnd(widths[c])
      : fmt(c, r[c]).padStart(widths[c]))).join(""));
  }

  // Terms, because a number without its boundary is an argument waiting to
  // happen. Same rule the blocks follow.
  console.log(`${NEWLINE}TERMS  Money RECEIVED inside the range, SUCCESS only, chargebacks excluded.`);
  if (fns.length) {
    console.log(`       Spend is what was booked in the range, joined by ${by === "source" ? "source" : "source and shown whole"}.`);
    for (const f of fns) console.log(`       ${ops.FUNCTIONS[f].label} — ${ops.FUNCTIONS[f].hint}`);
  }
  if (by !== "source" && fns.length) {
    console.log(`       NOTE: cut by ${by}, but spend is only known per SOURCE — ratios here use whole-source spend.`);
  }
  console.log(`${NEWLINE}${out.length} row(s) · ${material.gathered?.activityRows || 0} activity rows`);
}

main()
  // Honour an exitCode the validation already set. Forcing 0 here would let a
  // typo'd function exit "successfully" with no table at all — a caller that
  // checks the status code would read that as a report with nothing in it.
  .then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error("ask failed:", e.stack || e.message); process.exit(1); });
