"use strict";

// Local CX/WEM recording backloader.
//
// Walks a historical time range in small windows and runs the same
// RingCX recording archive path used by the control-plane :30 worker.
// Default mode is preview/list-only; pass --apply to download/upload.
//
// Examples:
//   node scripts/backfill-cx-wem-recordings.js
//     Preview today's useful PT window.
//
//   node scripts/backfill-cx-wem-recordings.js --date 2026-05-26 --start-hour 7 --end-hour 19 --apply
//     Backload today's business window, slowly enough for WEM metadata.
//
//   node scripts/backfill-cx-wem-recordings.js --start 2026-05-26T07:00:00-07:00 --end 2026-05-26T19:00:00-07:00 --apply
//     Backload an explicit range.

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CallLog } = require("../packages/shared-models/src");
const {
  runCxRecordingHourly,
} = require("../packages/shared-services/src/cxRecordingHourlyService");
const {
  buildTimezoneDateWindow,
} = require("../packages/shared-services/src/timezoneDateWindowService");

const DEFAULT_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_DOMAINS = ["TAG", "WYNN"];
const OUT_DIR = path.resolve(__dirname, "..", "runtime", "cx-wem-recording-backfills");
const TERMINAL_ARCHIVE_STATUSES = Object.freeze([
  "completed",
  "abandoned",
  "skipped",
  "no_group_match",
]);

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) continue;

    const eq = token.indexOf("=");
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }

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

function boolArg(value, fallback = false) {
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  return !["0", "false", "no", "off"].includes(text);
}

function intArg(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function appendJsonLine(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function formatDateKeyForZone(date = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function parseDate(value, label) {
  const raw = String(value || "").trim();
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be a valid date/time; received ${raw || "(empty)"}`);
  }
  return date;
}

function parseDateKey(value, label = "--date") {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be YYYY-MM-DD; received ${raw || "(empty)"}`);
  }
  return raw;
}

function localTimeOnDate(dateKey, timeZone, hour, minute = 0) {
  const day = buildTimezoneDateWindow(dateKey, timeZone);
  return new Date(
    day.start.getTime()
      + Math.max(0, Number(hour) || 0) * 60 * 60 * 1000
      + Math.max(0, Number(minute) || 0) * 60 * 1000,
  );
}

function normalizeDomains(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim().toUpperCase()).filter(Boolean);
  const raw = String(value || "").trim();
  const domains = raw
    ? raw.split(",").map((item) => item.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_DOMAINS;
  return [...new Set(domains)];
}

function buildCandidateQuery({ domain, windowStart, windowEnd, minDurationSec }) {
  return {
    domain,
    platform: "cx",
    callEndTime: {
      $gte: windowStart,
      $lte: windowEnd,
    },
    durationSec: { $gte: minDurationSec },
    $or: [
      { "recordingArchive.status": { $exists: false } },
      { "recordingArchive.status": null },
      { "recordingArchive.status": { $nin: TERMINAL_ARCHIVE_STATUSES } },
    ],
  };
}

function resolveOptions(args = {}) {
  const config = getSharedConfig();
  const timeZone = String(args.timezone || DEFAULT_TIME_ZONE).trim() || DEFAULT_TIME_ZONE;
  const now = new Date();
  const dateKey = parseDateKey(args.date || formatDateKeyForZone(now, timeZone));
  const readyDelayMin = Math.max(0, intArg(args["ready-delay-min"], 15));
  const apply = boolArg(args.apply, false);
  const listOnly = boolArg(args["list-only"], !apply);

  let rangeStart;
  let rangeEnd;
  if (args.start || args.end) {
    if (!args.start || !args.end) {
      throw new Error("Use both --start and --end when passing an explicit range.");
    }
    rangeStart = parseDate(args.start, "--start");
    rangeEnd = parseDate(args.end, "--end");
  } else {
    const startHour = numberArg(args["start-hour"], 7);
    const endHour = numberArg(args["end-hour"], 19);
    const startMinute = numberArg(args["start-minute"], 0);
    const endMinute = numberArg(args["end-minute"], 0);
    rangeStart = localTimeOnDate(dateKey, timeZone, startHour, startMinute);
    rangeEnd = localTimeOnDate(dateKey, timeZone, endHour, endMinute);
    if (rangeEnd <= rangeStart) {
      rangeEnd = new Date(rangeEnd.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  if (!boolArg(args["include-unready"], false)) {
    const newestAllowed = new Date(now.getTime() - readyDelayMin * 60 * 1000);
    if (rangeEnd > newestAllowed) rangeEnd = newestAllowed;
  }

  if (rangeEnd <= rangeStart) {
    throw new Error(`Resolved range is empty: ${rangeStart.toISOString()} -> ${rangeEnd.toISOString()}`);
  }

  const minDurationSec = Math.max(
    1,
    intArg(args["min-duration-sec"], Number(config.recordingArchive?.minDurationSec) || 300),
  );

  return {
    apply,
    listOnly,
    dryRun: !apply || listOnly,
    allowTestDbWrite: boolArg(args["allow-test-db-write"], false),
    dateKey,
    timeZone,
    rangeStart,
    rangeEnd,
    readyDelayMin,
    domains: normalizeDomains(args.domains),
    minDurationSec,
    maxRowsPerDomain: Math.max(1, intArg(args["max-rows-per-domain"], 500)),
    windowMinutes: Math.max(5, intArg(args["window-minutes"], 60)),
    betweenWindowsMs: Math.max(
      0,
      intArg(
        args["between-windows-ms"],
        intArg(process.env.RINGCX_RECORDING_METADATA_MIN_INTERVAL_MS, 180000),
      ),
    ),
    sampleLimit: Math.max(0, intArg(args["sample-limit"], 3)),
    outDir: path.resolve(String(args["out-dir"] || OUT_DIR)),
  };
}

function buildWindows(options) {
  const windows = [];
  let cursor = new Date(options.rangeStart);
  const hardEnd = new Date(options.rangeEnd);
  const stepMs = options.windowMinutes * 60 * 1000;

  while (cursor < hardEnd) {
    const nextExclusive = new Date(Math.min(cursor.getTime() + stepMs, hardEnd.getTime()));
    const inclusiveEnd = new Date(nextExclusive.getTime() - 1);
    if (inclusiveEnd >= cursor) {
      windows.push({
        windowStart: new Date(cursor),
        windowEnd: inclusiveEnd,
      });
    }
    cursor = nextExclusive;
  }
  return windows;
}

async function countWindowCandidates(window, options) {
  const domains = {};
  let total = 0;
  for (const domain of options.domains) {
    const query = buildCandidateQuery({
      domain,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      minDurationSec: options.minDurationSec,
    });
    const [count, samples] = await Promise.all([
      CallLog.countDocuments(query),
      options.sampleLimit > 0
        ? CallLog.find(query, {
            _id: 0,
            telephonySessionId: 1,
            caseId: 1,
            callEndTime: 1,
            durationSec: 1,
            agentName: 1,
            "recordingArchive.status": 1,
          })
            .sort({ callEndTime: 1 })
            .limit(options.sampleLimit)
            .lean()
        : Promise.resolve([]),
    ]);

    total += count;
    domains[domain] = {
      candidateRows: count,
      overMaxRowsPerDomain: count > options.maxRowsPerDomain,
      samples: samples.map((row) => ({
        telephonySessionId: row.telephonySessionId || null,
        caseId: row.caseId || null,
        callEndTime: row.callEndTime ? new Date(row.callEndTime).toISOString() : null,
        durationSec: row.durationSec ?? null,
        agentName: row.agentName || null,
        archiveStatus: row.recordingArchive?.status || null,
      })),
    };
  }
  return { total, domains };
}

function summarizeRunResult(result) {
  const domains = {};
  for (const [domain, value] of Object.entries(result?.domains || {})) {
    domains[domain] = {
      candidateRows: value.candidateRows || 0,
      queued: value.queued || 0,
      processedInline: value.processedInline || 0,
      processedCompleted: value.processedCompleted || 0,
      processedNoRecording: value.processedNoRecording || 0,
      processedErrors: value.processedErrors || 0,
      skippedNoMetadata: value.skippedNoMetadata || 0,
      errors: Array.isArray(value.errors) ? value.errors.length : 0,
    };
  }
  return {
    ok: result?.ok !== false,
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
    metadata: result?.metadata || null,
    errors: result?.errors || [],
    domains,
  };
}

async function main() {
  const args = parseArgs();
  const options = resolveOptions(args);
  const config = getSharedConfig();
  if (!config.mongoUri) throw new Error("MONGO_URI is required");

  fs.mkdirSync(options.outDir, { recursive: true });
  const jsonlPath = path.join(options.outDir, `cx-wem-backfill_${stamp()}.ndjson`);

  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  const dbName = mongoose.connection.name;
  if (options.apply && dbName === "test" && !options.allowTestDbWrite) {
    throw new Error("Refusing to write to db=test. Set PARALLEL_DB_NAME or pass --allow-test-db-write.");
  }

  const windows = buildWindows(options);
  const header = {
    event: "start",
    at: new Date().toISOString(),
    dbName,
    apply: options.apply,
    listOnly: options.listOnly,
    date: options.dateKey,
    timezone: options.timeZone,
    rangeStart: options.rangeStart.toISOString(),
    rangeEnd: options.rangeEnd.toISOString(),
    readyDelayMin: options.readyDelayMin,
    domains: options.domains,
    minDurationSec: options.minDurationSec,
    maxRowsPerDomain: options.maxRowsPerDomain,
    windowMinutes: options.windowMinutes,
    betweenWindowsMs: options.betweenWindowsMs,
    windows: windows.length,
    jsonlPath,
  };
  console.log(JSON.stringify(header));
  appendJsonLine(jsonlPath, header);

  const summary = {
    ...header,
    event: "complete",
    completedAt: null,
    ok: true,
    candidateRows: 0,
    windowsWithCandidates: 0,
    windowsProcessed: 0,
    windowsSkippedEmpty: 0,
    processedCompleted: 0,
    processedErrors: 0,
  };

  const logger = {
    info(message, payload = {}) {
      const event = {
        event: "service-log",
        message,
        at: new Date().toISOString(),
        ...payload,
      };
      console.log(JSON.stringify(event));
      appendJsonLine(jsonlPath, event);
    },
  };

  try {
    for (let index = 0; index < windows.length; index += 1) {
      const window = windows[index];
      const counts = await countWindowCandidates(window, options);
      summary.candidateRows += counts.total;
      if (counts.total > 0) summary.windowsWithCandidates += 1;

      const previewEvent = {
        event: "window-preview",
        index: index + 1,
        totalWindows: windows.length,
        at: new Date().toISOString(),
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        totalCandidateRows: counts.total,
        domains: counts.domains,
      };
      console.log(JSON.stringify(previewEvent));
      appendJsonLine(jsonlPath, previewEvent);

      if (options.listOnly || !options.apply) {
        continue;
      }

      if (counts.total === 0) {
        summary.windowsSkippedEmpty += 1;
        continue;
      }

      const result = await runCxRecordingHourly({
        fireTime: new Date(),
        domains: options.domains,
        logger,
        scheduleMinute: intArg(process.env.RINGCX_RECORDING_HOURLY_MINUTE, 30),
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        maxRowsPerDomain: options.maxRowsPerDomain,
      });

      const runSummary = summarizeRunResult(result);
      summary.windowsProcessed += 1;
      for (const value of Object.values(runSummary.domains)) {
        summary.processedCompleted += value.processedCompleted || 0;
        summary.processedErrors += value.processedErrors || 0;
      }
      if (runSummary.ok === false) summary.ok = false;

      const runEvent = {
        event: "window-run",
        index: index + 1,
        totalWindows: windows.length,
        at: new Date().toISOString(),
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        ...runSummary,
      };
      console.log(JSON.stringify(runEvent));
      appendJsonLine(jsonlPath, runEvent);

      if (index < windows.length - 1 && options.betweenWindowsMs > 0) {
        const delayEvent = {
          event: "delay",
          at: new Date().toISOString(),
          ms: options.betweenWindowsMs,
          reason: "ringcx-metadata-rate-limit",
        };
        console.log(JSON.stringify(delayEvent));
        appendJsonLine(jsonlPath, delayEvent);
        await sleep(options.betweenWindowsMs);
      }
    }
  } finally {
    summary.completedAt = new Date().toISOString();
    console.log(JSON.stringify(summary));
    appendJsonLine(jsonlPath, summary);
    await mongoose.disconnect();
  }

  if (!summary.ok) process.exitCode = 1;
}

main().catch(async (error) => {
  const payload = {
    event: "fatal",
    at: new Date().toISOString(),
    ok: false,
    error: error.message,
    stack: error.stack,
  };
  console.error(JSON.stringify(payload, null, 2));
  try {
    await mongoose.disconnect();
  } catch (_) {
    // ignore shutdown errors
  }
  process.exitCode = 1;
});
