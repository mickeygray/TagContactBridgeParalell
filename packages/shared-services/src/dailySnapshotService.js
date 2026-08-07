"use strict";

// THE DAILY SNAPSHOT WRITER — one cheap automated write, with one explicit
// standalone repair escape hatch.
//
// The scheduled nightly path MUST supply the report it already gathered for the
// email. That path builds the fact in memory and performs one upsert; it must not
// compose again, start another scan, or arm a retry scheduler.
//
// An explicit missed-day/backfill caller may omit the report and pay for one
// independent compose. That delayed repair is knowingly heavier and is the
// accepted "risk it for the biscuit" path; it is not automatic nightly work.
//
// THE ONE THING THAT MUST NOT DRIFT: the day. The email's fact is keyed on the
// definition's resolved range.from, so this must resolve the SAME range from the
// SAME definition rather than computing a day of its own. A previous attempt
// used a local "completed day" helper, which produced TODAY while the email
// produced YESTERDAY — two documents, the later one silently overwriting the
// earlier via a unique-key $set.

const { composeReport } = require("./reportComposerService");
const {
  buildDailyReportFact,
  isDailyFactCaptureCandidate,
  persistBuiltDailyReportFact,
  CANONICAL_DEFINITION_NAME,
  REQUIRED_SECTIONS,
} = require("./dailyReportFactService");

/**
 * Write one day's snapshot from a freshly composed report.
 *
 * @param {Object}   def              the ReportDefinition (canonical rollup)
 * @param {Object}   range            {from, to} — the SAME range the email used
 * @param {Date}     [emailAcceptedAt] when the mail provider accepted, if it did
 * @param {Function} [compose]        injectable for tests
 * @param {Function} [writer]         injectable persistence
 * @param {Object}   [Model]          injectable model, threaded to the DEFAULT
 *                                    writer. Without this the default path is
 *                                    untestable without touching live Mongo —
 *                                    which is exactly how its rebuild bug
 *                                    survived: every caller that could reach it
 *                                    in a test injected `writer` and skipped it.
 * @returns {{status:string, reason?:string, dateKey?:string, revision?:number}}
 */
async function writeDailySnapshot({
  def,
  range,
  report: suppliedReport = null,
  emailAcceptedAt = new Date(),
  compose = composeReport,
  // persistBUILT, not persistDailyReportFact: this function already built the
  // fact above and the rebuild throws. See the note on persistBuiltDailyReportFact.
  writer = persistBuiltDailyReportFact,
  Model = null,
  logger = null,
} = {}) {
  if (!def || !range?.from) return { status: "skipped", reason: "no-definition-or-range" };

  // ONE PIPE. The scheduler hands over the report the email was built from, so
  // the snapshot and the email describe the same gather and Logics/CallRail/
  // RingCentral are asked once for the night instead of twice.
  let report = suppliedReport;

  if (!report) {
    // NO REPORT SUPPLIED — compose one for an EXPLICIT standalone missed-day or
    // backfill request. Scheduled automation supplies the report and never
    // reaches this heavier branch.
    //
    // Cheap gate FIRST here, because a gather is about to be paid for. Every
    // check in the candidate gate except the section check reads only `def` and
    // `range`, so a stub selection lets the definition-level reasons
    // (email-disabled, not-canonical, not-one-day, tenant-scoped, filtered) bite
    // before the cost is incurred.
    const preVerdict = isDailyFactCaptureCandidate(def, { selection: [...REQUIRED_SECTIONS] }, range);
    if (!preVerdict.capture) return { status: "skipped", reason: preVerdict.reason };

    try {
      // MIRRORS runDefinition EXACTLY. A definition stores its blocks on
      // `def.blocks` and defaults to ["daily"] — it has no `selection` and no
      // `preset`, and the live canonical row has neither field set at all. An
      // earlier version of this passed def.selection/def.preset, so compose fell
      // back to a default that produced two of the five required sections and
      // the writer skipped with "missing-rollup-sections". It failed politely
      // and stored nothing, which is exactly the shape of bug that survives
      // review.
      //
      // composeReport also destructures `where`, not `filters`; passing the
      // wrong key silently applies no filter at all.
      report = await compose({
        from: range.from,
        to: range.to,
        selection: def.blocks && def.blocks.length ? def.blocks : ["daily"],
        domain: def.domain || null,
        where: def.filters || [],
        live: true,
      });
    } catch (error) {
      logger?.error?.("daily_snapshot.compose_failed", {
        definition: def.name, dateKey: range.from, error: String(error.message).slice(0, 200),
      });
      return { status: "failed", reason: `compose: ${String(error.message).slice(0, 160)}` };
    }
  }

  // The real gate, against the report's ACTUAL selection — a preset can expand
  // to something different from def.selection, and the pre-gate above
  // deliberately said nothing about that. Runs on both paths: a supplied report
  // has skipped the pre-gate entirely, so this is its only check.
  const verdict = isDailyFactCaptureCandidate(def, report, range);
  if (!verdict.capture) return { status: "skipped", reason: verdict.reason };

  try {
    const fact = buildDailyReportFact({
      dateKey: range.from,
      definitionName: def.name,
      report,
      emailAcceptedAt,
    });
    const saved = await writer(fact, Model ? { Model } : undefined);
    logger?.info?.("daily_snapshot.written", {
      dateKey: range.from, revision: saved?.revision ?? null, complete: fact.coverage?.complete,
    });
    return {
      status: "written",
      dateKey: range.from,
      revision: saved?.revision ?? null,
      complete: fact.coverage?.complete === true,
    };
  } catch (error) {
    logger?.error?.("daily_snapshot.write_failed", {
      definition: def.name, dateKey: range.from, error: String(error.message).slice(0, 200),
    });
    return { status: "failed", reason: String(error.message).slice(0, 160) };
  }
}

/**
 * Record WHEN the mail was accepted, on a day already written.
 *
 * The record is now saved before the send, so at write time nothing has been
 * accepted and emailAcceptedAt is null. This stamps it afterwards, and only when
 * a provider actually took the message — leaving it null is the honest state for
 * a night whose mail bounced: the day still happened, the email did not.
 *
 * Deliberately its own tiny write rather than a re-save. Rebuilding the fact to
 * set one timestamp would re-derive every section against a day that has since
 * moved on, and a stored day must not drift because an email was delivered.
 */
async function stampEmailAccepted(dateKey, acceptedAt = new Date(), { Model = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    throw new Error("stampEmailAccepted needs a YYYY-MM-DD dateKey");
  }
  const M = Model || require("../../shared-models/src/DailyReportFact");
  const res = await M.updateOne({ dateKey }, { $set: { emailAcceptedAt: acceptedAt } });
  const matched = res?.matchedCount ?? res?.n;
  return { dateKey, stamped: matched == null ? true : Number(matched) === 1 };
}

module.exports = {
  writeDailySnapshot,
  stampEmailAccepted,
  CANONICAL_DEFINITION_NAME,
};
