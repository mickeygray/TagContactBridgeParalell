"use strict";

// One-shot peek at the Logics prospect-export CSV. The file is UTF-16
// LE (no BOM) so we have to decode before handing off to papaparse.
// Reports:
//   - row count
//   - field shape
//   - 3 sample rows including full Notes blob so we can see the
//     structured "mail-info" block we need to lift into MasterProspect

const fs = require("fs");
const os = require("os");
const path = require("path");
const Papa = require("papaparse");

const file = process.argv[2] || path.join(
  process.env.LOGICS_EXPORT_DIR || path.join(os.homedir(), "Downloads"),
  "CaseFilter_Prospects_20260428191635.csv",
);
const buf = fs.readFileSync(path.resolve(file));
// Strip BOM if any, then decode UTF-16 LE → UTF-8 string.
let csvText = buf.toString("utf16le");
if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

const parsed = Papa.parse(csvText, {
  header: true,
  skipEmptyLines: true,
});

const rows = parsed.data;
console.log(JSON.stringify({
  fileSizeMb: Number((buf.length / (1024 * 1024)).toFixed(2)),
  rowCount: rows.length,
  fields: parsed.meta.fields,
  papaErrorsSample: parsed.errors.slice(0, 3),
  sampleRows: rows.slice(0, 3).map((r) => {
    return {
      ...r,
      // Show the full notes verbatim so we can pattern-match the
      // structured block.
      Notes: r.Notes,
    };
  }),
}, null, 2));
