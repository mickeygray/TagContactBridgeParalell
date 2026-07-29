"use strict";

const {
  recordServiceAlert,
  recordWorkflowStage,
  runLogicsActivityReview,
  runLogicsActivityReviewBatch,
} = require("../../../../packages/shared-services/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./lexisNightlyService");

function normalizeDomains(value, fallback = ["TAG"]) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const domains = raw
    .map((item) => String(item || "").trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(domains)];
  return unique.length ? unique : fallback;
}

function createState(config = {}) {
  const domains = normalizeDomains(config.domains || config.domain || "TAG,WYNN,AMITY", ["TAG"]);
  return {
    enabled: Boolean(config.enabled),
    running: false,
    domain: String(config.domain || domains[0] || "TAG").toUpperCase(),
    domains,
    hour: Number(config.hour || 20),
    sameDay: config.sameDay !== false,
    minute: Number(config.minute || 0),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays || [0, 1, 2, 3, 4, 5, 6]),
    concurrency: Math.max(1, Number(config.concurrency || 3) || 3),
    sendEmail: config.sendEmail !== false,
    recipients: Array.isArray(config.recipients) ? config.recipients : [],
    reportEmail: config.reportEmail || "mgray@taxadvocategroup.com",
    attachCsv: Boolean(config.attachCsv),
    outDir: config.outDir || "",
    includeAiReview: config.includeAiReview !== false,
    aiReviewMaxCases: Math.max(0, Number(config.aiReviewMaxCases || 75) || 75),
    aiReviewConcurrency: Math.max(1, Number(config.aiReviewConcurrency || 1) || 1),
    aiReviewModel: config.aiReviewModel || "",
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
    domains: state.domains,
    hour: state.hour,
    minute: state.minute,
    timezone: state.timezone,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    concurrency: state.concurrency,
    sendEmail: state.sendEmail,
    recipients: state.recipients,
    reportEmail: state.reportEmail,
    attachCsv: state.attachCsv,
    outDir: state.outDir,
    includeAiReview: state.includeAiReview,
    aiReviewMaxCases: state.aiReviewMaxCases,
    aiReviewConcurrency: state.aiReviewConcurrency,
    aiReviewModel: state.aiReviewModel,
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

    const domains = normalizeDomains(options.domains || options.domain || state.domains, state.domains);
    const domain = domains.length === 1 ? domains[0] : "TAG";
    const domainLabel = domains.join(",");
    const runKey = `logics-activity-review-${domains.join("-")}-${Date.now()}`;

    // THE LOOP WAITS FOR THE SHEETS (Mickey, 2026-07-27: "the service
    // depends on the presence of the sheets to run ... if it's not uploaded
    // by this time don't do it at this time").
    //
    // The pull is normally SHEET-TRIGGERED (dailyLoopService): the moment
    // every required company's sheet lands, it fires. This scheduled tick
    // is the backstop, and it must NOT run early on an empty day — doing so
    // would consume the day's run and leave a later upload with nothing to
    // trigger. So: no sheets → skip WITHOUT claiming, and try again on the
    // next tick. A late upload therefore still gets a full loop.
    //
    // After SHEET_DEADLINE_HOUR (default 23:00 PT) the sheets are presumed
    // not coming. Activities are NOT sheet-derived — the DNC/post-date
    // counts and the notice review are still worth having — so the backstop
    // runs then, marked as having run without sheets. Money is unaffected
    // either way: the payments gate holds it independently.
    //
    // A manual/explicit-date run bypasses all of this deliberately.
    const isScheduledToday = Boolean(options.scheduled) && !options.date && !options.dateKey;
    let ranWithoutSheets = false;
    if (isScheduledToday) {
      try {
        const { claimActivitiesRun, decideScheduledActivitiesRun, pacificDateKey, sheetDeadlineHour } = require(
          "../../../../packages/shared-services/src/dailyLoopService",
        );
        const { readPaymentsSheetStatus } = require(
          "../../../../packages/shared-services/src/paymentsSheetGateService",
        );
        const todayKey = pacificDateKey();
        // An UNREADABLE gate is not a ready gate. Treating a thrown read as
        // "ready" would manufacture a sheets-ready claim and burn the day on
        // a Mongo blip — the exact outcome this whole block exists to
        // prevent — and it would not even be flagged as sheetless. So a
        // broken read WAITS, and only the deadline overrides it. The day is
        // never lost: the deadline still runs it.
        const gate = await readPaymentsSheetStatus({ dateKey: todayKey }).catch((error) => {
          runtime.logger?.warn?.("logics_activity_review.gate_unreadable", {
            dateKey: todayKey, error: String(error?.message || error).slice(0, 160),
          });
          return null;
        });
        const deadlineHour = sheetDeadlineHour();
        const hourNow = Number(new Intl.DateTimeFormat("en-US", {
          timeZone: state.timezone, hour: "2-digit", hour12: false,
        }).format(new Date()));
        const decision = decideScheduledActivitiesRun({
          gateReady: Boolean(gate?.ready),
          hourNow,
          deadlineHour,
        });

        if (!decision.run) {
          // Deliberately do NOT advance nextRunAt: leaving it in the past is
          // what makes the tick re-check every intervalMs until the sheets
          // land. Log only when the missing set changes, so a three-hour
          // wait writes two lines instead of a hundred and eighty.
          const missingKey = (gate?.missing || []).join(",");
          if (state.waitingForSheets?.key !== `${todayKey}|${missingKey}`) {
            runtime.logger?.info?.("logics_activity_review.waiting_for_sheets", {
              dateKey: todayKey, missing: gate?.missing || [], deadlineHour,
            });
          }
          state.lastSkippedAt = new Date();
          state.waitingForSheets = {
            key: `${todayKey}|${missingKey}`,
            dateKey: todayKey, missing: gate?.missing || [], since: new Date(),
          };
          return {
            ok: true, skipped: true, reason: "waiting-for-sheets",
            dateKey: todayKey, missing: gate?.missing || [], deadlineHour,
          };
        }
        ranWithoutSheets = decision.ranWithoutSheets;
        state.waitingForSheets = null;

        if (!(await claimActivitiesRun({ dateKey: todayKey, triggeredBy: ranWithoutSheets ? "deadline-no-sheets" : "schedule" }))) {
          // The sheet trigger already ran today. Advance to TOMORROW — the
          // tick fires whenever now >= nextRunAt, so leaving it in the past
          // here would spin the guard every intervalMs until midnight.
          runtime.logger?.info?.("logics_activity_review.skipped_already_ran", { dateKey: todayKey });
          state.lastSkippedAt = new Date();
          state.nextRunAt = computeNextRunAt(state.hour, state.minute, new Date(), {
            activeWeekdays: state.activeWeekdays,
            timezone: state.timezone,
          });
          return { ok: true, skipped: true, reason: "already-ran-today", dateKey: todayKey };
        }
        if (ranWithoutSheets) {
          runtime.logger?.warn?.("logics_activity_review.ran_without_sheets", {
            dateKey: todayKey, missing: gate?.missing || [], deadlineHour,
          });
        }
      } catch (error) {
        // A guard failure must not cost us the backstop run.
        runtime.logger?.warn?.("logics_activity_review.guard_failed", {
          error: String(error.message).slice(0, 160),
        });
      }
    }

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
      summary: `Beginning Logics activity review for ${domainLabel}`,
      payload: {
        domain,
        domains,
        scheduled: Boolean(options.scheduled),
      },
    });

    try {
      const runner = domains.length > 1 ? runLogicsActivityReviewBatch : runLogicsActivityReview;
      const result = await runner({
        domains,
        domain: domains[0],
        // sameDay: the EOD schedule reviews TODAY. Without it the service
        // defaults to yesterday — correct only for the retired 6 AM slot.
        // An explicit date always wins (manual re-runs of past days).
        dateKey:
          options.date
          || options.dateKey
          || (state.sameDay
            ? new Intl.DateTimeFormat("en-CA", {
              timeZone: options.timezone || state.timezone,
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date())
            : undefined),
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
        attachCsv:
          options.attachCsv !== undefined
            ? Boolean(options.attachCsv)
            : state.attachCsv,
        outDir:
          options.outDir !== undefined
            ? options.outDir
            : state.outDir,
        sendEmail:
          options.sendEmail !== undefined
            ? Boolean(options.sendEmail)
            : state.sendEmail,
        includeAiReview:
          options.includeAiReview !== undefined
            ? Boolean(options.includeAiReview)
            : state.includeAiReview,
        aiReviewMaxCases:
          options.aiReviewMaxCases !== undefined
            ? options.aiReviewMaxCases
            : state.aiReviewMaxCases,
        aiReviewConcurrency:
          options.aiReviewConcurrency !== undefined
            ? options.aiReviewConcurrency
            : state.aiReviewConcurrency,
        aiReviewModel:
          options.aiReviewModel !== undefined
            ? options.aiReviewModel
            : state.aiReviewModel,
      });

      state.lastCompletedAt = new Date();
      state.lastResult = {
        domains: result.domains || [result.domain],
        date: result.date,
        startDate: result.startDate,
        endDate: result.endDate,
        activityRows: result.processed?.parsedRows || 0,
        noticeCases: result.processed?.outputRows || 0,
        suspendedCases: result.processed?.suspendedOutputRows || 0,
        aiReviewedNoticeCases: result.processed?.aiReview?.reviewedCases || 0,
        aiReviewedSuspendedCases: result.processed?.suspendedAiReview?.reviewedCases || 0,
        csvOut: result.processed?.csvOut || null,
        suspendedCsvOut: result.processed?.suspendedCsvOut || null,
        email: result.email || null,
      };
      state.lastError = null;
      state.lastRanWithoutSheets = ranWithoutSheets;
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
        summary: `Logics activity review completed for ${domainLabel}`,
        result: state.lastResult,
      });

      runtime.logger.info("logics.activity_review.completed", state.lastResult);
      return result;
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastResult = null;
      state.lastError = error.message;
      // A failed run must hand the day back, or the sheet trigger / deadline
      // backstop finds "already-ran-today" and the night silently produces
      // nothing. Mirrors the release in triggerActivitiesIfSheetsReady —
      // the claim is a lease, not a tombstone (adversarial review 2026-07-27:
      // this path claimed without ever releasing).
      if (isScheduledToday) {
        try {
          const { releaseActivitiesRun, pacificDateKey } = require(
            "../../../../packages/shared-services/src/dailyLoopService",
          );
          const released = await releaseActivitiesRun({
            dateKey: pacificDateKey(), error: error.message,
          });
          if (!released) {
            runtime.logger?.warn?.("logics_activity_review.claim_release_failed", {
              error: String(error.message).slice(0, 160),
            });
          }
        } catch (releaseError) {
          runtime.logger?.warn?.("logics_activity_review.claim_release_failed", {
            error: String(releaseError.message).slice(0, 160),
          });
        }
      }
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
          domains,
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
          domains,
          scheduled: Boolean(options.scheduled),
        },
        tags: ["logics", "activity-report", "notice-review"],
      });

      runtime.logger.error("logics.activity_review.failed", {
        domain,
        domains,
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
        domains: state.domains,
      });
      return;
    }

    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runActivityReview({ scheduled: true, domains: state.domains });
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
      domains: state.domains,
      hour: state.hour,
      minute: state.minute,
      nextRunAt: state.nextRunAt,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      recipients: state.recipients,
      includeAiReview: state.includeAiReview,
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
