"use strict";

// THE NIGHT BOARD — scheduled service (pipeline contract Parts I + II).
//
// Runs the same `runNightPass` the CLI runs, then emails the board. Fires
// once per day, guarded by DailyLoopRun so a restart, a manual run, or a
// second tick cannot double-send.
//
// DELIBERATELY SEPARATE from logicsActivityReviewRuntime:
//   · that one claims `activitiesFiredAt` and does the notice/AI review
//   · this one claims `activityPassAt` + `emailSentAt`
// Different claim fields = no collision. It is scheduled AFTER the review
// (default 20:20 vs 20:00) so the day's Logics writes have settled.

const {
  recordServiceAlert,
  recordWorkflowStage,
} = require("../../../../packages/shared-services/src");
const { runNightPass, pacificDateKey } = require("../../../../packages/shared-services/src/nightPassService");
const { sendMail } = require("../../../../packages/shared-services/src/mailerService");
const { getInternalFromEmail } = require("../../../../packages/shared-config/src");
const { DailyLoopRun } = require("../../../../packages/shared-models/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./lexisNightlyService");

const money = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function createState(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    running: false,
    hour: Number(config.hour ?? 20),
    minute: Number(config.minute ?? 20),
    timezone: config.timezone || "America/Los_Angeles",
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    domains: Array.isArray(config.domains) && config.domains.length
      ? config.domains.map((d) => String(d).toUpperCase())
      : ["TAG", "WYNN", "AMITY"],
    recipients: String(config.recipients || "mgray@taxadvocategroup.com"),
    apply: config.apply !== false,        // a scheduled run persists by default
    attach: config.attach !== false,      // …and attaches a few recordings
    sendEmail: config.sendEmail !== false,
    timer: null,
    nextRunAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
    lastSkippedReason: null,
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
    recipients: state.recipients,
    apply: state.apply,
    attach: state.attach,
    sendEmail: state.sendEmail,
    nextRunAt: state.nextRunAt,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    lastSkippedReason: state.lastSkippedReason,
  };
}

/**
 * Claim the night-board pass for a day, atomically, with lease expiry.
 * A crashed pass (claimed, never completed) becomes reclaimable so a
 * restart does not silently cost the night.
 */
async function claimBoardPass(dateKey, leaseMinutes = 45) {
  const cutoff = new Date(Date.now() - leaseMinutes * 60 * 1000);
  try {
    const claimed = await DailyLoopRun.findOneAndUpdate(
      {
        dateKey,
        $or: [
          { activityPassAt: null },
          { activityPassAt: { $exists: false } },
          {
            activityPassAt: { $lt: cutoff },
            $and: [{ $or: [{ dayDocCompletedAt: null }, { dayDocCompletedAt: { $exists: false } }] }],
          },
        ],
      },
      { $set: { activityPassAt: new Date() }, $setOnInsert: { dateKey } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return Boolean(claimed);
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/** Claim the SEND itself, so a re-run can recompute but never re-email. */
async function claimBoardEmail(dateKey) {
  try {
    const claimed = await DailyLoopRun.findOneAndUpdate(
      { dateKey, $or: [{ emailSentAt: null }, { emailSentAt: { $exists: false } }] },
      { $set: { emailSentAt: new Date() }, $setOnInsert: { dateKey } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return Boolean(claimed);
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

function createNightBoardRuntime({ config = {}, runtime }) {
  const state = createState(config);

  async function runBoard(options = {}) {
    if (state.running) {
      return { ok: false, skipped: true, reason: "night-board-already-running" };
    }
    const dateKey = String(options.dateKey || pacificDateKey());
    const scheduled = Boolean(options.scheduled);

    // Scheduled runs claim the day; a manual run with an explicit date
    // bypasses the once-per-day rule deliberately (but still cannot
    // re-email — that claim lives at the send).
    // Same fail-closed rule: an unreadable claim must not license a second
    // scheduled pass.
    const passClaimed = scheduled
      ? await claimBoardPass(dateKey).catch((error) => {
        runtime.logger?.error?.("night_board.pass_claim_unreadable", {
          dateKey, error: String(error.message).slice(0, 200),
        });
        return false;
      })
      : true;
    if (scheduled && !passClaimed) {
      state.lastSkippedReason = "already-ran-today";
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, new Date(), {
        activeWeekdays: state.activeWeekdays, timezone: state.timezone,
      });
      return { ok: true, skipped: true, reason: "already-ran-today", dateKey };
    }

    state.running = true;
    state.lastStartedAt = new Date();
    state.lastError = null;
    state.lastSkippedReason = null;

    try {
      const result = await runNightPass({
        dateKey,
        domains: options.domains || state.domains,
        apply: options.apply !== undefined ? Boolean(options.apply) : state.apply,
        attach: options.attach !== undefined ? Boolean(options.attach) : state.attach,
        logger: runtime.logger,
      });

      const { night, emailData, text, attachments } = result;
      let emailResult = null;

      const wantsEmail = options.sendEmail !== undefined ? Boolean(options.sendEmail) : state.sendEmail;
      if (wantsEmail) {
        // The send-once claim lives HERE, not at the trigger, so manual
        // re-runs recompute freely without a second email landing.
        // Fail CLOSED. `.catch(() => true)` treated an unreachable Mongo as a
        // successful claim, so a blip here sent a SECOND board email — the
        // one outcome the claim exists to prevent. A missed email is
        // recoverable by re-running; a duplicate one is not.
        const claimed = await claimBoardEmail(dateKey).catch((error) => {
          runtime.logger?.error?.("night_board.email_claim_unreadable", {
            dateKey, error: String(error.message).slice(0, 200),
          });
          return false;
        });
        if (claimed) {
          const fromEmail = getInternalFromEmail();
          // Pin BOTH domain and transportDomain: a falsy domain routes the
          // send through WYNN's SendGrid key and marketing From address.
          emailResult = await sendMail("TAG", {
            to: options.recipients || state.recipients,
            subject: `Daily Board ${dateKey} — ${money(night.counters.confirmedAmountToday)} · ${night.lanes.deals.length} deal(s)`,
            template: "nightly/daily-board",
            data: emailData,
            text,
            attachments: attachments || [],
            from: `Parallel Nightly <${fromEmail}>`,
            replyTo: `Parallel Nightly <${fromEmail}>`,
            transportDomain: "TAG",
          });
        } else {
          emailResult = { sent: false, skipped: true, reason: "already-emailed-today-or-claim-unreadable" };
        }
      }

      // Diagnostics go to the LOG and the day-doc — never to the reader's
      // email (Mickey: "this is an email for people who dont care to read
      // emails from me").
      const counters = {
        ...night.counters,
        deals: night.lanes.deals.length,
        redlines: night.lanes.redlines.length,
        durationMs: night.durationMs,
      };
      await DailyLoopRun.updateOne(
        { dateKey },
        {
          $set: {
            counters,
            dayDocCompletedAt: new Date(),
            activitiesResult: { source: "night-board", deals: counters.deals, money: night.counters.confirmedAmountToday },
          },
        },
        { upsert: true },
      ).catch(() => {});

      if (night.review.length) {
        runtime.logger?.warn?.("night_board.review", {
          dateKey, count: night.review.length, items: night.review.slice(0, 20),
        });
      }

      state.lastCompletedAt = new Date();
      state.lastResult = {
        dateKey,
        money: night.counters.confirmedAmountToday,
        payments: night.counters.confirmedToday,
        deals: night.lanes.deals.length,
        redlines: night.lanes.redlines.length,
        reviewCount: night.review.length,
        emailed: Boolean(emailResult?.messageId),
        attachments: (attachments || []).length,
        durationMs: night.durationMs,
      };
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays, timezone: state.timezone,
      });

      await recordWorkflowStage({
        domain: "TAG", family: "metrics", subtype: "night-board", stage: "completed",
        aggregateType: "night-board", aggregateId: dateKey,
        sourceService: "control-plane",
        title: "Night board completed",
        summary: `${money(night.counters.confirmedAmountToday)} · ${night.lanes.deals.length} deal(s)`,
        payload: state.lastResult, result: state.lastResult,
      }).catch(() => {});

      runtime.logger?.info?.("night_board.completed", state.lastResult);
      return { ok: true, ...state.lastResult };
    } catch (error) {
      state.lastCompletedAt = new Date();
      state.lastError = error.message;
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, state.lastCompletedAt, {
        activeWeekdays: state.activeWeekdays, timezone: state.timezone,
      });
      // Hand the day back so a retry (or tomorrow's tick) is not blocked by
      // a claim from a run that produced nothing.
      await DailyLoopRun.updateOne({ dateKey }, { $set: { activityPassAt: null } }).catch(() => {});
      await recordServiceAlert({
        domain: "TAG", sourceService: "control-plane", category: "night-board",
        severity: "high", title: "Night board failed", summary: error.message,
        tags: ["metrics", "night-board"],
      }).catch(() => {});
      runtime.logger?.error?.("night_board.failed", { dateKey, error: error.message });
      throw error;
    } finally {
      state.running = false;
    }
  }

  async function start() {
    if (!state.enabled) {
      runtime.logger?.info?.("night_board.disabled");
      return;
    }
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, new Date(), {
      activeWeekdays: state.activeWeekdays, timezone: state.timezone,
    });
    const tick = async () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      try {
        await runBoard({ scheduled: true });
      } catch {
        /* runBoard already alerted, logged and rescheduled */
      }
    };
    state.timer = setInterval(() => { void tick(); }, state.intervalMs);
    if (state.timer.unref) state.timer.unref();
    runtime.logger?.info?.("night_board.started", {
      hour: state.hour, minute: state.minute, nextRunAt: state.nextRunAt,
    });
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  return {
    getState: () => summarizeState(state),
    runBoard,
    start,
    stop,
  };
}

module.exports = { createNightBoardRuntime };
