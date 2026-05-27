"use strict";

const {
  CaseProfile,
  SourceCanonical,
} = require("../../shared-models/src");
const {
  callLedgerRepository,
  caseProfileRepository,
  leadCadenceRepository,
  spendEntryRepository,
} = require("../../shared-repositories/src");
const { listRoiEligiblePayments } = require("./paymentRoiService");
const { reconcileMetricsAttributionCandidates } = require("./metricsAttributionReviewService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const DEFAULT_LEAD_LIMIT = 20000;

const VENDOR_FAMILY_DEFS = Object.freeze([
  {
    key: "affiliate",
    label: "Lead Form Affiliate",
    matches: (source, channel) =>
      channel === "affiliate" || source.includes("affiliate"),
  },
  // LD CUSTOM — checked FIRST so it wins when routeCampaignKey is set.
  // The ld-posting fallback below catches legacy rows with no route
  // campaign key. ld-custom / ld-general distinction comes from the
  // `routeCampaignKey` field on CallLog (mirrored from LeadCadence at
  // intake — VFD/GS03RB7W → ld-custom, JM8K5B7Y → ld-general). The
  // matcher only fires when routeCampaignKey is plumbed through; the
  // classifier wrapper that calls into this list passes the campaign
  // key as a third argument.
  {
    key: "ld-custom",
    label: "LD CUSTOM",
    matches: (source, channel, routeCampaignKey) =>
      routeCampaignKey === "ld-custom" ||
      source === "ld custom" ||
      source.includes("ld custom"),
  },
  {
    key: "ld-general",
    label: "LD GENERAL",
    matches: (source, channel, routeCampaignKey) =>
      routeCampaignKey === "ld-general" ||
      source === "ld general" ||
      source.includes("ld general"),
  },
  {
    key: "ld-posting",
    label: "LD Posting",
    matches: (source, channel) =>
      channel === "ld" ||
      channel === "ld-posting" ||
      source === "ld" ||
      source.includes("ld-posting") ||
      source.includes("ld posting") ||
      source.includes("lead data") ||
      source.includes("lead post") ||
      source.includes("a+ leads"),
  },
  {
    key: "social",
    label: "Social",
    matches: (source, channel) =>
      channel === "social" ||
      channel === "digital" ||
      channel === "facebook" ||
      channel === "instagram" ||
      channel === "tiktok" ||
      channel === "meta" ||
      source.includes("facebook") ||
      source.includes("instagram") ||
      source.includes("tiktok") ||
      source.includes("meta") ||
      source.includes("social") ||
      source.includes("landing page") ||
      source.includes("digital lead") ||
      /\bvf\b/.test(source) ||
      source.includes("vf ") ||
      source.startsWith("vf") ||
      source.includes(" vertical fund") ||
      source.includes(" vertical financial"),
  },
  {
    key: "mail",
    label: "Mail",
    matches: (source, channel) =>
      channel === "mailer" ||
      channel === "mail" ||
      source.includes("mailer") ||
      source.includes("direct mail"),
  },
  {
    key: "bcd",
    label: "BCD",
    matches: (source, channel) =>
      channel === "bcd" || source.includes("bcd"),
  },
  {
    key: "callfire",
    label: "CallFire",
    matches: (source, channel) =>
      channel === "callfire" ||
      channel === "dialer" ||
      source.includes("callfire") ||
      source.includes("dialer"),
  },
]);

const TRACKED_VENDOR_FAMILIES = new Set([
  "ld-custom",
  "ld-general",
  "ld-posting",
  "affiliate",
  "social",
]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeVendorChannel(channel) {
  const normalized = normalizeText(channel);
  if (!normalized) return null;
  if (normalized === "mail") return "mailer";
  if (normalized === "ld-posting") return "ld";
  if (normalized === "callfire") return "dialer";
  return normalized;
}

function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatDateKey(date = new Date(), timeZone = "America/Los_Angeles") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function classifyVendorFamily(sourceName, fallbackChannel = null, routeCampaignKey = null) {
  const normalizedSource = normalizeText(sourceName);
  const normalizedChannel = normalizeVendorChannel(fallbackChannel);
  const normalizedRouteKey = routeCampaignKey
    ? String(routeCampaignKey).trim().toLowerCase()
    : null;
  for (const family of VENDOR_FAMILY_DEFS) {
    if (family.matches(normalizedSource, normalizedChannel, normalizedRouteKey)) {
      return {
        key: family.key,
        label: family.label,
        tracked: TRACKED_VENDOR_FAMILIES.has(family.key),
      };
    }
  }
  return {
    key: "other",
    label: "Other",
    tracked: false,
  };
}

function vendorFamilyByKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  const family = VENDOR_FAMILY_DEFS.find((entry) => entry.key === normalized);
  if (!family) {
    return {
      key: normalized || "other",
      label: normalized || "Other",
      tracked: TRACKED_VENDOR_FAMILIES.has(normalized),
    };
  }
  return {
    key: family.key,
    label: family.label,
    tracked: TRACKED_VENDOR_FAMILIES.has(family.key),
  };
}

function isTrackedVendorCandidate(sourceName, fallbackChannel = null, routeCampaignKey = null) {
  return classifyVendorFamily(sourceName, fallbackChannel, routeCampaignKey).tracked;
}

function createMetricRow(source, channel, family) {
  return {
    source: String(source || "Unknown"),
    channel: normalizeVendorChannel(channel) || null,
    family: family.key,
    familyLabel: family.label,
    tracked: Boolean(family.tracked),
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leads: 0,
    reportedLeads: 0,
    calls: 0,
    callsOver5: 0,
    callsOver2: 0,
    uniqueCallers: 0,
    scoredCalls: 0,
    averageScore: null,
    hot: 0,
    warm: 0,
    cold: 0,
    dead: 0,
    fake: 0,
    dncToday: 0,
    postdateToday: 0,
    initialPayments: 0,
    initialPaymentCount: 0,
    totalCollected: 0,
  };
}

function createEmptyAccumulator() {
  return {
    spend: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
    leads: 0,
    reportedLeads: 0,
    calls: 0,
    callsOver5: 0,
    callsOver2: 0,
    uniqueCallers: 0,
    scoredCalls: 0,
    hot: 0,
    warm: 0,
    cold: 0,
    dead: 0,
    fake: 0,
    dncToday: 0,
    postdateToday: 0,
    initialPayments: 0,
    initialPaymentCount: 0,
    totalCollected: 0,
    scoreSum: 0,
  };
}

function addMetrics(target, patch = {}) {
  target.spend += toNumber(patch.spend);
  target.pieces += toNumber(patch.pieces);
  target.impressions += toNumber(patch.impressions);
  target.clicks += toNumber(patch.clicks);
  target.leads += toNumber(patch.leads);
  target.reportedLeads += toNumber(patch.reportedLeads);
  target.calls += toNumber(patch.calls);
  target.callsOver5 += toNumber(patch.callsOver5);
  target.callsOver2 += toNumber(patch.callsOver2);
  target.uniqueCallers += toNumber(patch.uniqueCallers);
  target.scoredCalls += toNumber(patch.scoredCalls);
  target.hot += toNumber(patch.hot);
  target.warm += toNumber(patch.warm);
  target.cold += toNumber(patch.cold);
  target.dead += toNumber(patch.dead);
  target.fake += toNumber(patch.fake);
  target.dncToday += toNumber(patch.dncToday);
  target.postdateToday += toNumber(patch.postdateToday);
  target.initialPayments += toNumber(patch.initialPayments);
  target.initialPaymentCount += toNumber(patch.initialPaymentCount);
  target.totalCollected += toNumber(patch.totalCollected);

  const averageScore = Number(patch.averageScore);
  const scoredCalls = toNumber(patch.scoredCalls);
  if (scoredCalls > 0 && Number.isFinite(averageScore)) {
    target.scoreSum += averageScore * scoredCalls;
  }
}

function finalizeRow(row) {
  const scoredCalls = toNumber(row.scoredCalls);
  const leadBase = toNumber(row.leads) || toNumber(row.reportedLeads);
  const averageScore =
    scoredCalls > 0
      ? Number((toNumber(row.scoreSum) / scoredCalls).toFixed(2))
      : null;
  const roas =
    row.spend > 0 ? Number((row.totalCollected / row.spend).toFixed(2)) : null;
  const costPerLead =
    leadBase > 0 ? Number((row.spend / leadBase).toFixed(2)) : null;

  const { scoreSum, ...rest } = row;
  return {
    ...rest,
    averageScore,
    dealsToday: row.initialPaymentCount,
    roas,
    costPerLead,
    scoreCoverage:
      row.calls > 0 ? Number((row.scoredCalls / row.calls).toFixed(2)) : null,
  };
}

function ensureSourceRow(bySource, sourceName, channel, routeCampaignKey = null) {
  const family = classifyVendorFamily(sourceName, channel, routeCampaignKey);
  const normalizedSource = String(sourceName || "Unknown").trim() || "Unknown";
  const normalizedChannel = normalizeVendorChannel(channel);
  const key = JSON.stringify({
    source: normalizedSource,
    channel: normalizedChannel || null,
    family: family.key,
  });
  if (!bySource.has(key)) {
    bySource.set(
      key,
      createMetricRow(normalizedSource, normalizedChannel || null, family),
    );
  }
  return bySource.get(key);
}

function ensureFamilyRow(byFamily, sourceName, channel, routeCampaignKey = null) {
  const family = classifyVendorFamily(sourceName, channel, routeCampaignKey);
  if (!byFamily.has(family.key)) {
    byFamily.set(family.key, createMetricRow(family.label, null, family));
  }
  return byFamily.get(family.key);
}

function ensureFamilyRowByKey(byFamily, familyKey) {
  const family = vendorFamilyByKey(familyKey);
  if (!byFamily.has(family.key)) {
    byFamily.set(family.key, createMetricRow(family.label, null, family));
  }
  return byFamily.get(family.key);
}

function createCandidate(kind, source, channel, metrics = {}, extra = {}) {
  // routeCampaignKey may be passed through `extra` so call sites can
  // bucket LD calls into ld-custom / ld-general without a separate
  // function-signature change. Stamped onto the candidate so the
  // downstream attribution-review service and the byFamily/bySource
  // bucketing both classify the same way.
  const routeCampaignKey = extra.routeCampaignKey || null;
  const family = classifyVendorFamily(source, channel, routeCampaignKey);
  return {
    kind,
    source,
    channel: normalizeVendorChannel(channel),
    routeCampaignKey: routeCampaignKey || null,
    rawSource: source,
    rawChannel: channel,
    familyKey: family.key,
    observed: metrics,
    ...extra,
  };
}

async function fetchOutcomeProfiles(domain, dateKey, options = {}) {
  const { start, end } = buildTimezoneDateWindow(
    dateKey,
    options.timezone || "America/Los_Angeles",
  );
  const rows = await CaseProfile.find(
    {
      domain: normalizeDomain(domain),
      statusLastChangedAt: { $gte: start, $lte: end },
      statusCategory: { $in: ["dnc", "postdate"] },
    },
    {
      caseId: 1,
      sourceName: 1,
      sourceCanonicalId: 1,
      statusCategory: 1,
    },
  ).lean();

  const canonicalIds = [...new Set(
    rows
      .map((row) => String(row.sourceCanonicalId || "").trim())
      .filter(Boolean),
  )];
  const canonicals = canonicalIds.length > 0
    ? await SourceCanonical.find(
        { _id: { $in: canonicalIds } },
        { _id: 1, internalName: 1, channel: 1 },
      ).lean()
    : [];
  const canonicalById = new Map(
    canonicals.map((row) => [String(row._id), row]),
  );

  return rows.map((row) => {
    const canonical = canonicalById.get(String(row.sourceCanonicalId || "")) || null;
    return {
      caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
      source: row.sourceName || canonical?.internalName || "Unknown",
      channel: canonical?.channel || null,
      statusCategory: row.statusCategory || null,
    };
  });
}

async function buildVendorDailySummary(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const timeZone = options.timezone || "America/Los_Angeles";
  const dateKey = String(
    options.date || formatDateKey(new Date(), timeZone),
  ).trim();
  const leadLimit = Math.min(
    Math.max(Number(options.leadLimit) || DEFAULT_LEAD_LIMIT, 1),
    50000,
  );
  const { start, end } = buildTimezoneDateWindow(dateKey, timeZone);

  const [spendRows, leadRows, callRows, roiPayments, outcomeProfiles] =
    await Promise.all([
      spendEntryRepository.summarizeSpendBySource(normalizedDomain, { date: dateKey }),
      leadCadenceRepository.listLeadCadence(normalizedDomain, {
        createdAtAfter: dateKey,
        createdAtBefore: dateKey,
        limit: leadLimit,
      }),
      callLedgerRepository.summarizeCallLedgerBySource(normalizedDomain, {
        date: dateKey,
      }),
      listRoiEligiblePayments(normalizedDomain, {
        date: dateKey,
        limit: 10000,
      }),
      fetchOutcomeProfiles(normalizedDomain, dateKey, { timezone: timeZone }),
    ]);

  const leadCaseIds = [...new Set(
    leadRows
      .map((row) => Number(row.caseId))
      .filter(Number.isFinite),
  )];
  const leadProfiles = leadCaseIds.length > 0
    ? await caseProfileRepository.listCaseProfilesByCaseIds(normalizedDomain, leadCaseIds)
    : [];
  const leadProfileByCaseId = new Map(
    leadProfiles.map((profile) => [Number(profile.caseId), profile]),
  );

  const bySource = new Map();
  const byFamily = new Map();
  const candidates = [];

  for (const row of spendRows) {
    const source = row._id?.source || "Unknown";
    const channel = row._id?.channel || null;
    if (!isTrackedVendorCandidate(source, channel)) continue;
    candidates.push(createCandidate("spend", source, channel, {
      spend: row.spend,
      pieces: row.pieces,
      impressions: row.impressions,
      clicks: row.clicks,
      reportedLeads: row.leadsReported,
    }, {
      dateKey,
      sample: {
        source,
        channel,
      },
    }));
  }

  for (const row of leadRows) {
    const profile = leadProfileByCaseId.get(Number(row.caseId)) || null;
    const source =
      profile?.sourceName ||
      row.sourceName ||
      row.intakeSource ||
      row.partnerSource ||
      "Unknown";
    const channel =
      profile?.sourceChannel ||
      row.sourceChannel ||
      row.intakeRoute ||
      null;
    const routeCampaignKey = row.routeCampaignKey || null;
    if (!isTrackedVendorCandidate(source, channel, routeCampaignKey)) continue;
    candidates.push(createCandidate("lead", source, channel, {
      leads: 1,
    }, {
      dateKey,
      routeCampaignKey,
      caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
      sample: {
        caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
        intakeSource: row.intakeSource || null,
        intakeRoute: row.intakeRoute || null,
        routeCampaignKey,
      },
    }));
  }

  for (const row of callRows) {
    const source = row._id?.source || "Unknown";
    const channel = row._id?.channel || null;
    const routeCampaignKey = row._id?.routeCampaignKey || null;
    if (!isTrackedVendorCandidate(source, channel, routeCampaignKey)) continue;
    const uniqueCallers = Array.isArray(row.uniqueCallersSet)
      ? row.uniqueCallersSet.filter(Boolean).length
      : 0;
    const patch = {
      calls: row.calls,
      callsOver5: row.callsOver5,
      callsOver2: row.callsOver2,
      uniqueCallers,
      scoredCalls: row.scoredCalls,
      averageScore:
        row.averageScore != null ? Number(Number(row.averageScore).toFixed(2)) : null,
      hot: row.hot,
      warm: row.warm,
      cold: row.cold,
      dead: row.dead,
      fake: row.fake,
    };
    candidates.push(createCandidate("call", source, channel, patch, {
      dateKey,
      routeCampaignKey,
      sample: {
        source,
        channel,
        routeCampaignKey,
      },
    }));
  }

  for (const entry of roiPayments) {
    if (!entry?.roiEligible) continue;
    const payment = entry.payment || {};
    const sourceMeta = entry.sourceMeta || {};
    const source = sourceMeta.source || "Unknown";
    const channel = sourceMeta.channel || null;
    if (!isTrackedVendorCandidate(source, channel)) continue;
    const paymentType = String(payment.paymentType || "").toLowerCase();
    candidates.push(createCandidate("payment", source, channel, {
      totalCollected: payment.amount,
      initialPayments: paymentType === "initial" ? payment.amount : 0,
      initialPaymentCount: paymentType === "initial" ? 1 : 0,
    }, {
      dateKey,
      caseId: Number.isFinite(Number(payment.caseId)) ? Number(payment.caseId) : null,
      casePaymentId: Number.isFinite(Number(payment.casePaymentId))
        ? Number(payment.casePaymentId)
        : null,
      sample: {
        caseId: Number.isFinite(Number(payment.caseId)) ? Number(payment.caseId) : null,
        casePaymentId: Number.isFinite(Number(payment.casePaymentId))
          ? Number(payment.casePaymentId)
          : null,
        paymentReference: Number.isFinite(Number(payment.casePaymentId))
          ? String(Number(payment.casePaymentId))
          : null,
        amount: Number(payment.amount || 0),
      },
    }));
  }

  for (const row of outcomeProfiles) {
    const source = row.source || "Unknown";
    const channel = row.channel || null;
    if (!isTrackedVendorCandidate(source, channel)) continue;
    const patch =
      row.statusCategory === "dnc"
        ? { dncToday: 1 }
        : row.statusCategory === "postdate"
          ? { postdateToday: 1 }
          : null;
    if (!patch) continue;
    candidates.push(createCandidate("outcome", source, channel, patch, {
      dateKey,
      caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
      sample: {
        caseId: Number.isFinite(Number(row.caseId)) ? Number(row.caseId) : null,
        statusCategory: row.statusCategory || null,
      },
    }));
  }

  const attribution = await reconcileMetricsAttributionCandidates(
    normalizedDomain,
    candidates,
  );

  for (const candidate of attribution.accepted) {
    const source = candidate.source || "Unknown";
    const channel = candidate.channel || null;
    const routeCampaignKey = candidate.routeCampaignKey || null;
    const patch = candidate.observed || {};
    addMetrics(ensureSourceRow(bySource, source, channel, routeCampaignKey), patch);
    addMetrics(ensureFamilyRow(byFamily, source, channel, routeCampaignKey), patch);
  }

  for (const familyKey of ["ld-custom", "ld-general", "ld-posting"]) {
    ensureFamilyRowByKey(byFamily, familyKey);
  }

  const sources = [...bySource.values()]
    .map((row) => finalizeRow(row))
    .sort((left, right) => {
      const rightWeight =
        toNumber(right.totalCollected) +
        toNumber(right.initialPayments) +
        toNumber(right.spend) +
        toNumber(right.calls);
      const leftWeight =
        toNumber(left.totalCollected) +
        toNumber(left.initialPayments) +
        toNumber(left.spend) +
        toNumber(left.calls);
      return rightWeight - leftWeight || left.source.localeCompare(right.source);
    });

  const families = [...byFamily.values()]
    .map((row) => finalizeRow(row))
    .sort((left, right) => {
      if (left.tracked !== right.tracked) {
        return left.tracked ? -1 : 1;
      }
      const rightWeight =
        toNumber(right.totalCollected) +
        toNumber(right.initialPayments) +
        toNumber(right.spend) +
        toNumber(right.calls);
      const leftWeight =
        toNumber(left.totalCollected) +
        toNumber(left.initialPayments) +
        toNumber(left.spend) +
        toNumber(left.calls);
      return rightWeight - leftWeight || left.familyLabel.localeCompare(right.familyLabel);
    });

  const totalsAccumulator = createEmptyAccumulator();
  for (const row of sources) addMetrics(totalsAccumulator, row);
  const totals = finalizeRow({
    ...totalsAccumulator,
    source: "All Vendors",
    channel: null,
    family: "all",
    familyLabel: "All Vendors",
    tracked: false,
  });

  return {
    domain: normalizedDomain,
    date: dateKey,
    totals,
    families,
    trackedFamilies: families.filter((row) => row.tracked),
    rows: sources,
    attributionReview: attribution.review,
  };
}

module.exports = {
  TRACKED_VENDOR_FAMILIES,
  buildVendorDailySummary,
  classifyVendorFamily,
};
