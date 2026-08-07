"use strict";

// ONE PASS RUNTIME, THREE CLOCKS.
//
// Mickey 2026-08-06: "turn off hourly and do three processes — set up the
// morning and run lead cadence for the day, recalibrate at noon and run a
// second cadence blast, close up and release financial info."
//
// The morning and midday passes are the same machine as the evening one: a
// durable per-day claim, an ordered task registry, a positional cursor, bounded
// attempts, and a standing dry run. Only the clock, the loop key and the tasks
// differ.
//
// So this is a factory rather than a third copy. `nightlyHygieneRuntime` is
// deliberately NOT migrated onto it: it is running, heavily tested, and holds a
// live cursor — moving that while it works buys nothing and risks the one pass
// that already earns its keep. Two copies is the cost of not disturbing it; a
// third would not have been.
//
// ── WHAT THIS GUARANTEES, AND WHY EACH ONE EXISTS ──────────────────────────
//
//  * THE CLAIM IS ATOMIC AND LEASED. Two processes polling the same minute must
//    not both run the day. The claim matches on "unclaimed, or claimed longer
//    ago than the lease" in one updateOne, so the loser sees no match.
//  * plan() RUNS WHETHER OR NOT THE TASK IS ARMED. That is the whole basis of
//    "land dark, observe one cycle, arm" — a task that reported nothing while
//    dark gave the operator nothing to arm on.
//  * A TASK THAT THROWS COSTS ONLY ITSELF. Bounded retries, then the pass steps
//    past it, because the alternative is one bad chore wedging the day.
//  * LOSING THE CURSOR ABORTS THE PASS. Distinct from a task failing: if
//    another process took the day, continuing would write it twice.
//  * THE GUARD IS TAKEN BEFORE ANY EARLY RETURN CAN SKIP IT.

const DailyLoopRun = require("../../../../packages/shared-models/src/DailyLoopRun");

const CURSOR_LOST = "durable-cursor-lost";
const cursorLost = (passKey) => Object.assign(
  new Error(`${passKey} durable cursor was lost`), { code: CURSOR_LOST },
);

function pacificParts(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t) => parts.find((x) => x.type === t)?.value;
  return { weekday: get("weekday"), hour: Number(get("hour")) % 24, minute: Number(get("minute")) };
}

function pacificDayKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

const isPacificBusinessDay = (at = new Date()) => {
  const { weekday } = pacificParts(at);
  return weekday !== "Sat" && weekday !== "Sun";
};

/**
 * Claim the day for one pass. Returns null if somebody else holds it.
 *
 * Keyed under `passes.<passKey>` — see the note on DailyLoopRun.passes for why
 * that is a Mixed subdocument and not five more flat fields.
 */
async function claimPass(passKey, dateKey, { leaseMs, at = new Date(), Model = DailyLoopRun } = {}) {
  const leaseCutoff = new Date(at.getTime() - leaseMs);
  const base = `passes.${passKey}`;
  try {
    const claimed = await Model.findOneAndUpdate(
      {
        dateKey,
        $or: [
          { [`${base}.claimedAt`]: { $exists: false } },
          { [`${base}.claimedAt`]: null },
          { [`${base}.claimedAt`]: { $lte: leaseCutoff } },
        ],
        [`${base}.completedAt`]: { $in: [null, undefined] },
      },
      { $set: { [`${base}.claimedAt`]: at } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    if (!claimed) return null;
    const cursor = claimed?.passes?.[passKey] || {};
    return {
      claimedAt: new Date(cursor.claimedAt || at),
      nextTaskIndex: Math.max(0, Number(cursor.nextTaskIndex || 0)),
      attemptsByTask: { ...(cursor.attemptsByTask || {}) },
      failedTasks: { ...(cursor.failedTasks || {}) },
    };
  } catch (error) {
    // A duplicate-key race means the other side won the upsert.
    if (Number(error?.code) === 11000) return null;
    throw error;
  }
}

/**
 * Advance the cursor, still holding the claim. Returns the RENEWED claimedAt,
 * or null when the claim was lost.
 *
 * Advancing also renews the lease. The lease was fixed at claim time, so a
 * pass whose tasks legitimately took longer than 45 minutes IN TOTAL could be
 * reclaimed by another process while its original worker was mid-write — the
 * takeover predicate only knows claimedAt. Bumping claimedAt on every advance
 * makes the lease per-task rather than per-pass: a takeover now needs 45
 * minutes of genuine silence, not 45 minutes of honest work.
 */
async function advancePass(passKey, dateKey, claimedAt, nextTaskIndex, counts, {
  at = new Date(),
  Model = DailyLoopRun,
  attemptsByTask = {},
  failedTasks = {},
} = {}) {
  const base = `passes.${passKey}`;
  const result = await Model.updateOne(
    { dateKey, [`${base}.claimedAt`]: claimedAt, [`${base}.completedAt`]: { $in: [null, undefined] } },
    {
      $set: {
        [`${base}.claimedAt`]: at,
        [`${base}.nextTaskIndex`]: nextTaskIndex,
        [`${base}.counts`]: counts,
        [`${base}.attemptsByTask`]: attemptsByTask,
        [`${base}.failedTasks`]: failedTasks,
        [`${base}.lastErrorCode`]: Object.keys(failedTasks).length ? "task-failures" : null,
      },
    },
  );
  const matched = result?.matchedCount ?? result?.n;
  const ok = matched == null ? result?.acknowledged !== false : Number(matched) === 1;
  return ok ? at : null;
}

/**
 * Hand the day back without completing it.
 *
 * REQUIRED ON EVERY RETRY RETURN. The claim is leased, so a pass that bails out
 * still holding it cannot be re-entered until the lease expires — 45 minutes,
 * against a 5-minute poll. The intended retry budget (3 attempts x 5 minutes)
 * would silently become one attempt every 45 minutes, and a chore that needed
 * two tries would not get its second until most of the window was gone.
 */
async function releasePass(passKey, dateKey, claimedAt, errorCode = null, {
  Model = DailyLoopRun,
  attemptsByTask = {},
} = {}) {
  const base = `passes.${passKey}`;
  await Model.updateOne(
    { dateKey, [`${base}.claimedAt`]: claimedAt, [`${base}.completedAt`]: { $in: [null, undefined] } },
    { $set: {
      [`${base}.claimedAt`]: null,
      [`${base}.attemptsByTask`]: attemptsByTask,
      [`${base}.lastErrorCode`]: errorCode,
    } },
  );
}

async function finishPass(passKey, dateKey, claimedAt, nextTaskIndex, counts, {
  at = new Date(),
  Model = DailyLoopRun,
  attemptsByTask = {},
  failedTasks = {},
} = {}) {
  const base = `passes.${passKey}`;
  const result = await Model.updateOne(
    { dateKey, [`${base}.claimedAt`]: claimedAt, [`${base}.completedAt`]: { $in: [null, undefined] } },
    {
      $set: {
        [`${base}.completedAt`]: at,
        [`${base}.nextTaskIndex`]: nextTaskIndex,
        [`${base}.counts`]: counts,
        [`${base}.attemptsByTask`]: attemptsByTask,
        [`${base}.failedTasks`]: failedTasks,
        [`${base}.degraded`]: Object.keys(failedTasks).length > 0,
        [`${base}.lastErrorCode`]: Object.keys(failedTasks).length
          ? "completed-with-task-failures"
          : null,
      },
    },
  );
  const matched = result?.matchedCount ?? result?.n;
  return matched == null ? result?.acknowledged !== false : Number(matched) === 1;
}

/**
 * Build a pass runtime.
 *
 * @param {string} passKey     stable id, also the DailyLoopRun cursor key
 * @param {string} label       human name for logs and getState
 * @param {string} enabledEnv  env var that arms the RUNTIME (not its tasks)
 * @param {number} defaultHour Pacific hour it fires at
 * @param {Array}  tasks       the registry; same contract as nightly hygiene
 */
function createPassRuntime({
  passKey,
  label,
  enabledEnv,
  defaultHour,
  defaultMinute = 0,
  tasks = [],
  config = {},
  runtime = {},
  leaseMs = 45 * 60 * 1000,
  maxTaskAttempts = 3,
} = {}) {
  if (!passKey) throw new TypeError("a pass runtime needs a passKey");

  const TASKS = [...tasks];
  const log = runtime.logger || null;
  const envFlag = (name, fallback = false) => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return String(raw).toLowerCase() === "true";
  };

  const state = {
    // Default OFF. Deploying the code must never start a pass.
    enabled: config.enabled === true || envFlag(enabledEnv, false),
    hour: Number(process.env[`${enabledEnv.replace(/_ENABLED$/, "")}_HOUR`] ?? config.hour ?? defaultHour),
    minute: Number(process.env[`${enabledEnv.replace(/_ENABLED$/, "")}_MINUTE`] ?? config.minute ?? defaultMinute),
    pollMs: Math.max(60000, Number(config.pollMs) || 5 * 60 * 1000),
    domains: (process.env.NIGHTLY_HYGIENE_DOMAINS || "TAG,WYNN,AMITY")
      .split(",").map((d) => d.trim().toUpperCase()).filter(Boolean),
    running: false,
    timer: null,
    lastRunKey: null,
    lastRunAt: null,
    lastResults: [],
    lastError: null,
    totals: { planned: 0, written: 0 },
  };

  async function runOnce({ apply = null, force = false, now = new Date(), Model = DailyLoopRun } = {}) {
    // Guard FIRST. Every early return below must be unable to skip the release.
    if (state.running) return { skipped: "already running" };
    if (!state.enabled && !force) return { skipped: "disabled" };
    const dateKey = pacificDayKey(now);
    if (!force && state.lastRunKey === dateKey) return { skipped: "already ran today" };
    // Scheduled passes are always dark on Pacific weekends. The only weekend
    // automation boundary is inbound intake: persist the new lead, deliver its
    // initial SMS/email, and leave it durably enrolled for Monday. `force`
    // remains the explicit operator escape hatch.
    if (!force && !isPacificBusinessDay(now)) {
      return { skipped: "pacific-weekend" };
    }
    const pt = pacificParts(now);
    if (!force && (pt.hour * 60 + pt.minute) < (state.hour * 60 + state.minute)) {
      return { skipped: "before the scheduled time" };
    }

    state.running = true;
    const started = Date.now();
    try {
      const claim = await claimPass(passKey, dateKey, { leaseMs, at: now, Model });
      if (!claim) return { skipped: "claimed by another pass" };

      const results = [];
      const totals = { planned: 0, written: 0 };
      let index = claim.nextTaskIndex;
      const attemptsByTask = { ...claim.attemptsByTask };
      const failedTasks = { ...claim.failedTasks };

      while (index < TASKS.length) {
        const task = TASKS[index];
        const taskStarted = Date.now();
        try {
          // A pass admitted here is a business-day pass. Keep the per-task gate
          // as defense in depth for explicitly forced/custom runtimes; scheduled
          // automation never reaches it on a weekend.
          if (!force && task.weekdaysOnly === true && !isPacificBusinessDay(now)) {
            results.push({
              task: task.key,
              label: task.label,
              skipped: "pacific-weekend",
              planned: 0,
              durationMs: Date.now() - taskStarted,
            });
            index += 1;
            delete attemptsByTask[task.key];
            const renewed = await advancePass(passKey, dateKey, claim.claimedAt, index, totals, {
              Model, attemptsByTask, failedTasks,
            });
            if (!renewed) throw cursorLost(passKey);
            claim.claimedAt = renewed;
            continue;
          }
          const armed = apply === null ? task.writesArmed() : Boolean(apply);

          // THE STANDING DRY RUN. plan() runs for every task, armed or not —
          // otherwise a task landed dark reports nothing and there is no
          // evidence to arm on.
          const planned = await task.plan({ domains: state.domains, logger: log });
          const plannedCount = typeof task.count === "function"
            ? Number(task.count(planned)) || 0
            : planned.reduce((acc, p) => acc + (p.plan?.length || 0), 0);
          totals.planned += plannedCount;

          let applied = null;
          if (armed && plannedCount) {
            applied = await task.apply(planned, { logger: log, ...(config.collaborators || {}) });
            totals.written += applied?.written || 0;

            // A RETURNED total failure is still a failure. Every task here
            // catches provider errors and reports them as {failed: n} rather
            // than throwing — the right shape for a PARTIAL failure, where the
            // successes must not be re-run. But a night where NOTHING succeeded
            // used to sail through this loop, advance the cursor, and complete
            // the day: a total provider outage got zero retries and a clean
            // summary. Written and skipped both zero with failures present
            // means no work happened at all, and re-running loses nothing.
            const totalFailure = Number(applied?.failed) > 0
              && !(Number(applied?.written) > 0)
              && !(Number(applied?.skipped) > 0)
              && !(Number(applied?.lockBusy) > 0);
            if (totalFailure) {
              const first = Array.isArray(applied?.errors) ? applied.errors[0] : null;
              throw new Error(
                `${task.key} failed completely — ${String(first || `${applied.failed} failure(s)`).slice(0, 160)}`,
              );
            }

            // A task may return drained:false to say "work remains that I could
            // not finish" — a stuck provider mid-backlog, a round cap hit. That
            // is an INCOMPLETE task, not a done one: advancing the cursor over
            // it marks the day complete with items still due and nothing ever
            // comes back for them. Routing it through the retry path re-runs
            // the task, which CONTINUES the work rather than repeating it (the
            // per-lead daily keys advance with every success), bounded by the
            // same attempt budget as a throw.
            if (applied?.drained === false) {
              throw new Error(
                `${task.key} did not drain — ${Number(applied.failed) || 0} failure(s), work remains due`,
              );
            }
          }

          results.push({
            task: task.key,
            label: task.label,
            dryRun: !armed,
            ...(armed ? {} : { reason: "standing-dry-run" }),
            planned: plannedCount,
            summary: task.describe(planned),
            applied,
            durationMs: Date.now() - taskStarted,
          });
          log?.info?.(`${passKey}.task`, {
            task: task.key, planned: plannedCount, written: applied?.written ?? 0, dryRun: !armed,
          });

          index += 1;
          delete attemptsByTask[task.key];
          const renewed = await advancePass(passKey, dateKey, claim.claimedAt, index, totals, {
            Model, attemptsByTask, failedTasks,
          });
          if (!renewed) throw cursorLost(passKey);
          claim.claimedAt = renewed;
        } catch (error) {
          if (error?.code === CURSOR_LOST) throw error;
          const tried = Math.max(0, Number(attemptsByTask[task.key]) || 0) + 1;
          attemptsByTask[task.key] = tried;
          results.push({ task: task.key, label: task.label, error: String(error.message).slice(0, 240) });
          log?.error?.(`${passKey}.task_failed`, { task: task.key, attempt: tried, error: String(error.message) });
          if (tried < maxTaskAttempts) {
            // Leave the CURSOR where it is so the next poll retries this chore —
            // but hand the CLAIM back, or the lease locks the day out for 45
            // minutes and the retry budget never actually spends itself.
            await releasePass(passKey, dateKey, claim.claimedAt, error?.code || "task-failed", {
              Model, attemptsByTask,
            });
            state.lastResults = results;
            return { ran: results.length, results, retrying: task.key, attempt: tried, durationMs: Date.now() - started };
          }
          // Out of attempts — step past it so the rest of the day still runs.
          failedTasks[task.key] = {
            attempts: tried,
            errorCode: String(error?.code || error?.name || "task-failed").slice(0, 120),
            failedAt: new Date(),
          };
          results[results.length - 1].skippedAfterAttempts = tried;
          index += 1;
          delete attemptsByTask[task.key];
          const renewed = await advancePass(passKey, dateKey, claim.claimedAt, index, totals, {
            Model, attemptsByTask, failedTasks,
          });
          if (!renewed) throw cursorLost(passKey);
          claim.claimedAt = renewed;
        }
      }

      // An unacknowledged completion means the claim moved under us — the same
      // condition as a lost cursor, and marking the day done in memory anyway
      // would hide that a second process may be re-running it right now.
      if (!await finishPass(passKey, dateKey, claim.claimedAt, index, totals, {
        at: new Date(), Model, attemptsByTask, failedTasks,
      })) {
        throw cursorLost(passKey);
      }
      state.lastRunKey = dateKey;
      state.lastRunAt = new Date().toISOString();
      state.lastResults = results;
      state.totals = totals;
      state.lastError = Object.keys(failedTasks).length ? "completed-with-task-failures" : null;
      log?.info?.(`${passKey}.completed`, { dateKey, ...totals, tasks: results.length });
      return {
        ran: results.length,
        results,
        totals,
        degraded: Object.keys(failedTasks).length > 0,
        failedTasks: Object.keys(failedTasks),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      state.lastError = String(error.message).slice(0, 300);
      if (error?.code === CURSOR_LOST) {
        log?.warn?.(`${passKey}.cursor_lost`, { dateKey: pacificDayKey(now) });
        return { aborted: CURSOR_LOST };
      }
      log?.error?.(`${passKey}.failed`, { error: String(error.message) });
      return { error: state.lastError };
    } finally {
      state.running = false;
    }
  }

  async function start() {
    if (!state.enabled) {
      log?.info?.(`${passKey}.disabled`, { hint: `set ${enabledEnv}=true to arm` });
      return;
    }
    if (state.timer) return;
    state.timer = setInterval(() => { runOnce().catch(() => {}); }, state.pollMs);
    if (state.timer.unref) state.timer.unref();
    log?.info?.(`${passKey}.started`, { hour: state.hour, minute: state.minute, pollMs: state.pollMs });
    await runOnce();
  }

  async function stop({ maxWaitMs = 25_000 } = {}) {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    // A shutdown that returns while a pass is mid-task hands the process
    // manager a green light to kill writes in flight. Bounded, because a
    // shutdown that never returns is the other failure.
    const deadline = Date.now() + maxWaitMs;
    while (state.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (state.running) {
      log?.warn?.(`${passKey}.shutdown_timeout`, { waitedMs: maxWaitMs });
    }
  }

  function getState() {
    return {
      pass: passKey,
      label,
      enabled: state.enabled,
      running: state.running,
      at: `${String(state.hour).padStart(2, "0")}:${String(state.minute).padStart(2, "0")} PT`,
      today: pacificDayKey(),
      domains: state.domains,
      lastRunKey: state.lastRunKey,
      lastRunAt: state.lastRunAt,
      lastResults: state.lastResults,
      lastError: state.lastError,
      totals: state.totals,
      tasks: TASKS.map((t) => ({
        key: t.key,
        label: t.label,
        writesArmed: t.writesArmed(),
        mode: !state.enabled ? "off" : (t.writesArmed() ? "writing" : "standing dry-run"),
      })),
    };
  }

  return { TASKS, getState, runOnce, start, stop, passKey };
}

module.exports = {
  CURSOR_LOST,
  advancePass,
  claimPass,
  createPassRuntime,
  finishPass,
  releasePass,
  isPacificBusinessDay,
  pacificDayKey,
  pacificParts,
};
