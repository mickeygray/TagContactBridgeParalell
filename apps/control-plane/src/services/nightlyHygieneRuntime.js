"use strict";

// THE NIGHTLY SERVICE — one loop, a list of hygiene chores.
//
// Mickey 2026-07-28: "we need one nightly service that does this and then
// report generator that lets me automate what report gets sent out … and then
// basically we will prepackage the logic for certain reports and then have a
// report designer and thats it." Plus: "this thing is part time report
// generator part time database sanitizer."
//
// So the shape is deliberately two services, not five: THIS one keeps the
// upstream systems clean, and reportScheduleRuntime sends what people asked
// for. Anything nightly that FIXES data belongs here as a task; anything that
// REPORTS belongs in a saved ReportDefinition.
//
// Tasks are a registry, not a hard-coded sequence, because the whole point is
// that the next chore is a few lines rather than a fourth runtime. Each task:
//   · is individually gated by its own env flag (default OFF)
//   · reports what it WOULD do when its write switch is off
//   · cannot stop the others by failing
//
// Ordering rule: hygiene runs BEFORE the report scheduler's usual hours, so a
// morning report reads data this pass already corrected.

const {
  applySourceSanitization, pacificKey, planSourceSanitization,
} = require("../../../../packages/shared-services/src/logicsSourceSanitizerService");

// 19:50 PT. Mickey 2026-07-28 described the night in order: "source the deals,
// gather the call urls, create the night report for spend, honor any custom
// reports, wait til 7:50 and have a good night."
//
// The ORDER is the requirement: attribution must be sourced before any report
// reads it, or the board reports the day with tonight's deals unattributed.
// Running at 19:50 leaves the 20:20 board half an hour of headroom, and means
// the target day is TODAY — the day that just finished selling — which is how
// the old board always worked.
const DEFAULT_HOUR = 19;
const DEFAULT_MINUTE = 50;
const DEFAULT_POLL_MS = 5 * 60 * 1000;

/**
 * The completed business day this pass should persist.
 *
 * Offset -1 by default: at the 02:00 default hour the current Pacific day is
 * only two hours old, so "today" would mean overnight noise while yesterday's
 * deals never got stamped. A completed day is also restart-proof - it does
 * not matter what time the pass actually runs.
 */
function persistTargetDay(at = new Date()) {
  // Offset 0 because the pass runs in the EVENING: at 19:50 the current
  // Pacific day IS the day that just finished, exactly as the 20:20 board
  // always assumed. (An early-hours run would need -1 — the offset stays
  // configurable so the day and the hour can never drift apart silently.)
  const offset = Number(process.env.NIGHT_PERSIST_DAY_OFFSET ?? 0);
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  return new Date(Date.parse(`${key}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
}

function pacificHourMinute(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t) => Number(parts.find((x) => x.type === t)?.value);
  return { hour: get("hour") % 24, minute: get("minute") };
}

/**
 * The chore list. Add a task here rather than adding a runtime.
 *
 * plan()  — read-only; always safe, always run, so `lastRun` shows the work
 *           even when the task may not write.
 * apply() — only called when the task's own write switch is armed.
 */
const TASKS = [
  {
    // THE one that cannot be lost. nightPassService's per-domain loop is the
    // only code that writes officerAtSale/sourceAtSale, and a live re-pull
    // can never reconstruct it — Logics returns who owns the case TODAY, not
    // who closed it in July. The board it used to render is now a saved
    // ReportDefinition; this keeps the writes and drops nothing.
    key: "night-persist",
    label: "Persist activity events + payment truth (attribution snapshots)",
    // Reuses runNightPass verbatim with persistOnly, so the stamp-then-persist
    // ordering inside that loop is the SAME code the old board ran, not a
    // reimplementation that could drift.
    writesArmed: () => String(process.env.NIGHT_PERSIST_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger }) {
      const { runNightPass } = require("../../../../packages/shared-services/src/nightPassService");
      // THE COMPLETED business day, not "today". The old board ran at 20:20,
      // where pacificDateKey() is the day nearly finished. This service runs
      // at 02:00, where pacificDateKey() is a day only two hours old - so it
      // would pull overnight noise and never stamp YESTERDAY's deals.
      // Targeting the completed day also makes the result independent of when
      // the pass fires, so a restart at 14:00 still persists a whole day.
      const dateKey = persistTargetDay();
      // apply:false reads and counts everything, writes nothing, and collects
      // the pending writes so apply() persists exactly THOSE.
      const { night } = await runNightPass({
        dateKey, domains, apply: false, persistOnly: true, logger,
      });
      return [{ dateKey, counters: night.counters, pending: night.pending, night }];
    },
    async apply(planned, { logger }) {
      // Persist what plan() ALREADY derived. Re-running the whole pass with
      // apply:true resolves attribution a second time, independently, so the
      // numbers written would not be the numbers reported - and a lookup that
      // succeeded during plan() but failed during apply() would persist a
      // weaker snapshot than the one just shown.
      const {
        insertActivityEvents,
      } = require("../../../../packages/shared-services/src/activityEventService");
      const {
        persistPaymentTruths,
      } = require("../../../../packages/shared-services/src/paymentTruthService");
      const pending = planned[0]?.pending || { events: [], truths: [] };
      const out = { written: 0, events: 0, payments: 0, resurfaced: 0, skipped: 0, failed: 0, errors: [] };
      if (pending.events.length) {
        try {
          const ins = await insertActivityEvents(pending.events);
          out.events = ins.inserted || 0;
          out.resurfaced = ins.resurfaced || 0;
        } catch (error) {
          out.failed += 1;
          out.errors.push(`events: ${String(error.message).slice(0, 160)}`);
        }
      }
      if (pending.truths.length) {
        try {
          const res = await persistPaymentTruths(pending.truths);
          out.payments = res.upserted || 0;
        } catch (error) {
          out.failed += 1;
          out.errors.push(`payments: ${String(error.message).slice(0, 160)}`);
        }
      }
      out.written = out.events + out.payments;
      logger?.info?.("night_persist.applied", {
        dateKey: planned[0]?.dateKey, events: out.events, payments: out.payments, failed: out.failed,
      });
      return out;
    },
    // Its plan is a counter snapshot, not a row list. Without its own count()
    // the runtime's default (plan.length) reads 0 and apply() never runs —
    // the task would look armed and silently write nothing.
    count(planned) {
      const p = planned[0]?.pending || { events: [], truths: [] };
      return p.events.length + p.truths.length;
    },
    describe(planned) {
      const c = planned[0]?.counters || {};
      const p = planned[0]?.pending || { events: [], truths: [] };
      // deals live on night.lanes.deals, NOT on counters - reading c.deals
      // made this line say "0 deal(s)" every single night.
      const deals = planned[0]?.night?.lanes?.deals?.length || 0;
      return `${planned[0]?.dateKey}: ${c.rows || 0} row(s) · ${deals} deal(s) · `
        + `${p.events.length} event(s) + ${p.truths.length} payment truth(s) to persist`;
    },
  },
  {
    // "gather the call urls" — step two of the night, for real.
    //
    // Mickey 2026-07-29: "you have a pool of links and those are attached to
    // the call. so youre grabbing and organzing the link info for marketing
    // calls."
    //
    // CallRail hands out recording URLs ONE CALL AT A TIME, so a report that
    // wants listen links pays a round-trip per call every time it runs. A
    // finished call's URL never changes, so capturing it once turns that into
    // a Mongo read — and the link survives whether or not a report ever asks
    // for that day.
    //
    // MARKETING lines only. Servicing calls ("Client Contact - TAG") are real
    // calls but not marketing, and letting them into the pool is how a client
    // ringing support starts to look like a fresh response.
    //
    // PhoneBurner is NOT here: the service account cannot enumerate its dial
    // sessions (0 indexed on every day tried), so those URLs can only arrive
    // from the forward-looking capture path.
    key: "call-links",
    label: "Capture marketing call recording links",
    writesArmed: () => String(process.env.CALL_LINK_CAPTURE_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, logger }) {
      const { captureCallLinks } = require("../../../../packages/shared-services/src/marketingCallLinkService");
      const dateKey = persistTargetDay();
      const out = [];
      for (const domain of domains) {
        // CallRail is ONE tenant; asking per domain is the same account
        // answered three times.
        if (String(domain).toUpperCase() !== "TAG") continue;
        out.push(await captureCallLinks({ dateKey, domain, apply: false, logger }));
      }
      return out;
    },
    async apply(planned, { logger }) {
      const { captureCallLinks } = require("../../../../packages/shared-services/src/marketingCallLinkService");
      const out = { written: 0, skipped: 0, failed: 0, errors: [] };
      for (const p of planned) {
        const r = await captureCallLinks({ dateKey: p.dateKey, domain: p.domain, apply: true, logger });
        out.written += r.written || 0;
        out.skipped += r.alreadyHad || 0;
        out.failed += r.failed || 0;
        if (r.error) out.errors.push(r.error);
      }
      return out;
    },
    count(planned) {
      return planned.reduce((a, p) => a + (p.marketing || 0), 0);
    },
    describe(planned) {
      const p = planned[0] || {};
      if (!p.calls) return `${p.dateKey || "?"}: no calls`;
      return `${p.dateKey}: ${p.calls} call(s) · ${p.marketing} marketing · `
        + `${p.withRecording} with a recording · ${p.alreadyHad} already pooled`;
    },
  },
  {
    // Freeze the day's queue activity so a RANGE never has to ask RingCentral.
    //
    // RC answers per day and rate-limits hard, which is why the work log
    // refused ranges over 7 days. CallLog cannot substitute: on inbound legs
    // extensionId is the QUEUE that rang, not the agent who answered (5 of 44
    // legs mapped on 2026-07-27). Once the day is over, who answered what
    // stops changing — so a stored copy can never go stale.
    key: "queue-rollup",
    label: "Freeze the day's per-agent call counts",
    writesArmed: () => String(process.env.QUEUE_ROLLUP_ENABLED || "false").toLowerCase() === "true",
    async plan({ logger }) {
      const { captureQueueDay } = require("../../../../packages/shared-services/src/queueRollupService");
      const dateKey = persistTargetDay();
      // Read-only: shapes the day without writing it.
      return [{ dateKey, ...(await captureQueueDay({ dateKey, logger })) }];
    },
    async apply(planned, { logger }) {
      const { persistQueueDay } = require("../../../../packages/shared-services/src/queueRollupService");
      const day = await persistQueueDay({ dateKey: planned[0]?.dateKey, logger });
      return {
        written: day.agents.length,
        skipped: 0,
        failed: day.partial ? 1 : 0,
        errors: day.partial ? [`partial: ${day.partialReason}`] : [],
      };
    },
    count(planned) {
      return Number(planned[0]?.agents?.length) || 0;
    },
    describe(planned) {
      const r = planned[0] || {};
      const taken = (r.streams || []).reduce((a, x) => a + (x.connected || 0), 0);
      const made = (r.agents || []).reduce((a, x) => a + (x.made || 0), 0);
      return `${r.dateKey}: ${r.agents?.length || 0} agent(s) · ${taken} taken · ${made} made`
        + (r.partial ? ` — PARTIAL (${r.partialReason})` : "");
    },
  },
  {
    key: "logics-source",
    label: "Write the mail piece onto the Logics case",
    // Two switches on purpose: the task may run (and show its plan) long
    // before it is allowed to write to live client records.
    writesArmed: () => String(process.env.LOGICS_SOURCE_WRITER_ENABLED || "false").toLowerCase() === "true",
    async plan({ domains, days, logger }) {
      const out = [];
      for (const domain of domains) {
        const planned = await planSourceSanitization({ domain, days, logger });
        out.push({ domain, ...planned });
      }
      return out;
    },
    async apply(planned, { logger }) {
      const rows = planned.flatMap((p) => p.plan || []);
      if (!rows.length) return { written: 0, skipped: 0, failed: 0 };
      return applySourceSanitization(rows, { logger });
    },
    describe(planned) {
      const n = planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
      const callers = planned.reduce((acc, p) => acc + (p.stats?.callers || 0), 0);
      return `${callers} caller(s) on an active piece → ${n} case(s) to move off the catch-all`;
    },
  },
];

function createNightlyHygieneRuntime({ config = {}, runtime = {} } = {}) {
  // Each runtime owns its OWN task list. TASKS is the shared default, and
  // handing the module-level array out directly meant any caller mutating it
  // (a test, a future config path) silently reconfigured every other
  // instance — including, in principle, the live one.
  const tasks = Array.isArray(config.tasks) ? [...config.tasks] : [...TASKS];

  const state = {
    enabled: config.enabled === true || String(process.env.NIGHTLY_HYGIENE_ENABLED) === "true",
    hour: Math.min(23, Math.max(0, Number(config.hour ?? process.env.NIGHTLY_HYGIENE_HOUR ?? DEFAULT_HOUR))),
    minute: Math.min(59, Math.max(0, Number(config.minute ?? process.env.NIGHTLY_HYGIENE_MINUTE ?? DEFAULT_MINUTE))),
    pollMs: Math.max(60000, Number(config.pollMs || process.env.NIGHTLY_HYGIENE_POLL_MS) || DEFAULT_POLL_MS),
    days: Math.max(1, Number(config.days || process.env.NIGHTLY_HYGIENE_DAYS) || 3),
    // ALL tenants by default, matching runNightPass. Defaulting to TAG meant
    // WYNN and AMITY activity events and payment truths were never written -
    // two thirds of the tenants silently dropped. A task that only applies to
    // one tenant (the source writer has a TAG-only registry) skips the rest
    // by itself.
    domains: (config.domains || String(process.env.NIGHTLY_HYGIENE_DOMAINS || "TAG,WYNN,AMITY"))
      .toString().split(",").map((d) => d.trim().toUpperCase()).filter(Boolean),
    running: false,
    timer: null,
    lastRunKey: null,          // Pacific day of the last COMPLETED pass
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    totals: { passes: 0, planned: 0, written: 0 },
  };

  const log = runtime.logger || null;

  /** One pass over every task. `force` ignores the clock and the once-a-day rule. */
  async function runOnce({ force = false, apply = null } = {}) {
    // Guard FIRST — every early return below must be unable to skip its
    // release. A runtime on this box once wedged permanently because the
    // `finally` belonged to a different `try`.
    if (state.running) return { skipped: "already running" };
    if (!state.enabled && !force) return { skipped: "disabled" };
    const today = pacificKey();
    if (!force) {
      const now = pacificHourMinute();
      if (now.hour * 60 + now.minute < state.hour * 60 + state.minute) {
        return { skipped: "before the scheduled time" };
      }
      // Compared against a stored day key, not a boolean, so a restart cannot
      // re-run the pass (or a second one) later the same night.
      if (state.lastRunKey === today) return { skipped: "already ran today" };
    }
    state.running = true;
    const started = Date.now();
    try {
      const results = [];
      for (const task of tasks) {
        const taskStarted = Date.now();
        try {
          const planned = await task.plan({ domains: state.domains, days: state.days, logger: log });
          // Each task decides what "something to do" means; the row-list shape
          // is only the default, not an assumption the runtime may make.
          const plannedCount = typeof task.count === "function"
            ? Number(task.count(planned)) || 0
            : planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
          state.totals.planned += plannedCount;

          const armed = apply === null ? task.writesArmed() : Boolean(apply);
          let applied = null;
          if (armed && plannedCount) {
            applied = await task.apply(planned, { logger: log });
            state.totals.written += applied.written || 0;
          }
          results.push({
            task: task.key, label: task.label, dryRun: !armed,
            planned: plannedCount, summary: task.describe(planned), applied,
            durationMs: Date.now() - taskStarted,
            sample: planned.flatMap((p) => (p.plan || []).slice(0, 5)
              .map((r) => ({ caseId: r.caseId, from: r.fromSourceId, to: r.sourceId, piece: r.piece }))).slice(0, 10),
          });
          log?.info?.("nightly_hygiene.task", {
            task: task.key, planned: plannedCount, written: applied?.written ?? 0, dryRun: !armed,
          });
        } catch (error) {
          // One chore failing must never cost the others their night.
          results.push({ task: task.key, label: task.label, error: String(error.message).slice(0, 240) });
          log?.error?.("nightly_hygiene.task_failed", { task: task.key, error: String(error.message) });
        }
      }
      state.totals.passes += 1;
      state.lastRunAt = new Date().toISOString();
      state.lastResult = { at: state.lastRunAt, day: today, durationMs: Date.now() - started, tasks: results };
      // Only a completed pass claims the day; a crash retries on the next poll.
      state.lastRunKey = today;
      return state.lastResult;
    } catch (error) {
      state.lastError = String(error.message).slice(0, 300);
      log?.error?.("nightly_hygiene.failed", { error: String(error.message) });
      return { error: state.lastError };
    } finally {
      state.running = false;
    }
  }

  async function start() {
    if (!state.enabled) {
      log?.info?.("nightly_hygiene.disabled", {
        hint: "set NIGHTLY_HYGIENE_ENABLED=true to run; each task still needs its own write switch",
      });
      return;
    }
    if (state.timer) return;
    state.timer = setInterval(() => { runOnce().catch(() => {}); }, state.pollMs);
    if (state.timer.unref) state.timer.unref();
    log?.info?.("nightly_hygiene.started", {
      at: `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")} PT`,
      pollMs: state.pollMs, domains: state.domains, tasks: tasks.map((t) => t.key),
    });
    await runOnce();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function getState() {
    return {
      enabled: state.enabled,
      hour: state.hour,
      minute: state.minute,
      at: `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")} PT`,
      pollMs: state.pollMs,
      targetDay: persistTargetDay(),
      domains: state.domains,
      days: state.days,
      running: state.running,
      today: pacificKey(),
      lastRunKey: state.lastRunKey,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
      totals: { ...state.totals },
      tasks: tasks.map((t) => ({
        key: t.key, label: t.label,
        writesArmed: t.writesArmed(),
        monitor: Boolean(t.monitor),
        mode: !state.enabled ? "off"
          : t.monitor ? "monitor (never writes)"
            : (t.writesArmed() ? "writing" : "standing dry-run"),
      })),
      lastResult: state.lastResult,
    };
  }

  return { TASKS: tasks, getState, runOnce, start, stop };
}

module.exports = { createNightlyHygieneRuntime, persistTargetDay };
