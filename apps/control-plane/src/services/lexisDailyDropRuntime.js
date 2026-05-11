"use strict";

const {
  recordServiceAlert,
  recordWorkflowStage,
  sendLexisDailyDropMail,
} = require("../../../../packages/shared-services/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./lexisNightlyService");

function createLexisDailyDropState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    domain: String(config.domain || "TAG").toUpperCase(),
    hour: Number(config.hour || 2),
    minute: Number(config.minute || 0),
    intervalMs: Number(config.intervalMs || 30000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    recipients: String(config.recipients || ""),
    alertRecipients: String(config.alertRecipients || ""),
    subject: config.subject || "Daily Drop",
    text: config.text || "Please see the attached file.",
    alertSubject: config.alertSubject || "",
    alertText: config.alertText || "",
    timezone: config.timezone || "America/Los_Angeles",
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
    timezone: state.timezone,
    recipients: String(state.recipients || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    alertRecipients: String(state.alertRecipients || "")
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

function createLexisDailyDropRuntime({ config, runtime }) {
  const state = createLexisDailyDropState(config);

  async function runDailyDrop(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "lexis-daily-drop-already-running",
        state: summarizeState(state),
      };
    }

    const domain = String(options.domain || state.domain || "TAG").toUpperCase();
    const runKey = `lexis-daily-drop-${domain}-${Date.now()}`;

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    await recordWorkflowStage({
      domain,
      family: "lexis",
      subtype: "daily-drop-runtime",
      stage: "requested",
      aggregateType: "lexis-daily-drop-runtime",
      aggregateId: runKey,
      sourceService: "control-plane",
      title: "Lexis daily drop runtime started",
      summary: `Beginning daily drop send for ${domain}`,
      payload: {
        domain,
        scheduled: Boolean(options.scheduled),
      },
    });

    try {
      const result = await sendLexisDailyDropMail({
        domain,
        sourceService: "control-plane",
        scheduled: Boolean(options.scheduled),
        force: Boolean(options.force),
        emitRetryOnFailure:
          options.emitRetryOnFailure !== undefined
            ? Boolean(options.emitRetryOnFailure)
            : Boolean(options.scheduled),
        recipients:
          options.recipients !== undefined ? options.recipients : state.recipients,
        alertRecipients:
          options.alertRecipients !== undefined
            ? options.alertRecipients
            : state.alertRecipients || state.recipients,
        subject: options.subject || state.subject,
        text: options.text || state.text,
        alertSubject: options.alertSubject || state.alertSubject,
        alertText: options.alertText || state.alertText,
        ignoreConfiguredRecipients: Boolean(options.ignoreConfiguredRecipients),
        ignoreConfiguredAlertRecipients: Boolean(options.ignoreConfiguredAlertRecipients),
        timezone: options.timezone || state.timezone,
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        remoteDir: options.remoteDir,
        zipPassword: options.zipPassword,
      });

      state.lastCompletedAt = new Date();
      state.lastResult = result;
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays,
      });

      await recordWorkflowStage({
        domain,
        family: "lexis",
        subtype: "daily-drop-runtime",
        stage: "completed",
        aggregateType: "lexis-daily-drop-runtime",
        aggregateId: result.runId || runKey,
        sourceService: "control-plane",
        title: "Lexis daily drop runtime completed",
        summary: result.skipped
          ? `Skipped daily drop for ${domain}: ${result.reason}`
          : `Sent daily drop for ${domain}`,
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
        subtype: "daily-drop-runtime",
        stage: "failed",
        aggregateType: "lexis-daily-drop-runtime",
        aggregateId: runKey,
        sourceService: "control-plane",
        status: "failed",
        title: "Lexis daily drop runtime failed",
        summary: error.message,
        payload: {
          domain,
          scheduled: Boolean(options.scheduled),
        },
        result: {
          error: error.message,
        },
      });

      await recordServiceAlert({
        domain,
        sourceService: "control-plane",
        category: "lexis-daily-drop",
        severity: "critical",
        title: "Lexis daily drop failed",
        summary: error.message,
        payload: {
          domain,
          scheduled: Boolean(options.scheduled),
        },
        tags: ["lexis", "sftp", "daily-drop", "mailhouse"],
      });

      runtime.logger.error("lexis.daily_drop.failed", {
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
      runtime.logger.warn("lexis.daily_drop.disabled", {
        domain: state.domain,
      });
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runDailyDrop({ scheduled: true, domain: state.domain });
      } catch (_error) {
        // Failure is already recorded into workflow/service-alert streams.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);

    if (typeof state.timer.unref === "function") {
      state.timer.unref();
    }

    runtime.logger.info("lexis.daily_drop.armed", {
      domain: state.domain,
      hour: state.hour,
      minute: state.minute,
      nextRunAt: state.nextRunAt,
      timezone: state.timezone,
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
    runDailyDrop,
    start,
    stop,
  };
}

module.exports = {
  createLexisDailyDropRuntime,
};
