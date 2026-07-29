"use strict";

// Render the harvested term map into the reference dictionary's §4.
//
// Kept as a script rather than hand-written markdown so the dictionary can be
// regenerated when the vocabulary drifts — the log is prose, and prose moves.
//
//   node scripts/build-terms-doc.js
//
// Reads  runtime/vocab/terms-harvest.json
// Writes .claude/skills/generate-report/reference/activity-report-terms.md (§4)

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HARVEST = path.join(ROOT, "runtime", "vocab", "terms-harvest.json");
const DOC = path.join(ROOT, ".claude", "skills", "generate-report", "reference", "activity-report-terms.md");
const NEWLINE = String.fromCharCode(10);

const FAMILY_ORDER = ["intake", "status", "money", "credit", "comms", "casework", "staff", "system"];
const FAMILY_TITLE = {
  intake: "Intake, source and attribution",
  status: "Status and lifecycle",
  money: "Money and billing",
  credit: "Credit and underwriting (the soft pull)",
  comms: "Communications",
  casework: "Casework and documents",
  staff: "People and assignment",
  system: "System, automation and field mechanics",
};

const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\r?\n+/g, " ").trim();
const clip = (s, n) => { const t = esc(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function main() {
  if (!fs.existsSync(HARVEST)) {
    console.error(`no harvest at ${HARVEST}`);
    process.exit(1);
  }
  const families = JSON.parse(fs.readFileSync(HARVEST, "utf8"));
  const byFamily = new Map();
  for (const f of families) {
    for (const t of f.terms || []) {
      const key = t.family || "other";
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(t);
    }
  }

  const total = [...byFamily.values()].reduce((a, v) => a + v.length, 0);
  const L = [];
  L.push("## 4. Term families");
  L.push("");
  L.push(`${total} terms, mapped from the July 2026 pull and grouped by family.`);
  L.push("");
  L.push("**Confidence is the analyst's own and is not uniform.** `observed` means the");
  L.push("meaning is evident in the data or defined in repo code; `inferred` is a reasonable");
  L.push("reading with nothing confirming it; `uncertain` means genuinely unknown. Treat");
  L.push("anything below `observed` as a lead, not a fact — and check a number before you");
  L.push("put it in front of anyone.");
  L.push("");
  L.push("Regenerate with `node scripts/build-terms-doc.js`.");
  L.push("");

  for (const fam of [...FAMILY_ORDER, ...[...byFamily.keys()].filter((k) => !FAMILY_ORDER.includes(k))]) {
    const terms = byFamily.get(fam);
    if (!terms || !terms.length) continue;
    // Highest-volume first: what you are most likely to meet, you meet first.
    terms.sort((a, b) => (Number(b.julyCount) || 0) - (Number(a.julyCount) || 0));

    L.push(`### ${FAMILY_TITLE[fam] || fam}`);
    L.push("");
    L.push("| Term | July | Means | Watch out |");
    L.push("|---|---:|---|---|");
    for (const t of terms) {
      const n = Number(t.julyCount) || 0;
      const mark = t.confidence === "observed" ? "" : ` _(${t.confidence})_`;
      L.push(`| **${clip(t.term, 46)}**${mark} | ${n ? n.toLocaleString("en-US") : "—"} `
        + `| ${clip(t.meaning, 190)} | ${clip(t.gotchas, 170) || "—"} |`);
    }
    L.push("");
  }

  const doc = fs.readFileSync(DOC, "utf8");
  const startIdx = doc.indexOf("## 4. Term families");
  const endIdx = doc.indexOf("## 5. Combinations you can read");
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    console.error("could not locate the §4 slot in the reference doc");
    process.exit(1);
  }
  const next = doc.slice(0, startIdx) + L.join(NEWLINE) + NEWLINE + "---" + NEWLINE + NEWLINE + doc.slice(endIdx);
  fs.writeFileSync(DOC, next);
  console.log(`wrote §4 — ${total} terms across ${byFamily.size} families`);
  for (const fam of byFamily.keys()) console.log(`  ${String(byFamily.get(fam).length).padStart(4)}  ${fam}`);
}

main();
