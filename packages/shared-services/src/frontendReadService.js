"use strict";

const {
  activityAiReviewRepository,
  agentStateRepository,
  callLogRepository,
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  dailyCallStatRepository,
  deepCutRunRepository,
  dispatchListRepository,
  leadCadenceRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentAlertRepository,
  paymentLedgerRepository,
  qualityReviewRepository,
  reviewQueueRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { PORTS, getCompanyKeys, getRingCentralConfig } = require("../../shared-config/src");
const { legacyReadDb } = require("../../shared-repositories/src/legacyReadDb");
const { buildControlPlaneHealthReport, buildProviderHealth } = require("./controlPlaneHealthService");
const { buildContactLibraryCatalog } = require("./contactLibraryService");
const {
  getLatestManualDailySummaryDate,
  listManualDailySummaryRows,
  listManualMetricSourceRows,
} = require("./metricsManualOverlayService");
const {
  listRoiEligiblePayments,
  resolveRoiPaymentSourceMeta,
  summarizeRoiPaymentsBySource,
} = require("./paymentRoiService");
const { listServiceTopology } = require("./serviceCatalog");
const { listSourceCanonicals } = require("./sourceCanonicalService");
const {
  mintRecordingPlaybackUrl,
} = require("./recordingPlaybackUrlService");
const { deriveFreshLeadGate } = require("./agentAvailabilityService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function todayIsoLA(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}

function toDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

const GLOBAL_METRICS_DOMAIN = "ALL";
const METRICS_ALIAS_DOMAIN = "METRICS";
const METRICS_ALL_TIME_START = "2024-01-01";

function isGlobalMetricsDomain(domain) {
  const normalized = normalizeDomain(domain);
  return !normalized || normalized === GLOBAL_METRICS_DOMAIN || normalized === METRICS_ALIAS_DOMAIN;
}

function listMetricsDomains() {
  return [...new Set(getCompanyKeys().map((value) => normalizeDomain(value)).filter(Boolean))];
}

function resolveMetricFamilyKey(channel, source = null) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const value = `${normalizedChannel} ${normalizedSource}`;

  if (
    normalizedChannel === "mailer" ||
    normalizedChannel === "mail" ||
    value.includes("direct mail")
  ) return "mail";
  if (
    normalizedChannel === "bcd" ||
    (normalizedChannel === "vendor" && value.includes("bcd")) ||
    value.includes("bcd")
  ) return "bcd";
  if (
    normalizedChannel === "ld" ||
    normalizedChannel === "ld-posting" ||
    normalizedChannel === "affiliate" ||
    normalizedChannel === "lead-distribution" ||
    normalizedChannel === "lead-data" ||
    value.includes("lead data") ||
    value.includes("lead post") ||
    value.includes("affiliate") ||
    value.includes("digital") ||
    value.includes("a+ leads")
  ) return "ld";
  if (
    normalizedChannel === "meta" ||
    normalizedChannel === "paid-social" ||
    normalizedChannel === "paid-search" ||
    normalizedChannel === "facebook" ||
    normalizedChannel === "instagram" ||
    normalizedChannel === "tiktok" ||
    normalizedChannel === "social" ||
    value.includes("vf meta") ||
    value.includes("meta") ||
    value.includes("facebook") ||
    value.includes("fb") ||
    value.includes("instagram") ||
    value.includes("tiktok")
  ) return "meta";
  if (
    normalizedChannel === "dialer" ||
    normalizedChannel === "callfire" ||
    value.includes("dialer") ||
    value.includes("callfire") ||
    value.includes("rvm transfer")
  ) return "dialer";

  return "other";
}

const METRIC_SOURCE_ROLLUP_OVERRIDES = new Map([
  [
    "affordability federal snap",
    { source: "Affordability Federal", channel: "mailer" },
  ],
  [
    "affordability federal snpa",
    { source: "Affordability Federal", channel: "mailer" },
  ],
  [
    "affordability pink state snap",
    { source: "Affordability Pink State", channel: "mailer" },
  ],
  [
    "aged data",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "callfire",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "hand dialer",
    { source: "CallFire", channel: "dialer" },
  ],
  [
    "citation state",
    { source: "Citation State PC", channel: "mailer" },
  ],
  [
    "yellow line dialer",
    { source: "CallFire", channel: "dialer" },
  ],
]);

function toComparableNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function computeClientInternalScore(caseProfile = null, prospect = null, cadence = null) {
  let score = 0;

  if (caseProfile?.qcSummary?.score != null) {
    score += toComparableNumber(caseProfile.qcSummary.score, 0);
  }

  if (toComparableNumber(caseProfile?.paymentsCount, 0) > 0) {
    score += 20;
  }

  if (toComparableNumber(caseProfile?.totalPaid, 0) > 0) {
    score += Math.min(Math.round(toComparableNumber(caseProfile.totalPaid, 0) / 500), 25);
  }

  if (caseProfile?.conversationAi?.optOutDetected) {
    score -= 40;
  }

  const aiStatus = String(caseProfile?.aiActivityReview?.status || "").toLowerCase();
  if (aiStatus.includes("allow")) {
    score += 10;
  }
  if (aiStatus.includes("do_not_contact") || aiStatus.includes("stop")) {
    score -= 35;
  }

  if (caseProfile?.attribution?.needsReview) {
    score -= 10;
  }

  if (cadence?.active === true) {
    score += 5;
  }

  if (String(prospect?.statusCategory || "").toLowerCase() === "prospect") {
    score += 3;
  }

  return score;
}

function buildClientListRow(domain, caseId, caseProfile = null, prospect = null, cadence = null) {
  const name =
    caseProfile?.name ||
    [caseProfile?.firstName, caseProfile?.lastName].filter(Boolean).join(" ").trim() ||
    prospect?.name ||
    [prospect?.firstName, prospect?.lastName].filter(Boolean).join(" ").trim() ||
    null;

  const status =
    caseProfile?.statusLabel ||
    caseProfile?.status ||
    prospect?.statusLabelRaw ||
    prospect?.statusCategory ||
    null;

  const updatedAt =
    caseProfile?.updatedAt ||
    prospect?.updatedAt ||
    cadence?.updatedAt ||
    null;

  return {
    domain,
    caseId: Number(caseId),
    name,
    email: caseProfile?.email || prospect?.email || cadence?.email || null,
    phone:
      caseProfile?.primaryPhone ||
      prospect?.cellPhone ||
      cadence?.primaryPhone ||
      null,
    status,
    statusId: caseProfile?.statusId ?? prospect?.statusId ?? null,
    statusCategory: caseProfile?.statusCategory || prospect?.statusCategory || null,
    intakeSource:
      cadence?.intakeSource ||
      prospect?.metadata?.intakeSource ||
      null,
    intakeRoute: cadence?.intakeRoute || null,
    activeCadence: cadence?.active === true,
    totalPaid: toComparableNumber(caseProfile?.totalPaid, 0),
    paymentsCount: toComparableNumber(caseProfile?.paymentsCount, 0),
    qcScore: caseProfile?.qcSummary?.score ?? null,
    aiStatus: caseProfile?.aiActivityReview?.status || null,
    optOutDetected: Boolean(caseProfile?.conversationAi?.optOutDetected),
    attributionNeedsReview: Boolean(caseProfile?.attribution?.needsReview),
    sourceCanonicalId:
      caseProfile?.sourceCanonicalId != null ? String(caseProfile.sourceCanonicalId) : null,
    attribution: caseProfile?.attribution || null,
    scrubStatus: caseProfile?.scrubSummary?.status || null,
    lastScrubbedAt: caseProfile?.scrubSummary?.reviewedAt || null,
    internalScore: computeClientInternalScore(caseProfile, prospect, cadence),
    updatedAt,
  };
}

function compareClientRows(sortBy = "updated", sortDir = "desc") {
  const direction = String(sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;

  return (left, right) => {
    if (sortBy === "score") {
      return (left.internalScore - right.internalScore) * direction;
    }
    if (sortBy === "status") {
      const a = String(left.status || "");
      const b = String(right.status || "");
      return a.localeCompare(b) * direction;
    }
    if (sortBy === "payments") {
      return (toComparableNumber(left.totalPaid) - toComparableNumber(right.totalPaid)) * direction;
    }
    if (sortBy === "name") {
      return String(left.name || "").localeCompare(String(right.name || "")) * direction;
    }

    const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
    const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
    return (leftTime - rightTime) * direction;
  };
}

function computeRingCentralDiagnostics(agents = []) {
  const config = getRingCentralConfig();
  const staleThresholdMs = Math.max(Number(config.presenceStaleThresholdMs) || 120000, 30000);
  const now = Date.now();

  const staleAgents = [];
  const activeCalls = [];
  const recentMissedCalls = [];

  for (const agent of agents) {
    const lastEventReceivedAt = agent.lastEventReceived ? new Date(agent.lastEventReceived).getTime() : 0;
    const isStale = !lastEventReceivedAt || (now - lastEventReceivedAt) > staleThresholdMs;
    if (isStale) {
      staleAgents.push({
        extensionId: agent.extensionId,
        name: agent.name,
        status: agent.status,
        lastEventReceived: agent.lastEventReceived || null,
      });
    }

    if (agent.currentCall?.telephonySessionId || agent.currentCall?.sessionId) {
      activeCalls.push({
        extensionId: agent.extensionId,
        name: agent.name,
        status: agent.status,
        currentCall: agent.currentCall,
      });
    }

    if (agent.lastMissedCallAt) {
      recentMissedCalls.push({
        extensionId: agent.extensionId,
        name: agent.name,
        lastMissedCallAt: agent.lastMissedCallAt,
        lastMissedCallFrom: agent.lastMissedCallFrom || null,
        lastMissedCallTo: agent.lastMissedCallTo || null,
      });
    }
  }

  recentMissedCalls.sort((left, right) => new Date(right.lastMissedCallAt).getTime() - new Date(left.lastMissedCallAt).getTime());

  return {
    staleThresholdMs,
    staleAgentCount: staleAgents.length,
    activeCallCount: activeCalls.length,
    recentMissedCallCount: recentMissedCalls.length,
    staleAgents: staleAgents.slice(0, 10),
    activeCalls: activeCalls.slice(0, 10),
    recentMissedCalls: recentMissedCalls.slice(0, 10),
  };
}

async function buildReviewWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    openCount,
    reviewedCount,
    warningCount,
    criticalCount,
    recentOpenItems,
    recentDailyRuns,
  ] = await Promise.all([
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "reviewed" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "warning" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "critical" }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { status: "open", limit: 15 }),
    deepCutRunRepository.listDeepCutRuns(normalizedDomain, { limit: 10 }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      open: openCount,
      reviewed: reviewedCount,
      warning: warningCount,
      critical: criticalCount,
    },
    recentOpenItems,
    recentDailyRuns,
  };
}

async function listReviewWorkspaceItems(domain, filters = {}) {
  return reviewQueueRepository.listReviewQueueItems(normalizeDomain(domain), filters);
}

async function buildInboxWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    openCount,
    draftedCount,
    reviewCount,
    optOutCount,
    workflows,
    recentReviewItems,
    recentWorkflowStages,
  ] = await Promise.all([
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "observed" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "drafted" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { status: "manual-review" }),
    conversationWorkflowRepository.countConversationWorkflows(normalizedDomain, { optOutDetected: true }),
    conversationWorkflowRepository.listConversationWorkflows(normalizedDomain, {
      status: filters.status,
      channel: filters.channel,
      search: filters.search,
      limit: filters.limit,
      // includeAutoResponded: legacy flag — let auto-handled threads
      //   (dnc_confirm / callback_prompt) appear in the list.
      // includeOptedOut:     show opted-out threads in the live view.
      // includeTerminated:   show suppressed/closed threads in the
      //   live view (audit / "all" tab).
      includeAutoResponded: Boolean(filters.includeAutoResponded),
      includeOptedOut: Boolean(filters.includeOptedOut),
      includeTerminated: Boolean(filters.includeTerminated),
      optOutDetected: filters.optOutDetected,
    }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      workflow: filters.workflow || "conversation-ai",
      limit: 20,
    }),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      family: filters.family || "conversation",
      limit: 20,
    }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      observed: openCount,
      drafted: draftedCount,
      manualReview: reviewCount,
      optOutDetected: optOutCount,
    },
    workflows,
    recentReviewItems,
    recentWorkflowStages,
  };
}

async function buildClientDetail(domain, caseId, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  const viewer = options.viewer || null;

  const [
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    recentWorkflowStages,
  ] = await Promise.all([
    masterProspectRepository.findMasterProspect(normalizedDomain, numericCaseId),
    caseProfileRepository.findCaseProfile(normalizedDomain, numericCaseId),
    leadCadenceRepository.findLeadCadence(normalizedDomain, numericCaseId),
    paymentLedgerRepository.listPaymentsForCase(normalizedDomain, numericCaseId),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { caseId: numericCaseId, limit: 50 }),
    activityAiReviewRepository.findLatestActivityAiReview(normalizedDomain, numericCaseId),
    qualityReviewRepository.findLatestQualityReview(normalizedDomain, numericCaseId),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      caseId: numericCaseId,
      limit: 20,
    }),
  ]);

  const primaryPhone = caseProfile?.primaryPhone || prospect?.cellPhone || prospect?.homePhone || prospect?.workPhone || null;
  const [latestConversationWorkflow, calls, textChain] = await Promise.all([
    primaryPhone
      ? conversationWorkflowRepository.findConversationWorkflow(normalizedDomain, primaryPhone)
      : Promise.resolve(null),
    // Case-scoped call history — CallLog rows linked via caseId, with
    // transcription.recordingUri for inline audio playback in the UI.
    callLogRepository.listCallLogsByCaseId(normalizedDomain, numericCaseId, {
      limit: 25,
    }),
    // Text chain for the case's primary phone. ConversationMessage
    // rows are keyed on phone, not caseId, so we look up by phone.
    // Returns newest-first; UI can reverse for chronological display.
    primaryPhone
      ? conversationMessageRepository.listRecentMessagesForPhone(
          normalizedDomain,
          primaryPhone,
          { limit: 50 },
        )
      : Promise.resolve([]),
  ]);

  // Rewrite each call's `transcription.recordingUri` to a Parallel-
  // signed proxy URL when it points at RC media. The audio element
  // can't add Authorization headers — so we mint a sig'd URL the
  // browser can fetch as-is. Drive URLs pass through unchanged
  // (Apps Script owns Drive URL minting). When `viewer` isn't
  // available (no auth context), the helper passes raw — broken
  // playback is still visibly broken in dev / curl flows rather
  // than silently rewritten with no viewer to verify against.
  const callsWithSignedUrls = (calls || []).map((call) => {
    const recordingUri = call?.transcription?.recordingUri;
    if (!recordingUri || !viewer) return call;
    return {
      ...call,
      transcription: {
        ...(call.transcription || {}),
        recordingUri: mintRecordingPlaybackUrl(recordingUri, { viewer }),
      },
    };
  });

  return {
    domain: normalizedDomain,
    caseId: numericCaseId,
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    latestConversationWorkflow,
    recentWorkflowStages,
    calls: callsWithSignedUrls,
    textChain,
    scrubSummary: caseProfile?.scrubSummary || null,
    availableSources: await listActiveSourceCanonicals(normalizedDomain),
  };
}

async function buildClientWorkspaceList(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const limit = Math.min(Number(filters.limit) || 50, 200);
  const statusCategoryFilter = String(filters.statusCategory || "").trim().toLowerCase();
  const includeProspects = !statusCategoryFilter || statusCategoryFilter === "prospect";
  const includeCaseProfiles = !statusCategoryFilter || statusCategoryFilter !== "prospect";

  const [prospects, caseProfiles] = await Promise.all([
    includeProspects
      ? masterProspectRepository.listMasterProspects(normalizedDomain, {
          search: filters.search,
          statusCategory: statusCategoryFilter === "prospect" ? "prospect" : undefined,
          limit,
        })
      : Promise.resolve([]),
    includeCaseProfiles
      ? caseProfileRepository.listCaseProfiles(normalizedDomain, {
          search: filters.search,
          statusCategory: statusCategoryFilter || undefined,
          hasPayments:
            filters.hasPayments === "true"
              ? true
              : filters.hasPayments === "false"
                ? false
                : undefined,
          aiStatus: filters.aiStatus,
          limit,
        })
      : Promise.resolve([]),
  ]);

  const caseIds = [
    ...new Set(
      [...prospects, ...caseProfiles]
        .map((entry) => Number(entry.caseId))
        .filter(Number.isFinite),
    ),
  ];

  const cadenceRows = await leadCadenceRepository.listLeadCadenceByCaseIds(normalizedDomain, caseIds);
  const cadenceByCaseId = new Map(cadenceRows.map((row) => [Number(row.caseId), row]));

  const merged = new Map();

  for (const prospect of prospects) {
    const id = Number(prospect.caseId);
    merged.set(id, {
      prospect,
      caseProfile: null,
      cadence: cadenceByCaseId.get(id) || null,
    });
  }

  for (const caseProfile of caseProfiles) {
    const id = Number(caseProfile.caseId);
    const current = merged.get(id) || {
      prospect: null,
      caseProfile: null,
      cadence: cadenceByCaseId.get(id) || null,
    };
    current.caseProfile = caseProfile;
    merged.set(id, current);
  }

  let rows = [...merged.entries()].map(([caseIdValue, entry]) =>
    buildClientListRow(
      normalizedDomain,
      caseIdValue,
      entry.caseProfile,
      entry.prospect,
      entry.cadence,
    ),
  );

  if (filters.status) {
    const statusNeedle = String(filters.status).trim().toLowerCase();
    rows = rows.filter((row) => String(row.status || "").toLowerCase().includes(statusNeedle));
  }

  if (filters.activeCadence === "true") {
    rows = rows.filter((row) => row.activeCadence);
  } else if (filters.activeCadence === "false") {
    rows = rows.filter((row) => !row.activeCadence);
  }

  rows.sort(compareClientRows(filters.sortBy, filters.sortDir));

  return {
    domain: normalizedDomain,
    total: rows.length,
    items: rows.slice(0, limit),
    filters: {
      search: filters.search || "",
      status: filters.status || null,
      statusCategory: filters.statusCategory || null,
      sortBy: filters.sortBy || "updated",
      sortDir: filters.sortDir || "desc",
      activeCadence: filters.activeCadence || null,
    },
  };
}

async function searchClientWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const search = String(filters.search || "").trim();
  const limit = Math.min(Number(filters.limit) || 25, 100);
  const scope = String(filters.scope || "all").trim().toLowerCase();

  const [prospects, caseProfiles] = await Promise.all([
    scope === "clients"
      ? Promise.resolve([])
      : masterProspectRepository.listMasterProspects(normalizedDomain, { search, limit }),
    scope === "prospects"
      ? Promise.resolve([])
      : caseProfileRepository.listCaseProfiles(normalizedDomain, { search, limit }),
  ]);

  const prospectsByCaseId = new Map(
    prospects
      .map((prospect) => [Number(prospect.caseId), prospect])
      .filter(([caseId]) => Number.isFinite(caseId)),
  );
  const byCaseId = new Map();
  for (const prospect of prospects) {
    const caseId = Number(prospect.caseId);
    if (!Number.isFinite(caseId)) continue;
    byCaseId.set(caseId, buildClientListRow(normalizedDomain, caseId, null, prospect, null));
  }
  for (const caseProfile of caseProfiles) {
    const caseId = Number(caseProfile.caseId);
    if (!Number.isFinite(caseId)) continue;
    const current = byCaseId.get(caseId);
    byCaseId.set(
      caseId,
      buildClientListRow(
        normalizedDomain,
        caseId,
        caseProfile,
        prospectsByCaseId.get(caseId) || null,
        null,
      ),
    );
  }

  return {
    domain: normalizedDomain,
    search,
    scope,
    prospects,
    caseProfiles,
    merged: [...byCaseId.values()].sort(compareClientRows("updated", "desc")).slice(0, limit),
  };
}

async function buildRingCentralWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const rawAgents = await agentStateRepository.listAgentStates({ company: normalizedDomain });
  const agents = rawAgents.map((agent) => ({
    ...agent,
    presence: agent.exPresenceStatus || agent.status || null,
    telephonyStatus: agent.exTelephonyStatus || "NoCall",
    lastUpdate:
      agent.lastStatusChange
      || agent.lastPresencePollAt
      || agent.lastEventReceived
      || agent.updatedAt
      || null,
    callsToday: Number(agent.dailyStats?.totalCalls || 0),
    freshLeadGate: deriveFreshLeadGate(agent, agent.cxRouting || null),
  }));
  const diagnostics = computeRingCentralDiagnostics(agents);

  const summary = agents.reduce((accumulator, agent) => {
    accumulator.total += 1;
    accumulator.byStatus[agent.status] = (accumulator.byStatus[agent.status] || 0) + 1;
    if (agent.cxRouting?.desiredAvailability === "unavailable") {
      accumulator.cxUnavailable += 1;
    }
    if (agent.freshLeadGate?.blocked && agent.freshLeadGate?.source !== "routing-disabled") {
      accumulator.freshLeadBlocked += 1;
    }
    if (agent.freshLeadGate?.source === "ex-call") {
      accumulator.freshLeadBlockedByEx += 1;
    }
    if (agent.currentCall?.telephonySessionId || agent.currentCall?.sessionId) {
      accumulator.activeCalls += 1;
    }
    return accumulator;
  }, {
    total: 0,
    cxUnavailable: 0,
    freshLeadBlocked: 0,
    freshLeadBlockedByEx: 0,
    activeCalls: 0,
    byStatus: {},
  });

  return {
    domain: normalizedDomain,
    summary,
    diagnostics,
    agents,
  };
}

async function buildRingBridgeWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [presence, providerHealth, recentWorkflowStages, recentReviewItems] = await Promise.all([
    buildRingCentralWorkspace(normalizedDomain),
    buildProviderHealth(normalizedDomain),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      family: "ringcentral",
      limit: 20,
    }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      limit: 10,
    }),
  ]);

  return {
    domain: normalizedDomain,
    presence,
    runtime: providerHealth.runtimeStatus?.ringcentral || null,
    providerHealth,
    diagnostics: presence.diagnostics,
    recentWorkflowStages,
    recentReviewItems,
  };
}

async function listRingCentralEvents(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  return workflowRecordRepository.listWorkflowRecords({
    domain: normalizedDomain,
    family: "ringcentral",
    subtype: filters.subtype,
    stage: filters.stage,
    aggregateType: filters.aggregateType,
    aggregateId: filters.aggregateId,
    caseId: filters.caseId,
    limit: filters.limit || 50,
  });
}

async function buildDeployWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [controlPlane, providerHealth, recentServiceAlerts] = await Promise.all([
    buildControlPlaneHealthReport(),
    buildProviderHealth(normalizedDomain),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      workflow: "service-health",
      limit: 20,
    }),
  ]);

  return {
    domain: normalizedDomain,
    topology: listServiceTopology({ ports: PORTS }),
    controlPlane,
    providerHealth,
    recentServiceAlerts,
  };
}

async function buildLibraryWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const catalog = buildContactLibraryCatalog();
  const [recentEmailDispatches, recentSmsDispatches] = await Promise.all([
    dispatchListRepository.listDispatchLists(normalizedDomain, {
      channel: "email",
      limit: 15,
    }),
    dispatchListRepository.listDispatchLists(normalizedDomain, {
      channel: "sms",
      limit: 15,
    }),
  ]);

  return {
    domain: normalizedDomain,
    catalogs: {
      textMessages: catalog.sms.entries,
      emailTemplates: catalog.email.entries,
      campaigns: [],
    },
    summary: {
      smsCount: catalog.sms.count,
      emailCount: catalog.email.count,
      smsCategories: catalog.sms.byCategory,
      emailCategories: catalog.email.byCategory,
      emailBrands: catalog.email.byBrand,
    },
    recentUsage: {
      emailDispatches: recentEmailDispatches,
      smsDispatches: recentSmsDispatches,
    },
    capabilities: {
      canEditTextLibrary: true,
      canEditEmailTemplates: true,
      canLaunchEmailCampaigns: true,
      canLaunchTextCampaigns: true,
    },
    notes: [
      "Library content is currently sourced from the original TagContactBridge templates and text library.",
      "Next step is materializing edited campaign content into parallel-owned storage instead of filesystem-backed reads.",
    ],
    source: catalog.source,
  };
}

module.exports = {
  buildClientDetail,
  buildClientWorkspaceList,
  buildDeployWorkspace,
  buildInboxWorkspace,
  buildLibraryWorkspace,
  buildReviewWorkspace,
  buildRingBridgeWorkspace,
  buildRingCentralWorkspace,
  listRingCentralEvents,
  listReviewWorkspaceItems,
  searchClientWorkspace,
};
