"use strict";

/*
 * Controlled RingCX 429 probe.
 *
 * Default behavior:
 *   - waits until the requested local start time if supplied
 *   - uses read-only RingCX admin endpoints
 *   - ramps request rate by level
 *   - stops at duration or after a sustained 429 window
 *   - writes JSONL samples plus a summary to out/
 *
 * Example:
 *   node scripts/stress-ringcx-rate-limit.js --start-at 17:00 --duration-minutes 10
 */

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { createRingcxVoiceClient } = require("../packages/shared-integrations/src/ringcxVoiceClient");

const DEFAULT_LEVELS = "1,2,4,8,12,16,24,32,48,64";

function readArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLevels(raw) {
  return String(raw || DEFAULT_LEVELS)
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function formatStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function localDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function parseStartAt(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const absolute = new Date(value);
  if (!Number.isNaN(absolute.getTime())) return absolute;

  const match = value.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    throw new Error(`Could not parse --start-at "${value}". Use HH:mm, e.g. 17:00.`);
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const second = Number(match[3] || 0);
  const ampm = String(match[4] || "").toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid --start-at "${value}".`);
  }

  // Windows local timezone on this machine is PT; this keeps the script
  // simple and matches the user's requested "5 exact" local window.
  const [year, month, day] = localDateKey(new Date()).split("-").map(Number);
  let target = new Date(year, month - 1, day, hour, minute, second, 0);
  if (target.getTime() < Date.now() - 5_000) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }
  return target;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(error) {
  return {
    message: error?.message || String(error),
    status: Number(error?.status || error?.details?.responseStatus || 0) || null,
    responseStatus: Number(error?.details?.responseStatus || 0) || null,
    retryAfter: error?.details?.retryAfter || null,
    retryable: Boolean(error?.retryable ?? error?.details?.retryable),
  };
}

function is429(error) {
  const status = Number(error?.status || error?.details?.responseStatus || 0);
  return status === 429;
}

function appendJsonl(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

async function callProbeEndpoint(client, endpoint) {
  if (endpoint === "aux-states") {
    return client.listAuxStates({ activeOnly: true });
  }
  if (endpoint === "dial-groups") {
    return client.listDialGroups();
  }
  return client.listActiveCalls();
}

async function runLevel({ client, endpoint, rps, levelMs, maxConcurrency, logFile, stopOnFirst429 }) {
  const startedAt = Date.now();
  const endsAt = startedAt + levelMs;
  const spacingMs = Math.max(1000 / rps, 1);
  let nextDueAt = startedAt;
  let sequence = 0;
  let inFlight = 0;
  let first429 = null;
  const stats = {
    rps,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: null,
    attempted: 0,
    ok: 0,
    rateLimited: 0,
    errors: 0,
    minLatencyMs: null,
    maxLatencyMs: 0,
    totalLatencyMs: 0,
    retryAfterValues: {},
    statuses: {},
  };
  const pending = new Set();

  const launch = () => {
    sequence += 1;
    stats.attempted += 1;
    inFlight += 1;
    const requestStarted = Date.now();
    const p = callProbeEndpoint(client, endpoint)
      .then(() => {
        const latencyMs = Date.now() - requestStarted;
        stats.ok += 1;
        stats.statuses["2xx"] = Number(stats.statuses["2xx"] || 0) + 1;
        stats.totalLatencyMs += latencyMs;
        stats.minLatencyMs = stats.minLatencyMs == null ? latencyMs : Math.min(stats.minLatencyMs, latencyMs);
        stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
      })
      .catch((error) => {
        const latencyMs = Date.now() - requestStarted;
        const summary = summarizeError(error);
        const statusKey = summary.responseStatus || summary.status || "error";
        stats.statuses[statusKey] = Number(stats.statuses[statusKey] || 0) + 1;
        stats.totalLatencyMs += latencyMs;
        stats.minLatencyMs = stats.minLatencyMs == null ? latencyMs : Math.min(stats.minLatencyMs, latencyMs);
        stats.maxLatencyMs = Math.max(stats.maxLatencyMs, latencyMs);
        if (is429(error)) {
          stats.rateLimited += 1;
          const retryKey = String(summary.retryAfter || "none");
          stats.retryAfterValues[retryKey] = Number(stats.retryAfterValues[retryKey] || 0) + 1;
          if (!first429) {
            first429 = {
              at: new Date().toISOString(),
              rps,
              sequence,
              latencyMs,
              error: summary,
            };
            appendJsonl(logFile, { type: "first-429", ...first429 });
          }
        } else {
          stats.errors += 1;
          appendJsonl(logFile, {
            type: "error",
            at: new Date().toISOString(),
            rps,
            sequence,
            latencyMs,
            error: summary,
          });
        }
      })
      .finally(() => {
        inFlight -= 1;
        pending.delete(p);
      });
    pending.add(p);
  };

  while (Date.now() < endsAt) {
    while (Date.now() >= nextDueAt && inFlight < maxConcurrency) {
      launch();
      nextDueAt += spacingMs;
      if (stopOnFirst429 && first429) break;
    }
    if (stopOnFirst429 && first429) break;
    await sleep(10);
  }

  await Promise.allSettled(Array.from(pending));
  stats.completedAt = new Date().toISOString();
  stats.avgLatencyMs = stats.attempted > 0 ? Math.round(stats.totalLatencyMs / stats.attempted) : 0;
  return { stats, first429 };
}

async function main() {
  const startAt = parseStartAt(readArg("--start-at", ""));
  const durationMs = parsePositiveNumber(readArg("--duration-minutes", "10"), 10) * 60 * 1000;
  const levelMs = parsePositiveNumber(readArg("--level-seconds", "30"), 30) * 1000;
  const levels = parseLevels(readArg("--levels", DEFAULT_LEVELS));
  const endpoint = String(readArg("--endpoint", "active-calls")).trim().toLowerCase();
  const maxConcurrency = Math.max(1, Math.floor(parsePositiveNumber(readArg("--max-concurrency", "80"), 80)));
  const stopOnFirst429 = hasFlag("--stop-on-first-429");
  const stopAfterSustained429 = String(readArg("--stop-after-sustained-429", "true")).toLowerCase() !== "false";
  const sustained429Levels = Math.max(1, Math.floor(parsePositiveNumber(readArg("--sustained-429-levels", "2"), 2)));
  const outDir = path.resolve(process.cwd(), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, `ringcx-429-probe-${formatStamp()}.jsonl`);

  const config = {
    startAt: startAt ? startAt.toISOString() : null,
    durationMs,
    levelMs,
    levels,
    endpoint,
    maxConcurrency,
    stopOnFirst429,
    stopAfterSustained429,
    sustained429Levels,
    logFile,
  };
  console.log(JSON.stringify({ type: "config", ...config }, null, 2));
  appendJsonl(logFile, { type: "config", at: new Date().toISOString(), config });

  if (startAt && startAt.getTime() > Date.now()) {
    const waitMs = startAt.getTime() - Date.now();
    console.log(`Waiting ${Math.round(waitMs / 1000)}s until ${startAt.toString()}`);
    await sleep(waitMs);
  }

  const client = createRingcxVoiceClient();
  const whoami = await client.auth.whoami();
  console.log(JSON.stringify({ type: "auth-ok", whoami }, null, 2));
  appendJsonl(logFile, { type: "auth-ok", at: new Date().toISOString(), whoami });

  const startedAt = Date.now();
  const endsAt = startedAt + durationMs;
  let first429 = null;
  let consecutive429Levels = 0;
  const levelResults = [];

  for (let i = 0; Date.now() < endsAt; i += 1) {
    const rps = levels[Math.min(i, levels.length - 1)];
    const remainingMs = Math.max(endsAt - Date.now(), 0);
    const thisLevelMs = Math.min(levelMs, remainingMs);
    console.log(`Level ${i + 1}: ${rps} rps for ${Math.round(thisLevelMs / 1000)}s`);
    const { stats, first429: levelFirst429 } = await runLevel({
      client,
      endpoint,
      rps,
      levelMs: thisLevelMs,
      maxConcurrency,
      logFile,
      stopOnFirst429,
    });
    if (levelFirst429 && !first429) first429 = levelFirst429;
    if (stats.rateLimited > 0) consecutive429Levels += 1;
    else consecutive429Levels = 0;
    levelResults.push(stats);
    appendJsonl(logFile, { type: "level", at: new Date().toISOString(), stats });
    console.log(JSON.stringify({ type: "level", stats }, null, 2));
    if (stopOnFirst429 && first429) break;
    if (stopAfterSustained429 && consecutive429Levels >= sustained429Levels) {
      console.log(`Stopping after ${consecutive429Levels} consecutive 429 levels.`);
      break;
    }
  }

  const totals = levelResults.reduce(
    (acc, row) => {
      acc.attempted += Number(row.attempted || 0);
      acc.ok += Number(row.ok || 0);
      acc.rateLimited += Number(row.rateLimited || 0);
      acc.errors += Number(row.errors || 0);
      for (const [key, value] of Object.entries(row.statuses || {})) {
        acc.statuses[key] = Number(acc.statuses[key] || 0) + Number(value || 0);
      }
      return acc;
    },
    { attempted: 0, ok: 0, rateLimited: 0, errors: 0, statuses: {} },
  );
  const lastCleanLevel = [...levelResults].reverse().find((row) => Number(row.rateLimited || 0) === 0);
  const firstLimitedLevel = levelResults.find((row) => Number(row.rateLimited || 0) > 0);
  const summary = {
    type: "summary",
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    endpoint,
    totals,
    first429,
    lastCleanRps: lastCleanLevel?.rps || null,
    firstLimitedRps: firstLimitedLevel?.rps || null,
    logFile,
  };
  appendJsonl(logFile, summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ type: "fatal", at: new Date().toISOString(), error: summarizeError(error) }, null, 2));
  process.exit(1);
});
