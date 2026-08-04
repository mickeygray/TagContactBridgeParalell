"use strict";

// THE REPORT SCHEDULER RUNTIME — fires saved shapes on a clock.
//
// One poll, several definitions. Each definition owns its own time, weekday
// and day-of-month rules, so this loop holds no schedule of its own; it only
// asks "what is due?" and runs those.
//
// Two safety properties, both learned the hard way on this box:
//
//  1. The running guard is taken BEFORE any early return can skip it. A
//     previous runtime set state.running = true and cleared it in a `finally`
//     that belonged to a different try — one early return wedged the loop for
//     good.
//  2. Due-ness is decided against the definition's persisted lastRunKey, not
//     an in-memory flag, so a control-plane restart at 09:00 cannot re-send
//     the 07:00 report.

const {
  dueDefinitions, isDue, pacificKey, runDefinition,
} = require("../../../../packages/shared-services/src/reportDefinitionService");
const {
  writeDailySnapshot,
} = require("../../../../packages/shared-services/src/dailySnapshotService");
const { sendMail } = require("../../../../packages/shared-services/src/mailerService");
const { recordServiceAlert } = require("../../../../packages/shared-services/src");
const { getInternalFromEmail } = require("../../../../packages/shared-config/src");

const DEFAULT_POLL_MS = 5 * 60 * 1000;

function isPacificBusinessDay(value = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", weekday: "short",
  }).format(new Date(value));
  return weekday !== "Sat" && weekday !== "Sun";
}

function createReportScheduleRuntime({ config = {}, runtime = {} } = {}) {
  const state = {
    // Default OFF. Arming a loop that emails people is Mickey's call, not a
    // side effect of deploying the code.
    enabled: config.enabled === true || String(process.env.REPORT_SCHEDULER_ENABLED) === "true",
    pollMs: Math.max(60000, Number(config.pollMs || process.env.REPORT_SCHEDULER_POLL_MS) || DEFAULT_POLL_MS),
    running: false,
    timer: null,
    lastPollAt: null,
    lastRunAt: null,
    lastResults: [],
    lastError: null,
    ranToday: [],
  };

  const log = runtime.logger || null;

  async function poll({ force = false, now = new Date() } = {}) {
    // Guard FIRST: every early return below must be unable to skip the
    // release, so the flag can never be left set.
    if (state.running) return { skipped: "already running" };
    if (!state.enabled && !force) return { skipped: "disabled" };
    if (!force && !isPacificBusinessDay(now)) return { skipped: "pacific-weekend" };
    state.running = true;
    const started = Date.now();
    try {
      state.lastPollAt = new Date().toISOString();
      const due = await dueDefinitions();
      if (!due.length) return { ran: 0 };

      const results = [];
      for (const def of due) {
        try {
          const result = await runDefinition(def, {
            logger: log ? { info: (m) => log.info?.("report_schedule.step", { message: String(m).slice(0, 200) }) } : null,
            sendMail,
            fromEmail: getInternalFromEmail(),
          });
          results.push({
            name: def.name, range: result.range, delivered: result.delivered,
            sections: result.sections, errors: result.errors, durationMs: result.durationMs,
          });
          log?.info?.("report_schedule.ran", {
            definition: def.name, from: result.range.from, to: result.range.to,
            delivered: result.delivered, durationMs: result.durationMs,
          });

          // THE SNAPSHOT, AFTER THE EMAIL. Moved out of runDefinition on
          // 2026-08-04 so sending carries no persistence concern.
          //
          // It composes its own report — a second gather, accepted knowingly for
          // one patch ("to be careful let's just run it twice for now"), merged
          // into one pipe next patch. It is handed `result.range`, NOT a day it
          // computes itself: the fact is keyed on range.from, and an
          // independently-derived day produced TODAY where the email produced
          // YESTERDAY, writing a second document that silently overwrote the
          // first.
          //
          // Deliberately only for a DELIVERED email. A day whose mail never went
          // out should not acquire a snapshot claiming it did.
          if (result.delivered) {
            result.dailyFactCapture = await writeDailySnapshot({
              def, range: result.range, emailAcceptedAt: new Date(), logger: log,
            }).catch((error) => ({
              status: "failed", reason: String(error.message || error).slice(0, 200),
            }));
          }

          if (result.dailyFactCapture?.status === "failed") {
            // The email was already accepted, so this is an alert—not a retry.
            // Retrying runDefinition would duplicate the email just to repair
            // an internal fact document.
            await recordServiceAlert({
              domain: "TAG",
              sourceService: "control-plane",
              category: "daily-report-fact",
              severity: "high",
              title: "Nightly email sent but daily fact capture failed",
              summary: String(result.dailyFactCapture.reason || "unknown capture failure").slice(0, 300),
              tags: ["metrics", "daily-facts"],
            }).catch(() => {});
          }
        } catch (error) {
          // One bad definition must not stop the others from going out.
          results.push({ name: def.name, error: String(error.message).slice(0, 300) });
          log?.error?.("report_schedule.failed", { definition: def.name, error: String(error.message) });
          let attempts = 0;
          try {
            def.lastError = String(error.message).slice(0, 400);
            // Deliberately NOT stamping lastRunKey: a failed run is not a run,
            // so the next poll retries it rather than skipping the day. The
            // ATTEMPT counter is what stops that retry from running all night —
            // isDue gives up after three, because every try is a full live
            // gather against Logics, CallRail and RingCentral.
            const key = pacificKey();
            attempts = def.lastAttemptKey === key ? (Number(def.attemptsToday) || 0) + 1 : 1;
            def.lastAttemptKey = key;
            def.attemptsToday = attempts;
            if (typeof def.save === "function") await def.save();
          } catch { /* bookkeeping must not mask the real error */ }

          // TELL A HUMAN. This was the only nightly runtime on the box that
          // never raised a service alert — three dead nights produced three log
          // lines and nothing else, and nobody reads logs. Alert on the first
          // failure (the night may still be recoverable) and again when we give
          // up, which is the one that means "tomorrow needs you".
          await recordServiceAlert({
            domain: def.domain || "TAG",
            sourceService: "control-plane",
            category: "report-schedule",
            severity: attempts >= 3 ? "critical" : "high",
            title: attempts >= 3
              ? `Scheduled report GAVE UP: ${def.name}`
              : `Scheduled report failed: ${def.name}`,
            summary: `${String(error.message).slice(0, 300)}`
              + (attempts >= 3 ? " — three attempts today, not retrying until tomorrow." : ` (attempt ${attempts} of 3)`),
            tags: ["metrics", "report-schedule"],
          }).catch(() => { /* an alert that cannot be filed must not eat the night */ });
        }
      }
      state.lastRunAt = new Date().toISOString();
      state.lastResults = results;
      state.ranToday = [...new Set([...state.ranToday, ...results.map((r) => r.name)])];
      return { ran: results.length, results, durationMs: Date.now() - started };
    } catch (error) {
      state.lastError = String(error.message).slice(0, 300);
      log?.error?.("report_schedule.poll_failed", { error: String(error.message) });
      return { error: state.lastError };
    } finally {
      state.running = false;
    }
  }

  async function start() {
    if (!state.enabled) {
      log?.info?.("report_schedule.disabled", { hint: "set REPORT_SCHEDULER_ENABLED=true to arm" });
      return;
    }
    if (state.timer) return;
    state.timer = setInterval(() => { poll().catch(() => {}); }, state.pollMs);
    if (state.timer.unref) state.timer.unref();
    log?.info?.("report_schedule.started", { pollMs: state.pollMs });
    await poll();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  // Synchronous, like every other runtime's getState — the health endpoint
  // is a sync handler and must not be made to await a database round-trip.
  function getState() {
    return {
      enabled: state.enabled, running: state.running, pollMs: state.pollMs,
      today: pacificKey(), lastPollAt: state.lastPollAt, lastRunAt: state.lastRunAt,
      lastResults: state.lastResults, lastError: state.lastError,
    };
  }

  /** The DB-backed view: what is armed, and why each one is or is not due. */
  async function listDefinitions() {
    const { ReportDefinition } = require("../../../../packages/shared-services/src/reportDefinitionService");
    const all = await ReportDefinition.find({ archivedAt: null }).sort({ name: 1 });
    return all.map((d) => {
      const verdict = isDue(d);
      return {
        name: d.name, range: d.range, blocks: d.blocks || [], domain: d.domain || null,
        at: `${String(d.schedule?.hour ?? 0).padStart(2, "0")}:${String(d.schedule?.minute ?? 0).padStart(2, "0")} PT`,
        enabled: Boolean(d.schedule?.enabled),
        lastRunKey: d.lastRunKey, lastRunAt: d.lastRunAt, lastError: d.lastError || null,
        due: verdict.due, reason: verdict.reason, recipients: d.recipients || [],
      };
    });
  }

  return { getState, listDefinitions, poll, start, stop };
}

module.exports = { createReportScheduleRuntime, isPacificBusinessDay };
