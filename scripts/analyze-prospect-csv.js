"use strict";

// Analyze the Logics prospect-export CSV to:
//   1. Extract the structured mail-info block from Notes
//      (Mail Date, Lien Amount, Plaintiff, Filing Date, Lien Type)
//      while ignoring human-typed prose.
//   2. Group rows by intake-Date (the `Date` column) and report which
//      weekdays are MISSING in the observed date range that fit the
//      "has mail info in notes" pattern. Weekends are excluded.
//
// Output is JSON so we can pipe into the backloader once the user OKs
// the missing-day report.

const fs = require("fs");
const path = require("path");
const Papa = require("papaparse");

const file = process.argv[2] || "C:\\Users\\Admin\\Downloads\\CaseFilter_Prospects_20260428191635.csv";
const buf = fs.readFileSync(path.resolve(file));
let csvText = buf.toString("utf16le");
if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);

const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
const rows = parsed.data;

// Mail-info detection: the structured block uses a fixed set of
// labels. We treat a Notes blob as "structured" if it matches at least
// two of these labels at line start (case-insensitive). Two-of-N
// avoids false positives from free-form notes that happen to mention
// "Mail Date" or "Plaintiff" in passing.
const MAIL_INFO_LABELS = [
  /^\s*Mail\s+Date\s*:/im,
  /^\s*Lien\s+Amount\s*:/im,
  /^\s*Plaintiff\s*:/im,
  /^\s*Filing\s+Date\s*:/im,
  /^\s*Lien\s+Type\s*:/im,
  /^\s*Amount\s*:/im,
];

function classifyNotes(notes) {
  const text = String(notes || "");
  if (!text.trim()) return "empty";
  let hits = 0;
  for (const pattern of MAIL_INFO_LABELS) {
    if (pattern.test(text)) hits += 1;
  }
  return hits >= 2 ? "mail-info" : "human-typed";
}

function extractMailInfo(notes) {
  const text = String(notes || "");
  const grab = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im");
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    mailDate: grab("Mail Date"),
    lienAmount: grab("Lien Amount") || grab("Amount"),
    plaintiff: grab("Plaintiff"),
    filingDate: grab("Filing Date"),
    lienType: grab("Lien Type"),
  };
}

// Parse "1/5/2026 8:38:46 AM" → "2026-01-05" date-only key.
function parseDateKey(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const month = String(m[1]).padStart(2, "0");
  const day = String(m[2]).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isWeekend(dateKey) {
  // Use UTC noon to dodge tz wobble — weekday boundary doesn't shift
  // between PT/UTC at midday.
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return dow === 0 || dow === 6;
}

function dayOfWeekName(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
}

const byDate = new Map(); // dateKey -> { mailInfo, humanTyped, empty, total, sampleNote }
const classifyTallies = { "mail-info": 0, "human-typed": 0, empty: 0 };
const missingDate = [];

for (const row of rows) {
  const dateKey = parseDateKey(row["Date"]);
  if (!dateKey) {
    missingDate.push(row);
    continue;
  }
  const cls = classifyNotes(row["Notes"]);
  classifyTallies[cls] += 1;
  if (!byDate.has(dateKey)) {
    byDate.set(dateKey, {
      mailInfo: 0,
      humanTyped: 0,
      empty: 0,
      total: 0,
      sample: null,
    });
  }
  const slot = byDate.get(dateKey);
  if (cls === "mail-info") slot.mailInfo += 1;
  else if (cls === "human-typed") slot.humanTyped += 1;
  else slot.empty += 1;
  slot.total += 1;
  if (!slot.sample && cls === "mail-info") {
    slot.sample = extractMailInfo(row["Notes"]);
  }
}

const sortedDates = [...byDate.keys()].sort();
const minDate = sortedDates[0] || null;
const maxDate = sortedDates[sortedDates.length - 1] || null;

// Walk every calendar day in the observed range and flag the
// weekdays that have ZERO mail-info rows.
const missingWeekdays = [];
const allWeekdaysSeen = [];
if (minDate && maxDate) {
  const [y0, m0, d0] = minDate.split("-").map(Number);
  const [yN, mN, dN] = maxDate.split("-").map(Number);
  const startMs = Date.UTC(y0, m0 - 1, d0);
  const endMs = Date.UTC(yN, mN - 1, dN);
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    const date = new Date(ms);
    const key = date.toISOString().slice(0, 10);
    if (isWeekend(key)) continue;
    const slot = byDate.get(key);
    if (!slot || slot.mailInfo === 0) {
      missingWeekdays.push({
        date: key,
        dayOfWeek: dayOfWeekName(key),
        humanTypedCount: slot ? slot.humanTyped : 0,
        emptyCount: slot ? slot.empty : 0,
        totalRows: slot ? slot.total : 0,
      });
    } else {
      allWeekdaysSeen.push(key);
    }
  }
}

const dailyTally = sortedDates.map((dateKey) => ({
  date: dateKey,
  dayOfWeek: dayOfWeekName(dateKey),
  ...byDate.get(dateKey),
}));

console.log(JSON.stringify({
  fileSizeMb: Number((buf.length / (1024 * 1024)).toFixed(2)),
  totalRows: rows.length,
  rowsWithoutDate: missingDate.length,
  classifyTallies,
  dateRange: { from: minDate, to: maxDate, daysObserved: sortedDates.length },
  weekdaysWithMailInfo: allWeekdaysSeen.length,
  missingWeekdays: {
    count: missingWeekdays.length,
    list: missingWeekdays,
  },
  perDayTally: dailyTally,
}, null, 2));
