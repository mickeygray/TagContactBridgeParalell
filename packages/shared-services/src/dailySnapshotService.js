"use strict";

// THE DAILY SNAPSHOT WRITER — end to end, and deliberately on its own.
//
// Mickey 2026-08-04: "keep exactly what's there without changing it and move the
// snapshot out of it and make an end-to-end snapshot writer that combines and
// simplifies to run after the email. then make it one pipe on the next patch."
// And, on the cost of doing so: "to be careful let's just run it twice for now."
//
// So this composes its OWN report rather than borrowing the email's. That is a
// second gather, accepted knowingly for one patch, and it buys two things:
//
//   1. The email path stops carrying a persistence concern. Sending is sending.
//   2. The snapshot becomes runnable on its own — for a missed night, or a
//      backfill — instead of only ever existing as a side effect of a send.
//
// Next patch merges them back into one gather. When that happens, DELETE the
// compose here and take the report as an argument; everything else stays.
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
  persistDailyReportFact,
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
 * @returns {{status:string, reason?:string, dateKey?:string, revision?:number}}
 */
async function writeDailySnapshot({
  def,
  range,
  report: suppliedReport = null,
  emailAcceptedAt = new Date(),
  compose = composeReport,
  writer = persistDailyReportFact,
  logger = null,
} = {}) {
  if (!def || !range?.from) return { status: "skipped", reason: "no-definition-or-range" };

  // ONE PIPE. The scheduler hands over the report the email was built from, so
  // the snapshot and the email describe the same gather and Logics/CallRail/
  // RingCentral are asked once for the night instead of twice.
  let report = suppliedReport;

  if (!report) {
    // NO REPORT SUPPLIED — compose one. This path is NOT dead weight: it is what
    // makes a missed night or a backfill runnable on its own, without sending an
    // email to produce a fact. Removing it turns the snapshot back into a side
    // effect of a send, which is what it was extracted from.
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
    const saved = await writer(fact);
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

module.exports = {
  writeDailySnapshot,
  CANONICAL_DEFINITION_NAME,
};
