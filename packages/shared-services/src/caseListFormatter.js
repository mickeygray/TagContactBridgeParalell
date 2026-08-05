"use strict";

// COMPACT CASE LISTS FOR THE EMAIL.
//
// Mickey 2026-08-05: "we need to find out how to make the email not a bulky
// ridiculous thing, especially with those lists of cases — so maybe instead of
// one row per thing it's a list sorted by database:
//
//     redlines:
//     tag:  1234, 5678, etc
//     wynn: 3456, 7810 etc
//
// so instead of a thing that's 50 lines long you can fit maybe 10 keys per row
// and save a little space on the page."
//
// This matters more the longer the range. One day's redlines is a short list; a
// month's is hundreds, and one row per case turns a readable board into a wall.
// Grouping by database and wrapping at N per line turns 50 lines into 5.
//
// ── WHAT THIS WILL NOT DO ───────────────────────────────────────────────────
//
// It will not silently truncate. A capped list says exactly how many it did not
// print, because a board that quietly shows the first 40 of 300 redlines is
// worse than one that shows none — it reads as the whole answer. If a cap is
// applied, the overflow is stated in the same breath.

const DEFAULT_PER_LINE = 10;

/** Domain display order: the tenants we actually report, then anything else. */
const DOMAIN_ORDER = ["TAG", "WYNN", "AMITY"];

const domainRank = (d) => {
  const i = DOMAIN_ORDER.indexOf(String(d || "").toUpperCase());
  return i === -1 ? DOMAIN_ORDER.length : i;
};

/**
 * Group rows into `{DOMAIN: [id, id, ...]}`, sorted and de-duplicated.
 *
 * De-duplication is deliberate: the same case can appear twice in a range (two
 * status flips on different days), and printing it twice implies two cases.
 */
function groupCaseIds(rows = [], { domainKey = "domain", idKey = "caseId" } = {}) {
  const byDomain = new Map();
  for (const row of rows) {
    if (!row) continue;
    const domain = String(row[domainKey] || "").toUpperCase() || "UNKNOWN";
    const id = row[idKey];
    if (id == null || id === "") continue;
    if (!byDomain.has(domain)) byDomain.set(domain, new Set());
    byDomain.get(domain).add(String(id));
  }
  const out = {};
  const domains = [...byDomain.keys()].sort((a, b) => domainRank(a) - domainRank(b) || a.localeCompare(b));
  for (const d of domains) {
    // Numeric sort where the ids are numeric — 1000 after 999, not before it.
    out[d] = [...byDomain.get(d)].sort((a, b) => {
      const na = Number(a); const nb = Number(b);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a).localeCompare(String(b));
    });
  }
  return out;
}

/**
 * Render a grouped case list as compact lines.
 *
 * @param {Array}  rows
 * @param {string} label       e.g. "Redlines"
 * @param {number} perLine     ids per line (default 10)
 * @param {number} maxPerDomain cap per database; 0 = no cap
 * @returns {string[]} lines, empty when there is nothing to show
 */
function formatCaseList(rows = [], {
  label = "",
  perLine = DEFAULT_PER_LINE,
  maxPerDomain = 0,
  domainKey = "domain",
  idKey = "caseId",
} = {}) {
  const grouped = groupCaseIds(rows, { domainKey, idKey });
  const domains = Object.keys(grouped);
  if (!domains.length) return [];

  const total = domains.reduce((n, d) => n + grouped[d].length, 0);
  const lines = [];
  if (label) lines.push(`${label} (${total})`);

  // Pad the domain labels so the id columns line up across databases — the
  // whole point is scanning it quickly.
  const width = Math.max(...domains.map((d) => d.length)) + 1;

  for (const domain of domains) {
    const all = grouped[domain];
    const shown = maxPerDomain > 0 ? all.slice(0, maxPerDomain) : all;
    const dropped = all.length - shown.length;

    for (let i = 0; i < shown.length; i += perLine) {
      const chunk = shown.slice(i, i + perLine).join(", ");
      // The database name labels the FIRST line only; continuations indent to
      // the same column so the block reads as one list, not several.
      const head = i === 0 ? `${domain.toLowerCase()}:`.padEnd(width + 1) : " ".repeat(width + 1);
      lines.push(`  ${head}${chunk}`);
    }
    if (dropped > 0) {
      // Never silent. A board showing the first 40 of 300 that does not say so
      // reads as the whole answer.
      lines.push(`  ${" ".repeat(width + 1)}… and ${dropped} more not shown`);
    }
  }
  return lines;
}

/** One-line variant for a small set: "tag: 1, 2 · wynn: 7". */
function formatCaseListInline(rows = [], { domainKey = "domain", idKey = "caseId" } = {}) {
  const grouped = groupCaseIds(rows, { domainKey, idKey });
  const parts = Object.entries(grouped).map(([d, ids]) => `${d.toLowerCase()}: ${ids.join(", ")}`);
  return parts.join("  ·  ");
}

module.exports = {
  groupCaseIds,
  formatCaseList,
  formatCaseListInline,
  DEFAULT_PER_LINE,
};
