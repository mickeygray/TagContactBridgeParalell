"use strict";

// Minimal .xlsx sheet reader — enough to turn one worksheet into rows of
// strings. No dependency, because adding one to a live monorepo for a one-off
// analysis is a poor trade.
//
// Handles the two string forms Excel emits: inline strings (<is><t>) and shared
// strings (<v> indexing sharedStrings.xml). Numbers come through as <v> with no
// t="s" attribute.

const fs = require("fs");
const path = require("path");

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, "&");

/** All <t> text inside a fragment, concatenated (rich text splits into runs). */
function textOf(fragment) {
  const parts = [...String(fragment).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]);
  return unescapeXml(parts.join(""));
}

function loadSharedStrings(dir) {
  const p = path.join(dir, "xl", "sharedStrings.xml");
  if (!fs.existsSync(p)) return [];
  const xml = fs.readFileSync(p, "utf8");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

const colIndex = (ref) => {
  const letters = String(ref).replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/**
 * @param {string} dir       extracted xlsx root
 * @param {string} sheetFile e.g. "sheet2.xml"
 * @returns {string[][]} rows of cell strings
 */
function readSheet(dir, sheetFile) {
  const shared = loadSharedStrings(dir);
  const xml = fs.readFileSync(path.join(dir, "xl", "worksheets", sheetFile), "utf8");
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = c[1];
      const body = c[2];
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let value;
      if (type === "inlineStr") value = textOf(body);
      else if (type === "s") {
        const idx = Number((body.match(/<v>(\d+)<\/v>/) || [])[1]);
        value = shared[idx] ?? "";
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = v == null ? "" : unescapeXml(v);
      }
      const i = ref ? colIndex(ref) : cells.length;
      cells[i] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

module.exports = { readSheet };

if (require.main === module) {
  const [dir, sheet] = process.argv.slice(2);
  const rows = readSheet(dir, sheet || "sheet1.xml");
  console.log(`rows: ${rows.length}`);
  for (const r of rows.slice(0, 12)) console.log("  " + r.map((c) => String(c).slice(0, 22)).join(" | "));
}
