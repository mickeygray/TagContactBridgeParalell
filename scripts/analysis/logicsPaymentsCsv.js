"use strict";
// Parse a Logics payments CSV. They arrive UTF-16LE with embedded newlines
// inside the quoted Comment column, so a line-split parser mangles them.
const fs = require("fs");

function readText(p) {
  const buf = fs.readFileSync(p);
  // UTF-16LE if every other byte is 0 in the head.
  const utf16 = buf.length > 4 && buf[1] === 0 && buf[3] === 0;
  return utf16 ? buf.toString("utf16le") : buf.toString("utf8");
}

/** RFC4180-ish: handles quoted fields containing commas and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim()));
}

function toObjects(rows) {
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? "").trim(); });
    return o;
  });
}

module.exports = { readText, parseCsv, toObjects };

if (require.main === module) {
  for (const p of process.argv.slice(2)) {
    const rows = parseCsv(readText(p));
    const objs = toObjects(rows);
    console.log("\n=== " + p.split(/[\\/]/).pop() + " ===");
    console.log("  columns: " + rows[0].map((h) => h.trim()).filter(Boolean).join(" | "));
    console.log("  data rows: " + objs.length);
    const real = objs.filter((o) => o["Case ID"] && /^\d+$/.test(o["Case ID"]));
    console.log("  rows with a numeric Case ID: " + real.length);
    let total = 0;
    for (const o of real) total += Number(String(o.Amount).replace(/[$,]/g, "")) || 0;
    console.log("  sum of Amount: $" + total.toFixed(2));
    const ids = real.map((o) => Number(o["Case ID"]));
    console.log("  case id range: " + Math.min(...ids) + " .. " + Math.max(...ids));
    const officers = {};
    for (const o of real) {
      const k = o["Settlement Officer"] || "(none)";
      officers[k] = officers[k] || { n: 0, amt: 0 };
      officers[k].n += 1;
      officers[k].amt += Number(String(o.Amount).replace(/[$,]/g, "")) || 0;
    }
    for (const [k, v] of Object.entries(officers).sort((a, b) => b[1].amt - a[1].amt)) {
      console.log("    " + k.padEnd(18) + String(v.n).padStart(3) + "  $" + v.amt.toFixed(2).padStart(10));
    }
    const srcs = {};
    for (const o of real) srcs[o["Source Name"] || "(none)"] = (srcs[o["Source Name"] || "(none)"] || 0) + 1;
    console.log("  sources: " + Object.entries(srcs).map(([k, v]) => k + "=" + v).join("  "));
  }
}
