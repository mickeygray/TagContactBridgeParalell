"use strict";

const fs = require("fs");
const path = require("path");
const { resolveExportStatus } = require("../packages/shared-config/src/statusMap");

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseSimpleCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf16le").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] || "";
    });
    return row;
  });
}

function analyzeFile(domain, filePath) {
  const rows = parseSimpleCsv(filePath);
  const unmatched = new Map();
  const matched = new Map();

  for (const row of rows) {
    const rawStatus = row.Status || row.status || "";
    const resolved = resolveExportStatus(domain, rawStatus);
    if (resolved) {
      const key = `${resolved.statusId}:${resolved.label}`;
      matched.set(key, (matched.get(key) || 0) + 1);
    } else {
      unmatched.set(rawStatus, (unmatched.get(rawStatus) || 0) + 1);
    }
  }

  return {
    domain,
    file: path.basename(filePath),
    rows: rows.length,
    matchedRows: rows.length - [...unmatched.values()].reduce((sum, count) => sum + count, 0),
    unmatchedRows: [...unmatched.values()].reduce((sum, count) => sum + count, 0),
    unmatchedStatuses: [...unmatched.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([status, count]) => ({ status, count })),
    matchedBuckets: [...matched.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([bucket, count]) => ({ bucket, count })),
  };
}

function main() {
  const inputs = [
    {
      domain: "TAG",
      filePath: "C:\\Users\\Admin\\Downloads\\CaseFilter_All_20260417101725.csv",
    },
    {
      domain: "WYNN",
      filePath: "C:\\Users\\Admin\\Downloads\\CaseFilter_All_20260417102000.csv",
    },
  ];

  const results = inputs.map((input) => analyzeFile(input.domain, input.filePath));
  console.log(JSON.stringify(results, null, 2));
}

if (require.main === module) {
  main();
}
