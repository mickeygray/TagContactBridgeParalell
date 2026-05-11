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

function computeNextRunAt(hour, minute, now = new Date(), options = {}) {
  const activeWeekdays = new Set(normalizeActiveWeekdays(options.activeWeekdays));
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  for (let attempts = 0; attempts < 8; attempts += 1) {
    if (activeWeekdays.has(next.getDay())) {
      return next;
    }
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
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
