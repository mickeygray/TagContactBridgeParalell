"use strict";

// Backload MasterProspectIndex from a Logics CaseFilter_Prospects CSV
// export. Pure index ingest — no Logics call, no LeadCadence write,
// no cadence outreach kick-off. These rows are reference inventory
// for: NCOA mail tracking, future dialer feeds, EX-call lookup
// ladder, and CX case-creation acceleration.
//
// Usage:
//   node scripts/backload-master-prospects.js [csvPath] [--dry-run] [--limit N]
//
// Default csvPath: $LOGICS_EXPORT_DIR/CaseFilter_Prospects_*.csv, or
// ~/Downloads/CaseFilter_Prospects_*.csv when LOGICS_EXPORT_DIR is unset.
// --dry-run prints the first 3 normalized records and exits without writing.
// --limit N processes only the first N rows (useful for smoke tests).

const fs = require("fs");
const os = require("os");
const path = require("path");
const Papa = require("papaparse");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { MasterProspectIndex } = require("../packages/shared-models/src");

const DOMAIN = "TAG";
const SOURCE_NAME = "ABC";
const BULK_SIZE = 1000;
const DEFAULT_CSV_PATH = path.join(
  process.env.LOGICS_EXPORT_DIR || path.join(os.homedir(), "Downloads"),
  "CaseFilter_Prospects_20260428191635.csv",
);

function parseArgs(argv) {
  const args = { dryRun: false, limit: 0, csvPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i]);
    if (token === "--dry-run") args.dryRun = true;
    else if (token === "--limit") args.limit = Number(argv[++i]) || 0;
    else if (!token.startsWith("--")) args.csvPath = token;
  }
  return args;
}

function readCsvUtf16(file) {
  const buf = fs.readFileSync(path.resolve(file));
  let text = buf.toString("utf16le");
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return Papa.parse(text, { header: true, skipEmptyLines: true });
}

function cleanText(value) {
  return String(value || "").trim() || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function splitName(value) {
  const raw = cleanText(value);
  if (!raw) return { firstName: null, lastName: null, name: null };
  // Logics exports collapse double-spaces. "CREIG  FORMAN" → ["CREIG", "FORMAN"]
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { firstName: null, lastName: parts[0], name: parts[0] };
  const lastName = parts[parts.length - 1];
  const firstName = parts.slice(0, -1).join(" ");
  return { firstName, lastName, name: `${firstName} ${lastName}` };
}

// "1/5/2026 8:38:46 AM" → Date object. Handles 12-hour clock + missing seconds.
function parseLogicsDate(value) {
  const raw = cleanText(value);
  if (!raw) return null;
  const m = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?/i,
  );
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  let hour = Number(m[4] || 0);
  const minute = Number(m[5] || 0);
  const second = Number(m[6] || 0);
  const meridiem = (m[7] || "").toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  // The Logics export is in PT (operator tz) — convert to UTC.
  const naiveUtcMs = Date.UTC(year, month, day, hour, minute, second);
  // PT offset for 2026: UTC-8 standard, UTC-7 daylight (Mar 8 - Nov 1).
  // Cheap heuristic: check by month/day. Negligible drift on the
  // transition days, fine for indexing intake date.
  const transitionStart = Date.UTC(year, 2, 8); // Mar 8
  const transitionEnd = Date.UTC(year, 10, 1); // Nov 1
  const isDaylight = naiveUtcMs >= transitionStart && naiveUtcMs < transitionEnd;
  const offsetHours = isDaylight ? 7 : 8;
  return new Date(naiveUtcMs + offsetHours * 60 * 60 * 1000);
}

const MAIL_INFO_LABELS = [
  /^\s*Mail\s+Date\s*:/im,
  /^\s*Lien\s+Amount\s*:/im,
  /^\s*Plaintiff\s*:/im,
  /^\s*Filing\s+Date\s*:/im,
  /^\s*Lien\s+Type\s*:/im,
  /^\s*Amount\s*:/im,
];

function hasMailInfo(notes) {
  const text = String(notes || "");
  let hits = 0;
  for (const pattern of MAIL_INFO_LABELS) {
    if (pattern.test(text)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function extractMailInfo(notes) {
  const text = String(notes || "");
  if (!text.trim()) return null;
  const grab = (label) => {
    const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "im");
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const block = {
    mailDate: grab("Mail Date"),
    lienAmount: grab("Lien Amount") || grab("Amount"),
    plaintiff: grab("Plaintiff"),
    filingDate: grab("Filing Date"),
    lienType: grab("Lien Type"),
  };
  // If every field is null this isn't really mail-info — return null
  // so the subdoc isn't a cluttered set of nulls.
  const hasAny = Object.values(block).some((v) => v != null);
  return hasAny ? block : null;
}

function rowToProspect(row, importBatch) {
  const caseIdRaw = cleanText(row["Case #"] || row["CaseID"] || row["Case Id"]);
  const caseId = caseIdRaw ? Number(caseIdRaw.replace(/\D/g, "")) : NaN;
  if (!Number.isFinite(caseId) || caseId <= 0) return null;

  const { firstName, lastName, name } = splitName(row["Name"]);
  const cellPhone = normalizePhone(row["Cell"]);
  const homePhone = normalizePhone(row["Home"]);
  const mailIntake = extractMailInfo(row["Notes"]);
  const intakeDate = parseLogicsDate(row["Date"]);
  const lastModified = parseLogicsDate(row["Last Modified Date"]) || intakeDate;
  const statusLabelRaw = cleanText(row["Status"]);
  // Logics status "[Active Prospect]-Opened" → strip bracket tag
  // for `statusLabelRaw`, but the file's filter is by definition
  // active prospects so `statusId: 2` is safe across the dataset.
  const statusLabel = statusLabelRaw
    ? statusLabelRaw.replace(/^\[[^\]]*\]\s*-?\s*/, "")
    : null;

  // Build the Mongo document. Only populated fields get $set so a
  // future re-run that lacks a column doesn't blow away existing
  // data. lastImportBatch tags this row as backloaded.
  const $set = {
    firstName,
    lastName,
    name,
    cellPhone,
    normalizedPhones: cellPhone ? [cellPhone] : [],
    email: cleanText(row["Email"]),
    state: cleanText(row["State"])?.toUpperCase() || null,
    statusId: 2,
    statusLabelRaw,
    statusLabel,
    statusCategory: "prospect",
    intakeRoute: "ncoa-upload",
    partnerSource: "mail-house-return",
    lastSeenAt: lastModified || new Date(),
    needsStatusRefresh: true,
    needsSourceRefresh: true,
    metadata: {
      intakeSource: SOURCE_NAME,
      lastImportBatch: importBatch,
      importChannel: "ncoa-backload",
      notes: ["ncoa-backload"],
      ...(homePhone ? { homePhone } : {}),
    },
  };
  if (mailIntake) {
    $set.mailIntake = { ...mailIntake, importBatch };
  }
  // firstSeenAt only on insert so re-running the loader doesn't
  // overwrite the original intake stamp.
  const $setOnInsert = {
    domain: DOMAIN,
    caseId,
    firstSeenAt: intakeDate || new Date(),
  };

  return { caseId, $set, $setOnInsert };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = args.csvPath || DEFAULT_CSV_PATH;
  if (!fs.existsSync(csvPath)) {
    // eslint-disable-next-line no-console
    console.error(`CSV not found: ${csvPath}`);
    process.exit(1);
  }
  const importBatch = path.basename(csvPath);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ phase: "parsing", csvPath, importBatch }));
  const parsed = readCsvUtf16(csvPath);
  let rows = parsed.data;
  if (args.limit > 0) rows = rows.slice(0, args.limit);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    phase: "parsed",
    rowCount: rows.length,
    fields: parsed.meta.fields,
    papaErrors: parsed.errors.slice(0, 3),
  }));

  // Map to prospect documents up front so we can report skipped rows
  // before touching Mongo.
  const docs = [];
  let skippedNoCaseId = 0;
  let mailInfoCount = 0;
  for (const row of rows) {
    const doc = rowToProspect(row, importBatch);
    if (!doc) {
      skippedNoCaseId += 1;
      continue;
    }
    if (doc.$set.mailIntake) mailInfoCount += 1;
    docs.push(doc);
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    phase: "normalized",
    docCount: docs.length,
    mailInfoCount,
    skippedNoCaseId,
  }));

  if (args.dryRun) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      phase: "dry-run-sample",
      sample: docs.slice(0, 3),
    }, null, 2));
    return;
  }

  await mongoose.connect(process.env.MONGO_URI);

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ phase: "writing", bulkSize: BULK_SIZE }));

  let inserted = 0;
  let modified = 0;
  let upserted = 0;
  let writeErrors = 0;
  const startedAt = Date.now();

  for (let offset = 0; offset < docs.length; offset += BULK_SIZE) {
    const slice = docs.slice(offset, offset + BULK_SIZE);
    const ops = slice.map((doc) => ({
      updateOne: {
        filter: { domain: DOMAIN, caseId: doc.caseId },
        update: { $set: doc.$set, $setOnInsert: doc.$setOnInsert },
        upsert: true,
      },
    }));
    try {
      const result = await MasterProspectIndex.bulkWrite(ops, { ordered: false });
      inserted += result.insertedCount || 0;
      modified += result.modifiedCount || 0;
      upserted += result.upsertedCount || 0;
    } catch (error) {
      writeErrors += 1;
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        phase: "bulk-error",
        offset,
        error: String(error && error.message ? error.message : error),
      }));
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      phase: "progress",
      offset: offset + slice.length,
      total: docs.length,
      runningInserted: inserted,
      runningModified: modified,
      runningUpserted: upserted,
      elapsedMs: Date.now() - startedAt,
    }));
  }

  await mongoose.disconnect();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    phase: "done",
    docCount: docs.length,
    mailInfoCount,
    skippedNoCaseId,
    inserted,
    modified,
    upserted,
    writeErrors,
    elapsedMs: Date.now() - startedAt,
  }, null, 2));
}

main().catch(async (error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  try { await mongoose.disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
