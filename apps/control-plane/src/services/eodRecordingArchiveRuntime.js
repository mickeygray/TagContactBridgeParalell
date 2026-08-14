"use strict";

const {
  runArchiveEodRecordings,
} = require("../../../../scripts/archive-eod-recordings");
const {
  waitForRecordingPipelineIdle,
} = require("../../../../packages/shared-services/src/recordingPipelineIdleService");

const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);
// Retained only for rollback during the no-delete proof window. Production is
// links-only: this runtime may neither arm its timer nor download audio.
const AUTOMATED_RECORDING_DOWNLOADS_ENABLED = false;

function normalizeActiveWeekdays(values = null) {
  const source = Array.isArray(values) && values.length > 0
    ? values
    : DEFAULT_WEEKDAYS;
  const normalized = [...new Set(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 5),
  )];
  return normalized.length > 0 ? normalized : [...DEFAULT_WEEKDAYS];
}

function computeNextRunAt(
  hour,
  minute,
  timezone = "America/Los_Angeles",
  now = new Date(),
  options = {},
) {
  const activeWeekdays = new Set(normalizeActiveWeekdays(options.activeWeekdays));
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const candidate = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`,
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }
  for (let attempts = 0; attempts < 8; attempts += 1) {
    if (activeWeekdays.has(candidate.getDay())) {
      return candidate;
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }
  return candidate;
}

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled) && AUTOMATED_RECORDING_DOWNLOADS_ENABLED,
    running: false,
    hour: Number(config.hour || 21),
    minute: Number(config.minute || 30),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    minDurationSec: Number(config.minDurationSec || 480),
    writeLocal: config.writeLocal !== false,
    emailCompanyKey: String(config.emailCompanyKey || "TAG").toUpperCase(),
    notifyRecipients: Array.isArray(config.notifyRecipients) ? config.notifyRecipients : [],
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
  };
}

function envBool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function summarizeState(state) {
  return {
    enabled: state.enabled,
    running: state.running,
    hour: state.hour,
    minute: state.minute,
    timezone: state.timezone,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    minDurationSec: state.minDurationSec,
    writeLocal: state.writeLocal,
    emailCompanyKey: state.emailCompanyKey,
    notifyRecipients: state.notifyRecipients,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

function createEodRecordingArchiveRuntime({ config = {}, runtime }) {
  const state = createState(config);

  async function runArchive(options = {}) {
    if (!AUTOMATED_RECORDING_DOWNLOADS_ENABLED) {
      return {
        ok: true,
        skipped: true,
        reason: "retired-links-only",
        state: summarizeState(state),
      };
    }
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "eod-recording-archive-already-running",
        state: summarizeState(state),
      };
    }

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    try {
      if (envBool("RECORDING_PIPELINE_IDLE_WAIT_ENABLED", true)) {
        await waitForRecordingPipelineIdle({
          label: "eod-recording-archive",
          pollMs: envNumber("RECORDING_PIPELINE_IDLE_POLL_MS", 60000),
          maxWaitMs: envNumber("RECORDING_PIPELINE_IDLE_MAX_WAIT_MS", 12 * 60 * 60 * 1000),
          logger: runtime.logger,
        });
      }

      const result = await runArchiveEodRecordings({
        date: options.date,
        minDurationSec:
          options.minDurationSec !== undefined
            ? options.minDurationSec
            : state.minDurationSec,
        dryRun: Boolean(options.dryRun),
        writeLocal:
          options.writeLocal !== undefined
            ? Boolean(options.writeLocal)
            : state.writeLocal,
        outputRoot: options.outputRoot,
        delayMs: options.delayMs,
        limit: options.limit,
        sendCompletionNotice:
          options.sendCompletionNotice !== undefined
            ? Boolean(options.sendCompletionNotice)
            : !options.dryRun,
        notifyRecipients:
          options.notifyRecipients !== undefined
            ? options.notifyRecipients
            : state.notifyRecipients,
        emailCompanyKey:
          options.emailCompanyKey !== undefined
            ? options.emailCompanyKey
            : state.emailCompanyKey,
      });

      state.lastCompletedAt = new Date();
      state.lastResult = {
        summaryPath: result.summaryPath,
        dateKey: result.summary?.dateKey || null,
        archived: result.summary?.stats?.archived || 0,
        skipped: result.summary?.stats?.skipped || 0,
        email: result.summary?.email || null,
      };
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      runtime.logger.info("recording-archive.eod.completed", state.lastResult);
      return result;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastResult = null;
      state.lastError = error.message;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );
      runtime.logger.error("recording-archive.eod.failed", {
        error: error.message,
      });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    state.enabled = Boolean(config.enabled) && AUTOMATED_RECORDING_DOWNLOADS_ENABLED;
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone, new Date(), {
      activeWeekdays: state.activeWeekdays,
    });

    if (!state.enabled) {
      runtime.logger.warn("recording-archive.eod.disabled");
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runArchive({ scheduled: true });
      } catch {
        // Logged in runArchive.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);

    if (typeof state.timer.unref === "function") {
      state.timer.unref();
    }

    runtime.logger.info("recording-archive.eod.armed", {
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      minDurationSec: state.minDurationSec,
      nextRunAt: state.nextRunAt,
      notifyRecipients: state.notifyRecipients,
    });
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return {
    getState: () => summarizeState(state),
    runArchive,
    start,
    stop,
  };
}

module.exports = {
  AUTOMATED_RECORDING_DOWNLOADS_ENABLED,
  computeNextRunAt,
  createEodRecordingArchiveRuntime,
  normalizeActiveWeekdays,
};
