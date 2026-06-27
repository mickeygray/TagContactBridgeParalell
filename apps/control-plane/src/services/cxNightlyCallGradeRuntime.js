"use strict";

const {
  createAiTaskClient,
  recordServiceAlert,
  recordWorkflowStage,
  runNightlyCallGrading,
  sendPlainEmail,
} = require("../../../../packages/shared-services/src");
const {
  cxAgentCallNoteRepository,
} = require("../../../../packages/shared-repositories/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./nightlyCloseRuntime");

function normalizeRecipients(values = []) {
  return (Array.isArray(values) ? values : String(values || "").split(","))
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    hour: Number(config.hour || 18),
    minute: Number(config.minute || 0),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Math.max(10000, Number(config.intervalMs || 60000)),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    minDurationSec: Math.max(0, Number(config.minDurationSec || 120) || 120),
    minSummaryChars: Math.max(0, Number(config.minSummaryChars || 80) || 80),
    limit: Math.max(1, Math.min(Number(config.limit || 500) || 500, 2000)),
    timeoutMs: Math.max(1000, Number(config.timeoutMs || 60000) || 60000),
    sendEmail: Boolean(config.sendEmail),
    recipients: normalizeRecipients(config.recipients),
    emailCompanyKey: String(config.emailCompanyKey || "TAG").trim().toUpperCase() || "TAG",
    qualityMode: String(config.qualityMode || "").trim(),
    preferProvider: String(config.preferProvider || "").trim(),
    preferModel: String(config.preferModel || "").trim(),
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
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    minDurationSec: state.minDurationSec,
    minSummaryChars: state.minSummaryChars,
    limit: state.limit,
    timeoutMs: state.timeoutMs,
    sendEmail: state.sendEmail,
    recipients: state.recipients,
    emailCompanyKey: state.emailCompanyKey,
    qualityMode: state.qualityMode,
    preferProvider: state.preferProvider,
    preferModel: state.preferModel,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
  };
}

function buildEmailPayload(recipients, email) {
  return {
    personalizations: [
      {
        to: recipients.map((address) => ({ email: address })),
        subject: email.subject,
      },
    ],
    from: { email: "noreply@parallel.local", name: "Parallel CX" },
    subject: email.subject,
    content: [
      {
        type: "text/plain",
        value: email.text,
      },
    ],
  };
}

function buildDefaultGradeWindow(state, now = new Date()) {
  const priorDay = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return {
    from: computeNextRunAt(0, 0, state.timezone, priorDay, {
      activeWeekdays: [0, 1, 2, 3, 4, 5, 6],
    }),
    to: now,
  };
}

function createCxNightlyCallGradeRuntime({ config = {}, runtime }) {
  const state = createState(config);
  const aiClient = createAiTaskClient({ defaultTimeoutMs: state.timeoutMs });

  async function sendGradeEmail(email) {
    if (!state.recipients.length) {
      return { ok: false, skipped: true, reason: "no-recipients" };
    }
    return sendPlainEmail(state.emailCompanyKey, buildEmailPayload(state.recipients, email));
  }

  async function runNightlyGrades(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "cx-nightly-call-grade-already-running",
        state: summarizeState(state),
      };
    }

    const runKey = `cx-nightly-call-grade-${Date.now()}`;
    const runStartedAt = new Date();
    const requestedFrom = options.from || options.start || null;
    const requestedTo = options.to || options.end || null;
    const defaultWindow = requestedFrom || requestedTo
      ? { from: requestedFrom, to: requestedTo || runStartedAt }
      : buildDefaultGradeWindow(state, runStartedAt);

    state.running = true;
    state.lastStartedAt = runStartedAt;
    state.lastError = null;

    await recordWorkflowStage({
      domain: "TAG",
      family: "cx",
      subtype: "nightly-call-grade",
      stage: "requested",
      aggregateType: "cx-nightly-call-grade-runtime",
      aggregateId: runKey,
      sourceService: "control-plane",
      title: "CX nightly call grading started",
      summary: "Beginning nightly CX call grading from durable call notes",
      payload: {
        scheduled: Boolean(options.scheduled),
        from: defaultWindow.from,
        to: defaultWindow.to,
        minDurationSec: options.minDurationSec ?? state.minDurationSec,
        sendEmail: options.sendEmail ?? state.sendEmail,
      },
    });

    try {
      const result = await runNightlyCallGrading(
        {
          from: defaultWindow.from,
          to: defaultWindow.to,
          agentEmail: options.agentEmail || null,
          generatedAt: options.generatedAt,
          minDurationSec: options.minDurationSec ?? state.minDurationSec,
          minSummaryChars: options.minSummaryChars ?? state.minSummaryChars,
          limit: options.limit ?? state.limit,
          timeoutMs: options.timeoutMs ?? state.timeoutMs,
          sendEmail: options.sendEmail !== undefined ? Boolean(options.sendEmail) : state.sendEmail,
          dryRun: Boolean(options.dryRun),
          qualityMode: options.qualityMode || state.qualityMode || undefined,
          preferProvider: options.preferProvider || state.preferProvider || undefined,
          preferModel: options.preferModel || state.preferModel || undefined,
        },
        {
          repository: cxAgentCallNoteRepository,
          runAiTask: (taskId, payload, taskOptions) => aiClient.runAiTask(taskId, payload, taskOptions),
          sendGradeEmail,
          logger: runtime.logger,
        },
      );

      state.lastCompletedAt = new Date();
      state.lastResult = {
        candidateCount: result.candidateCount,
        agentCount: result.agentCount,
        gradedCount: result.gradedCount,
        skippedCount: result.skippedCount,
        failedCount: result.failedCount,
        emailCount: result.emailCount,
        emailFailedCount: result.emailFailedCount,
      };
      state.lastError = null;
      state.nextRunAt = computeNextRunAt(
        state.hour,
        state.minute,
        state.timezone,
        state.lastCompletedAt,
        { activeWeekdays: state.activeWeekdays },
      );

      await recordWorkflowStage({
        domain: "TAG",
        family: "cx",
        subtype: "nightly-call-grade",
        stage: "completed",
        aggregateType: "cx-nightly-call-grade-runtime",
        aggregateId: runKey,
        sourceService: "control-plane",
        title: "CX nightly call grading completed",
        summary: `Graded ${result.gradedCount} calls across ${result.agentCount} agents`,
        result: state.lastResult,
      });

      runtime.logger.info("cx.nightly_call_grade.completed", state.lastResult);
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

      await recordWorkflowStage({
        domain: "TAG",
        family: "cx",
        subtype: "nightly-call-grade",
        stage: "failed",
        aggregateType: "cx-nightly-call-grade-runtime",
        aggregateId: runKey,
        sourceService: "control-plane",
        status: "failed",
        title: "CX nightly call grading failed",
        summary: error.message,
        result: { error: error.message },
      }).catch(() => null);

      await recordServiceAlert({
        domain: "TAG",
        sourceService: "control-plane",
        category: "cx-nightly-call-grade",
        severity: "warning",
        title: "CX nightly call grading failed",
        summary: error.message,
        payload: { scheduled: Boolean(options.scheduled) },
        tags: ["cx", "coach", "grading"],
      }).catch(() => null);

      runtime.logger.error("cx.nightly_call_grade.failed", { error: error.message });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    state.enabled = Boolean(config.enabled);
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.timezone, new Date(), {
      activeWeekdays: state.activeWeekdays,
    });

    if (!state.enabled) {
      runtime.logger.warn("cx.nightly_call_grade.disabled");
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runNightlyGrades({ scheduled: true });
      } catch {
        // Failure is recorded in runNightlyGrades.
      }
    };

    state.timer = setInterval(() => {
      void tick();
    }, state.intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();

    runtime.logger.info("cx.nightly_call_grade.armed", {
      hour: state.hour,
      minute: state.minute,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      minDurationSec: state.minDurationSec,
      sendEmail: state.sendEmail,
      recipientCount: state.recipients.length,
      nextRunAt: state.nextRunAt,
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
    runNightlyGrades,
    start,
    stop,
  };
}

module.exports = {
  createCxNightlyCallGradeRuntime,
};
