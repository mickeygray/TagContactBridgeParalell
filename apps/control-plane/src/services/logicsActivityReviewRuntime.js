"use strict";

const {
  recordServiceAlert,
  recordWorkflowStage,
  runLogicsActivityReview,
} = require("../../../../packages/shared-services/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./lexisNightlyService");

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    domain: String(config.domain || "TAG").toUpperCase(),
    hour: Number(config.hour || 6),
    minute: Number(config.minute || 0),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays || [0, 1, 2, 3, 4, 5, 6]),
    concurrency: Math.max(1, Number(config.concurrency || 3) || 3),
    sendEmail: config.sendEmail !== false,
    recipients: Array.isArray(config.recipients) ? config.recipients : [],
    reportEmail: config.reportEmail || "documents@taxadvocategroup.com",
    outDir: config.outDir || "",
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
    timezone: state.timezone,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    concurrency: state.concurrency,
    sendEmail: state.sendEmail,
    recipients: state.recipients,
    reportEmail: state.reportEmail,
    outDir: state.outDir,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

function createLogicsActivityReviewRuntime({ config = {}, runtime }) {
  const state = createState(config);

  async function runActivityReview(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "logics-activity-review-already-running",
        state: summarizeState(state),
      };
    }

    const domain = String(options.domain || state.domain || "TAG").toUpperCase();
    const runKey = `logics-activity-review-${domain}-${Date.now()}`;

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;

    await recordWorkflowStage({
      domain,
      family: "logics",
      subtype: "activity-review-runtime",
      stage: "requested",
      aggregateType: "logics-activity-review-runtime",
      aggregateId: runKey,
      sourceService: "control-plane",
      title: "Logics activity review started",
      summary: `Beginning Logics activity review for ${domain}`,
      payload: {
        domain,
        scheduled: Boolean(options.scheduled),
      },
    });

    try {
      const result = await runLogicsActivityReview({
        domain,
        dateKey: options.date || options.dateKey,
        startDateKey: options.startDate || options.startDateKey,
        endDateKey: options.endDate || options.endDateKey,
        timezone: options.timezone || state.timezone,
        concurrency:
          options.concurrency !== undefined
            ? options.concurrency
            : state.concurrency,
        recipients:
          options.recipients !== undefined
            ? options.recipients
            : state.recipients,
        reportEmail:
          options.reportEmail !== undefined
            ? options.reportEmail
            : state.reportEmail,
        outDir:
          options.outDir !== undefined
            ? options.outDir
            : state.outDir,
        sendEmail:
          options.sendEmail !== undefined
            ? Boolean(options.sendEmail)
            : state.sendEmail,
      });

      state.lastCompletedAt = new Date();
      state.lastResult = {
        date: result.date,
        startDate: result.startDate,
        endDate: result.endDate,
        activityRows: result.processed?.parsedRows || 0,
        noticeCases: result.processed?.outputRows || 0,
        suspendedCases: result.processed?.suspendedOutputRows || 0,
        csvOut: result.processed?.csvOut || null,
        suspendedCsvOut: result.processed?.suspendedCsvOut || null,
        email: result.email || null,
      };
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays,
        timezone: state.timezone,
      });

      await recordWorkflowStage({
        domain,
        family: "logics",
        subtype: "activity-review-runtime",
        stage: "completed",
        aggregateType: "logics-activity-review-runtime",
        aggregateId: runKey,
        sourceService: "control-plane",
        title: "Logics activity review completed",
        summary: `Logics activity review completed for ${domain}`,
        result: state.lastResult,
      });

      runtime.logger.info("logics.activity_review.completed", state.lastResult);
      return result;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastResult = null;
      state.lastError = error.message;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays,
        timezone: state.timezone,
      });

      await recordWorkflowStage({
        domain,
        family: "logics",
        subtype: "activity-review-runtime",
        stage: "failed",
        aggregateType: "logics-activity-review-runtime",
        aggregateId: runKey,
        sourceService: "control-plane",
        status: "failed",
        title: "Logics activity review failed",
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
        category: "logics-activity-review",
        severity: "warning",
        title: "Logics activity review failed",
        summary: error.message,
        payload: {
          domain,
          scheduled: Boolean(options.scheduled),
        },
        tags: ["logics", "activity-report", "notice-review"],
      });

      runtime.logger.error("logics.activity_review.failed", {
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
      timezone: state.timezone,
    });

    if (!state.enabled) {
      runtime.logger.warn("logics.activity_review.disabled", {
        domain: state.domain,
      });
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runActivityReview({ scheduled: true, domain: state.domain });
      } catch {
        // Failure is recorded in runActivityReview.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);

    if (typeof state.timer.unref === "function") {
      state.timer.unref();
    }

    runtime.logger.info("logics.activity_review.armed", {
      domain: state.domain,
      hour: state.hour,
      minute: state.minute,
      nextRunAt: state.nextRunAt,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      recipients: state.recipients,
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
    runActivityReview,
    start,
    stop,
  };
}

module.exports = {
  createLogicsActivityReviewRuntime,
};
