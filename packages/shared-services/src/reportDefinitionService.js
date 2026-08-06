"use strict";

// THE SCHEDULER — run a saved shape, on a clock, without a model in the loop.
//
// Mickey 2026-07-28: "so yeah mostly this is a report scheduler on the common
// things. so if i want to run something and email it tonight i can set that up
// without talkign to a model. but if i get asked an interesting question we can
// design something that uses this set of tools to get an answer."
//
// This file is the FIRST half of that sentence. It resolves a rolling range,
// composes the report from the authoritative services, and delivers it. It has
// no opinions about content — the blocks own that.

const ReportDefinition = require("../../shared-models/src/ReportDefinition");
const { composeReport, renderHtml, renderText, renderCsvs, toTemplateData } = require("./reportComposerService");
const {
  canRenderFromRecord,
  renderReportFromRecord: renderFromRecord,
} = require("./dailyRecordRenderService");
const { resolveSelection } = require("./reportBlocksService");

const DAY_MS = 86400000;

// Three attempts, then wait for tomorrow. See isDue.
const MAX_ATTEMPTS_PER_DAY = Math.max(1, Number(process.env.REPORT_MAX_ATTEMPTS_PER_DAY) || 3);

async function captureDeliveredDailyFact({
  def,
  report,
  range,
  emailAcceptedAt = new Date(),
  writer = null,
} = {}) {
  const {
    isDailyFactCaptureCandidate,
    persistDailyReportFact,
  } = require("./dailyReportFactService");
  const verdict = isDailyFactCaptureCandidate(def, report, range);
  if (!verdict.capture) return { status: "skipped", reason: verdict.reason };
  const persist = writer || persistDailyReportFact;
  return persist({
    dateKey: range.from,
    definitionName: def.name,
    report,
    emailAcceptedAt,
  });
}

/** Pacific day key — every loop on this box is Pacific, so reports are too. */
function pacificKey(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}

function pacificParts(at = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit",
    weekday: "short", day: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (t) => f.find((p) => p.type === t)?.value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { hour: Number(get("hour")) % 24, minute: Number(get("minute")), dayOfWeek: dow, dayOfMonth: Number(get("day")) };
}

const shift = (key, days) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Resolve a rolling range token to real dates.
 *
 * "yesterday" must mean yesterday on the day it RUNS — a saved shape that
 * froze a literal date would quietly email the same numbers forever.
 */
function resolveRange(token, now = new Date()) {
  const today = pacificKey(now);
  switch (String(token || "yesterday")) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = shift(today, -1); return { from: y, to: y }; }
    case "last7": return { from: shift(today, -7), to: shift(today, -1) };
    case "last30": return { from: shift(today, -30), to: shift(today, -1) };
    case "mtd": return { from: `${today.slice(0, 7)}-01`, to: today };
    case "lastmonth": {
      const first = `${today.slice(0, 7)}-01`;
      const lastDayPrev = shift(first, -1);
      return { from: `${lastDayPrev.slice(0, 7)}-01`, to: lastDayPrev };
    }
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    default: { const y = shift(today, -1); return { from: y, to: y }; }
  }
}

/**
 * Is this definition due right now?
 *
 * Due-ness is decided against lastRunKey, not an in-memory flag: the control
 * plane restarts often and must not re-send a report that already went out.
 */
function isDue(def, now = new Date()) {
  if (!def?.schedule?.enabled || def.archivedAt) return { due: false, reason: "not scheduled" };
  const { hour, minute, dayOfWeek, dayOfMonth } = pacificParts(now);
  const dows = def.schedule.daysOfWeek || [];
  if (dows.length && !dows.includes(dayOfWeek)) return { due: false, reason: "not a scheduled weekday" };
  const doms = def.schedule.daysOfMonth || [];
  if (doms.length) {
    const isLastDay = shift(pacificKey(now), 1).slice(8) === "01";
    const wanted = doms.includes(dayOfMonth) || (doms.includes(0) && isLastDay);
    if (!wanted) return { due: false, reason: "not a scheduled day of month" };
  }
  const nowMins = hour * 60 + minute;
  const wantMins = (def.schedule.hour || 0) * 60 + (def.schedule.minute || 0);
  if (nowMins < wantMins) return { due: false, reason: "before scheduled time" };
  const key = pacificKey(now);
  if (def.lastRunKey === key) return { due: false, reason: "already ran today" };
  // STOP RETRYING AFTER THREE. A failed run deliberately does not stamp
  // lastRunKey so the next poll retries it — right, but the only other stop was
  // Pacific midnight. At a 60s poll that is hundreds of attempts, each one a
  // FULL live gather: a CallRail daily-stat re-sync that WRITES to Mongo, ~46
  // per-day CallRail pulls, a Logics getCaseInfo per deal, RingCentral queue
  // paging. Hammering the vendors overnight is how a bad Tuesday makes
  // Wednesday wrong too, so three tries and then wait for tomorrow.
  if (def.lastAttemptKey === key && (Number(def.attemptsToday) || 0) >= MAX_ATTEMPTS_PER_DAY) {
    return { due: false, reason: `failed ${def.attemptsToday} time(s) today — not retrying until tomorrow` };
  }
  return { due: true, reason: null };
}

/**
 * Run one saved shape. Always re-gathers; never reads a stored answer.
 *
 * `dryRun` composes and renders but does not send or record the run — so a
 * schedule can be inspected before it is armed.
 */
async function runDefinition(def, {
  now = new Date(), dryRun = false, logger = null, sendMail = null, fromEmail = null,
  // Test/backfill seam only. Production leaves this null and uses the
  // canonical DailyReportFact writer.
  dailyFactWriter = null,
  // Per-invocation range override, used by --date to re-send a PAST day.
  // Never persisted: the definition's own range is left exactly as saved.
  rangeOverride = null,
  // Bypass the once-a-day claim for a MANUAL re-send. The claim exists so the
  // scheduler cannot double-send a night; a person asking for the same day
  // again is not that case. Never set by the scheduler.
  force = false,
  // Called with the composed report AFTER the day is claimed and BEFORE the
  // mail goes out.
  //
  // Mickey 2026-08-06: "email logic works so why change what works, just put it
  // in the flow so that it saves a copy then generates the email."
  //
  // A HOOK rather than a persistence call, deliberately. The 2026-08-04 split
  // moved persistence out of here so that sending carries no persistence
  // concern, and that ruling still holds — this function does not know what a
  // DailyReportFact is. It just offers the one moment where the report exists
  // and the mail has not yet been sent, and lets its caller decide what to do
  // with it.
  onComposed = null,
} = {}) {
  const started = Date.now();
  const range = rangeOverride || resolveRange(def.range, now);
  const selection = resolveSelection(def.blocks && def.blocks.length ? def.blocks : ["daily"]);
  if (selection.unknown.length) {
    // Refuse rather than quietly emailing a report missing the thing that was
    // asked for — a silently-dropped block looks like a zero.
    throw new Error(`definition "${def.name}" names unknown block(s): ${selection.unknown.join(", ")}`);
  }

  // TWO PRODUCERS OF ONE SHAPE.
  //
  // The default is unchanged: compose live. A definition carrying
  // renderSource:"record" renders from the stored DailyReportFact instead —
  // the side-by-side that shows whether a stored day can stand in for a live
  // gather.
  //
  // canRenderFromRecord, not a bare field check: it also refuses a
  // tenant-scoped or filtered definition. The record has no domain dimension
  // and the longcalls block filters on one, so rendering a WYNN board from an
  // all-domain record would hand the lead vendor recordings of our own mail
  // callers — which that block's comment records having happened once already.
  //
  // A MISSING RECORD IS NOT AN EMPTY DAY. renderFromRecord returns null and
  // this throws rather than emailing a confident page of zeroes. The runtime
  // already treats a throw as "not a run", so the day is retried instead of
  // being stamped delivered.
  const recordVerdict = canRenderFromRecord(def);
  let report;
  if (recordVerdict.ok) {
    report = await renderFromRecord({
      dateKey: range.from,
      selection: selection.blocks.map((b) => b.id),
    });
    if (!report) {
      throw new Error(
        `definition "${def.name}" is record-sourced but no DailyReportFact exists for ${range.from}`,
      );
    }
  } else {
    report = await composeReport({
      selection: def.blocks && def.blocks.length ? def.blocks : ["daily"],
      from: range.from, to: range.to,
      domain: def.domain || null,
      // composeReport destructures `where`, not `filters`. Passing the wrong key
      // did not throw — it silently dropped every saved filter, so a definition
      // saved as "cohort=2024 only" emailed the UNFILTERED numbers and looked
      // perfectly fine doing it.
      where: def.filters || [],
      live: true, logger,
    });
  }

  const text = renderText(report);
  const templateData = toTemplateData(report, {
    title: def.name,
    eyebrow: def.description || "Report",
  });
  const html = renderHtml(report);
  // A SOURCE THAT DID NOT ANSWER IS AN ERROR, not a footnote. `sections[].error`
  // only catches a block that THREW; a total Logics outage composes five
  // perfectly-formed sections of zero and filed as a clean run, which is how a
  // broken nightly went unnoticed for weeks.
  const failures = report.failures || [];
  const result = {
    definition: def.name, range, blocks: selection.blocks.map((b) => b.id),
    sections: report.sections.length,
    errors: report.sections.filter((s) => s.error).map((s) => `${s.id}: ${s.error}`),
    failures,
    degraded: failures.length > 0,
    notes: report.notes || [],
    text, html, report, delivered: false, durationMs: Date.now() - started,
  };

  if (dryRun) return result;

  const to = (def.recipients || []).filter(Boolean);
  // A definition armed to send, with nobody to send to, is broken — not idle.
  // It used to fall through to the bookkeeping below, stamp the day as run and
  // clear lastError, so every status surface reported success while no mail
  // existed. Throwing hands it to the runtime's catch, which records the error
  // and deliberately does NOT claim the day, so a fixed recipient list is
  // picked up on the next poll.
  if (def.sendEmail && !to.length) {
    throw new Error(`definition "${def.name}" is scheduled to send but has no recipients`);
  }
  if (def.sendEmail && typeof sendMail !== "function") {
    throw new Error(`definition "${def.name}" is scheduled to send but no mailer was provided`);
  }

  if (def.sendEmail) {
    // CLAIM THE DAY BEFORE SENDING, not after. isDue gates only on lastRunKey,
    // and the gap between "mail accepted" and "day stamped" was wide enough to
    // matter: a restart, an OOM or a failed save inside it re-sent the whole
    // board on the next poll, and start() polls immediately. Same ruling as
    // the night board's claimBoardEmail (since deleted) — a missed email is
    // recoverable, a duplicate one is not.
    const key = pacificKey(now);
    const prior = def.lastRunKey;
    const claimed = await ReportDefinition.findOneAndUpdate(
      { _id: def._id, lastRunKey: { $ne: key } },
      { $set: { lastRunKey: key } },
      { new: true },
    );
    if (!claimed && !force) return { ...result, delivered: false, skipped: "already claimed today" };

    // SAVE THE DAY, THEN SEND IT.
    //
    // The report exists, the day is claimed, the mail has not gone yet. This is
    // the only moment where a record can be written from the SAME gather the
    // email will use — which is the whole point: one ask of Logics, CallRail
    // and RingCentral, two consumers.
    //
    // It runs before the send rather than after because the record is the day's
    // record, not a receipt for an email. A night where the mail bounced still
    // happened and its numbers are still worth keeping.
    //
    // NOTHING HERE MAY STOP THE MAIL. The 2026-08-04 split existed to keep
    // persistence off the sending path, and reordering must not quietly undo
    // that: a save that throws is recorded on the result and the send proceeds.
    // A missing fact document is a repairable inconvenience; a nightly board
    // that stopped going out because a Mongo write failed is not.
    if (typeof onComposed === "function") {
      try {
        result.onComposed = await onComposed({ def, range, report });
      } catch (error) {
        result.onComposedError = String(error.message || error).slice(0, 200);
        logger?.info?.(`daily record save failed, sending anyway: ${result.onComposedError}`);
      }
    }

    // `attachCsv` was stored on every definition and printed as "+csv" on the
    // schedule listing, while nothing anywhere honoured it — the string appears
    // nowhere else in this file. A setting that shows as on and does nothing is
    // worse than no setting. One file per section; the mailer passes
    // inline-buffer attachments straight through.
    const attachments = def.attachCsv
      ? renderCsvs(report).map((c) => ({
        filename: c.filename,
        content: Buffer.from(c.content, "utf8"),
        contentType: "text/csv",
      }))
      : [];

    try {
      // sendMail(domain, options) — the DOMAIN is the first positional argument,
      // not a field on the options object. Passing options first silently sends
      // from the wrong transport at best and throws at worst.
      await sendMail(def.domain || null, {
        to, from: fromEmail || undefined,
        attachments,
        // A degraded board must announce itself in the SUBJECT. The red banner
        // inside only helps someone who opened it; the point of a nightly is
        // that most nights you glance at the subject and move on.
        subject: `${failures.length ? "[DEGRADED] " : ""}${def.name} · ${range.from}`
          + `${range.to !== range.from ? ` → ${range.to}` : ""}`,
        // Branded HBS template so report mail reads as part of the same
        // family as every other email the app sends. `text` is the plain-text
        // alternative; renderHtml stays for the standalone --html file path.
        template: "reports/report",
        data: templateData,
        text,
      });
      result.delivered = true;
      // The email and the daily fact must describe the SAME gather. Persist
      // only after the mail provider accepts the canonical one-day rollup, and
      // pass the already-computed report rather than re-reading any source.
      // A fact-write failure must not throw from this send block: the email is
      // already accepted, and throwing would give the daily claim back and
      // resend it on the next scheduler poll.
      // THE SNAPSHOT MOVED OUT — 2026-08-04. Sending is sending; persistence is
      // its own job, in dailySnapshotService, run after this returns.
      //
      // The try/catch that used to be here is still load-bearing as a PATTERN
      // and must not come back without it: this block sits inside the outer
      // catch that hands the day back on failure, so anything that throws AFTER
      // sendMail resolves would release the claim and re-send four emails on the
      // next five-minute poll. That is why the capture was wrapped, and it is
      // why the replacement lives outside this block entirely rather than being
      // moved a few lines down.
      //
      // `result.dailyFactCapture` is intentionally still populated by the
      // caller, because reportScheduleRuntime alerts on that exact field name.
    } catch (error) {
      // Give the day back so the next poll retries. Without this a transient
      // SMTP failure at 20:30 silently costs the whole night.
      await ReportDefinition.updateOne({ _id: def._id }, { $set: { lastRunKey: prior ?? null } })
        .catch(() => { /* the throw below is the real signal */ });
      throw error;
    }
  }

  if (typeof def.save === "function") {
    def.lastRunKey = pacificKey(now);
    def.lastRunAt = new Date();
    def.lastDurationMs = result.durationMs;
    // lastError from errors UNION failures — see above. A degraded run that
    // still delivered is worth recording; it is the second and third night in
    // a row that turn it into something to chase.
    const problems = [...result.errors, ...failures];
    if (result.dailyFactCapture?.status === "failed") {
      problems.push(`daily fact capture failed: ${result.dailyFactCapture.reason}`);
    }
    def.lastError = problems.length ? problems.join(" | ").slice(0, 400) : null;
    def.runCount = (def.runCount || 0) + 1;
    // A run that got here delivered (or was not meant to send), so the failure
    // counter resets. See isDue's attempt cap.
    def.attemptsToday = 0;
    await def.save();
  }
  return result;
}

/** Every definition due right now, oldest-scheduled first. */
async function dueDefinitions(now = new Date()) {
  const defs = await ReportDefinition.find({ "schedule.enabled": true, archivedAt: null });
  return defs.filter((d) => isDue(d, now).due);
}

module.exports = {
  ReportDefinition, captureDeliveredDailyFact, dueDefinitions, isDue,
  pacificKey, pacificParts, resolveRange, runDefinition,
};
