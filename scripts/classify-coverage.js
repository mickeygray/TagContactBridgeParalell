"use strict";

// CLASSIFIER COVERAGE — does the parser actually understand the log?
//
// The ActivityReport is prose. Staff type into it, so the same concept arrives
// spelled several ways and a regex written against one spelling silently
// misses the rest. A miss here is invisible: the row still parses, it just
// lands in the "note" bucket, and whatever counted on it reports a confident
// smaller number.
//
// This measures that. Run it against a real range and it tells you, per kind,
// how many rows were recognised and — the part that matters — shows you the
// highest-frequency subjects that fell through to `note` / `unclassified`.
//
//   node scripts/classify-coverage.js                      (uses runtime/vocab)
//   node scripts/classify-coverage.js --probe "soft ?pull" (why did THESE miss?)
//   node scripts/classify-coverage.js --kind credit-score  (what did it catch?)
//
// Read-only. Refresh the material first with:
//   node scripts/activity-vocab.js --from X --to Y

const fs = require("fs");
const path = require("path");
const { classifyRow } = require("../packages/shared-services/src/activityEventService");

const TSV = path.join(__dirname, "..", "runtime", "vocab", "activity-rows.tsv");
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};

function load() {
  if (!fs.existsSync(TSV)) {
    console.error(`no material at ${TSV}`);
    console.error("run: node scripts/activity-vocab.js --from 2026-07-01 --to 2026-07-28");
    process.exit(1);
  }
  return fs.readFileSync(TSV, "utf8").split(NEWLINE).slice(1)
    .map((l) => l.split(TAB))
    .filter((c) => c.length >= 6)
    .map((c) => ({
      __domain: c[0], CaseID: c[1], Type: c[2],
      Created: c[3], CreatedBy: c[4], ActivitySubject: c[5],
    }));
}

/** Mask digits so near-identical subjects collapse into one line. */
const shape = (s) => String(s).replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 88);

function main() {
  const rows = load();
  const probe = arg("probe");
  const onlyKind = arg("kind");

  const byKind = new Map();
  const missedShapes = new Map();
  const probeHits = [];

  for (const r of rows) {
    const { kind, payload } = classifyRow(r);
    if (!byKind.has(kind)) byKind.set(kind, { n: 0, withPayload: 0, examples: new Set() });
    const k = byKind.get(kind);
    k.n += 1;
    if (payload && Object.keys(payload).length) k.withPayload += 1;
    if (k.examples.size < 5) k.examples.add(String(r.ActivitySubject).slice(0, 100));

    // Anything landing in the catch-all buckets is un-modelled prose.
    if (kind === "note" || kind === "unclassified") {
      const s = shape(r.ActivitySubject);
      if (!missedShapes.has(s)) missedShapes.set(s, { n: 0, example: String(r.ActivitySubject).slice(0, 110) });
      missedShapes.get(s).n += 1;
    }

    if (probe && new RegExp(probe, "i").test(r.ActivitySubject)) {
      probeHits.push({ kind, payload, subject: String(r.ActivitySubject).slice(0, 100) });
    }
  }

  if (onlyKind) {
    const k = byKind.get(onlyKind);
    if (!k) { console.error(`no rows classified as "${onlyKind}"`); process.exit(1); }
    console.log(`${NEWLINE}${onlyKind} — ${k.n} row(s), ${k.withPayload} with a parsed payload${NEWLINE}`);
    for (const e of k.examples) console.log(`  ${e}`);
    return;
  }

  if (probe) {
    console.log(`${NEWLINE}ROWS MATCHING /${probe}/i — ${probeHits.length} found${NEWLINE}`);
    const byK = new Map();
    for (const h of probeHits) {
      if (!byK.has(h.kind)) byK.set(h.kind, { n: 0, noPayload: 0, examples: [] });
      const b = byK.get(h.kind);
      b.n += 1;
      if (!h.payload || !Object.keys(h.payload).length) {
        b.noPayload += 1;
        if (b.examples.length < 6) b.examples.push(h.subject);
      }
    }
    for (const [kind, b] of [...byK.entries()].sort((a, b2) => b2[1].n - a[1].n)) {
      console.log(`  ${String(b.n).padStart(5)}  ${kind}${b.noPayload ? `   (${b.noPayload} with NO payload extracted)` : ""}`);
      for (const e of b.examples) console.log(`           ${e}`);
    }
    // The headline: matched the concept but the parser did not recognise it.
    const stray = probeHits.filter((h) => h.kind === "note" || h.kind === "unclassified").length;
    const noPay = probeHits.filter((h) => !h.payload || !Object.keys(h.payload).length).length;
    console.log(`${NEWLINE}  ${stray} of ${probeHits.length} fell through to note/unclassified`);
    console.log(`  ${noPay} of ${probeHits.length} produced no payload — the value in the text was not extracted`);
    return;
  }

  console.log(`${NEWLINE}CLASSIFIER COVERAGE — ${rows.length} rows${NEWLINE}`);
  console.log("  kind".padEnd(22) + "rows".padStart(8) + "payload".padStart(10) + "  share");
  console.log("  " + "-".repeat(46));
  for (const [kind, k] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log("  " + kind.padEnd(20) + String(k.n).padStart(8)
      + String(k.withPayload).padStart(10)
      + ("  " + (k.n / rows.length * 100).toFixed(1) + "%").padStart(9));
  }

  const missed = [...missedShapes.entries()].sort((a, b) => b[1].n - a[1].n);
  const missedRows = missed.reduce((a, [, v]) => a + v.n, 0);
  console.log(`${NEWLINE}UN-MODELLED PROSE — ${missedRows} row(s) in ${missed.length} shapes`);
  console.log("  (these parse, but as an untyped note — anything counting on them undercounts)");
  console.log("");
  for (const [s, v] of missed.slice(0, 25)) {
    console.log("  " + String(v.n).padStart(5) + "  " + s);
  }
  if (missed.length > 25) console.log(`  … and ${missed.length - 25} more shapes`);
  console.log(`${NEWLINE}  probe one: node scripts/classify-coverage.js --probe "soft ?pull"${NEWLINE}`);
}

main();
