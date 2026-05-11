"use strict";

// Repopulate the AS bucket in Drive after a manual purge.
//
// Walks weekdays backward from a starting offset, runs the EOD
// archiver for each day with `bucketOnly: "AS"` so only AS-classified
// tasks are uploaded. The new interoffice exclusion in
// `archive-eod-recordings.deriveRouting` keeps internal-only calls
// out of the bucket on the way through. OG and CS Drive folders
// stay untouched because the filter never sends a write to them, and
// the appProperty dedup makes re-runs idempotent.
//
// Usage:
//   node scripts/repopulate-as-bucket.js [--start-offset N] [--days N]
//                                        [--write-local false]
//                                        [--weekdays-only true]
//                                        [--between-days-ms N]
//
// Defaults: starts at offset 1 (yesterday), walks 30 weekdays
// backward, weekdays only, write-local=false (cache stays lean).
//
// Stop conditions:
//   --days exhausted, OR
//   --stop-on-empty N consecutive days with archived=0 (Logics-style
//      retention floors). Default 0 = disabled.

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  runArchiveEodRecordings,
} = require("./archive-eod-recordings");

function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || String(next).startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = String(next);
    index += 1;
  }
  return args;
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "no", "off"].includes(normalized);
}

function formatDateKeyForZone(date, timeZone = "America/Los_Angeles") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function offsetDateKey(offsetDays, timeZone = "America/Los_Angeles") {
  const todayKey = formatDateKeyForZone(new Date(), timeZone);
  const [year, month, day] = todayKey.split("-").map((value) => Number(value));
  const ms = Date.UTC(year, month - 1, day) - offsetDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isWeekend(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  const dow = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return dow === 0 || dow === 6;
}

async function runDay(dateKey, baseOptions) {
  const startedAt = Date.now();
  let summary;
  let error = null;
  try {
    const result = await runArchiveEodRecordings({ ...baseOptions, date: dateKey });
    summary = result.summary;
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - startedAt;
  if (error) {
    return { dateKey, ok: false, elapsedMs, error: String(error?.message || error) };
  }
  const stats = summary?.stats || {};
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const skipped = Array.isArray(summary?.skipped) ? summary.skipped : [];
  // Bucket-only filter classifies non-AS tasks as `skipped: { reason:
  // "bucket-not-targeted" }` — we surface that as a separate count so
  // operators can sanity-check that the day had OG/CS volume too.
  const bucketSkipped = skipped.filter((s) => s.reason === "bucket-not-targeted").length;
  const interofficeSkipped = skipped.filter((s) => s.reason === "interoffice").length;
  const noRecording = skipped.filter((s) => s.reason === "no-recording-found").length;
  const taskFailed = skipped.filter((s) => s.reason === "task-failed").length;
  const uploaded = results.filter((r) => r.uploaded && !r.deduped).length;
  const deduped = results.filter((r) => r.deduped).length;
  return {
    dateKey,
    ok: true,
    elapsedMs,
    archived: stats.archived || results.length,
    uploaded,
    deduped,
    bucketSkipped,
    interofficeSkipped,
    noRecording,
    taskFailed,
    legacyRows: stats.legacyRowsFetched || 0,
    rcRecords: stats.rcRecordsFetched || 0,
    callrailCalls: stats.callrailCallsFetched || 0,
    tasksProcessed: stats.tasksProcessed || 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startOffset = intArg(args["start-offset"], 1);
  const days = Math.max(intArg(args.days, 30), 1);
  const writeLocal = boolArg(args["write-local"], false);
  const weekdaysOnly = boolArg(args["weekdays-only"], true);
  const stopEmpty = Math.max(intArg(args["stop-on-empty"], 0), 0);
  const delayBetweenDaysMs = Math.max(intArg(args["between-days-ms"], 1500), 0);

  const baseOptions = {
    writeLocal,
    sendCompletionNotice: false,
    bucketOnly: "AS",
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    event: "repopulate-as-start",
    startOffset,
    days,
    writeLocal,
    weekdaysOnly,
    stopEmpty,
  }));

  const summaries = [];
  let consecutiveEmpty = 0;
  let processed = 0;
  let offset = startOffset;

  while (processed < days) {
    const dateKey = offsetDateKey(offset);
    if (weekdaysOnly && isWeekend(dateKey)) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ event: "skip-weekend", offset, dateKey }));
      offset += 1;
      continue;
    }

    const summary = await runDay(dateKey, baseOptions);
    summaries.push(summary);
    processed += 1;

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: "day", offset, ...summary }));

    if (summary.ok && summary.archived === 0) {
      consecutiveEmpty += 1;
    } else {
      consecutiveEmpty = 0;
    }
    if (stopEmpty > 0 && consecutiveEmpty >= stopEmpty) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        event: "stop",
        reason: "consecutive-empty",
        consecutive: consecutiveEmpty,
      }));
      break;
    }

    if (delayBetweenDaysMs > 0 && processed < days) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenDaysMs));
    }
    offset += 1;
  }

  const totals = summaries.reduce(
    (acc, summary) => {
      if (!summary.ok) {
        acc.failed += 1;
        return acc;
      }
      acc.uploaded += summary.uploaded || 0;
      acc.deduped += summary.deduped || 0;
      acc.interofficeSkipped += summary.interofficeSkipped || 0;
      acc.bucketSkipped += summary.bucketSkipped || 0;
      acc.noRecording += summary.noRecording || 0;
      return acc;
    },
    { uploaded: 0, deduped: 0, interofficeSkipped: 0, bucketSkipped: 0, noRecording: 0, failed: 0 },
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    event: "repopulate-as-complete",
    daysProcessed: summaries.length,
    totals,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
