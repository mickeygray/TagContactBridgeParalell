"use strict";

// RingCX rate-limit capacity probe.
//
// Purpose: characterize the rate-limit ceiling on a read-only RingCX
// endpoint for our own account, so we can build proper pacing /
// backoff into the app. Output is the first-429 timestamp + the level
// at which we got it + RC's Retry-After hint if any, written to a
// JSONL audit log under runtime/ringcx-probe/.
//
// Scope guard rails:
//   - READ-ONLY ENDPOINTS ONLY (allowlist enforced). The probe refuses
//     to point at a mutating endpoint. If we want to characterize
//     mutating endpoints later, we add them to the allowlist with a
//     conscious decision.
//   - Hard duration cap of 15 minutes (cannot be raised at the CLI).
//   - Hard request-count cap of 5000 requests (cannot be raised).
//   - Stops on the first sustained 429 (configurable threshold).
//   - SIGINT clean shutdown — Ctrl+C drains in-flight requests then
//     writes the summary record before exiting.
//   - Uses the existing RingCX bearer (no auth shenanigans) and our
//     own account credentials — same auth path the app uses daily.
//   - Logs whoami at the start so the audit log shows which account
//     was probed.
//
// Usage:
//   node scripts/probe-ringcx-rate-limit.js \
//     [--endpoint active-calls|dial-groups|agent-groups|aux-states] \
//     [--start-at HH:MM]                          # local-tz wait clock
//     [--duration-minutes 10]                     # max 15
//     [--level-seconds 30]                        # how long each rps step
//     [--levels 1,2,4,8,12,16,24,32,48,64]
//     [--max-concurrency 64]
//     [--sustained-429-levels 2]                  # stop after N consecutive
//                                                 # levels with any 429
//     [--stop-on-first-429]                       # stop immediately
//
// Examples:
//   # Default run: 10 min ramp on active-calls, ramping rps levels until
//   # we get a sustained 429.
//   node scripts/probe-ringcx-rate-limit.js
//
//   # Scheduled run at 6am PT (off-hours):
//   node scripts/probe-ringcx-rate-limit.js --start-at 06:00
//
//   # Light recon — find the FIRST 429, then stop:
//   node scripts/probe-ringcx-rate-limit.js --stop-on-first-429
//
// Operational care (these are NOT enforced — operator's call):
//   - Run during low agent activity. RingCX rate limits are PER
//     ACCOUNT, not per app. Hammering this probe during peak agent
//     activity could starve agent click-to-dial requests. Off-hours
//     (early morning, late evening, weekend) or after agents AUX-out
//     is the polite move.
//   - Tell your RingCentral CSM. They might see the elevated traffic
//     in their anomaly detection — a heads-up beats a panicked email.
//   - Once you have the threshold, write it into the ops docs and
//     stop running the probe. The job is to discover, not to live at
//     the ceiling.

const path = require("path");
const fs = require("fs");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");

// ── Hard caps (cannot be overridden at the CLI) ─────────────────
const HARD_MAX_DURATION_MS = 15 * 60 * 1000;
const HARD_MAX_REQUEST_COUNT = 5000;

// ── Read-only endpoint allowlist ────────────────────────────────
//
// Each entry maps an --endpoint name to a `(client) => Promise<any>`
// function on our existing client. ALL of these are GET-only and do
// NOT mutate any RingCX state (no dial, no disposition, no agent
// state change, no lead loader). Adding entries requires a code edit
// — operator can't choose a mutating endpoint via CLI.
const READ_ONLY_ENDPOINTS = {
  "active-calls": (client) => client.listActiveCalls(),
  "dial-groups": (client) => client.listDialGroups(),
  "agent-groups": (client) => client.listAgentGroups(),
  "aux-states": (client) => client.listAuxStates({ activeOnly: true }),
};

// ── CLI ─────────────────────────────────────────────────────────
function readArg(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}
function hasFlag(name) {
  return process.argv.slice(2).includes(name);
}

function parseStartAt(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    throw new Error(`--start-at must be HH:MM (got ${value})`);
  }
  const target = new Date();
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (target.getTime() <= Date.now()) {
    // The "5:00" target already passed — schedule for tomorrow.
    target.setDate(target.getDate() + 1);
  }
  return target;
}

function parseLevels(value) {
  const items = String(value || "")
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (items.length === 0) {
    throw new Error("--levels must be a comma-separated list of positive numbers");
  }
  return items;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(file, record) {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// ── Per-level runner ────────────────────────────────────────────
async function runLevel({
  client,
  endpointFn,
  endpointName,
  rps,
  levelMs,
  maxConcurrency,
  globalCap,
  logFile,
  abortRef,
}) {
  const spacingMs = 1000 / rps;
  const startedAt = Date.now();
  const endsAt = startedAt + levelMs;

  const stats = {
    type: "level-stats",
    endpoint: endpointName,
    rps,
    levelMs,
    startedAt: new Date(startedAt).toISOString(),
    attempted: 0,
    ok: 0,
    rateLimited: 0,
    errors: 0,
    statuses: {},
    totalLatencyMs: 0,
    firstRateLimitedAt: null,
    firstRetryAfter: null,
  };

  const inFlight = new Set();
  let nextDueAt = Date.now();

  async function fireOne() {
    if (globalCap.count >= HARD_MAX_REQUEST_COUNT) {
      abortRef.value = "hard-request-cap";
      return;
    }
    globalCap.count += 1;
    stats.attempted += 1;
    const startedReq = Date.now();
    try {
      await endpointFn(client);
      stats.ok += 1;
      stats.statuses["200"] = (stats.statuses["200"] || 0) + 1;
      stats.totalLatencyMs += Date.now() - startedReq;
    } catch (err) {
      const status = Number(err?.status || err?.details?.responseStatus || 0);
      stats.statuses[String(status || "error")] =
        (stats.statuses[String(status || "error")] || 0) + 1;
      stats.totalLatencyMs += Date.now() - startedReq;
      if (status === 429) {
        stats.rateLimited += 1;
        if (!stats.firstRateLimitedAt) {
          stats.firstRateLimitedAt = nowIso();
          stats.firstRetryAfter = err?.details?.retryAfter || null;
          appendJsonl(logFile, {
            type: "first-429",
            at: stats.firstRateLimitedAt,
            endpoint: endpointName,
            rps,
            retryAfter: stats.firstRetryAfter,
          });
        }
      } else {
        stats.errors += 1;
      }
    }
  }

  while (Date.now() < endsAt) {
    if (abortRef.value) break;
    while (
      Date.now() >= nextDueAt &&
      inFlight.size < maxConcurrency &&
      !abortRef.value &&
      globalCap.count < HARD_MAX_REQUEST_COUNT
    ) {
      const p = fireOne().finally(() => inFlight.delete(p));
      inFlight.add(p);
      nextDueAt += spacingMs;
    }
    await sleep(10);
  }
  await Promise.allSettled(Array.from(inFlight));
  stats.completedAt = nowIso();
  stats.avgLatencyMs =
    stats.attempted > 0
      ? Math.round(stats.totalLatencyMs / stats.attempted)
      : 0;
  return stats;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const endpointName = String(readArg("--endpoint", "active-calls")).trim();
  const endpointFn = READ_ONLY_ENDPOINTS[endpointName];
  if (!endpointFn) {
    console.error(
      `ERROR: --endpoint must be one of: ${Object.keys(READ_ONLY_ENDPOINTS).join(", ")}\n` +
        `       (got "${endpointName}")\n` +
        `       Mutating endpoints are intentionally NOT exposed here.`,
    );
    process.exit(1);
  }

  const startAt = parseStartAt(readArg("--start-at", ""));
  let durationMs =
    Number(readArg("--duration-minutes", "10")) * 60 * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("--duration-minutes must be a positive number");
  }
  if (durationMs > HARD_MAX_DURATION_MS) {
    console.warn(
      `[probe] --duration-minutes clamped to hard cap (${HARD_MAX_DURATION_MS / 60_000} min)`,
    );
    durationMs = HARD_MAX_DURATION_MS;
  }

  const levelMs = Number(readArg("--level-seconds", "30")) * 1000;
  if (!Number.isFinite(levelMs) || levelMs <= 0) {
    throw new Error("--level-seconds must be positive");
  }

  const levels = parseLevels(
    readArg("--levels", "1,2,4,8,12,16,24,32,48,64"),
  );
  const maxConcurrency = Math.max(
    1,
    Number(readArg("--max-concurrency", "64")) || 64,
  );
  const stopOnFirst429 = hasFlag("--stop-on-first-429");
  const sustained429Levels = Math.max(
    1,
    Number(readArg("--sustained-429-levels", "2")) || 2,
  );

  // Output paths
  const outDir = path.resolve(__dirname, "..", "runtime", "ringcx-probe");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const logFile = path.join(outDir, `probe-${endpointName}-${stamp}.jsonl`);

  const config = {
    endpoint: endpointName,
    startAt: startAt ? startAt.toISOString() : null,
    durationMs,
    levelMs,
    levels,
    maxConcurrency,
    stopOnFirst429,
    sustained429Levels,
    hardCaps: {
      maxDurationMs: HARD_MAX_DURATION_MS,
      maxRequestCount: HARD_MAX_REQUEST_COUNT,
    },
    logFile,
  };
  console.log(JSON.stringify({ type: "config", ...config }, null, 2));
  appendJsonl(logFile, { type: "config", at: nowIso(), config });

  // Wait until --start-at if scheduled
  if (startAt && startAt.getTime() > Date.now()) {
    const waitMs = startAt.getTime() - Date.now();
    console.log(
      `[probe] Waiting ${Math.round(waitMs / 1000)}s until ${startAt.toString()}`,
    );
    appendJsonl(logFile, {
      type: "wait-until",
      at: nowIso(),
      target: startAt.toISOString(),
      waitMs,
    });
    await sleep(waitMs);
  }

  // Sanity check: whoami so the audit log captures who we're testing as
  const client = createRingcxVoiceClient();
  const whoami = await client.auth.whoami();
  console.log(JSON.stringify({ type: "auth-ok", whoami }, null, 2));
  appendJsonl(logFile, { type: "auth-ok", at: nowIso(), whoami });

  // SIGINT handler — drain + summary on Ctrl+C
  const abortRef = { value: null };
  process.on("SIGINT", () => {
    if (!abortRef.value) {
      abortRef.value = "sigint";
      console.log("\n[probe] SIGINT — draining…");
    }
  });

  const startedAt = Date.now();
  const endsAt = startedAt + durationMs;
  const globalCap = { count: 0 };
  const levelResults = [];
  let firstSustained429Level = null;
  let consecutive429Levels = 0;

  for (let i = 0; Date.now() < endsAt; i += 1) {
    if (abortRef.value) break;
    const rps = levels[Math.min(i, levels.length - 1)];
    const remainingMs = Math.max(endsAt - Date.now(), 0);
    const thisLevelMs = Math.min(levelMs, remainingMs);
    console.log(
      `[probe] level ${i + 1}: ${rps} rps for ${Math.round(thisLevelMs / 1000)}s`,
    );
    const stats = await runLevel({
      client,
      endpointFn,
      endpointName,
      rps,
      levelMs: thisLevelMs,
      maxConcurrency,
      globalCap,
      logFile,
      abortRef,
    });
    levelResults.push(stats);
    appendJsonl(logFile, { type: "level", at: nowIso(), stats });
    console.log(
      `  → attempted=${stats.attempted} ok=${stats.ok} 429=${stats.rateLimited} errors=${stats.errors} avgMs=${stats.avgLatencyMs}`,
    );

    if (stats.rateLimited > 0) {
      consecutive429Levels += 1;
      if (consecutive429Levels === 1) firstSustained429Level = stats.rps;
    } else {
      consecutive429Levels = 0;
    }

    if (stopOnFirst429 && stats.rateLimited > 0) {
      console.log("[probe] --stop-on-first-429: halting after first 429 level");
      break;
    }
    if (consecutive429Levels >= sustained429Levels) {
      console.log(
        `[probe] sustained ${consecutive429Levels} consecutive levels with 429 — halting`,
      );
      break;
    }
    if (globalCap.count >= HARD_MAX_REQUEST_COUNT) {
      console.log("[probe] hit hard request-count cap — halting");
      break;
    }
  }

  // Summarize
  const lastCleanLevel = [...levelResults]
    .reverse()
    .find((row) => Number(row.rateLimited || 0) === 0);
  const firstLimitedLevel = levelResults.find(
    (row) => Number(row.rateLimited || 0) > 0,
  );
  const totals = levelResults.reduce(
    (acc, row) => {
      acc.attempted += row.attempted;
      acc.ok += row.ok;
      acc.rateLimited += row.rateLimited;
      acc.errors += row.errors;
      for (const [k, v] of Object.entries(row.statuses)) {
        acc.statuses[k] = (acc.statuses[k] || 0) + v;
      }
      return acc;
    },
    { attempted: 0, ok: 0, rateLimited: 0, errors: 0, statuses: {} },
  );
  const summary = {
    type: "summary",
    endpoint: endpointName,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: nowIso(),
    elapsedMs: Date.now() - startedAt,
    abortReason: abortRef.value || null,
    totals,
    lastCleanRps: lastCleanLevel?.rps || null,
    firstLimitedRps: firstLimitedLevel?.rps || null,
    firstSustained429Level,
    levelCount: levelResults.length,
    logFile,
  };
  appendJsonl(logFile, summary);
  console.log("\n========= PROBE SUMMARY =========");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Full audit log: ${logFile}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.details) console.error(err.details);
  process.exit(1);
});
