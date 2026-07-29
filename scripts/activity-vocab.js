"use strict";
// READ-ONLY. Pull a real range of raw ActivityReport rows and enumerate the
// vocabulary: every field, fill rate, and full frequency for categoricals.
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { pullDomainRows } = require("../packages/shared-services/src/liveGatherService");
const { createLogicsClient } = require("../packages/shared-integrations/src/logicsClient");

const OUT = process.env.VOCAB_OUT || require("path").join(__dirname, "..", "runtime", "vocab");
require("fs").mkdirSync(OUT, { recursive: true });
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};

(async () => {
  const from = arg("from", "2026-07-01");
  const to = arg("to", "2026-07-28");
  const domains = String(arg("domains", "TAG,WYNN,AMITY")).split(",");
  await connectMongo(getSharedConfig());

  const all = [];
  for (const domain of domains) {
    const client = createLogicsClient(domain);
    const { rows, windows, cappedWindows } = await pullDomainRows({
      client, domain, from, to, logger: { info: (m) => console.error("  " + m) },
    });
    console.error(`[${domain}] ${rows.length} rows · ${windows} window(s) · ${cappedWindows} capped`);
    for (const r of rows) all.push({ __domain: domain, ...r });
  }
  console.error(`TOTAL ${all.length} raw rows ${from}..${to}`);

  fs.writeFileSync(path.join(OUT, "activity-raw-sample.json"), JSON.stringify(all.slice(0, 300), null, 1));

  // Every row, one per line, as TSV. This is what makes an odd question
  // ("how many soft pulls came back frozen?") a grep instead of another pull —
  // and the ActivityReport is prose, so grep is the honest instrument.
  const TAB = String.fromCharCode(9);
  const LF = String.fromCharCode(10);
  // Built from char codes: a regex literal cannot span lines, and escape
  // sequences do not survive every layer that writes this file.
  const WS = new RegExp("[" + TAB + LF + String.fromCharCode(13) + "]+", "g");
  const flat = (v) => String(v === null || v === undefined ? "" : v).replace(WS, " ").trim();
  const tsv = [["domain", "caseId", "type", "created", "createdBy", "subject"].join(TAB)];
  for (const r of all) {
    tsv.push([
      flat(r.__domain), flat(r.CaseID), flat(r.Type),
      flat(r.Created), flat(r.CreatedBy), flat(r.ActivitySubject),
    ].join(TAB));
  }
  fs.writeFileSync(path.join(OUT, "activity-rows.tsv"), tsv.join(LF));

  const fields = new Map();
  for (const r of all) {
    for (const [k, v] of Object.entries(r || {})) {
      if (!fields.has(k)) fields.set(k, { nonEmpty: 0, samples: new Set(), distinct: new Set() });
      const f = fields.get(k);
      const s = v === null || v === undefined ? "" : String(v);
      if (s !== "") {
        f.nonEmpty += 1;
        if (f.samples.size < 8) f.samples.add(s.slice(0, 160));
        if (f.distinct.size < 6000) f.distinct.add(s.slice(0, 200));
      }
    }
  }
  const census = [...fields.entries()].map(([k, f]) => ({
    field: k, nonEmpty: f.nonEmpty,
    fillRate: `${Math.round((f.nonEmpty / all.length) * 100)}%`,
    distinctCount: f.distinct.size, samples: [...f.samples],
  })).sort((a, b) => b.nonEmpty - a.nonEmpty);
  fs.writeFileSync(path.join(OUT, "activity-field-census.json"), JSON.stringify(census, null, 1));

  const cats = {};
  for (const [k, f] of fields.entries()) {
    if (f.distinct.size > 0 && f.distinct.size <= 600) {
      const freq = new Map();
      for (const r of all) {
        const s = r?.[k] === null || r?.[k] === undefined ? "" : String(r[k]);
        if (s === "") continue;
        freq.set(s, (freq.get(s) || 0) + 1);
      }
      cats[k] = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, n }));
    }
  }
  fs.writeFileSync(path.join(OUT, "activity-categoricals.json"), JSON.stringify(cats, null, 1));

  // ActivitySubject is the payload-bearing field: cluster by leading token
  const subjKey = ["ActivitySubject", "Subject", "Activity"].find((k) => fields.has(k));
  if (subjKey) {
    const shapes = new Map();
    for (const r of all) {
      const s = String(r[subjKey] || "");
      if (!s) continue;
      const shape = s
        .replace(/\d+/g, "#")
        .replace(/\s+/g, " ")
        .slice(0, 90);
      if (!shapes.has(shape)) shapes.set(shape, { n: 0, examples: new Set() });
      const e = shapes.get(shape);
      e.n += 1;
      if (e.examples.size < 3) e.examples.add(s.slice(0, 200));
    }
    const out = [...shapes.entries()]
      .map(([shape, v]) => ({ shape, n: v.n, examples: [...v.examples] }))
      .sort((a, b) => b.n - a.n);
    fs.writeFileSync(path.join(OUT, "activity-subject-shapes.json"), JSON.stringify(out, null, 1));
    console.error(`\n${out.length} distinct ${subjKey} shapes; top 40:`);
    for (const s of out.slice(0, 40)) console.error(`  ${String(s.n).padStart(6)}  ${s.shape}`);
  }

  console.error("\nFIELDS:");
  for (const c of census) console.error(`  ${c.field.padEnd(30)} ${c.fillRate.padStart(5)}  ${String(c.distinctCount).padStart(5)} distinct`);
  console.error("\nCATEGORICALS:", Object.keys(cats).join(", "));
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
