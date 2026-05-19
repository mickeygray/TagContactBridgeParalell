"use strict";

// One-off EOD recording archive backfill for an explicit date range.
//
// This is intentionally boring and slow: it runs the existing
// archive-eod-recordings.js logic one day at a time, writes JSONL
// progress to runtime/eod-recording-backfills, and requires --apply
// before it uploads anything to Drive.
//
// Examples:
//   node scripts/backfill-eod-recordings-range.js
//     Dry-run current month through yesterday.
//
//   node scripts/backfill-eod-recordings-range.js --month 2026-05 --apply
//     Backfill all of May 2026 through yesterday.
//
//   node scripts/backfill-eod-recordings-range.js --start 2026-05-01 --end 2026-05-15 --apply --between-days-ms 5000 --task-delay-ms 1200
//     Backfill a fixed range, slowly enough to leave breathing room for APIs.
//
//   node scripts/backfill-eod-recordings-range.js --start 2026-05-01 --end 2026-05-15 --apply --exclude-agents "Michael Gray,Alex Banks"
//     Backfill while skipping known internal/test users.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const {
  runArchiveEodRecordings,
} = require("./archive-eod-recordings");
const {
  waitForRecordingPipelineIdle,
} = require("../packages/shared-services/src/recordingPipelineIdleService");

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const OUT_DIR = path.resolve(__dirname, "..", "runtime", "eod-recording-backfills");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
}

function formatDateKeyForZone(date, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split("-").map((value) => Number(value));
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0), 12));
  return date.toISOString().slice(0, 10);
}

function validateDateKey(value, label) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be YYYY-MM-DD; received ${raw || "(empty)"}`);
  }
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new Error(`${label} is not a valid date: ${raw}`);
  }
  return raw;
}

function defaultMonthKey(timeZone = DEFAULT_TIME_ZONE) {
  return formatDateKeyForZone(new Date(), timeZone).slice(0, 7);
}

function resolveRange(args = {}) {
  const timeZone = String(args.timezone || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  const month = String(args.month || defaultMonthKey(timeZone)).trim();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month must be YYYY-MM; received ${month}`);
  }

  const today = formatDateKeyForZone(new Date(), timeZone);
  const defaultEnd = boolArg(args["include-today"], false) ? today : addDays(today, -1);
  const start = validateDateKey(args.start || `${month}-01`, "--start");
  const end = validateDateKey(args.end || defaultEnd, "--end");
  if (end < start) {
    throw new Error(`--end (${end}) must be on or after --start (${start})`);
  }
  return { start, end, month, timeZone };
}

function isWeekend(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map((value) => Number(value));
  const dow = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return dow === 0 || dow === 6;
}

function appendJsonLine(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

async function runDay(dateKey, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await runArchiveEodRecordings({
      date: dateKey,
      dryRun: options.dryRun,
      writeLocal: options.writeLocal,
      sendCompletionNotice: false,
      minDurationSec: options.minDurationSec,
      delayMs: options.taskDelayMs,
      limit: options.limitPerDay,
      outputRoot: options.outputRoot,
      bucketOnly: options.bucketOnly,
      excludeAgents: options.excludeAgents,
    });
    const summary = result.summary || {};
    const stats = summary.stats || {};
    const results = Array.isArray(summary.results) ? summary.results : [];
    const skipped = Array.isArray(summary.skipped) ? summary.skipped : [];
    const uploaded = results.filter((row) => row.uploaded && !row.deduped).length;
    const deduped = results.filter((row) => row.deduped).length;
    return {
      dateKey,
      ok: true,
      elapsedMs: Date.now() - startedAt,
      summaryPath: result.summaryPath || null,
      legacyRows: Number(stats.legacyRowsFetched || 0),
      rcRecords: Number(stats.rcRecordsFetched || 0),
      callrailCalls: Number(stats.callrailCallsFetched || 0),
      tasks: Number(stats.tasksProcessed || results.length || 0),
      archived: Number(stats.archived || results.length || 0),
      uploaded,
      deduped,
      skipped: Number(stats.skipped || skipped.length || 0),
    };
  } catch (error) {
    return {
      dateKey,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: String(error?.message || error),
    };
  }
}

async function waitForIdleBeforeDay(dateKey, options = {}, jsonlPath) {
  if (!options.waitForIdle) return null;
  const started = {
    event: "idle-wait-start",
    dateKey,
    pollMs: options.idlePollMs,
    maxWaitMs: options.idleMaxWaitMs,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(started));
  appendJsonLine(jsonlPath, started);

  const logger = {
    info(message, payload = {}) {
      const event = {
        event: "idle-wait",
        dateKey,
        message,
        at: new Date().toISOString(),
        ...payload,
      };
      console.log(JSON.stringify(event));
      appendJsonLine(jsonlPath, event);
    },
  };

  const result = await waitForRecordingPipelineIdle({
    label: `eod-backfill:${dateKey}`,
    pollMs: options.idlePollMs,
    maxWaitMs: options.idleMaxWaitMs,
    logger,
  });

  const complete = {
    event: "idle-wait-complete",
    dateKey,
    waitedMs: result.waitedMs,
    counts: result.activity?.counts || null,
    at: new Date().toISOString(),
  };
  console.log(JSON.stringify(complete));
  appendJsonLine(jsonlPath, complete);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const range = resolveRange(args);
  const dryRun = !boolArg(args.apply, false);
  const weekdaysOnly = boolArg(args["weekdays-only"], false);
  const options = {
    dryRun,
    writeLocal: boolArg(args["write-local"], false),
    minDurationSec: args["min-duration"] !== undefined ? intArg(args["min-duration"], undefined) : undefined,
    taskDelayMs: Math.max(intArg(args["task-delay-ms"], 1200), 0),
    betweenDaysMs: Math.max(intArg(args["between-days-ms"], 5000), 0),
    limitPerDay: Math.max(intArg(args["limit-per-day"], 0), 0),
    outputRoot: args["out-dir"],
    bucketOnly: args["bucket-only"],
    excludeAgents: args["exclude-agents"],
    waitForIdle: boolArg(args["wait-for-idle"], true),
    idlePollMs: Math.max(
      intArg(args["idle-poll-ms"], Number(process.env.RECORDING_PIPELINE_IDLE_POLL_MS) || 60000),
      1000,
    ),
    idleMaxWaitMs: Math.max(
      intArg(
        args["idle-max-wait-ms"],
        Number(process.env.RECORDING_PIPELINE_IDLE_MAX_WAIT_MS) || 12 * 60 * 60 * 1000,
      ),
      0,
    ),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonlPath = path.join(OUT_DIR, `backfill-eod-recordings-range-${stamp()}.jsonl`);
  const started = {
    event: "backfill-start",
    startedAt: new Date().toISOString(),
    range,
    dryRun,
    applyRequired: dryRun ? "pass --apply to upload to Drive" : null,
    weekdaysOnly,
    options,
    jsonlPath,
  };
  console.log(JSON.stringify(started));
  appendJsonLine(jsonlPath, started);

  const totals = {
    days: 0,
    failedDays: 0,
    legacyRows: 0,
    rcRecords: 0,
    callrailCalls: 0,
    tasks: 0,
    archived: 0,
    uploaded: 0,
    deduped: 0,
    skipped: 0,
  };

  for (let dateKey = range.start; dateKey <= range.end; dateKey = addDays(dateKey, 1)) {
    if (weekdaysOnly && isWeekend(dateKey)) {
      const event = { event: "skip-weekend", dateKey };
      console.log(JSON.stringify(event));
      appendJsonLine(jsonlPath, event);
      continue;
    }

    await waitForIdleBeforeDay(dateKey, options, jsonlPath);

    const day = await runDay(dateKey, options);
    const event = { event: "day", ...day };
    console.log(JSON.stringify(event));
    appendJsonLine(jsonlPath, event);

    totals.days += 1;
    if (!day.ok) {
      totals.failedDays += 1;
    } else {
      totals.legacyRows += day.legacyRows || 0;
      totals.rcRecords += day.rcRecords || 0;
      totals.callrailCalls += day.callrailCalls || 0;
      totals.tasks += day.tasks || 0;
      totals.archived += day.archived || 0;
      totals.uploaded += day.uploaded || 0;
      totals.deduped += day.deduped || 0;
      totals.skipped += day.skipped || 0;
    }

    if (dateKey < range.end && options.betweenDaysMs > 0) {
      await sleep(options.betweenDaysMs);
    }
  }

  const complete = {
    event: "backfill-complete",
    completedAt: new Date().toISOString(),
    range,
    dryRun,
    totals,
    jsonlPath,
  };
  console.log(JSON.stringify(complete));
  appendJsonLine(jsonlPath, complete);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
