import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const ENRICHED_CSV = "C:/Users/Admin/Downloads/cnam-list_20260506-223742_ringcentral-enriched.csv";
const OUTPUT_XLSX = "C:/Users/Admin/Downloads/cnam-list_20260506-223742_ringcentral-enriched.xlsx";
const EXTENSIONS_CSV = "C:/Users/Admin/Code/TagContactBridgeParallel/ops/ringcentral-reference/rc-extensions.csv";

function csvEscape(value) {
  if (value == null) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        value += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  const headers = rows.shift() || [];
  return {
    headers,
    rows: rows
      .filter((cells) => cells.some((cell) => String(cell || "").trim()))
      .map((cells) => Object.fromEntries(headers.map((header, idx) => [header, cells[idx] || ""]))),
  };
}

function spreadsheetColumnName(count) {
  let value = count;
  let name = "";
  while (value > 0) {
    const rem = (value - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function buildExtensionNameMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const ext = String(row.Extension || "").trim();
    const name = String(row.Name || "").trim();
    if (ext && name) map.set(ext, name);
  }
  return map;
}

function resolveMemberList(value, extensionNameByNumber) {
  return String(value || "")
    .split(";")
    .map((part) => {
      const item = part.trim();
      const match = item.match(/^ext\s+([0-9]+)$/i);
      if (!match) return item;
      const ext = match[1];
      const name = extensionNameByNumber.get(ext);
      return name ? `${name} ext ${ext}` : item;
    })
    .filter(Boolean)
    .join("; ");
}

async function main() {
  const { headers, rows } = parseCsv(await fs.readFile(ENRICHED_CSV, "utf8"));
  const extensionRows = parseCsv(await fs.readFile(EXTENSIONS_CSV, "utf8")).rows;
  const extensionNameByNumber = buildExtensionNameMap(extensionRows);

  for (const row of rows) {
    row["Queue/IVR Members"] = resolveMemberList(row["Queue/IVR Members"], extensionNameByNumber);
  }

  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  await fs.writeFile(ENRICHED_CSV, csv, "utf8");

  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Summary");
  summary.showGridLines = false;
  const counts = new Map();
  for (const row of rows) {
    const kind = row["Assigned Kind"] || "Unknown";
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  summary.getRange("A1:B10").values = [
    ["CNAM RingCentral Enrichment", ""],
    ["Source CSV", "C:/Users/Admin/Downloads/cnam-list_20260506-223742.csv"],
    ["Generated", new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" })],
    ["Input rows", rows.length],
    ["User assignments", counts.get("User") || 0],
    ["Queue assignments", counts.get("Queue") || 0],
    ["IVR assignments", counts.get("IVR") || 0],
    ["Other extensions", counts.get("Extension") || 0],
    ["Not found", counts.get("Not found") || 0],
    ["Rows with device data", rows.filter((row) => Number(row["Devices Found"]) > 0).length],
  ];
  summary.getRange("A1:B1").format = {
    font: { bold: true, color: "#FFFFFF" },
    fill: { color: "#1F4E79" },
  };
  summary.getRange("A1:B10").format.columnWidthPx = 220;
  summary.getRange("A4:A10").format = { font: { bold: true } };

  const data = workbook.worksheets.add("Enriched Numbers");
  data.showGridLines = false;
  const matrix = [headers, ...rows.map((row) => headers.map((header) => row[header]))];
  const lastColumn = spreadsheetColumnName(headers.length);
  data.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
  data.getRangeByIndexes(0, 0, 1, headers.length).format = {
    font: { bold: true, color: "#FFFFFF" },
    fill: { color: "#1F4E79" },
    wrapText: true,
  };
  data.freezePanes.freezeRows(1);
  data.tables.add(`A1:${lastColumn}${matrix.length}`, true, "CnamRingCentralEnrichment");
  data.getRange("A:A").format.columnWidthPx = 135;
  data.getRange("B:B").format.columnWidthPx = 150;
  data.getRange("C:C").format.columnWidthPx = 105;
  data.getRange("D:D").format.columnWidthPx = 220;
  data.getRange("E:F").format.columnWidthPx = 115;
  data.getRange("G:G").format.columnWidthPx = 190;
  data.getRange("H:I").format.columnWidthPx = 310;
  data.getRange("J:K").format.columnWidthPx = 210;
  data.getRange(`L:${lastColumn}`).format.columnWidthPx = 150;
  data.getRange(`A1:${lastColumn}1`).format.rowHeightPx = 34;
  data.getRange(`A2:${lastColumn}${matrix.length}`).format.wrapText = false;

  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(OUTPUT_XLSX);

  const preview = await workbook.inspect({
    kind: "table",
    range: `Enriched Numbers!A1:I8`,
    include: "values",
    tableMaxRows: 8,
    tableMaxCols: 9,
  });
  console.log(preview.ndjson);
  console.log(JSON.stringify({
    outputXlsx: OUTPUT_XLSX,
    outputCsv: ENRICHED_CSV,
    rows: rows.length,
    assignmentCounts: Object.fromEntries(counts),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
