"use strict";

// The end-of-day loop, sheet-triggered (build-up work order F1).
//
// Mickey (2026-07-27): "I'll pull both payment sheets at 6 pm and upload
// them, you'll pull both activities when you get both the payment sheets
// and run the loop."
//
// So the ACTIVITIES PULL is triggered by the payments gate going ready, not
// by a clock — and, per Mickey (same day): "the service depends on the
// presence of the sheets to run ... if it's not uploaded by this time don't
// do it at this time." The scheduled tick therefore WAITS rather than
// running a report on half a day's inputs; see decideScheduledActivitiesRun.
//
// Every stage is guarded by a per-day document (`DailyLoopRun`) rather than
// runtime state, so a re-upload, a retry, or a process restart cannot
// double-fire.

const { DailyLoopRun } = require("../../shared-models/src");

function pacificDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/**
 * Hand a claimed day back when the run failed.
 *
 * The claim is a LEASE, not a tombstone. Without this, one Logics 500 at
 * 18:04 stamps the day as fired, the deadline backstop then finds it
 * "already ran", and the night silently produces nothing — the exact
 * opposite of the guarantee that the pull happens that night.
 */
async function releaseActivitiesRun({ dateKey, error = null } = {}) {
  const key = String(dateKey || pacificDateKey());
  try {
    await DailyLoopRun.updateOne(
      { dateKey: key },
      {
        $set: {
          activitiesFiredAt: null,
          activitiesResult: error ? { failed: String(error).slice(0, 300) } : null,
        },
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the activities-pull for `dateKey`, atomically.
 *
 * Returns true to EXACTLY ONE caller per day. Implemented as a conditional
 * upsert: the filter requires `activitiesFiredAt` to be null/absent, so two
 * concurrent uploads race at the database and only one wins.
 */
/** Claim lease length. A held claim with no completed day-doc older than
 * this is presumed crashed and becomes reclaimable — a hard process crash
 * executes no catch, so without expiry an nssm restart mid-pass would leave
 * the day stamped and the night silently lost (adversarial finding). */
const DEFAULT_CLAIM_LEASE_MINUTES = 45;

function claimLeaseMinutes() {
  const raw = Number(process.env.LOOP_CLAIM_LEASE_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CLAIM_LEASE_MINUTES;
  return Math.trunc(raw);
}

async function claimActivitiesRun({ dateKey, triggeredBy = null } = {}) {
  const key = String(dateKey || pacificDateKey());
  const leaseCutoff = new Date(Date.now() - claimLeaseMinutes() * 60 * 1000);
  try {
    const claimed = await DailyLoopRun.findOneAndUpdate(
      {
        dateKey: key,
        $or: [
          { activitiesFiredAt: null },
          { activitiesFiredAt: { $exists: false } },
          // Expired lease: claimed long ago, never completed. Reclaimable.
          // A COMPLETED night (dayDocCompletedAt set) is never reclaimable —
          // once-per-day stays absolute for finished work.
          {
            activitiesFiredAt: { $lt: leaseCutoff },
            $and: [{ $or: [
              { dayDocCompletedAt: null },
              { dayDocCompletedAt: { $exists: false } },
            ] }],
          },
        ],
      },
      {
        $set: { activitiesFiredAt: new Date(), activitiesTriggeredBy: triggeredBy },
        $setOnInsert: { dateKey: key },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return Boolean(claimed);
  } catch (error) {
    // Duplicate key = another upload claimed it microseconds earlier. That
    // is the guard working, not a failure.
    if (error?.code === 11000) return false;
    throw error;
  }
}

// ── the three clock hands ─────────────────────────────────────────────────
//
// Mickey (2026-07-27): "it can arm at 6 even and wait for the sheet imo. so
// check until it shows up and then alert me that i forgot at 8 perhaps."
//
//   ARM      18:00  the tick starts asking "are the sheets up?" every minute
//   REMIND   20:00  still not up → email him ONCE that he forgot
//   DEADLINE 23:00  presumed not coming → run anyway, flagged sheetless
//
// ARM is the runtime's own schedule hour (the tick does not exist before
// it), so only the latter two live here.
//
// The DEADLINE is a floor, not an escape hatch. Mickey (same day): "the
// logics activity pull honestly might be able to phase out payments sheet
// requirements eventually so its definitely a that night thing because it
// has everything really." The pull is a Logics read that stands on its own;
// the sheet is a PREFERRED input we wait for so the night's loop is
// complete, never a hard dependency. So the guarantee is: the pull happens
// that night. Waiting is the courtesy; running is the contract. If the sheet
// requirement is dropped later, this whole wait collapses to `gateReady:
// true` and nothing downstream changes.

const DEFAULT_SHEET_REMINDER_HOUR = 20;
const DEFAULT_SHEET_DEADLINE_HOUR = 23;

function envHour(name, fallback) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(23, Math.trunc(raw)));
}

function sheetReminderHour() {
  return envHour("LOGICS_ACTIVITY_REVIEW_SHEET_REMINDER_HOUR", DEFAULT_SHEET_REMINDER_HOUR);
}

function sheetDeadlineHour() {
  return envHour("LOGICS_ACTIVITY_REVIEW_SHEET_DEADLINE_HOUR", DEFAULT_SHEET_DEADLINE_HOUR);
}

/**
 * Claim the "you forgot the sheet" reminder for `dateKey`, atomically.
 *
 * Same conditional-upsert shape as claimActivitiesRun, and for the same
 * reason: the tick asks every 60 seconds from 20:00 to 23:00, so without a
 * claim Mickey would get 180 identical emails. Returns true to exactly one
 * caller per day.
 */
async function claimSheetReminder({ dateKey, missing = [] } = {}) {
  const key = String(dateKey || pacificDateKey());
  try {
    const claimed = await DailyLoopRun.findOneAndUpdate(
      {
        dateKey: key,
        $or: [{ sheetReminderSentAt: null }, { sheetReminderSentAt: { $exists: false } }],
      },
      {
        $set: { sheetReminderSentAt: new Date(), sheetReminderMissing: missing },
        $setOnInsert: { dateKey: key },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return Boolean(claimed);
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * What should the SCHEDULED tick do right now?
 *
 * Mickey's rule: the loop depends on the sheets, so don't do it at the
 * scheduled time if they aren't uploaded — wait, and let a late upload still
 * get a full loop. The tick re-asks this every interval from ARM onward.
 *
 * The deadline is the one exception. Activities are NOT sheet-derived: the
 * DNC / post-date status changes are safety work, and the standing rule is
 * that the payments gate holds MONEY and never holds safety work. So once
 * the sheets are presumed not coming, the pull runs anyway — flagged, so the
 * day is legible as "ran without sheets" rather than silently thin.
 *
 * Pure: no clock, no DB, no env read when the caller supplies the hours.
 * The caller passes `hourNow` and whether the reminder already went out.
 */
function decideScheduledActivitiesRun({
  gateReady,
  hourNow,
  reminderHour = sheetReminderHour(),
  deadlineHour = sheetDeadlineHour(),
  reminderAlreadySent = false,
  remindersEnabled = true,
} = {}) {
  const hour = Number(hourNow);
  if (gateReady) {
    return { run: true, ranWithoutSheets: false, remind: false, reason: "sheets-ready" };
  }
  if (hour >= Number(deadlineHour)) {
    // Past the deadline we run and do NOT nag — the run itself reports that
    // it went without sheets, so a reminder on top is just a second email
    // about the same fact.
    return { run: true, ranWithoutSheets: true, remind: false, reason: "deadline-no-sheets" };
  }
  const remind = Boolean(remindersEnabled)
    && !reminderAlreadySent
    && hour >= Number(reminderHour);
  return {
    run: false,
    ranWithoutSheets: false,
    remind,
    reason: remind ? "waiting-and-reminding" : "waiting-for-sheets",
  };
}

/**
 * Fire the activities pull IF the payments gate is ready and today has not
 * already fired.
 *
 * NEVER throws — the caller is an upload handler and a metrics side effect
 * must not fail an import. Always returns a describable outcome.
 */
async function triggerActivitiesIfSheetsReady({
  dateKey,
  triggeredBy = null,
  logger = null,
  // seams for tests
  readGate = null,
  runActivities = null,
} = {}) {
  const key = String(dateKey || pacificDateKey());
  try {
    const gateReader = readGate
      || require("./paymentsSheetGateService").readPaymentsSheetStatus;
    const gate = await gateReader({ dateKey: key });
    if (!gate?.ready) {
      return { fired: false, reason: "gate-not-ready", missing: gate?.missing || [], stale: gate?.stale || [] };
    }

    if (!(await claimActivitiesRun({ dateKey: key, triggeredBy }))) {
      return { fired: false, reason: "already-ran-today" };
    }

    const runner = runActivities
      || require("./logicsActivityReviewService").runLogicsActivityReviewBatch;
    // The review sends its own operational email either way — this trigger
    // only decides WHEN the pull happens, never whether Mickey hears about
    // it. Whichever path runs first (sheet trigger or the 20:00 fallback)
    // is the one that sends; the other is skipped by the same guard.
    // Deliberately NOT awaited by the HTTP caller — see triggerAsync below.
    let result;
    try {
      result = await runner({ dateKey: key });
    } catch (runError) {
      // Give the day back so the deadline backstop can still run it.
      await releaseActivitiesRun({ dateKey: key, error: runError.message });
      throw runError;
    }
    await DailyLoopRun.updateOne(
      { dateKey: key },
      { $set: { activitiesResult: summarizeActivitiesResult(result) } },
    ).catch(() => {});
    logger?.info?.("daily_loop.activities_fired", { dateKey: key, triggeredBy });
    return { fired: true, dateKey: key };
  } catch (error) {
    logger?.warn?.("daily_loop.activities_trigger_failed", {
      dateKey: key, error: String(error.message).slice(0, 200),
    });
    return { fired: false, reason: "error", error: String(error.message).slice(0, 200) };
  }
}

/** Keep only the counts — the full review payload is large and already on disk. */
function summarizeActivitiesResult(result = {}) {
  const counts = result?.processed?.statusChangeCounts || null;
  return {
    domains: result?.domains || null,
    parsedRows: result?.processed?.parsedRows ?? null,
    statusChangeCounts: counts
      ? { dnc: counts.dnc, postdate: counts.postdate, casesChanged: counts.casesChanged }
      : null,
  };
}

/**
 * Fire-and-forget wrapper for HTTP handlers. Returns immediately; the pull
 * continues in the background. Errors are swallowed into the log — an
 * upload response must never wait on, or fail because of, the activities
 * review.
 */
function triggerActivitiesAsync(options = {}) {
  setImmediate(() => {
    triggerActivitiesIfSheetsReady(options).catch(() => {});
  });
  return { scheduled: true };
}

async function readDailyLoopRun(dateKey) {
  return DailyLoopRun.findOne({ dateKey: String(dateKey || pacificDateKey()) }).lean();
}

module.exports = {
  DEFAULT_SHEET_DEADLINE_HOUR,
  DEFAULT_SHEET_REMINDER_HOUR,
  claimActivitiesRun,
  claimSheetReminder,
  releaseActivitiesRun,
  decideScheduledActivitiesRun,
  sheetDeadlineHour,
  sheetReminderHour,
  pacificDateKey,
  readDailyLoopRun,
  summarizeActivitiesResult,
  triggerActivitiesAsync,
  triggerActivitiesIfSheetsReady,
};
