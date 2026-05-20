"use strict";

const {
  ingestLatestLexisDrop,
  recordServiceAlert,
  recordWorkflowStage,
  sendLexisRegionalMail,
} = require("../../../../packages/shared-services/src");

const DEFAULT_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);

function normalizeActiveWeekdays(values = null) {
  const source = Array.isArray(values) && values.length > 0
    ? values
    : DEFAULT_WEEKDAYS;
  const normalized = [...new Set(
    source
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
  )];
  return normalized.length > 0 ? normalized : [...DEFAULT_WEEKDAYS];
}

function getZonedDateParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdayMap[parts.weekday] ?? date.getUTCDay(),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function addDaysToLocalDate(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(date, timezone) {
  const parts = getZonedDateParts(date, timezone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedWallClockToUtc(parts, timezone) {
  const utcGuess = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    0,
    0,
  ));
  const firstOffset = getTimeZoneOffsetMs(utcGuess, timezone);
  let result = new Date(utcGuess.getTime() - firstOffset);
  const secondOffset = getTimeZoneOffsetMs(result, timezone);
  if (secondOffset !== firstOffset) {
    result = new Date(utcGuess.getTime() - secondOffset);
  }
  return result;
}

function computeNextRunAt(hour, minute, now = new Date(), options = {}) {
  const timezone = options.timezone || options.timeZone || "America/Los_Angeles";
  const activeWeekdays = new Set(normalizeActiveWeekdays(options.activeWeekdays));
  const nowParts = getZonedDateParts(now, timezone);
  let dateParts = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
  };
  let next = zonedWallClockToUtc({ ...dateParts, hour, minute }, timezone);
  if (next.getTime() <= now.getTime()) {
    dateParts = addDaysToLocalDate(dateParts, 1);
    next = zonedWallClockToUtc({ ...dateParts, hour, minute }, timezone);
  }
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const nextParts = getZonedDateParts(next, timezone);
    if (activeWeekdays.has(nextParts.weekday)) {
      return next;
    }
    dateParts = addDaysToLocalDate(dateParts, 1);
    next = zonedWallClockToUtc({ ...dateParts, hour, minute }, timezone);
  }
  return next;
}

function createLexisNightlyState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    domain: String(config.domain || "TAG").toUpperCase(),
    hour: Number(config.hour || 2),
    minute: Number(config.minute || 0),
    intervalMs: Number(config.intervalMs || 30000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    sendRegionalMail: config.sendRegionalMail !== false,
    recipients: String(config.recipients || ""),
    subject: config.subject || "Maverick Daily Drop",
    text: config.text || "Please see the attached file.",
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
    domain: state.domain,
    hour: state.hour,
    minute: state.minute,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    sendRegionalMail: state.sendRegionalMail,
    recipients: state.recipients
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

function createLexisNightlyRuntime({ config, runtime }) {
  const state = createLexisNightlyState(config);

  async function runNightlyLexisFlow(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "lexis-nightly-already-running",
        state: summarizeState(state),
      };
    }

    const domain = String(options.domain || state.domain || "TAG").toUpperCase();
    const sendRegionalMail = options.sendRegionalMail !== undefined
      ? Boolean(options.sendRegionalMail)
      : state.sendRegionalMail;
    const runKey = `lexis-nightly-${domain}-${Date.now()}`;

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "nightly-drop",
      stage: "requested",
      aggregateType: "lexis-drop",
      aggregateId: runKey,
      sourceService: "control-plane",
      title: "Lexis nightly run started",
      summary: `Beginning Lexis nightly pipeline for ${domain}`,
      payload: {
        domain,
        scheduled: Boolean(options.scheduled),
        sendRegionalMail,
      },
    });

    try {
      const ingestResult = await ingestLatestLexisDrop({
        domain,
        sourceService: "control-plane",
        importBatch: options.importBatch,
      });

      const regionalMailResult = sendRegionalMail
        ? await sendLexisRegionalMail({
            domain,
            recipients: options.recipients || state.recipients,
            subject: options.subject || state.subject,
            text: options.text || state.text,
          })
        : { ok: true, skipped: true, reason: "regional-mail-disabled" };

      const result = {
        ok: true,
        domain,
        runId: ingestResult.runId,
        ingest: ingestResult,
        regionalMail: regionalMailResult,
      };

      state.lastCompletedAt = new Date();
      state.lastResult = result;
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays,
      });

      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "nightly-drop",
        stage: "completed",
        aggregateType: "lexis-drop",
        aggregateId: ingestResult.runId || runKey,
        sourceService: "control-plane",
        title: "Lexis nightly run completed",
        summary: `Processed ${ingestResult.parsedRows} Lexis rows and ${regionalMailResult.skipped ? "skipped" : "sent"} regional mail`,
        payload: {
          domain,
          ingest: ingestResult,
          regionalMail: regionalMailResult,
        },
        result,
      });

      return result;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastError = error.message;
      state.lastResult = null;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays,
      });

      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "nightly-drop",
        stage: "failed",
        aggregateType: "lexis-drop",
        aggregateId: runKey,
        sourceService: "control-plane",
        status: "failed",
        title: "Lexis nightly run failed",
        summary: error.message,
        payload: {
          domain,
          scheduled: Boolean(options.scheduled),
          sendRegionalMail,
        },
        result: {
          error: error.message,
        },
      });

      await recordServiceAlert({
        domain,
        sourceService: "control-plane",
        category: "lexis-nightly",
        severity: "critical",
        title: "Lexis nightly run failed",
        summary: error.message,
        payload: {
          domain,
          scheduled: Boolean(options.scheduled),
          sendRegionalMail,
        },
        tags: ["lexis", "sftp", "mailhouse"],
      });

      runtime.logger.error("lexis.nightly.failed", {
        domain,
        error: error.message,
      });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    state.enabled = Boolean(config.enabled);
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, new Date(), {
      activeWeekdays: state.activeWeekdays,
    });

    if (!state.enabled) {
      runtime.logger.warn("lexis.nightly.disabled", {
        domain: state.domain,
      });
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runNightlyLexisFlow({ scheduled: true, domain: state.domain });
      } catch (_error) {
        // Error already recorded into workflow/service-alert streams.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);

    if (typeof state.timer.unref === "function") {
      state.timer.unref();
    }

    runtime.logger.info("lexis.nightly.armed", {
      domain: state.domain,
      hour: state.hour,
      minute: state.minute,
      nextRunAt: state.nextRunAt,
      sendRegionalMail: state.sendRegionalMail,
      activeWeekdays: state.activeWeekdays,
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
    runNightlyLexisFlow,
    start,
    stop,
  };
}

module.exports = {
  computeNextRunAt,
  createLexisNightlyRuntime,
  normalizeActiveWeekdays,
};
