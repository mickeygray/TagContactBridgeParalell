"use strict";

const {
  CallLedger,
  CallLog,
  CaseProfile,
  SourceCanonical,
} = require("../../shared-models/src");
const {
  caseProfileRepository,
  leadCadenceRepository,
  paymentLedgerRepository,
} = require("../../shared-repositories/src");
const { getCompanyConfig } = require("../../shared-config/src/companyConfig");
const {
  runHourlyCallLogHygieneForDomain,
} = require("./hourlyCallLogHygieneService");
const {
  reconcilePaymentsForDomain,
} = require("./paymentReconcileService");
const { listRoiEligiblePayments } = require("./paymentRoiService");
const { sendPlainEmail } = require("./sendgridMailService");
const {
  buildVendorDailySummary,
  classifyVendorFamily,
} = require("./vendorDailySummaryService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");
const {
  backfillCallLogSourceFromLeadCadence,
} = require("./callLogSourceBackfillService");
const { getInternalFromEmail } = require("../../shared-config/src");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_MAX_CALL_ROWS = 10000;
const DEFAULT_MAX_LEAD_ROWS = 20000;
const DEFAULT_MAX_PAYMENT_ROWS = 20000;
const LD_VENDOR_FAMILY_KEYS = new Set(["ld-custom", "ld-general"]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function vendorFamilyKey(row = {}) {
  return String(row.family || row.familyKey || row.sourceFamilyKey || "")
    .trim()
    .toLowerCase();
}

function isLdVendorFamily(row = {}) {
  return LD_VENDOR_FAMILY_KEYS.has(vendorFamilyKey(row));
}

function ldFamilyEstimatedCost(row = {}) {
  const leads = toNumber(row.leads);
  const key = vendorFamilyKey(row);
  if (key === "ld-custom") return leads * 3;
  if (key === "ld-general") return leads * 2;
  return 0;
}

function decorateLdVendorFamily(row = {}) {
  return {
    ...row,
    estimatedCost: ldFamilyEstimatedCost(row),
  };
}

function sumVendorRows(rows = [], field) {
  return rows.reduce((sum, row) => sum + toNumber(row?.[field]), 0);
}

function buildLdCostSummary(rows = []) {
  const custom = rows.find((row) => vendorFamilyKey(row) === "ld-custom") || {};
  const general = rows.find((row) => vendorFamilyKey(row) === "ld-general") || {};
  const customCount = toNumber(custom.leads);
  const generalCount = toNumber(general.leads);
  const customRate = 3;
  const generalRate = 2;
  const customCost = customCount * customRate;
  const generalCost = generalCount * generalRate;
  return {
    customCount,
    generalCount,
    customRate,
    generalRate,
    customCost,
    generalCost,
    total: customCost + generalCost,
  };
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDateKey(date = new Date(), timeZone = DEFAULT_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : "";
}

function formatCurrency(value) {
  return toNumber(value).toFixed(2);
}

function escapeCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function buildCsv(rows, columns) {
  const header = columns.map((column) => escapeCsvCell(column.header)).join(",");
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const rawValue = typeof column.value === "function"
          ? column.value(row)
          : row?.[column.key];
        return escapeCsvCell(rawValue);
      })
      .join(","),
  );
  return [header, ...body].join("\n");
}

function createAccumulator(seed = {}) {
  return {
    source: seed.source || "Unknown",
    channel: seed.channel || null,
    family: seed.family || "other",
    familyLabel: seed.familyLabel || "Other",
    tracked: seed.tracked !== false,
    spend: toNumber(seed.spend),
    pieces: toNumber(seed.pieces),
    impressions: toNumber(seed.impressions),
    clicks: toNumber(seed.clicks),
    leads: toNumber(seed.leads),
    reportedLeads: toNumber(seed.reportedLeads),
    calls: toNumber(seed.calls),
    callsOver5: toNumber(seed.callsOver5),
    callsOver2: toNumber(seed.callsOver2),
    uniqueCallers: toNumber(seed.uniqueCallers),
    scoredCalls: toNumber(seed.scoredCalls),
    hot: toNumber(seed.hot),
    warm: toNumber(seed.warm),
    cold: toNumber(seed.cold),
    dead: toNumber(seed.dead),
    fake: toNumber(seed.fake),
    dncToday: toNumber(seed.dncToday),
    postdateToday: toNumber(seed.postdateToday),
    initialPayments: toNumber(seed.initialPayments),
    initialPaymentCount: toNumber(seed.initialPaymentCount),
    totalCollected: toNumber(seed.totalCollected),
    dealsToday: toNumber(seed.dealsToday),
    scoreSum: 0,
    uniqueCallerSet: new Set(),
  };
}

function addScore(accumulator, score) {
  if (score === "" || score == null) return;
  const numeric = Number(score);
  if (Number.isFinite(numeric)) {
    accumulator.scoredCalls += 1;
    accumulator.scoreSum += numeric;
  }
}

function addUniqueCaller(accumulator, phone) {
  const normalized = String(phone || "").trim();
  if (!normalized) return;
  accumulator.uniqueCallerSet.add(normalized);
  accumulator.uniqueCallers = accumulator.uniqueCallerSet.size;
}

function finalizeAccumulator(accumulator) {
  return {
    source: accumulator.source,
    channel: accumulator.channel,
    family: accumulator.family,
    familyLabel: accumulator.familyLabel,
    tracked: accumulator.tracked,
    spend: accumulator.spend,
    pieces: accumulator.pieces,
    impressions: accumulator.impressions,
    clicks: accumulator.clicks,
    leads: accumulator.leads,
    reportedLeads: accumulator.reportedLeads,
    calls: accumulator.calls,
    callsOver5: accumulator.callsOver5,
    callsOver2: accumulator.callsOver2,
    uniqueCallers: accumulator.uniqueCallers,
    scoredCalls: accumulator.scoredCalls,
    averageScore: accumulator.scoredCalls > 0
      ? Number((accumulator.scoreSum / accumulator.scoredCalls).toFixed(2))
      : null,
    hot: accumulator.hot,
    warm: accumulator.warm,
    cold: accumulator.cold,
    dead: accumulator.dead,
    fake: accumulator.fake,
    dncToday: accumulator.dncToday,
    postdateToday: accumulator.postdateToday,
    initialPayments: accumulator.initialPayments,
    initialPaymentCount: accumulator.initialPaymentCount,
    totalCollected: accumulator.totalCollected,
    dealsToday: accumulator.dealsToday || accumulator.initialPaymentCount,
  };
}

function trackedVendorMeta(sourceName, sourceChannel = null, routeCampaignKey = null) {
  const family = classifyVendorFamily(sourceName, sourceChannel, routeCampaignKey);
  return {
    source: String(sourceName || "Unknown").trim() || "Unknown",
    channel: sourceChannel || null,
    familyKey: family.key,
    familyLabel: family.label,
    tracked: Boolean(family.tracked),
  };
}

function isTrackedVendorCandidate(sourceName, sourceChannel = null, routeCampaignKey = null) {
  return trackedVendorMeta(sourceName, sourceChannel, routeCampaignKey).tracked;
}

function uniqueStrings(values = []) {
  return [...new Set(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  )];
}

function splitRecipients(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function buildCanonicalMap(sourceCanonicalIds = []) {
  const ids = uniqueStrings(sourceCanonicalIds);
  if (ids.length === 0) return new Map();

  const rows = await SourceCanonical.find(
    { _id: { $in: ids } },
    { _id: 1, internalName: 1, channel: 1 },
  ).lean();

  return new Map(
    rows.map((row) => [String(row._id), row]),
  );
}

async function runVendorNightlyClosePass(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const result = {
    domain: normalizedDomain,
    startedAt: new Date(),
    callLogHygiene: null,
    sourceBackfill: null,
    paymentReconcile: null,
    errors: [],
  };

  if (options.performClosePass === false) {
    result.skipped = true;
    result.finishedAt = new Date();
    result.durationMs = result.finishedAt - result.startedAt;
    return result;
  }

  try {
    result.callLogHygiene = await runHourlyCallLogHygieneForDomain(normalizedDomain, {
      sinceMs: Math.max(Number(options.callSinceMs) || 36 * 60 * 60 * 1000, 60 * 60 * 1000),
      limitPerDomain: Math.min(Math.max(Number(options.callLimitPerDomain) || 500, 1), 5000),
      minDurationSec: Math.max(Number(options.minDurationSec) || 120, 0),
      maxCaseRefreshesPerDomain: Math.min(Math.max(Number(options.maxCaseRefreshesPerDomain) || 75, 1), 500),
      maxScoringPerDomain: Math.min(Math.max(Number(options.maxScoringPerDomain) || 25, 1), 200),
      syncMetricsDates: options.syncMetricsDates !== false,
      scorePendingCalls: options.scorePendingCalls !== false,
      now: options.now || new Date(),
    });
  } catch (error) {
    result.errors.push({
      step: "call-log-hygiene",
      error: error.message,
    });
  }

  // Source-name backfill: stamps sourceName/sourceChannel on CallLog
  // rows that have caseId but no source attribution yet — most
  // commonly CX-cadence outbound stubs to LD/affiliate/social leads,
  // where the EX resolver never fires. Without this pass, those calls
  // are invisible to the vendor pipeline (classifier returns "Other"
  // for null sourceName). Runs against the same date window as the
  // email so today's CX calls show up in tonight's CSVs.
  if (options.performSourceBackfill !== false) {
    try {
      const dateKey = String(
        options.date ||
          formatDateKey(options.now || new Date(), options.timezone || DEFAULT_TIMEZONE),
      ).trim();
      result.sourceBackfill = await backfillCallLogSourceFromLeadCadence({
        domain: normalizedDomain,
        date: dateKey,
        timezone: options.timezone || DEFAULT_TIMEZONE,
        limit: Math.min(Math.max(Number(options.sourceBackfillLimit) || 5000, 1), 50000),
        logger: options.logger || null,
      });
    } catch (error) {
      result.errors.push({
        step: "source-backfill",
        error: error.message,
      });
    }
  }

  try {
    result.paymentReconcile = await reconcilePaymentsForDomain({
      domain: normalizedDomain,
      staleAfterMs: 0,
      maxCases: Math.min(Math.max(Number(options.maxPaymentCases) || 300, 1), 5000),
      logger: options.logger || null,
    });
  } catch (error) {
    result.errors.push({
      step: "payment-reconcile",
      error: error.message,
    });
  }

  result.finishedAt = new Date();
  result.durationMs = result.finishedAt - result.startedAt;
  return result;
}

async function buildVendorCallRows(domain, dateKey, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_MAX_CALL_ROWS, 1), 50000);

  let rows = await CallLedger.find(
    {
      domain: normalizedDomain,
      date: String(dateKey),
    },
    {
      telephonySessionId: 1,
      callStartTime: 1,
      callEndTime: 1,
      durationSec: 1,
      direction: 1,
      phone: 1,
      normalizedPhone: 1,
      contactName: 1,
      caseId: 1,
      sourceName: 1,
      sourceChannel: 1,
      routeCampaignKey: 1,
      routeCampaignName: 1,
      recordingAvailable: 1,
      transcriptAvailable: 1,
      transcriptionStatus: 1,
      scoreOverall: 1,
      scoreVerdict: 1,
      scoreSummary: 1,
      agentName: 1,
      extensionId: 1,
      missed: 1,
    },
  )
    .sort({ callStartTime: 1, telephonySessionId: 1 })
    .limit(limit)
    .lean();

  if (rows.length === 0) {
    const { start, end } = buildTimezoneDateWindow(
      dateKey,
      options.timezone || DEFAULT_TIMEZONE,
    );
    rows = await CallLog.find(
      {
        domain: normalizedDomain,
        callStartTime: { $gte: start, $lte: end },
      },
      {
        telephonySessionId: 1,
        callStartTime: 1,
        callEndTime: 1,
        durationSec: 1,
        durationSeconds: 1,
        direction: 1,
        phone: 1,
        normalizedPhone: 1,
        contactName: 1,
        caseId: 1,
        sourceName: 1,
        sourceChannel: 1,
        routeCampaignKey: 1,
        routeCampaignName: 1,
        caseMatch: 1,
        transcription: 1,
        callScore: 1,
        agentName: 1,
        extensionId: 1,
        missed: 1,
      },
    )
      .sort({ callStartTime: 1, telephonySessionId: 1 })
      .limit(limit)
      .lean();
  }

  return rows
    .map((row) => {
      const sourceName = row.sourceName || row.caseMatch?.sourceName || "Unknown";
      const sourceChannel = row.sourceChannel || row.caseMatch?.sourceChannel || null;
      const routeCampaignKey = row.routeCampaignKey || null;
      const meta = trackedVendorMeta(sourceName, sourceChannel, routeCampaignKey);
      const rawScoreOverall = row.scoreOverall ?? row.callScore?.overall ?? "";
      const scoreVerdict = row.scoreVerdict || row.callScore?.lead_verdict || "";
      const numericScore = Number(rawScoreOverall);
      const scoreOverall =
        Number.isFinite(numericScore) && (numericScore > 0 || scoreVerdict)
          ? rawScoreOverall
          : "";
      const scoreSummary = row.scoreSummary || row.callScore?.summary || "";
      const durationSec = toNumber(row.durationSec || row.durationSeconds);
      return {
        date: dateKey,
        callStartTime: formatIso(row.callStartTime),
        callEndTime: formatIso(row.callEndTime),
        telephonySessionId: row.telephonySessionId || "",
        caseId: row.caseId ?? "",
        phone: row.phone || row.normalizedPhone || "",
        contactName: row.contactName || "",
        sourceFamily: meta.familyLabel,
        sourceFamilyKey: meta.familyKey,
        sourceName: meta.source,
        sourceChannel: meta.channel || "",
        routeCampaignKey,
        routeCampaignName: row.routeCampaignName || "",
        direction: row.direction || "",
        durationSec,
        callsOver2: durationSec >= 120 ? 1 : 0,
        callsOver5: durationSec >= 300 ? 1 : 0,
        recordingAvailable: row.recordingAvailable || row.transcription?.recordingUri ? "yes" : "no",
        transcriptAvailable: row.transcriptAvailable || row.transcription?.text ? "yes" : "no",
        transcriptionStatus: row.transcriptionStatus || row.transcription?.status || "",
        scoreOverall,
        scoreVerdict,
        scoreSummary,
        agentName: row.agentName || "",
        extensionId: row.extensionId || "",
        missed: row.missed ? "yes" : "no",
        tracked: meta.tracked,
      };
    })
    .filter((row) => row.tracked)
    .map(({ tracked, ...rest }) => rest);
}

async function buildVendorLeadRows(domain, dateKey, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_MAX_LEAD_ROWS, 1), 50000);
  const rows = await leadCadenceRepository.listLeadCadence(normalizedDomain, {
    createdAtAfter: dateKey,
    createdAtBefore: dateKey,
    limit,
  });
  const caseIds = [...new Set(
    rows
      .map((row) => Number(row.caseId))
      .filter(Number.isFinite),
  )];
  const profiles = caseIds.length > 0
    ? await caseProfileRepository.listCaseProfilesByCaseIds(normalizedDomain, caseIds)
    : [];
  const profileByCaseId = new Map(
    profiles.map((profile) => [Number(profile.caseId), profile]),
  );

  return rows
    .map((row) => {
      const profile = profileByCaseId.get(Number(row.caseId)) || null;
      const sourceName =
        profile?.sourceName ||
        row.sourceName ||
        row.intakeSource ||
        row.partnerSource ||
        row.metadata?.sourceName ||
        "Unknown";
      const sourceChannel =
        profile?.sourceChannel ||
        row.sourceChannel ||
        row.intakeRoute ||
        row.metadata?.sourceChannel ||
        null;
      const routeCampaignKey = row.routeCampaignKey || null;
      const meta = trackedVendorMeta(sourceName, sourceChannel, routeCampaignKey);
      const name =
        row.name ||
        [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
        "";
      return {
        date: dateKey,
        createdAt: formatIso(row.createdAt),
        caseId: row.caseId ?? "",
        name,
        phone: row.primaryPhone || row.phone || "",
        email: row.email || "",
        sourceFamily: meta.familyLabel,
        sourceFamilyKey: meta.familyKey,
        sourceName: meta.source,
        sourceChannel: meta.channel || "",
        intakeSource: row.intakeSource || "",
        intakeRoute: row.intakeRoute || "",
        // Route campaign — surfaced for the nightly vendor email's
        // "Lead intake by campaign" breakdown. Carries the LD CUSTOM /
        // LD GENERAL / organic / affiliate split that the LD intake
        // stamps at ingest time (see normalizeLdLeadPayload).
        routeCampaignKey,
        routeCampaignName: row.routeCampaignName || null,
        currentStage: row.currentStage || "",
        active: row.active === false ? "no" : "yes",
        tracked: meta.tracked,
      };
    })
    .filter((row) => row.tracked)
    .map(({ tracked, ...rest }) => rest);
}

async function buildVendorOutcomeRows(domain, dateKey, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const timeZone = options.timezone || DEFAULT_TIMEZONE;
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_MAX_PAYMENT_ROWS, 1), 50000);
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);

  const [roiPayments, successfulPayments] = await Promise.all([
    listRoiEligiblePayments(normalizedDomain, {
      date: dateKey,
      limit,
    }),
    paymentLedgerRepository.listPaymentsByDateRange(normalizedDomain, {
      date: dateKey,
      transactionStatus: "SUCCESS",
      limit,
    }),
  ]);

  const paymentSummaryByCaseId = new Map();
  for (const payment of successfulPayments) {
    const caseId = Number(payment.caseId);
    if (!Number.isFinite(caseId)) continue;
    if (!paymentSummaryByCaseId.has(caseId)) {
      paymentSummaryByCaseId.set(caseId, {
        totalCollected: 0,
        initialCollected: 0,
        paymentCount: 0,
        initialPaymentCount: 0,
        latestPaymentDate: null,
      });
    }
    const entry = paymentSummaryByCaseId.get(caseId);
    const amount = toNumber(payment.amount);
    entry.totalCollected += amount;
    entry.paymentCount += 1;
    if (String(payment.paymentType || "").toLowerCase() === "initial") {
      entry.initialCollected += amount;
      entry.initialPaymentCount += 1;
    }
    const paymentDate = toDate(payment.paymentDate);
    if (paymentDate && (!entry.latestPaymentDate || paymentDate > entry.latestPaymentDate)) {
      entry.latestPaymentDate = paymentDate;
    }
  }

  const dealCaseIds = [...new Set(
    roiPayments
      .filter((entry) => entry?.roiEligible)
      .map((entry) => Number(entry?.payment?.caseId))
      .filter(Number.isFinite),
  )];

  const profiles = await CaseProfile.find(
    {
      domain: normalizedDomain,
      $or: [
        { statusLastChangedAt: { $gte: start, $lte: end } },
        ...(dealCaseIds.length > 0 ? [{ caseId: { $in: dealCaseIds } }] : []),
      ],
    },
    {
      caseId: 1,
      name: 1,
      sourceName: 1,
      sourceChannel: 1,
      sourceCanonicalId: 1,
      statusId: 1,
      statusCategory: 1,
      statusLastChangedAt: 1,
      convertedAt: 1,
      firstPaymentDate: 1,
      totalPaid: 1,
      initialPayment: 1,
    },
  ).lean();

  const canonicalMap = await buildCanonicalMap(
    profiles.map((row) => row.sourceCanonicalId).filter(Boolean),
  );

  return profiles
    .map((profile) => {
      const canonical = canonicalMap.get(String(profile.sourceCanonicalId || "")) || null;
      const sourceName = profile.sourceName || canonical?.internalName || "Unknown";
      const sourceChannel = profile.sourceChannel || canonical?.channel || null;
      const meta = trackedVendorMeta(sourceName, sourceChannel);
      const paymentSummary = paymentSummaryByCaseId.get(Number(profile.caseId)) || {
        totalCollected: 0,
        initialCollected: 0,
        paymentCount: 0,
        initialPaymentCount: 0,
        latestPaymentDate: null,
      };
      const changedAt = toDate(profile.statusLastChangedAt);
      const changedToday = Boolean(changedAt && changedAt >= start && changedAt <= end);
      const becameDnc = changedToday && String(profile.statusCategory || "").toLowerCase() === "dnc";
      const becamePostdate = changedToday && String(profile.statusCategory || "").toLowerCase() === "postdate";
      const becameDeal = paymentSummary.initialPaymentCount > 0;
      const outcomeTypes = [
        becameDnc ? "dnc" : null,
        becamePostdate ? "postdate" : null,
        becameDeal ? "deal" : null,
      ].filter(Boolean);

      return {
        date: dateKey,
        caseId: profile.caseId ?? "",
        name: profile.name || "",
        sourceFamily: meta.familyLabel,
        sourceFamilyKey: meta.familyKey,
        sourceName: meta.source,
        sourceChannel: meta.channel || "",
        statusId: profile.statusId ?? "",
        statusCategory: profile.statusCategory || "",
        statusLastChangedAt: formatIso(profile.statusLastChangedAt),
        outcomeTypes: outcomeTypes.join("|"),
        becameDnc: becameDnc ? "yes" : "no",
        becamePostdate: becamePostdate ? "yes" : "no",
        becameDeal: becameDeal ? "yes" : "no",
        initialCollectedToday: formatCurrency(paymentSummary.initialCollected),
        totalCollectedToday: formatCurrency(paymentSummary.totalCollected),
        paymentCountToday: paymentSummary.paymentCount,
        initialPaymentCountToday: paymentSummary.initialPaymentCount,
        latestPaymentDate: formatIso(paymentSummary.latestPaymentDate),
        convertedAt: formatIso(profile.convertedAt),
        firstPaymentDate: formatIso(profile.firstPaymentDate),
        tracked: meta.tracked,
      };
    })
    .filter((row) =>
      row.tracked &&
      (row.becameDnc === "yes" || row.becamePostdate === "yes" || row.becameDeal === "yes"),
    )
    .map(({ tracked, ...rest }) => rest)
    .sort((left, right) =>
      String(left.sourceFamily).localeCompare(String(right.sourceFamily)) ||
      String(left.sourceName).localeCompare(String(right.sourceName)) ||
      Number(left.caseId || 0) - Number(right.caseId || 0),
    );
}

function buildDetailBackedVendorSummary(baseSummary, callRows, leadRows, outcomeRows) {
  const bySource = new Map();
  const byFamily = new Map();

  function ensureSourceAccumulator(row) {
    const key = JSON.stringify({
      source: row.sourceName || row.source || "Unknown",
      channel: row.sourceChannel || row.channel || null,
      family: row.sourceFamilyKey || row.family || "other",
    });
    if (!bySource.has(key)) {
      bySource.set(key, createAccumulator({
        source: row.sourceName || row.source || "Unknown",
        channel: row.sourceChannel || row.channel || null,
        family: row.sourceFamilyKey || row.family || "other",
        familyLabel: row.sourceFamily || row.familyLabel || "Other",
        tracked: true,
      }));
    }
    return bySource.get(key);
  }

  function ensureFamilyAccumulator(row) {
    const familyKey = row.sourceFamilyKey || row.family || "other";
    if (!byFamily.has(familyKey)) {
      byFamily.set(familyKey, createAccumulator({
        source: row.sourceFamily || row.familyLabel || "Other",
        channel: null,
        family: familyKey,
        familyLabel: row.sourceFamily || row.familyLabel || "Other",
        tracked: true,
      }));
    }
    return byFamily.get(familyKey);
  }

  for (const row of baseSummary?.rows || []) {
    if (!row.tracked) continue;
    const sourceAccumulator = ensureSourceAccumulator({
      sourceName: row.source,
      sourceChannel: row.channel,
      sourceFamilyKey: row.family,
      sourceFamily: row.familyLabel,
    });
    const familyAccumulator = ensureFamilyAccumulator({
      sourceFamilyKey: row.family,
      sourceFamily: row.familyLabel,
    });
    for (const target of [sourceAccumulator, familyAccumulator]) {
      target.spend += toNumber(row.spend);
      target.pieces += toNumber(row.pieces);
      target.impressions += toNumber(row.impressions);
      target.clicks += toNumber(row.clicks);
      target.reportedLeads += toNumber(row.reportedLeads);
    }
  }

  for (const row of leadRows) {
    const sourceAccumulator = ensureSourceAccumulator(row);
    const familyAccumulator = ensureFamilyAccumulator(row);
    sourceAccumulator.leads += 1;
    familyAccumulator.leads += 1;
  }

  for (const row of callRows) {
    const sourceAccumulator = ensureSourceAccumulator(row);
    const familyAccumulator = ensureFamilyAccumulator(row);
    for (const target of [sourceAccumulator, familyAccumulator]) {
      target.calls += 1;
      target.callsOver2 += toNumber(row.callsOver2);
      target.callsOver5 += toNumber(row.callsOver5);
      addUniqueCaller(target, row.phone);
      addScore(target, row.scoreOverall);
      const verdict = String(row.scoreVerdict || "").toLowerCase();
      if (verdict === "hot") target.hot += 1;
      if (verdict === "warm") target.warm += 1;
      if (verdict === "cold") target.cold += 1;
      if (verdict === "dead") target.dead += 1;
      if (verdict === "fake") target.fake += 1;
    }
  }

  for (const row of outcomeRows) {
    const sourceAccumulator = ensureSourceAccumulator(row);
    const familyAccumulator = ensureFamilyAccumulator(row);
    for (const target of [sourceAccumulator, familyAccumulator]) {
      if (row.becameDnc === "yes") target.dncToday += 1;
      if (row.becamePostdate === "yes") target.postdateToday += 1;
      if (row.becameDeal === "yes") target.dealsToday += 1;
      target.initialPayments += toNumber(row.initialCollectedToday);
      target.totalCollected += toNumber(row.totalCollectedToday);
      target.initialPaymentCount += toNumber(row.initialPaymentCountToday);
    }
  }

  const rows = [...bySource.values()]
    .map(finalizeAccumulator)
    .sort((left, right) =>
      toNumber(right.totalCollected) - toNumber(left.totalCollected) ||
      toNumber(right.leads) - toNumber(left.leads) ||
      String(left.source).localeCompare(String(right.source)),
    );

  const trackedFamilies = [...byFamily.values()]
    .map(finalizeAccumulator)
    .sort((left, right) =>
      toNumber(right.totalCollected) - toNumber(left.totalCollected) ||
      toNumber(right.leads) - toNumber(left.leads) ||
      String(left.familyLabel).localeCompare(String(right.familyLabel)),
    );

  const totalAccumulator = createAccumulator({
    source: "All Vendors",
    family: "all",
    familyLabel: "All Vendors",
    tracked: false,
  });

  for (const row of trackedFamilies) {
    totalAccumulator.spend += toNumber(row.spend);
    totalAccumulator.pieces += toNumber(row.pieces);
    totalAccumulator.impressions += toNumber(row.impressions);
    totalAccumulator.clicks += toNumber(row.clicks);
    totalAccumulator.leads += toNumber(row.leads);
    totalAccumulator.reportedLeads += toNumber(row.reportedLeads);
    totalAccumulator.calls += toNumber(row.calls);
    totalAccumulator.callsOver2 += toNumber(row.callsOver2);
    totalAccumulator.callsOver5 += toNumber(row.callsOver5);
    totalAccumulator.uniqueCallers += toNumber(row.uniqueCallers);
    totalAccumulator.hot += toNumber(row.hot);
    totalAccumulator.warm += toNumber(row.warm);
    totalAccumulator.cold += toNumber(row.cold);
    totalAccumulator.dead += toNumber(row.dead);
    totalAccumulator.fake += toNumber(row.fake);
    totalAccumulator.dncToday += toNumber(row.dncToday);
    totalAccumulator.postdateToday += toNumber(row.postdateToday);
    totalAccumulator.initialPayments += toNumber(row.initialPayments);
    totalAccumulator.initialPaymentCount += toNumber(row.initialPaymentCount);
    totalAccumulator.totalCollected += toNumber(row.totalCollected);
    totalAccumulator.dealsToday += toNumber(row.dealsToday);
    totalAccumulator.scoredCalls += toNumber(row.scoredCalls);
    totalAccumulator.scoreSum += toNumber(row.averageScore) * toNumber(row.scoredCalls);
  }

  return {
    domain: baseSummary?.domain || null,
    date: baseSummary?.date || null,
    totals: finalizeAccumulator(totalAccumulator),
    trackedFamilies,
    rows,
    attributionReview: baseSummary?.attributionReview || {},
  };
}

function buildVendorNightlyBody(domain, dateKey, summary, details, closePass) {
  const trackedFamilies = (Array.isArray(summary.trackedFamilies)
    ? summary.trackedFamilies
    : [])
      .filter(isLdVendorFamily)
      .map(decorateLdVendorFamily);
  const ldCost = buildLdCostSummary(trackedFamilies);
  const lines = [
    `[${domain}] Vendor nightly close for ${dateKey}`,
    "",
    "Top line",
    `LD leads: ${sumVendorRows(trackedFamilies, "leads")}`,
    `LD cost: $${formatCurrency(ldCost.total)} (LD CUSTOM ${ldCost.customCount} x $${ldCost.customRate} + LD GENERAL ${ldCost.generalCount} x $${ldCost.generalRate})`,
    `LD calls: ${sumVendorRows(trackedFamilies, "calls")} (${sumVendorRows(trackedFamilies, "callsOver2")} over 2m, ${sumVendorRows(trackedFamilies, "callsOver5")} over 5m)`,
    `Scored LD calls: ${sumVendorRows(trackedFamilies, "scoredCalls")}`,
    `DNC today: ${sumVendorRows(trackedFamilies, "dncToday")}`,
    `Postdate today: ${sumVendorRows(trackedFamilies, "postdateToday")}`,
    `Deals today: ${sumVendorRows(trackedFamilies, "dealsToday")}`,
    `Initials today: $${formatCurrency(sumVendorRows(trackedFamilies, "initialPayments"))}`,
    `Collected today: $${formatCurrency(sumVendorRows(trackedFamilies, "totalCollected"))}`,
    "",
    "LD family summary",
  ];

  if (trackedFamilies.length === 0) {
    lines.push("No LD families were found for this date.");
  } else {
    for (const row of trackedFamilies.slice(0, 12)) {
      lines.push(
        `${row.familyLabel}: leads ${toNumber(row.leads)}, cost $${formatCurrency(row.estimatedCost)}, calls ${toNumber(row.calls)}, scored ${toNumber(row.scoredCalls)}, dnc ${toNumber(row.dncToday)}, postdate ${toNumber(row.postdateToday)}, deals ${toNumber(row.dealsToday)}, collected $${formatCurrency(row.totalCollected)}`,
      );
    }
  }

  lines.push("");
  lines.push("Attachments");
  for (const attachment of details.attachments) {
    lines.push(`${attachment.filename} (${attachment.rowCount} rows)`);
  }

  const heldOut = summary.attributionReview || {};
  lines.push("");
  lines.push(
    `Attribution held out: ${toNumber(heldOut.skipped)} skipped, ${toNumber(heldOut.queued)} queued, ${toNumber(heldOut.resolved)} resolved, ${toNumber(heldOut.ignored)} ignored`,
  );

  if (closePass?.errors?.length > 0) {
    lines.push("");
    lines.push("Final close pass warnings");
    for (const error of closePass.errors) {
      lines.push(`${error.step}: ${error.error}`);
    }
  }

  return lines.join("\n");
}

function buildAttachmentPayload(filename, csv, rowCount) {
  return {
    filename,
    type: "text/csv",
    disposition: "attachment",
    content: Buffer.from(csv, "utf8").toString("base64"),
    rowCount,
    sizeBytes: Buffer.byteLength(csv, "utf8"),
  };
}

async function sendVendorNightlyEmail(domain, report, options = {}) {
  const company = getCompanyConfig(domain);
  // 2026-05-12 — pulled the broader distro back to mgray + manderson only
  // while the LD-lead / LD-call counters get re-plumbed. Once the call-
  // attribution backfill is verified and the daily CSVs reconcile, the
  // env-overrides below can expand the list again (NIGHTLY_CLOSE_LEAD_DATA_RECIPIENTS
  // takes precedence, then options.recipients on a per-call basis).
  const DEFAULT_VENDOR_RECIPIENTS = Object.freeze([
    "mgray@taxadvocategroup.com",
    "manderson@taxadvocategroup.com",
  ]);
  const envRecipients = splitRecipients(
    process.env.NIGHTLY_CLOSE_LEAD_DATA_RECIPIENTS ||
      process.env.RB_REPORT_TO ||
      "",
  );
  const defaultRecipients = envRecipients.length > 0
    ? envRecipients
    : [...DEFAULT_VENDOR_RECIPIENTS];
  const recipients = uniqueStrings(
    Array.isArray(options.recipients) && options.recipients.length > 0
      ? options.recipients
      : defaultRecipients,
  );

  if (recipients.length === 0) {
    return { sent: false, reason: "no-recipients" };
  }

  const payload = {
    personalizations: [
      {
        to: recipients.map((email) => ({ email })),
      },
    ],
    from: {
      email: getInternalFromEmail(),
      name: company.emailName,
    },
    reply_to: {
      email: getInternalFromEmail(),
      name: company.contactName || company.emailName,
    },
    subject: `[${domain}] Vendor nightly ${report.date}`,
    content: [
      {
        type: "text/plain",
        value: report.body,
      },
    ],
    attachments: report.attachments.map((attachment) => ({
      filename: attachment.filename,
      type: attachment.type,
      disposition: attachment.disposition,
      content: attachment.content,
    })),
    mail_settings: {
      sandbox_mode: {
        enable: false,
      },
    },
  };

  await sendPlainEmail(domain, payload);
  return {
    sent: true,
    recipients,
    subject: payload.subject,
  };
}

async function runVendorNightlyEmail(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const timeZone = options.timezone || DEFAULT_TIMEZONE;
  const dateKey = String(options.date || formatDateKey(new Date(), timeZone)).trim();

  const closePass = await runVendorNightlyClosePass(normalizedDomain, {
    ...options,
    timezone: timeZone,
  });

  const [baselineSummary, callRows, leadRows, outcomeRows] = await Promise.all([
    buildVendorDailySummary(normalizedDomain, {
      date: dateKey,
      timezone: timeZone,
      leadLimit: options.leadLimit || DEFAULT_MAX_LEAD_ROWS,
    }),
    buildVendorCallRows(normalizedDomain, dateKey, {
      limit: options.callRowLimit || DEFAULT_MAX_CALL_ROWS,
    }),
    buildVendorLeadRows(normalizedDomain, dateKey, {
      limit: options.leadRowLimit || DEFAULT_MAX_LEAD_ROWS,
    }),
    buildVendorOutcomeRows(normalizedDomain, dateKey, {
      timezone: timeZone,
      limit: options.outcomeRowLimit || DEFAULT_MAX_PAYMENT_ROWS,
    }),
  ]);

  const summary = buildDetailBackedVendorSummary(
    baselineSummary,
    callRows,
    leadRows,
    outcomeRows,
  );

  const callsCsv = buildCsv(callRows, [
    { header: "date", key: "date" },
    { header: "callStartTime", key: "callStartTime" },
    { header: "callEndTime", key: "callEndTime" },
    { header: "telephonySessionId", key: "telephonySessionId" },
    { header: "caseId", key: "caseId" },
    { header: "phone", key: "phone" },
    { header: "contactName", key: "contactName" },
    { header: "sourceFamily", key: "sourceFamily" },
    { header: "sourceFamilyKey", key: "sourceFamilyKey" },
    { header: "sourceName", key: "sourceName" },
    { header: "sourceChannel", key: "sourceChannel" },
    { header: "routeCampaignKey", key: "routeCampaignKey" },
    { header: "routeCampaignName", key: "routeCampaignName" },
    { header: "direction", key: "direction" },
    { header: "durationSec", key: "durationSec" },
    { header: "callsOver2", key: "callsOver2" },
    { header: "callsOver5", key: "callsOver5" },
    { header: "recordingAvailable", key: "recordingAvailable" },
    { header: "transcriptAvailable", key: "transcriptAvailable" },
    { header: "transcriptionStatus", key: "transcriptionStatus" },
    { header: "scoreOverall", key: "scoreOverall" },
    { header: "scoreVerdict", key: "scoreVerdict" },
    { header: "scoreSummary", key: "scoreSummary" },
    { header: "agentName", key: "agentName" },
    { header: "extensionId", key: "extensionId" },
    { header: "missed", key: "missed" },
  ]);

  const leadsCsv = buildCsv(leadRows, [
    { header: "date", key: "date" },
    { header: "createdAt", key: "createdAt" },
    { header: "caseId", key: "caseId" },
    { header: "name", key: "name" },
    { header: "phone", key: "phone" },
    { header: "email", key: "email" },
    { header: "sourceFamily", key: "sourceFamily" },
    { header: "sourceFamilyKey", key: "sourceFamilyKey" },
    { header: "sourceName", key: "sourceName" },
    { header: "sourceChannel", key: "sourceChannel" },
    { header: "routeCampaignKey", key: "routeCampaignKey" },
    { header: "routeCampaignName", key: "routeCampaignName" },
    { header: "intakeSource", key: "intakeSource" },
    { header: "intakeRoute", key: "intakeRoute" },
    { header: "currentStage", key: "currentStage" },
    { header: "active", key: "active" },
  ]);

  const outcomesCsv = buildCsv(outcomeRows, [
    { header: "date", key: "date" },
    { header: "caseId", key: "caseId" },
    { header: "name", key: "name" },
    { header: "sourceFamily", key: "sourceFamily" },
    { header: "sourceFamilyKey", key: "sourceFamilyKey" },
    { header: "sourceName", key: "sourceName" },
    { header: "sourceChannel", key: "sourceChannel" },
    { header: "statusId", key: "statusId" },
    { header: "statusCategory", key: "statusCategory" },
    { header: "statusLastChangedAt", key: "statusLastChangedAt" },
    { header: "outcomeTypes", key: "outcomeTypes" },
    { header: "becameDnc", key: "becameDnc" },
    { header: "becamePostdate", key: "becamePostdate" },
    { header: "becameDeal", key: "becameDeal" },
    { header: "initialCollectedToday", key: "initialCollectedToday" },
    { header: "totalCollectedToday", key: "totalCollectedToday" },
    { header: "paymentCountToday", key: "paymentCountToday" },
    { header: "initialPaymentCountToday", key: "initialPaymentCountToday" },
    { header: "latestPaymentDate", key: "latestPaymentDate" },
    { header: "convertedAt", key: "convertedAt" },
    { header: "firstPaymentDate", key: "firstPaymentDate" },
  ]);

  const attachments = [
    buildAttachmentPayload(
      `${normalizedDomain.toLowerCase()}-vendor-calls-${dateKey}.csv`,
      callsCsv,
      callRows.length,
    ),
    buildAttachmentPayload(
      `${normalizedDomain.toLowerCase()}-vendor-leads-${dateKey}.csv`,
      leadsCsv,
      leadRows.length,
    ),
    buildAttachmentPayload(
      `${normalizedDomain.toLowerCase()}-vendor-outcomes-${dateKey}.csv`,
      outcomesCsv,
      outcomeRows.length,
    ),
  ];

  const attachmentMeta = attachments.map((attachment) => ({
    filename: attachment.filename,
    rowCount: attachment.rowCount,
    sizeBytes: attachment.sizeBytes,
    type: attachment.type,
  }));

  const report = {
    domain: normalizedDomain,
    date: dateKey,
    timeZone,
    closePass,
    summary,
    attachments,
    attachmentMeta,
  };

  report.body = buildVendorNightlyBody(
    normalizedDomain,
    dateKey,
    summary,
    { attachments: attachmentMeta },
    closePass,
  );

  if (options.sendEmail === false) {
    report.emailResult = { sent: false, reason: "send-disabled" };
    return report;
  }

  report.emailResult = await sendVendorNightlyEmail(normalizedDomain, report, options.email || options);
  return report;
}

module.exports = {
  buildDetailBackedVendorSummary,
  buildVendorCallRows,
  buildVendorLeadRows,
  buildVendorOutcomeRows,
  runVendorNightlyClosePass,
  runVendorNightlyEmail,
};
