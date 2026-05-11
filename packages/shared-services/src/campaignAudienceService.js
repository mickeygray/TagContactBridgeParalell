"use strict";

const { getSharedConfig } = require("../../shared-config/src");
const {
  caseProfileRepository,
  leadCadenceRepository,
} = require("../../shared-repositories/src");
const { CaseProfile, MasterProspectIndex, WorkflowRecord } = require("../../shared-models/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { buildTimezoneDateWindow } = require("./timezoneDateWindowService");

const CASE_PROFILE_STATUS_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUDIENCE_TIMEZONE = "America/Los_Angeles";

function buildRegex(value) {
  return new RegExp(
    String(value || "")
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );
}

function buildSuppressionMap(caseProfiles = []) {
  return new Map(
    caseProfiles.map((profile) => {
      const aiStatus = String(profile?.aiActivityReview?.status || "").toLowerCase();
      const suppressed =
        Boolean(profile?.conversationAi?.optOutDetected) ||
        aiStatus === "stop_contact" ||
        aiStatus === "pause_contact";
      const reasons = [];
      if (profile?.conversationAi?.optOutDetected) reasons.push("opt_out_detected");
      if (aiStatus === "stop_contact") reasons.push("ai_stop_contact");
      if (aiStatus === "pause_contact") reasons.push("ai_pause_contact");
      return [Number(profile.caseId), { suppressed, reasons }];
    }),
  );
}

function normalizeAudienceRowFromCadence(row, suppression = null) {
  return {
    caseId: String(row.caseId),
    name:
      (row.name && String(row.name).trim()) ||
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
      null,
    phone: row.primaryPhone || null,
    email: row.email || null,
    status: row.currentStage || null,
    lastSeenAt: row.updatedAt || null,
    suppressed: Boolean(suppression?.suppressed),
    suppressionReasons: suppression?.reasons || [],
  };
}

function normalizeAudienceRowFromProspect(row, suppression = null) {
  return {
    caseId: String(row.caseId),
    name:
      (row.name && String(row.name).trim()) ||
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
      null,
    phone: row.cellPhone || null,
    email: row.email || null,
    status: row.statusLabel || row.statusLabelRaw || null,
    lastSeenAt: row.updatedAt || row.lastSeenAt || null,
    suppressed: Boolean(suppression?.suppressed),
    suppressionReasons: suppression?.reasons || [],
  };
}

function normalizeAudienceRowFromCaseProfile(row, suppression = null, sourceMeta = null) {
  return {
    caseId: String(row.caseId),
    name:
      (row.name && String(row.name).trim()) ||
      [row.firstName, row.lastName].filter(Boolean).join(" ").trim() ||
      null,
    phone: row.primaryPhone || null,
    email: row.email || null,
    status: row.status || row.statusLabel || row.statusCategory || (row.statusId != null ? `Status ${row.statusId}` : null),
    lastSeenAt: row.updatedAt || row.lastSeenAt || null,
    source: sourceMeta?.intakeSource || sourceMeta?.sourceName || null,
    suppressed: Boolean(suppression?.suppressed),
    suppressionReasons: suppression?.reasons || [],
  };
}

function normalizeWords(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

function parseDate(value) {
  if (!value) return null;
  const next = new Date(value);
  return Number.isNaN(next.getTime()) ? null : next;
}

function formatDateKeyInZone(date = new Date(), timeZone = DEFAULT_AUDIENCE_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function boolFromQuery(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

async function listRecentlyCompletedOutboundCaseIds(domain, channel, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  if (!normalizedDomain || !normalizedChannel) return new Set();
  if (boolFromQuery(filters.includeRecentlyContacted, false)) return new Set();

  const timezone = filters.timezone || DEFAULT_AUDIENCE_TIMEZONE;
  const dateKey = filters.excludeCompletedDateKey || formatDateKeyInZone(new Date(), timezone);
  const { start, end } = buildTimezoneDateWindow(dateKey, timezone);
  const rows = await WorkflowRecord.find({
    domain: normalizedDomain,
    family: "outbound",
    subtype: `${normalizedChannel}-lead`,
    stage: { $in: ["completed", "skipped"] },
    caseId: { $ne: null },
    createdAt: { $gte: start, $lte: end },
  })
    .select("caseId")
    .lean();

  return new Set(
    rows
      .map((row) => Number(row.caseId))
      .filter(Number.isFinite),
  );
}

function dateWithinDays(value, days, now = new Date()) {
  const date = parseDate(value);
  if (!date) return false;
  return now.getTime() - date.getTime() <= days * 24 * 60 * 60 * 1000;
}

function isStatusRefreshStale(profile, now = new Date()) {
  const checkedAt = parseDate(profile?.lastStatusCheckAt || profile?.updatedAt);
  if (!checkedAt) return true;
  return now.getTime() - checkedAt.getTime() > CASE_PROFILE_STATUS_STALE_MS;
}

async function refreshCaseProfilesForAudience(domain, rows = [], existingProfiles = []) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const now = new Date();
  const profilesByCaseId = new Map(
    existingProfiles.map((profile) => [Number(profile.caseId), profile]),
  );
  const staleCaseIds = rows
    .map((row) => Number(row.caseId))
    .filter(Number.isFinite)
    .filter((caseId) => isStatusRefreshStale(profilesByCaseId.get(caseId), now));

  if (staleCaseIds.length === 0) {
    return {
      profilesByCaseId,
      refreshedCount: 0,
      failedCount: 0,
    };
  }

  const facade = createLogicsFacade(normalizedDomain);
  let refreshedCount = 0;
  let failedCount = 0;

  for (const caseId of staleCaseIds) {
    try {
      const fresh = await facade.fetchCaseInfo(caseId);
      if (!fresh?.ok) {
        failedCount += 1;
        continue;
      }

      const updatedProfile = await caseProfileRepository.upsertCaseProfile(
        normalizedDomain,
        caseId,
        {
          statusId: fresh.data?.StatusID ?? fresh.data?.Status ?? null,
          firstName: fresh.data?.FirstName || undefined,
          lastName: fresh.data?.LastName || undefined,
          name:
            `${fresh.data?.FirstName || ""} ${fresh.data?.LastName || ""}`.trim() ||
            undefined,
          email: fresh.data?.Email || undefined,
          primaryPhone:
            fresh.data?.CellPhone ||
            fresh.data?.HomePhone ||
            fresh.data?.WorkPhone ||
            undefined,
          lastStatusCheckAt: new Date(),
        },
      );
      profilesByCaseId.set(caseId, updatedProfile);
      refreshedCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  return {
    profilesByCaseId,
    refreshedCount,
    failedCount,
  };
}

function isClientSkipStatus(row) {
  const haystack = `${normalizeWords(row.status)} ${normalizeWords(row.currentStage)}`;
  if (!haystack.trim()) return false;
  return (
    haystack.includes("tier 5") ||
    haystack.includes("bad inactive") ||
    haystack.includes("inactive") ||
    haystack.includes("changed mind") ||
    haystack.includes("default payment")
  );
}

function getClientExclusionReasons(row, now = new Date()) {
  const reasons = [];
  if (isClientSkipStatus(row)) reasons.push("client_skip_status");
  if (Number(row.totalPayment || 0) > 50000) reasons.push("high_total_payment");
  if (dateWithinDays(row.lastInvoiceDate, 90, now)) reasons.push("recent_invoice_90d");
  return reasons;
}

function isTrustedProspectOptIn(row) {
  const sourceBucket = inferSourceBucket(row.metadata?.intakeSource, row.sourceId);
  const intakeSource = normalizeWords(row.metadata?.intakeSource);
  return (
    sourceBucket === "ld" ||
    intakeSource.includes("affiliate") ||
    intakeSource.includes("landing") ||
    intakeSource.includes("vf") ||
    intakeSource.includes("organic")
  );
}

function isBadInactiveProspect(row) {
  const haystack = `${normalizeWords(row.statusLabel)} ${normalizeWords(row.statusLabelRaw)}`;
  return haystack.includes("bad inactive");
}

function normalizeSourceFocus(value) {
  const next = String(value || "").trim().toLowerCase();
  if (!next || next === "all") return null;
  if (next === "ld" || next === "lead-data" || next === "lead data") return "ld";
  if (next === "mail" || next === "direct-mail" || next === "direct mail") return "mail";
  return next;
}

function inferSourceBucket(...values) {
  const haystack = values
    .flat()
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase())
    .join(" ");

  if (!haystack) return null;
  if (haystack.includes("lead data") || haystack.includes("ld-") || /\bld\b/.test(haystack)) return "ld";
  if (haystack.includes("mail")) return "mail";
  return "other";
}

function matchesSourceFocus(focus, ...values) {
  const normalized = normalizeSourceFocus(focus);
  if (!normalized) return true;
  return inferSourceBucket(...values) === normalized;
}

function buildCaseProfileSearchQuery(search) {
  const value = String(search || "").trim();
  if (!value) return null;

  const regex = buildRegex(value);
  const digits = value.replace(/\D/g, "");
  const clauses = [
    { name: regex },
    { firstName: regex },
    { lastName: regex },
    { email: regex },
    { primaryPhone: regex },
  ];

  if (digits) {
    clauses.push({ normalizedPhones: digits });
    clauses.push({ caseId: Number(digits) });
  }

  return { $or: clauses };
}

function isProspectLikeCaseProfile(profile = {}) {
  const paymentsCount = Number(profile.paymentsCount || 0);
  const totalPaid = Number(profile.totalPaid || 0);
  const initialPayment = Number(profile.initialPayment || 0);
  return (
    paymentsCount <= 0 &&
    totalPaid <= 0 &&
    initialPayment <= 0 &&
    !profile.convertedAt
  );
}

async function fetchProspectMetadataByCaseIds(domain, caseIds = []) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const normalizedIds = caseIds.map((value) => Number(value)).filter(Number.isFinite);
  if (normalizedIds.length === 0) return new Map();

  const rows = await MasterProspectIndex.find({
    domain: normalizedDomain,
    caseId: { $in: normalizedIds },
  })
    .select({
      caseId: 1,
      sourceId: 1,
      metadata: 1,
      statusLabel: 1,
      statusLabelRaw: 1,
      updatedAt: 1,
      lastSeenAt: 1,
      email: 1,
      cellPhone: 1,
      name: 1,
      firstName: 1,
      lastName: 1,
    })
    .lean();

  return new Map(rows.map((row) => [Number(row.caseId), row]));
}

async function buildSupplementalCaseProfileProspects(domain, filters = {}, excludeCaseIds = new Set()) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const channel = String(filters.channel || "any").toLowerCase();
  const sourceFocus = normalizeSourceFocus(filters.sourceFocus);
  const maxCaseIds = Math.min(Number(filters.maxSize) || 5000, 20000);

  const query = {
    domain: normalizedDomain,
    $or: [
      { paymentsCount: { $lte: 0 } },
      { paymentsCount: { $exists: false } },
    ],
    $and: [
      {
        $or: [
          { totalPaid: { $lte: 0 } },
          { totalPaid: { $exists: false } },
        ],
      },
      {
        $or: [
          { initialPayment: { $lte: 0 } },
          { initialPayment: { $exists: false } },
        ],
      },
      {
        $or: [
          { convertedAt: null },
          { convertedAt: { $exists: false } },
        ],
      },
    ],
  };

  if (channel === "email") {
    query.email = { $exists: true, $nin: [null, ""] };
  } else if (channel === "sms" || channel === "rvm" || channel === "callfire") {
    query.primaryPhone = { $exists: true, $nin: [null, ""] };
  } else {
    query.$and.push({
      $or: [
        { primaryPhone: { $exists: true, $nin: [null, ""] } },
        { email: { $exists: true, $nin: [null, ""] } },
      ],
    });
  }

  if (filters.search) {
    query.$and.push(buildCaseProfileSearchQuery(filters.search));
  }

  const rows = await CaseProfile.find(query)
    .select({
      caseId: 1,
      firstName: 1,
      lastName: 1,
      name: 1,
      email: 1,
      primaryPhone: 1,
      normalizedPhones: 1,
      statusId: 1,
      statusCategory: 1,
      convertedAt: 1,
      paymentsCount: 1,
      totalPaid: 1,
      initialPayment: 1,
      updatedAt: 1,
      lastStatusCheckAt: 1,
      aiActivityReview: 1,
      conversationAi: 1,
    })
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(maxCaseIds * 3)
    .lean();

  const filteredRows = rows
    .filter((row) => !excludeCaseIds.has(Number(row.caseId)))
    .filter(isProspectLikeCaseProfile);

  const prospectMetaByCaseId = await fetchProspectMetadataByCaseIds(
    normalizedDomain,
    filteredRows.map((row) => row.caseId),
  );

  const existingProfiles = filteredRows;
  const refreshed = await refreshCaseProfilesForAudience(
    normalizedDomain,
    filteredRows,
    existingProfiles,
  );
  const suppressionMap = buildSuppressionMap(
    Array.from(refreshed.profilesByCaseId.values()),
  );

  const caseIds = [];
  const sample = [];
  let excludedCount = 0;
  const exclusionReasons = {};
  let pendingValidationCount = 0;
  let eligibleMatchedCount = 0;

  for (const row of filteredRows) {
    const sourceMeta = prospectMetaByCaseId.get(Number(row.caseId));
    if (!matchesSourceFocus(sourceFocus, sourceMeta?.metadata?.intakeSource, sourceMeta?.sourceId)) {
      continue;
    }
    eligibleMatchedCount += 1;

    const suppression = suppressionMap.get(Number(row.caseId)) || { suppressed: false, reasons: [] };
    const reasons = [...suppression.reasons];
    const prospectMeta = sourceMeta || {};
    if (suppression.suppressed) reasons.push("suppressed");
    const requiresValidation =
      !isTrustedProspectOptIn({
        sourceId: prospectMeta.sourceId,
        metadata: prospectMeta.metadata,
      }) &&
      !prospectMeta.metadata?.validation;
    if (requiresValidation) pendingValidationCount += 1;
    if (reasons.length) {
      excludedCount += 1;
      reasons.forEach((reason) => {
        exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
      });
      continue;
    }

    caseIds.push(Number(row.caseId));
    if (sample.length < 25) {
      sample.push(
        normalizeAudienceRowFromCaseProfile(
          {
            ...row,
            status:
              prospectMeta.statusLabel ||
              prospectMeta.statusLabelRaw ||
              "prospect",
          },
          suppression,
          prospectMeta.metadata || null,
        ),
      );
    }
  }

  return {
    rows: filteredRows,
    caseIds,
    sample,
    excludedCount,
    diagnostics: {
      source: "case-profiles-prospects",
      matchedCount: eligibleMatchedCount,
      exclusionReasons,
      pendingValidationCount,
      statusRefresh: {
        refreshedCount: refreshed.refreshedCount,
        failedCount: refreshed.failedCount,
      },
    },
  };
}

async function buildLeadCadenceAudience(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const channel = String(filters.channel || "callfire").toLowerCase();
  const effectiveStatusId =
    normalizedDomain === "WYNN" && channel === "callfire"
      ? 2
      : filters.statusId != null
        ? Number(filters.statusId)
        : null;
  const maxCaseIds = Math.min(Number(filters.maxSize) || 5000, 20000);
  const config = getSharedConfig();
  const dncStatusSet = new Set(config.logicsDncStatusIds.map((value) => Number(value)));

  // Logics live-status intersection used to be applied for
  // WYNN+callfire — the cadence row's caseId had to exist in the
  // current `GetCasesByStatus(2)` result before we'd dial it. That
  // makes sense if your audience starts from Logics and you're
  // re-confirming; but our audience starts from lead cadence, which
  // already gates on `active: true` and is the source of truth for
  // this dialer flow. Intersecting just narrows the audience for no
  // gain (and produced the "1 recipient" surprise when the legacy
  // collection's `statusId` field is null on every row).
  //
  // Default = bypass. Pass `bypassLogicsStatusGate: false` if a
  // future caller wants the legacy intersection back.
  const bypassLogicsStatusGate = filters.bypassLogicsStatusGate !== false;
  const shouldIntersectLogicsStatus =
    !bypassLogicsStatusGate &&
    normalizedDomain === "WYNN" &&
    channel === "callfire" &&
    Number.isFinite(effectiveStatusId);

  let statusCaseIds = null;
  let liveStatusError = null;
  if (shouldIntersectLogicsStatus) {
    try {
      const facade = createLogicsFacade(normalizedDomain);
      statusCaseIds = await facade.getCasesByStatus(effectiveStatusId, {
        limit: maxCaseIds,
      });
    } catch (error) {
      statusCaseIds = null;
      liveStatusError = error?.message || "Unable to refresh live Logics status set";
    }
  }

  // Date-range scoping (createdAt) is plumbed into both branches as
  // optional filters. Both repos coerce date-only strings to PT day
  // bounds — see coerceDateBoundary — so the UI can pass YYYY-MM-DD
  // straight through without timezone bookkeeping.
  const cadenceFilters = {
    active: true,
    search: filters.search,
    limit: maxCaseIds,
    createdAtAfter: filters.createdAtAfter || null,
    createdAtBefore: filters.createdAtBefore || null,
  };

  const rows = await leadCadenceRepository.listLeadCadence(normalizedDomain, cadenceFilters);

  const usedLiveStatusIntersection = Array.isArray(statusCaseIds);
  const allowedCaseIds = usedLiveStatusIntersection
    ? new Set(statusCaseIds.map((value) => Number(value)))
    : null;
  const legacyCadenceCount = rows.length;
  const liveStatusCount = Array.isArray(statusCaseIds) ? statusCaseIds.length : null;

  const scopedRows = rows.filter((row) => {
    // When the Logics gate is bypassed (default), trust cadence's own
    // `active: true` flag (already applied at the listing level) and
    // any caller-provided filters (search, createdAt range). The
    // `row.statusId === effectiveStatusId` row-level fallback would
    // exclude every WYNN row since that field is null on legacy docs.
    if (bypassLogicsStatusGate) return true;
    if (allowedCaseIds) return allowedCaseIds.has(Number(row.caseId));
    if (Number.isFinite(effectiveStatusId)) return Number(row.statusId) === effectiveStatusId;
    return true;
  });

  const reachable = scopedRows.filter((row) => {
    if (channel === "email") return Boolean(row.email);
    if (channel === "sms" || channel === "rvm" || channel === "callfire") return Boolean(row.primaryPhone);
    return Boolean(row.primaryPhone || row.email);
  });
  const alreadyCompletedCaseIds = channel === "callfire"
    ? await listRecentlyCompletedOutboundCaseIds(normalizedDomain, channel, filters)
    : new Set();
  const reachableAfterRecentCompletionExclusion = reachable.filter(
    (row) => !alreadyCompletedCaseIds.has(Number(row.caseId)),
  );

  const caseProfiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    normalizedDomain,
    reachableAfterRecentCompletionExclusion.map((row) => row.caseId),
  );
  const suppressionMap = buildSuppressionMap(caseProfiles);

  const sample = [];
  const caseIds = [];
  let excludedCount = 0;

  for (const row of reachableAfterRecentCompletionExclusion) {
    const suppression = suppressionMap.get(Number(row.caseId)) || { suppressed: false, reasons: [] };
    const dncSuppressed = dncStatusSet.has(Number(row.statusId));
    const finalSuppression = {
      suppressed: suppression.suppressed || dncSuppressed,
      reasons: [
        ...suppression.reasons,
        ...(dncSuppressed ? ["dnc_status"] : []),
      ],
    };
    if (finalSuppression.suppressed) {
      excludedCount += 1;
      continue;
    }
    caseIds.push(Number(row.caseId));
    if (sample.length < 25) {
      sample.push(normalizeAudienceRowFromCadence(row, finalSuppression));
    }
  }

  return {
    domain: normalizedDomain,
    channel,
    audienceSource: "lead-cadence",
    statusId: effectiveStatusId,
    matchedBy: bypassLogicsStatusGate
      ? "lead-cadence-active-flag"
      : usedLiveStatusIntersection
        ? "logics-status-intersection"
        : "lead-cadence-status",
    total: reachableAfterRecentCompletionExclusion.length,
    returned: caseIds.length,
    truncated: reachableAfterRecentCompletionExclusion.length > caseIds.length,
    excludedCount,
    caseIds,
    sample,
    diagnostics: {
      source: "control-plane-leadcadence",
      legacyCadenceCount,
      liveStatusCount,
      intersectedCount: scopedRows.length,
      reachableCount: reachable.length,
      reachableAfterRecentCompletionExclusion: reachableAfterRecentCompletionExclusion.length,
      recentCompletionExcludedCount: alreadyCompletedCaseIds.size,
      recentHandledExcludedCount: alreadyCompletedCaseIds.size,
      persistedCandidateCount: caseIds.length,
      liveStatusError,
      logicsStatusGate: bypassLogicsStatusGate ? "bypassed" : "applied",
      // Echo the date-range bounds the caller passed (if any) so log
      // consumers can correlate the funnel with the operator's UI inputs
      // without having to thread the original request body alongside.
      createdAtAfter: filters.createdAtAfter || null,
      createdAtBefore: filters.createdAtBefore || null,
    },
  };
}

async function buildMasterProspectAudience(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const statusId = filters.statusId != null ? Number(filters.statusId) : 2;
  const channel = String(filters.channel || "any").toLowerCase();

  const sourceFocus = normalizeSourceFocus(filters.sourceFocus);
  const query = {
    domain: normalizedDomain,
    statusId,
  };

  if (channel === "email") {
    query.email = { $exists: true, $nin: [null, ""] };
  } else if (channel === "sms" || channel === "rvm" || channel === "callfire") {
    query.cellPhone = { $exists: true, $nin: [null, ""] };
  } else if (channel === "any") {
    query.$or = [
      { cellPhone: { $exists: true, $nin: [null, ""] } },
      { email: { $exists: true, $nin: [null, ""] } },
    ];
  }

  if (filters.search) {
    const pattern = buildRegex(filters.search);
    query.$and = [
      ...(query.$and || []),
      {
        $or: [
          { name: pattern },
          { firstName: pattern },
          { lastName: pattern },
          { cellPhone: pattern },
          { email: pattern },
        ],
      },
    ];
  }

  const maxCaseIds = Math.min(Number(filters.maxSize) || 5000, 20000);
  const rows = await MasterProspectIndex.find(query)
      .select({
        caseId: 1,
        name: 1,
        firstName: 1,
        lastName: 1,
        cellPhone: 1,
        email: 1,
        statusLabel: 1,
        statusLabelRaw: 1,
        updatedAt: 1,
        lastSeenAt: 1,
        sourceId: 1,
        metadata: 1,
      })
      .sort({ updatedAt: -1, caseId: -1 })
      .limit(maxCaseIds * 2)
      .lean();

  const scopedRows = rows.filter((row) =>
    matchesSourceFocus(sourceFocus, row.metadata?.intakeSource, row.sourceId),
  ).slice(0, maxCaseIds);

  const caseProfiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    normalizedDomain,
    scopedRows.map((row) => row.caseId),
  );
  const suppressionMap = buildSuppressionMap(caseProfiles);

  const caseIds = [];
  const sample = [];
  let excludedCount = 0;
  const exclusionReasons = {};
  let pendingValidationCount = 0;

  for (const row of scopedRows) {
    const suppression = suppressionMap.get(Number(row.caseId)) || { suppressed: false, reasons: [] };
    const reasons = [...suppression.reasons];
    if (suppression.suppressed) {
      reasons.push("suppressed");
    }
    if (isBadInactiveProspect(row)) {
      reasons.push("bad_inactive");
    }
    if (!isTrustedProspectOptIn(row) && !row.metadata?.validation) {
      pendingValidationCount += 1;
    }
    if (reasons.length) {
      excludedCount += 1;
      reasons.forEach((reason) => {
        exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
      });
      continue;
    }
    caseIds.push(Number(row.caseId));
    if (sample.length < 25) {
      sample.push(normalizeAudienceRowFromProspect(row, suppression));
    }
  }

  const supplemental = await buildSupplementalCaseProfileProspects(
    normalizedDomain,
    filters,
    new Set(caseIds),
  );

  const mergedCaseIds = [...caseIds, ...supplemental.caseIds];
  const mergedSample = [...sample, ...supplemental.sample].slice(0, 25);
  const mergedExcludedCount = excludedCount + supplemental.excludedCount;
  const mergedExclusionReasons = { ...exclusionReasons };
  Object.entries(supplemental.diagnostics.exclusionReasons || {}).forEach(([reason, count]) => {
    mergedExclusionReasons[reason] = (mergedExclusionReasons[reason] || 0) + Number(count || 0);
  });
  const mergedPendingValidationCount =
    pendingValidationCount + Number(supplemental.diagnostics.pendingValidationCount || 0);

  return {
    domain: normalizedDomain,
    channel,
    audienceSource: "prospect-index",
    statusId,
    total: scopedRows.length + supplemental.diagnostics.matchedCount,
    returned: mergedCaseIds.length,
    truncated:
      rows.length > scopedRows.length ||
      scopedRows.length > caseIds.length ||
      mergedCaseIds.length < scopedRows.length + supplemental.diagnostics.matchedCount,
    excludedCount: mergedExcludedCount,
    caseIds: mergedCaseIds,
    sample: mergedSample,
    diagnostics: {
      source: "prospect-index+case-profiles",
      sourceFocus: sourceFocus || "all",
      matchedCount: scopedRows.length + supplemental.diagnostics.matchedCount,
      prospectIndexMatchedCount: scopedRows.length,
      caseProfileMatchedCount: supplemental.diagnostics.matchedCount,
      exclusionReasons: mergedExclusionReasons,
      pendingValidationCount: mergedPendingValidationCount,
      caseProfileStatusRefresh: supplemental.diagnostics.statusRefresh,
    },
  };
}

async function buildCaseProfileAudience(domain, filters = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const channel = String(filters.channel || "any").toLowerCase();
  const maxCaseIds = Math.min(Number(filters.maxSize) || 5000, 20000);
  const sourceFocus = normalizeSourceFocus(filters.sourceFocus);
  const statusId = filters.statusId != null ? Number(filters.statusId) : null;

  const query = {
    domain: normalizedDomain,
    $or: [
      { paymentsCount: { $gt: 0 } },
      { totalPaid: { $gt: 0 } },
      { initialPayment: { $gt: 0 } },
      { convertedAt: { $ne: null } },
      { statusCategory: "client" },
    ],
  };
  if (statusId != null) query.statusId = statusId;
  if (filters.search) {
    query.$and = [
      ...(query.$and || []),
      buildCaseProfileSearchQuery(filters.search),
    ].filter(Boolean);
  }

  const caseProfileRows = await CaseProfile.find(query)
    .select({
      caseId: 1,
      name: 1,
      firstName: 1,
      lastName: 1,
      email: 1,
      primaryPhone: 1,
      normalizedPhones: 1,
      statusId: 1,
      statusCategory: 1,
      updatedAt: 1,
      lastStatusCheckAt: 1,
      totalPaid: 1,
      initialPayment: 1,
      paymentsCount: 1,
      lastPaymentDate: 1,
      aiActivityReview: 1,
      conversationAi: 1,
    })
    .sort({ updatedAt: -1, caseId: -1 })
    .limit(maxCaseIds * 2)
    .lean();

  const reachableRows = caseProfileRows.filter((row) => {
    if (channel === "email") return Boolean(row.email);
    if (channel === "sms" || channel === "rvm" || channel === "callfire") return Boolean(row.primaryPhone);
    return Boolean(row.primaryPhone || row.email);
  });

  const prospectRows = await MasterProspectIndex.find({
    domain: normalizedDomain,
    caseId: { $in: reachableRows.map((row) => Number(row.caseId)) },
  })
    .select({
      caseId: 1,
      sourceId: 1,
      metadata: 1,
    })
    .lean();
  const prospectByCaseId = new Map(prospectRows.map((row) => [Number(row.caseId), row]));
  const existingCaseProfiles = await caseProfileRepository.listCaseProfilesByCaseIds(
    normalizedDomain,
    reachableRows.map((row) => row.caseId),
  );
  const refreshed = await refreshCaseProfilesForAudience(
    normalizedDomain,
    reachableRows,
    existingCaseProfiles,
  );
  const suppressionMap = buildSuppressionMap(
    Array.from(refreshed.profilesByCaseId.values()),
  );

  const scopedRows = reachableRows.filter((row) => {
    const sourceMeta = prospectByCaseId.get(Number(row.caseId));
    return matchesSourceFocus(sourceFocus, sourceMeta?.metadata?.intakeSource, sourceMeta?.sourceId);
  }).slice(0, maxCaseIds);

  const caseIds = [];
  const sample = [];
  let excludedCount = 0;
  const exclusionReasons = {};
  const now = new Date();

  for (const row of scopedRows) {
    const suppression = suppressionMap.get(Number(row.caseId)) || { suppressed: false, reasons: [] };
    const reasons = [...suppression.reasons, ...getClientExclusionReasons(row, now)];
    if (reasons.length) {
      excludedCount += 1;
      reasons.forEach((reason) => {
        exclusionReasons[reason] = (exclusionReasons[reason] || 0) + 1;
      });
      continue;
    }
    caseIds.push(Number(row.caseId));
    if (sample.length < 25) {
      sample.push(
        normalizeAudienceRowFromCaseProfile(
          row,
          suppression,
          prospectByCaseId.get(Number(row.caseId))?.metadata || null,
        ),
      );
    }
  }

  return {
    domain: normalizedDomain,
    channel,
    audienceSource: "case-profiles",
    statusId,
    total: scopedRows.length,
    returned: caseIds.length,
    truncated: caseProfileRows.length > scopedRows.length || scopedRows.length > caseIds.length,
    excludedCount,
    caseIds,
    sample,
    diagnostics: {
      source: "control-plane-case-profiles",
      sourceFocus: sourceFocus || "all",
      matchedCount: scopedRows.length,
      exclusionReasons,
      statusRefresh: {
        refreshedCount: refreshed.refreshedCount,
        failedCount: refreshed.failedCount,
      },
    },
  };
}

async function buildCampaignAudience(domain, filters = {}) {
  const audienceSource =
    String(filters.audienceSource || "").trim().toLowerCase() ||
    (String(filters.channel || "").toLowerCase() === "callfire" ? "lead-cadence" : "master-prospect");

  if (audienceSource === "lead-cadence") {
    return buildLeadCadenceAudience(domain, filters);
  }

  if (audienceSource === "case-profiles" || audienceSource === "clients") {
    return buildCaseProfileAudience(domain, filters);
  }

  return buildMasterProspectAudience(domain, filters);
}

module.exports = {
  buildCampaignAudience,
};
