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
const {
  buildDailyEntry,
  gatherersFromReport,
} = require("./dailyEntryService");
const {
  DAILY_REPAIR_REASONS,
  HISTORICAL_REPAIR_MAX_AGE_DAYS,
  isValidDateKey,
} = require("./dailyReportContract");
const REPAIR_REASON = DAILY_REPAIR_REASONS;

function shiftDateKey(dateKey, deltaDays) {
  if (!isValidDateKey(dateKey)) return null;
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Number(deltaDays || 0));
  return date.toISOString().slice(0, 10);
}

function isWeekdayDateKey(dateKey) {
  if (!isValidDateKey(dateKey)) return false;
  const day = new Date(`${dateKey}T12:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

const positive = (...values) => values.some((value) => Number(value) > 0);
const unresolvedOfficer = (value) => /^\((?:unassigned|no snapshot)\)$/i.test(String(value || "").trim());
const unresolvedSource = (value) => {
  const text = String(value || "").trim();
  return !text
    || /^\((?:unsourced|unattributed|no snapshot)\)$/i.test(text)
    || /catch-all/i.test(text)
    || /^unattributed\b/i.test(text);
};

/**
 * Identify ONLY the holes visible in a stored day. No external services are
 * touched here; this is the cheap gate that keeps the historical repair from
 * rebuilding seven complete reports every night.
 */
function dailyFactRepairReasons(fact) {
  const reasons = new Set((fact?.coverage?.repairHints || []).filter((reason) => (
    Object.values(REPAIR_REASON).includes(reason)
  )));
  const byAgent = fact?.facts?.byAgent || {};
  const agentRows = Array.isArray(byAgent.agents)
    ? byAgent.agents
    : (Array.isArray(byAgent.rows) ? byAgent.rows : []);
  if (agentRows.some((row) => (
    unresolvedOfficer(row?.agent || row?.officer)
    && positive(row?.deals, row?.cash, row?.newCash, row?.totalCash)
  ))) reasons.add(REPAIR_REASON.OFFICER);

  const sourceRows = Array.isArray(fact?.facts?.bySource)
    ? fact.facts.bySource
    : (Array.isArray(fact?.facts?.bySource?.rows) ? fact.facts.bySource.rows : []);
  if (sourceRows.some((row) => (
    unresolvedSource(row?.source)
    && positive(row?.deals, row?.newCash, row?.recurringCash, row?.totalCash, row?.cash)
  ))) reasons.add(REPAIR_REASON.MARKETING_SOURCE);

  // A paid-channel row doing measurable work with no denominator is exactly
  // an uncosted marketing statistic. Aged and catch-all rows are intentionally
  // excluded: they carry no current-campaign ratio by design.
  const { AGED_LABEL, isActiveSource, isLdSource, sourceChannel } = require(
    "../../shared-config/src/activeSources"
  );
  const uncostedRow = sourceRows.some((row) => {
    const source = String(row?.source || "").trim();
    if (!source || source === AGED_LABEL || unresolvedSource(source)) return false;
    const channel = sourceChannel(source);
    const paidChannel = isLdSource(source) || channel === "bcd" || channel === "mail" || isActiveSource(source);
    if (!paidChannel) return false;
    const hasMarketingActivity = positive(
      row?.deals, row?.newCash, row?.responses, row?.calls, row?.leads,
    );
    return hasMarketingActivity && !(Number(row?.spend) > 0);
  });

  const spend = fact?.facts?.spend;
  const financial = fact?.facts?.financial || {};
  // Legacy facts written before repairHints existed still need to catch the
  // August 10 shape: the report was degraded, TAG mail applied, and both mail
  // dollars and pieces were absent on a business day.
  const legacyMissingMail = isWeekdayDateKey(fact?.dateKey)
    && fact?.coverage?.reportDegraded === true
    && financial.mailApplies !== false
    && spend != null
    && !(Number(spend.mail) > 0)
    && !(Number(spend.mailPieces) > 0);
  if (uncostedRow || legacyMissingMail) reasons.add(REPAIR_REASON.MARKETING_COST);

  return [...reasons];
}

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
  overwriteFrozen = [],
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
    // ONE IN-MEMORY DAY. Every report-owned section is sliced from the exact
    // report that is about to become the email. This creates both views at the
    // same time: sanitized additive facts and complete one-day detail. No
    // service writes while the object is being assembled.
    const dailyEntry = await buildDailyEntry({
      dateKey: range.from,
      gatherers: gatherersFromReport(report),
      apply: false,
    });
    const fact = buildDailyReportFact({
      dateKey: range.from,
      definitionName: def.name,
      report,
      emailAcceptedAt,
      dailyEntry,
    });
    const writerOptions = {
      ...(Model ? { Model } : {}),
      ...(overwriteFrozen?.length ? { overwriteFrozen } : {}),
    };
    const saved = await writer(
      fact,
      Object.keys(writerOptions).length ? writerOptions : undefined,
    );
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
 * Rebuild only the historical days named by a newly derived late document.
 *
 * This is deliberately event-driven rather than "rebuild the last three days
 * every night". Most nights pay zero extra gathers. A late invoice pays one
 * explicit compose for the day it actually changes, preserves that day's
 * original email-acceptance stamp, and deliberately reopens the frozen spend
 * section while refreshing the other report facts from the same compose.
 */
async function repairDailySnapshots({
  dateKeys = [],
  def: suppliedDefinition = null,
  compose = composeReport,
  Model = null,
  DefinitionModel = null,
  // Late invoice callers deliberately reopen spend. The nightly anomaly
  // repair supplies a per-day override so an officer-only repair cannot
  // restate a closed day's cost.
  overwriteFrozen = ["spend"],
  overwriteFrozenByDate = null,
  logger = null,
} = {}) {
  const wanted = [...new Set((dateKeys || []).map((key) => String(key || "").trim()))]
    .filter(isValidDateKey);
  if (!wanted.length) return { status: "skipped", repaired: 0, failed: 0, dates: [] };

  const FactModel = Model || require("../../shared-models/src/DailyReportFact");
  const DefModel = DefinitionModel || require("../../shared-models/src/ReportDefinition");
  const def = suppliedDefinition || await DefModel.findOne({
    name: { $regex: new RegExp(`^${CANONICAL_DEFINITION_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
  }).lean();
  if (!def) {
    return {
      status: "failed", repaired: 0, failed: wanted.length,
      dates: wanted.map((dateKey) => ({ dateKey, status: "failed", reason: "canonical-definition-missing" })),
    };
  }

  const dates = [];
  for (const dateKey of wanted) {
    try {
      const existing = await FactModel.findOne({ dateKey }).select("emailAcceptedAt").lean();
      const result = await writeDailySnapshot({
        def,
        range: { from: dateKey, to: dateKey },
        emailAcceptedAt: existing?.emailAcceptedAt ?? null,
        compose,
        Model: FactModel,
        overwriteFrozen: Array.isArray(overwriteFrozenByDate?.[dateKey])
          ? overwriteFrozenByDate[dateKey]
          : overwriteFrozen,
        logger,
      });
      dates.push({ dateKey, status: result.status, reason: result.reason || null });
    } catch (error) {
      logger?.error?.("daily_snapshot.late_repair_failed", {
        dateKey, error: String(error.message || error).slice(0, 160),
      });
      dates.push({ dateKey, status: "failed", reason: String(error.message || error).slice(0, 160) });
    }
  }
  const repaired = dates.filter((row) => row.status === "written").length;
  const failed = dates.filter((row) => row.status === "failed").length;
  return { status: failed ? "partial" : "completed", repaired, failed, dates };
}

/**
 * Return historical service days whose derived invoice is newer than the
 * spend section captured in DailyReportFact.
 *
 * updatedAt cannot answer this: call/activity writers legitimately update the
 * same document while leaving frozen spend untouched. The spend-specific
 * marker makes a failed late repair durable and retryable without adding a
 * polling loop or rebuilding every day in the lookback window.
 */
async function findSpendRepairDateKeys({
  from,
  to,
  currentDateKey = null,
  InvoiceModel = null,
  FactModel = null,
} = {}) {
  if (!isValidDateKey(from) || !isValidDateKey(to)) return [];
  const Invoice = InvoiceModel || require("../../shared-models/src/MailInvoice");
  const Fact = FactModel || require("../../shared-models/src/DailyReportFact");
  const invoices = await Invoice.find({
    serviceDate: { $gte: from, $lte: to },
    state: { $ne: "superseded" },
    spendDerivedAt: { $ne: null },
  }).select("serviceDate spendDerivedAt").lean();

  const latestByDate = new Map();
  for (const invoice of invoices || []) {
    const dateKey = String(invoice?.serviceDate || "");
    if (!isValidDateKey(dateKey) || dateKey === currentDateKey) continue;
    const stamp = new Date(invoice?.spendDerivedAt || 0);
    if (Number.isNaN(stamp.getTime())) continue;
    const previous = latestByDate.get(dateKey);
    if (!previous || stamp > previous) latestByDate.set(dateKey, stamp);
  }
  const dateKeys = [...latestByDate.keys()].sort();
  if (!dateKeys.length) return [];

  const facts = await Fact.find({ dateKey: { $in: dateKeys } })
    .select("dateKey spendCapturedAt")
    .lean();
  const capturedByDate = new Map((facts || []).map((fact) => [
    String(fact?.dateKey || ""),
    fact?.spendCapturedAt ? new Date(fact.spendCapturedAt) : null,
  ]));
  return dateKeys.filter((dateKey) => {
    const captured = capturedByDate.get(dateKey);
    return !captured || Number.isNaN(captured.getTime()) || captured < latestByDate.get(dateKey);
  });
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Compare the current mail sheet with the spend already frozen into prior
 * daily facts. The vendor can update several service days in one edit, so the
 * comparison is grouped by the date carried by EACH row rather than by the day
 * on which the CSV happened to be fetched.
 *
 * Invoice-backed dates are excluded because the invoice deliberately outranks
 * the hand-kept sheet. A disagreement on such a date is diagnostic, not a
 * reason to replace the invoice with sheet money.
 */
async function findMailSheetRepairDateKeys({
  from,
  to,
  currentDateKey = null,
  facts: suppliedFacts = null,
  sheetReader = null,
  FactModel = null,
  MailSpendModel = null,
} = {}) {
  if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) {
    return { dateKeys: [], daysSeen: 0, invoiceDaysExcluded: 0, unavailable: "invalid-range" };
  }
  const readSheet = sheetReader || require("./mailSheetCsvService").readMailSheetCsv;
  const sheet = await readSheet({ from, to });
  if (sheet?.unavailable) {
    return {
      dateKeys: [], daysSeen: 0, invoiceDaysExcluded: 0,
      unavailable: String(sheet.unavailable).slice(0, 160),
    };
  }

  const sheetByDate = new Map();
  for (const row of sheet?.rows || []) {
    const dateKey = String(row?.date || "").slice(0, 10);
    if (!isValidDateKey(dateKey) || dateKey < from || dateKey > to) continue;
    const total = sheetByDate.get(dateKey) || { mail: 0, mailPieces: 0 };
    total.mail = round2(total.mail + (Number(row?.spend) || 0));
    total.mailPieces += Number(row?.pieces) || 0;
    sheetByDate.set(dateKey, total);
  }
  const sheetDateKeys = [...sheetByDate.keys()].sort();
  if (!sheetDateKeys.length) {
    return { dateKeys: [], daysSeen: 0, invoiceDaysExcluded: 0, unavailable: null };
  }

  const SpendDay = MailSpendModel || require("../../shared-models/src/MailSpendDay");
  const invoiceRows = await SpendDay.find({
    domain: "TAG", serviceDate: { $in: sheetDateKeys }, active: true,
  }).select("serviceDate").lean();
  const invoiceDays = new Set((invoiceRows || []).map((row) => (
    String(row?.serviceDate || "").slice(0, 10)
  )).filter(isValidDateKey));

  let facts = suppliedFacts;
  if (!Array.isArray(facts)) {
    const Fact = FactModel || require("../../shared-models/src/DailyReportFact");
    facts = await Fact.find({ dateKey: { $in: sheetDateKeys } })
      .select("dateKey facts.spend")
      .lean();
  }
  const factByDate = new Map((facts || []).map((fact) => [String(fact?.dateKey || ""), fact]));

  const dateKeys = sheetDateKeys.filter((dateKey) => {
    if (dateKey === currentDateKey || invoiceDays.has(dateKey)) return false;
    const sheetSpend = sheetByDate.get(dateKey);
    const stored = factByDate.get(dateKey)?.facts?.spend;
    if (!stored) return true;
    return Math.abs(round2(stored.mail) - sheetSpend.mail) >= 0.01
      || Number(stored.mailPieces || 0) !== Number(sheetSpend.mailPieces || 0);
  });
  return {
    dateKeys,
    daysSeen: sheetDateKeys.length,
    invoiceDaysExcluded: sheetDateKeys.filter((key) => invoiceDays.has(key)).length,
    unavailable: null,
  };
}

/**
 * Read the previous seven daily facts through their indexed dateKey and keep
 * only dates that still show a repairable hole. The current day is excluded:
 * it was just composed by the nightly report and must never pay for a second
 * gather in the same close.
 */
async function findHistoricalDailyFactRepairs({
  currentDateKey,
  maxAgeDays = HISTORICAL_REPAIR_MAX_AGE_DAYS,
  FactModel = null,
  includeMailSheet = false,
  sheetReader = null,
  MailSpendModel = null,
  logger = null,
} = {}) {
  if (!isValidDateKey(currentDateKey)) return [];
  const age = Math.max(1, Math.min(
    HISTORICAL_REPAIR_MAX_AGE_DAYS,
    Number(maxAgeDays) || HISTORICAL_REPAIR_MAX_AGE_DAYS,
  ));
  const from = shiftDateKey(currentDateKey, -age);
  const to = shiftDateKey(currentDateKey, -1);
  const Fact = FactModel || require("../../shared-models/src/DailyReportFact");
  const facts = await Fact.find({ dateKey: { $gte: from, $lte: to } })
    .select("dateKey facts.byAgent facts.bySource facts.spend facts.financial coverage.reportDegraded coverage.repairHints")
    .sort({ dateKey: 1 })
    .lean();
  const candidates = (facts || []).map((fact) => ({
    dateKey: String(fact.dateKey || ""),
    reasons: dailyFactRepairReasons(fact),
  })).filter((row) => row.reasons.length > 0);

  if (includeMailSheet) {
    const sheetRepair = await findMailSheetRepairDateKeys({
      from, to, currentDateKey, facts, sheetReader, FactModel, MailSpendModel,
    });
    if (sheetRepair.unavailable) {
      logger?.warn?.("daily_snapshot.mail_sheet_repair_unavailable", {
        reason: sheetRepair.unavailable,
      });
    }
    const byDate = new Map(candidates.map((candidate) => [candidate.dateKey, candidate]));
    for (const dateKey of sheetRepair.dateKeys) {
      const candidate = byDate.get(dateKey) || { dateKey, reasons: [] };
      if (!candidate.reasons.includes(REPAIR_REASON.MARKETING_COST)) {
        candidate.reasons.push(REPAIR_REASON.MARKETING_COST);
      }
      byDate.set(dateKey, candidate);
    }
    return [...byDate.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }

  return candidates;
}

/**
 * Bounded post-close repair. One cheap indexed scan every business night;
 * external gathers happen only for the anomalous dates it found. An unresolved
 * date naturally falls out after seven days, leaving future manual correction
 * to the reporting UI rather than becoming a permanent retry loop.
 */
async function repairHistoricalDailyFacts({
  currentDateKey,
  maxAgeDays = HISTORICAL_REPAIR_MAX_AGE_DAYS,
  candidates: suppliedCandidates = null,
  finder = findHistoricalDailyFactRepairs,
  repair = repairDailySnapshots,
  FactModel = null,
  logger = null,
} = {}) {
  const age = Math.max(1, Math.min(
    HISTORICAL_REPAIR_MAX_AGE_DAYS,
    Number(maxAgeDays) || HISTORICAL_REPAIR_MAX_AGE_DAYS,
  ));
  if (!isValidDateKey(currentDateKey)) {
    return {
      status: "skipped", reason: "invalid-current-date", scannedDays: age,
      candidates: 0, repaired: 0, failed: 0,
    };
  }
  const from = shiftDateKey(currentDateKey, -age);
  const to = shiftDateKey(currentDateKey, -1);
  const candidates = Array.isArray(suppliedCandidates)
    ? suppliedCandidates
      .map((candidate) => ({
        dateKey: String(candidate?.dateKey || ""),
        reasons: [...new Set((candidate?.reasons || []).filter((reason) => (
          Object.values(REPAIR_REASON).includes(reason)
        )))],
      }))
      // A durable plan is still untrusted input when a process resumes. Never
      // let a stale or malformed checkpoint expand this bounded repair beyond
      // the same prior-day window the indexed finder enforces.
      .filter((candidate) => (
        isValidDateKey(candidate.dateKey)
        && candidate.dateKey >= from
        && candidate.dateKey <= to
        && candidate.reasons.length > 0
      ))
    : await finder({ currentDateKey, maxAgeDays, FactModel });
  if (!candidates.length) {
    return { status: "skipped", scannedDays: age, candidates: 0, repaired: 0, failed: 0 };
  }
  const overwriteFrozenByDate = Object.fromEntries(candidates.map((candidate) => [
    candidate.dateKey,
    candidate.reasons.includes(REPAIR_REASON.MARKETING_COST) ? ["spend"] : [],
  ]));
  const result = await repair({
    dateKeys: candidates.map((candidate) => candidate.dateKey),
    overwriteFrozen: [],
    overwriteFrozenByDate,
    logger,
  });
  const countsByReason = {};
  for (const candidate of candidates) {
    for (const reason of candidate.reasons) {
      countsByReason[reason] = (countsByReason[reason] || 0) + 1;
    }
  }
  const summary = {
    status: result.status,
    scannedDays: age,
    candidates: candidates.length,
    repaired: Number(result.repaired || 0),
    failed: Number(result.failed || 0),
    countsByReason,
  };
  logger?.info?.("daily_snapshot.historical_repair_completed", summary);
  return summary;
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
  if (!isValidDateKey(dateKey)) {
    throw new Error("stampEmailAccepted needs a YYYY-MM-DD dateKey");
  }
  const M = Model || require("../../shared-models/src/DailyReportFact");
  const res = await M.updateOne({ dateKey }, { $set: { emailAcceptedAt: acceptedAt } });
  const matched = res?.matchedCount ?? res?.n;
  return { dateKey, stamped: matched == null ? true : Number(matched) === 1 };
}

module.exports = {
  HISTORICAL_REPAIR_MAX_AGE_DAYS,
  REPAIR_REASON,
  dailyFactRepairReasons,
  findHistoricalDailyFactRepairs,
  findMailSheetRepairDateKeys,
  findSpendRepairDateKeys,
  repairHistoricalDailyFacts,
  repairDailySnapshots,
  writeDailySnapshot,
  stampEmailAccepted,
  CANONICAL_DEFINITION_NAME,
};
