"use strict";

// Sequential historical backfill of the EOD recording archive.
//
// Walks dates backwards from a starting offset and runs the same logic
// as `archive-eod-recordings.js` for each day. Drive-side dedup (via
// appProperties / telephonySessionId | callrailCallId) makes re-runs
// safe — if a day was previously archived, every task short-circuits to
// `deduped: true` and nothing is re-uploaded.
//
// Stop conditions (whichever fires first):
//   1. --days reached
//   2. --stop-on-fully-deduped <N> consecutive days where archived>0 and
//      uploaded=0 (everything was already in Drive — natural floor of
//      previously-archived history). Default 3.
//   3. --stop-on-empty <N> consecutive days where archived=0 (no calls
//      that meet min-duration). Default 0 = disabled. RingCentral cuts
//      off call-log retention at ~30 days on lower tiers, so empty days
//      are also a natural stopping signal.
//
// Defaults: skip today (offset 0) and yesterday (offset 1) since EOD
// would normally cover those — start at offset 2 (= 2 days ago). Pass
// --start-offset to override.
//
// Output: one JSON line per day to stdout so the loop is greppable
// later. Per-day Drive activity is also recorded in
// `ops/end-of-day-recordings/archive-eod-recordings-<date>.json` by the
// underlying archiver.

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
  // Compute "today minus N days" in the configured tz. We do the
  // arithmetic by converting the current zoned ymd to UTC midnight,
  // subtracting N*24h, and reformatting — accurate enough for a
  // backfill window since DST transitions only nudge by an hour and the
  // archiver pulls full zoned-day windows anyway.
  const todayKey = formatDateKeyForZone(new Date(), timeZone);
  const [year, month, day] = todayKey.split("-").map((value) => Number(value));
  const ms = Date.UTC(year, month - 1, day) - offsetDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function isWeekend(dateKey) {
  // dateKey is a zoned YYYY-MM-DD. Use UTC noon to dodge tz wobble when
  // computing the day-of-week — weekday boundary doesn't shift between
  // PT and UTC at 12:00 UTC for any valid date.
  const [year, month, day] = String(dateKey)
    .split("-")
    .map((value) => Number(value));
  const dow = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return dow === 0 || dow === 6;
}

async function runDay(dateKey, baseOptions) {
  const startedAt = Date.now();
  let summary;
  let error = null;
  try {
    const result = await runArchiveEodRecordings({
      ...baseOptions,
      date: dateKey,
    });
    summary = result.summary;
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - startedAt;

  if (error) {
    return {
      dateKey,
      ok: false,
      elapsedMs,
      error: String(error?.message || error),
    };
  }

  const stats = summary?.stats || {};
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const uploaded = results.filter((row) => row.uploaded && !row.deduped).length;
  const deduped = results.filter((row) => row.deduped).length;
  const archived = stats.archived || results.length;
  const skipped = stats.skipped || (Array.isArray(summary?.skipped) ? summary.skipped.length : 0);

  return {
    dateKey,
    ok: true,
    elapsedMs,
    legacyRows: stats.legacyRowsFetched || 0,
    rcRecords: stats.rcRecordsFetched || 0,
    callrailCalls: stats.callrailCallsFetched || 0,
    tasks: stats.tasksProcessed || 0,
    archived,
    uploaded,
    deduped,
    skipped,
    fullyDeduped: archived > 0 && uploaded === 0,
    empty: archived === 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startOffset = intArg(args["start-offset"], 2);
  const days = Math.max(intArg(args.days, 30), 1);
  const writeLocal = boolArg(args["write-local"], false);
  const minDurationSec = intArg(args["min-duration"], undefined);
  const stopFullyDeduped = Math.max(intArg(args["stop-on-fully-deduped"], 3), 0);
  const stopEmpty = Math.max(intArg(args["stop-on-empty"], 0), 0);
  const delayBetweenDaysMs = Math.max(intArg(args["between-days-ms"], 1500), 0);
  const weekdaysOnly = boolArg(args["weekdays-only"], true);

  const baseOptions = {
    writeLocal,
    sendCompletionNotice: false,
  };
  if (minDurationSec !== undefined) {
    baseOptions.minDurationSec = minDurationSec;
  }

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    event: "backfill-start",
    startOffset,
    days,
    writeLocal,
    stopFullyDeduped,
    stopEmpty,
    weekdaysOnly,
  }));

  const summaries = [];
  let consecutiveFullyDeduped = 0;
  let consecutiveEmpty = 0;
  let lastError = null;
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

    if (!summary.ok) {
      lastError = summary.error;
      // Single-day failure shouldn't kill the whole backfill — keep
      // walking. The per-day JSON summary on disk is the authoritative
      // record either way.
      consecutiveFullyDeduped = 0;
      consecutiveEmpty = 0;
    } else {
      if (summary.fullyDeduped) {
        consecutiveFullyDeduped += 1;
      } else {
        consecutiveFullyDeduped = 0;
      }
      if (summary.empty) {
        consecutiveEmpty += 1;
      } else {
        consecutiveEmpty = 0;
      }
    }

    if (stopFullyDeduped > 0 && consecutiveFullyDeduped >= stopFullyDeduped) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        event: "stop",
        reason: "consecutive-fully-deduped",
        consecutive: consecutiveFullyDeduped,
      }));
      break;
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
      acc.skipped += summary.skipped || 0;
      acc.archived += summary.archived || 0;
      return acc;
    },
    { uploaded: 0, deduped: 0, skipped: 0, archived: 0, failed: 0 },
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    event: "backfill-complete",
    daysProcessed: summaries.length,
    totals,
    lastError,
  }));
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
