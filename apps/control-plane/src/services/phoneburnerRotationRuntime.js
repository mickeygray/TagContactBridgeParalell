"use strict";

// 7am PhoneBurner folder rotation. Spawns the legacy
// `TagContactBridge/scripts/run-pb-morning-rotation.js` once per
// weekday morning and parses its result envelope into a workflow
// stage so the Parallel observability surface (and tomorrow's
// nightly close email) reflects whether PB folders rotated cleanly.
//
// Runs Mon–Fri only (matches legacy `0 7 * * 1-5`). Skips weekends.
// Idempotent against same-day re-fire because cascadeByAge inside
// the legacy pbService only moves leads whose caseAge is past the
// threshold — a second run finds nothing to cascade.
//
// Lifetime: this is a *bridge* runtime. When PhoneBurner is fully
// deprecated by CX dialing, delete this file + the legacy wrapper
// script + the cron-schedule env vars. Until then, it owns the
// schedule so legacy webhook.js's cron can be commented out without
// losing the daily folder-management work.

const path = require("path");
const { spawn } = require("child_process");
const { recordWorkflowStage } = require("../../../../packages/shared-services/src");

const LEGACY_SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "TagContactBridge",
  "scripts",
  "run-pb-morning-rotation.js",
);

function computeNextRunAt(hour, minute, timezone = "America/Los_Angeles", now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  let candidate = (function build(forNow) {
    const parts = Object.fromEntries(
      formatter.formatToParts(forNow).map((p) => [p.type, p.value]),
    );
    return new Date(
      `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
    );
  })(now);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  // Skip Sat (6) and Sun (0). Walk forward until we hit a weekday.
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const dayParts = Object.fromEntries(
      formatter.formatToParts(candidate).map((p) => [p.type, p.value]),
    );
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[dayParts.weekday];
    if (weekday >= 1 && weekday <= 5) return candidate;
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    hour: Number(config.hour ?? 7),
    minute: Number(config.minute ?? 0),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60_000),
    domains: Array.isArray(config.domains) && config.domains.length > 0
      ? config.domains.map((value) => String(value).toUpperCase())
      : ["WYNN"],
    legacyScriptPath: config.legacyScriptPath || LEGACY_SCRIPT_PATH,
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
  };
}

function summarizeState(state) {
  return {
    enabled: state.enabled,
    running: state.running,
    hour: state.hour,
    minute: state.minute,
    timezone: state.timezone,
    domains: state.domains,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

// Run the legacy wrapper script for one company. Returns the parsed
// result envelope from the script's stdout (last line marked with
// __PARALLEL_RESULT_ENVELOPE__:). On non-zero exit or unparseable
// envelope, returns an error-shaped envelope so the caller can stamp
// a failed workflow stage.
function runOnceForDomain(scriptPath, domain, runtime) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, domain], {
      cwd: path.dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuffer += text;
      // Forward human-readable lines into the structured logger so
      // operator can scan progress without cracking the legacy log
      // file.
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("__PARALLEL_RESULT_ENVELOPE__:")) continue;
        runtime.logger.info("phoneburner.rotation.stdout", { domain, line: trimmed });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        ok: false,
        domain,
        error: `spawn error: ${error.message}`,
        stderr: stderrBuffer.slice(0, 1000),
      });
    });

    child.on("exit", (code) => {
      // Find the envelope line. Last one wins if multiple printed.
      const envelopeLine = stdoutBuffer
        .split("\n")
        .reverse()
        .find((line) => line.includes("__PARALLEL_RESULT_ENVELOPE__:"));
      let envelope = null;
      if (envelopeLine) {
        const jsonStr = envelopeLine.split("__PARALLEL_RESULT_ENVELOPE__:")[1];
        try {
          envelope = JSON.parse(jsonStr);
        } catch {
          envelope = null;
        }
      }
      if (envelope) {
        resolve({ ...envelope, exitCode: code });
        return;
      }
      resolve({
        ok: false,
        domain,
        exitCode: code,
        error: `script exited ${code} without parseable envelope`,
        stdoutTail: stdoutBuffer.slice(-1000),
        stderrTail: stderrBuffer.slice(-1000),
      });
    });
  });
}

function createPhoneburnerRotationRuntime({ config = {}, runtime }) {
  const state = createState(config);

  async function runRotation(options = {}) {
    if (state.running) {
      return { ok: false, skipped: true, reason: "phoneburner-rotation-already-running" };
    }
    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    const domains = Array.isArray(options.domains) && options.domains.length > 0
      ? options.domains.map((d) => String(d).toUpperCase())
      : state.domains;

    const results = [];
    try {
      for (const domain of domains) {
        const r = await runOnceForDomain(state.legacyScriptPath, domain, runtime);
        results.push(r);
        await recordWorkflowStage({
          domain,
          family: "phoneburner",
          subtype: "morning-rotation",
          stage: r.ok ? "completed" : "failed",
          aggregateType: "phoneburner-folder-rotation",
          aggregateId: `${domain}-${state.lastStartedAt.toISOString().slice(0, 10)}`,
          sourceService: "control-plane",
          title: r.ok ? "PhoneBurner morning rotation completed" : "PhoneBurner morning rotation failed",
          summary: r.ok
            ? `${r.summary?.unpushed_to_hot?.pushed || 0} pushed to HOT, ${r.summary?.hot_to_day1?.moved || 0} HOT→DAY1, ${r.summary?.day1_to_day2?.moved || 0} DAY1→DAY2, ${r.summary?.day2_to_day3_10?.moved || 0} DAY2→DAY3_10, ${r.summary?.day3_10_to_day10_plus?.moved || 0} DAY3_10→DAY10+, ${r.summary?.transfer?.bounced || 0} TRANSFER bounced`
            : `Spawn/exec failed: ${r.error || "unknown"}`,
          payload: { domains: state.domains },
          result: r,
        }).catch(() => null);
      }
      state.lastCompletedAt = new Date();
      state.lastResult = { domains, results };
      runtime.logger.info("phoneburner.rotation.completed", { domains, results: results.map((r) => ({ domain: r.domain, ok: r.ok })) });
      return { ok: true, domains, results };
    } catch (error) {
      state.lastError = error.message;
      runtime.logger.error("phoneburner.rotation.failed", { error: error.message });
      return { ok: false, error: error.message };
    } finally {
      state.running = false;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone);
    }
  }

  async function start() {
    if (!state.enabled) {
      runtime.logger.warn("phoneburner.rotation.disabled", {
        reason: "PHONEBURNER_ROTATION_ENABLED not set; legacy webhook.js cron may still own this work",
      });
      return summarizeState(state);
    }
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone);

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      await runRotation().catch((error) => {
        runtime.logger.error("phoneburner.rotation.tick_failed", { error: error.message });
      });
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();

    runtime.logger.info("phoneburner.rotation.armed", {
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      domains: state.domains,
      nextRunAt: state.nextRunAt,
    });
    return summarizeState(state);
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    // Wait briefly for an in-flight rotation to finish before returning
    // — same shutdown discipline as the other workers.
    const deadline = Date.now() + 25_000;
    while (state.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function getState() {
    return summarizeState(state);
  }

  return {
    start,
    stop,
    getState,
    runRotation,
  };
}

module.exports = {
  createPhoneburnerRotationRuntime,
  computeNextRunAt,
};
