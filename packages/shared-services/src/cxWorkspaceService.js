"use strict";

const { createEvent } = require("../../event-core/src");
const {
  agentStateRepository,
  callLogRepository,
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  cxAppointmentRepository,
  cxDialQueueRepository,
  leadCadenceRepository,
  paymentLedgerRepository,
  postDateHoldRepository,
  reviewQueueRepository,
  userAccountRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { CxDialQueue, LeadCadence, MasterProspectIndex } = require("../../shared-models/src");
const { recordWorkflowStage } = require("./workflowStateService");
const {
  decideCxCurrentCallDialBlock,
  evaluateCxClear,
} = require("./cxCallStateGuard");
const { searchClientWorkspace } = require("./frontendReadService");
const {
  applyCallEndedDailyStats,
  buildManualCxRouting,
  deriveActivityState,
  deriveFreshLeadGate,
  bumpLastActivityAt,
  getBreakUsageSummary,
  normalizeDailyStats,
  normalizeCxPauseType,
  setActivityState,
  touchCxWorkspacePresence,
} = require("./agentAvailabilityService");
const {
  ensureRingcxAgentOffhookAllowed,
} = require("./ringcxAgentSelfHealService");
const {
  emitHourlyJobEvent,
  runWithImmediateRetries,
} = require("./hourlyJobEventService");
const {
  queueCallRecordingArchiveJob,
} = require("./recordingArchiveService");
const {
  isKnownTemplateKey: isKnownEmailTemplateKey,
  renderEmailTemplate,
} = require("./emailTemplateService");
const {
  createLogicsClient,
  createRingCentralClient,
  createSendgridClient,
} = require("../../shared-integrations/src");
const {
  deriveUcqAgeBucket,
  normalizeLeadQueueFamily,
  normalizeLeadQueueFamilyList,
} = require("../../shared-normalizers/src");
const {
  assignCxQueueBatch,
  backfillCxQueueOrdering,
  cancelCxQueueItem,
  completeCxQueueItem,
  releaseCxQueueItem,
  rescheduleCxQueueItem,
  queueCxDialRequest,
  stageCxDispatchIntent,
} = require("./cxCadenceService");
const {
  buildCxCallLifecyclePatch,
  describeCxCallGate,
  isCxCanonicalCallReadEnabled,
  isCxCanonicalCallStrictGateEnabled,
  isCxCanonicalCallVerboseLoggingEnabled,
  isCxCanonicalCallWriteEnabled,
  writeCxCallLifecycleShadowState,
} = require("./cxCallLifecycleService");
const {
  writeCxCallWrapSummary,
} = require("./cxCallWrapService");
const {
  observeCxBucketTerminalOutcome,
  primeCxBucketNewCalls,
} = require("./cxDialQueueMediatorService");
const {
  cancelCxAppointmentsForCase,
  resolveCxAppointmentAfterDisposition,
} = require("./cxAppointmentService");
const { extractPaymentRows } = require("./paymentReconcileService");
const { deriveQueueFamily } = require("./cxLoadBalancerService");
const {
  deriveQueueFamilyFromLeadCreatedAt,
  getCooldownReleaseAt,
  getPacificBusinessDayAge,
  getPacificBusinessDayStart,
  getPacificDateKey,
  getPacificMonthKey,
  getQueueFamilySortRank,
  normalizeRouteCampaigns,
  resolveAccountQueuePolicy,
  resolveQueueDialability,
  resolveQueueDialTimeWindow,
} = require("./cxQueuePolicyService");
const {
  getCxQueueServeRank,
} = require("./cxQueueFairnessService");
const {
  getMarketingFromEmail,
  getRingCentralConfig,
  getSharedConfig,
  PORTS,
} = require("../../shared-config/src");
const { getCompanyConfig } = require("../../shared-config/src/companyConfig");
const { resolveExportStatus, resolveStatus } = require("../../shared-config/src/statusMap");
const { findExShellsForEmail } = require("../../shared-data/src/exShellDirectory");
const {
  findLogicsAgentByEmail,
  resolveLogicsForCompany,
} = require("../../shared-data/src/logicsAgents");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sanitizeInterviewSnapshotValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.trim().slice(0, 2000);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizeInterviewSnapshotValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const normalizedKey = String(key || "").trim().slice(0, 80);
      if (!normalizedKey) continue;
      out[normalizedKey] = sanitizeInterviewSnapshotValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function resolveQueueItemCallStartTime(queueItem = null) {
  for (const value of [
    queueItem?.metadata?.lastDialExecutionAt,
    queueItem?.metadata?.lastQueueAttemptAt,
    queueItem?.lastPlacedAt,
    queueItem?.updatedAt,
  ]) {
    const date = parseDateOrNull(value);
    if (date) return date;
  }
  return null;
}

function resolveRingcxActiveCallRoute(queueItem = null, input = {}, workflowRoute = {}) {
  const metadata = plainObject(queueItem?.metadata);
  const lastPublishedRoute = plainObject(metadata.lastRingcxPublishedRoute);
  const lastExecutionPublish = plainObject(metadata.lastDialExecutionRingcxPublish);
  const publishedWorkflowRoute = plainObject(workflowRoute);

  return {
    campaignId:
      normalizeExternalId(metadata.lastRingcxPublishedCampaignId)
      || normalizeExternalId(lastPublishedRoute.campaignId)
      || normalizeExternalId(lastExecutionPublish.campaignId)
      || normalizeExternalId(metadata.lastDialExecutionCampaignId)
      || normalizeExternalId(metadata.rcxVisibilityCampaignId)
      || normalizeExternalId(publishedWorkflowRoute.campaignId)
      || normalizeExternalId(input.campaignId)
      || normalizeExternalId(input.rcxCampaignId)
      || normalizeExternalId(queueItem?.rcxCampaignId)
      || normalizeExternalId(metadata.rcxCampaignId),
    dialGroupId:
      normalizeExternalId(metadata.lastRingcxPublishedDialGroupId)
      || normalizeExternalId(lastPublishedRoute.dialGroupId)
      || normalizeExternalId(lastExecutionPublish.dialGroupId)
      || normalizeExternalId(metadata.lastDialExecutionDialGroupId)
      || normalizeExternalId(metadata.rcxVisibilityDialGroupId)
      || normalizeExternalId(publishedWorkflowRoute.dialGroupId)
      || normalizeExternalId(input.dialGroupId)
      || normalizeExternalId(input.rcxDialGroupId)
      || normalizeExternalId(queueItem?.rcxDialGroupId)
      || normalizeExternalId(metadata.rcxDialGroupId),
    externId:
      normalizeExternalId(metadata.lastRingcxPublishedExternId)
      || normalizeExternalId(lastPublishedRoute.externId)
      || normalizeExternalId(lastExecutionPublish.externId)
      || normalizeExternalId(metadata.lastDialExecutionExternId)
      || normalizeExternalId(metadata.rcxVisibilityExternId)
      || normalizeExternalId(publishedWorkflowRoute.externId)
      || normalizeExternalId(input.externId),
  };
}

async function resolveLastPublishedRouteFromWorkflow(queueItemId) {
  const id = normalizeExternalId(queueItemId);
  if (!id) return {};
  const records = await workflowRecordRepository.listWorkflowRecords({
    family: "cx",
    subtype: "dial-request",
    stage: "completed",
    aggregateType: "cx-dial-queue",
    aggregateId: id,
    limit: 5,
  }).catch(() => []);

  for (const record of records) {
    const payload = plainObject(record?.payload);
    const publish = plainObject(payload.publish);
    const route = {
      campaignId: normalizeExternalId(publish.campaignId || payload.campaignId),
      dialGroupId: normalizeExternalId(publish.dialGroupId || payload.dialGroupId),
      accountId: normalizeExternalId(publish.accountId || payload.accountId),
      externId: normalizeExternalId(publish.externId || payload.externId),
    };
    if (route.campaignId || route.dialGroupId || route.externId) return route;
  }
  return {};
}

function callIdentity(call = {}) {
  return normalizeExternalId(
    call?.telephonySessionId
      || call?.sessionId
      || call?.callSessionId
      || call?.uii
      || "",
  );
}

function readEnvExternalId(name) {
  return normalizeExternalId(process.env[name]);
}

function envToken(value) {
  const token = String(value || "").trim();
  if (!token) return null;
  const normalized = token
    .replace(/@/g, "_AT_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || null;
}

function compactUnique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function resolveAgentSpecificRcxRouting(input = {}, queueItem = null, metadata = {}) {
  const assignment = queueItem?.assignment && typeof queueItem.assignment === "object"
    ? queueItem.assignment
    : {};
  const tokens = compactUnique([
    input.assignedExtensionId,
    input.dialerExtensionId,
    input.extensionId,
    input.assignedAgentId,
    input.dialerCxAgentId,
    input.agent?.cxAgentId,
    input.agent?.assignedExtensionId,
    assignment.extensionId,
    input.assignedAgentEmail,
    input.dialerEmail,
    input.agent?.email,
    assignment.agentEmail,
    assignment.email,
    assignment.agentName,
    metadata.assignedExtensionId,
    metadata.assignedAgentName,
    metadata.assignedAgentEmail,
    metadata.assignedAgentId,
  ]);

  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const dialGroupId = readEnvExternalId(`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`);
    const campaignId = readEnvExternalId(`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`);
    const executionMode = readEnvExternalId(`RINGCX_AGENT_ROUTE_${suffix}_EXECUTION_MODE`);
    if (dialGroupId || campaignId || executionMode) {
      return {
        dialGroupId,
        campaignId,
        executionMode,
        matchedToken: String(token),
      };
    }
  }

  return null;
}

function resolveRcxRoutingForQueueIntent(input = {}, queueItem = null) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const agentRoute = resolveAgentSpecificRcxRouting(input, queueItem, metadata);
  const family = String(
    input.queueFamily ||
      queueItem?.queueFamily ||
      metadata.queueFamily ||
      "",
  ).trim().toLowerCase();
  const familyCampaignId =
    family === "fresh-day1" || family === "fresh"
      ? readEnvExternalId("RINGCX_VOICE_NEW_CAMPAIGN_ID")
      : family === "fresh-day2to10"
        ? readEnvExternalId("RINGCX_VOICE_OLD_CAMPAIGN_ID")
        : family === "fresh-day16to30"
          ? (
              readEnvExternalId("RINGCX_VOICE_YELLOW_CAMPAIGN_ID")
              || readEnvExternalId("RINGCX_VOICE_OLD_CAMPAIGN_ID")
            )
          : family === "aged"
            ? readEnvExternalId("RINGCX_VOICE_AGED_CAMPAIGN_ID")
            : null;

  return {
    accountId:
      normalizeExternalId(input.rcxAccountId)
      || normalizeExternalId(input.accountId)
      || normalizeExternalId(queueItem?.rcxAccountId)
      || normalizeExternalId(metadata.rcxAccountId)
      || readEnvExternalId("RINGCX_VOICE_ACCOUNT_ID"),
    dialGroupId:
      agentRoute?.dialGroupId
      || normalizeExternalId(input.rcxDialGroupId)
      || normalizeExternalId(input.dialGroupId)
      || normalizeExternalId(queueItem?.rcxDialGroupId)
      || normalizeExternalId(metadata.rcxDialGroupId)
      || readEnvExternalId("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID"),
    campaignId:
      agentRoute?.campaignId
      || normalizeExternalId(input.rcxCampaignId)
      || normalizeExternalId(input.campaignId)
      || normalizeExternalId(input.queueId)
      || normalizeExternalId(queueItem?.rcxCampaignId)
      || normalizeExternalId(metadata.rcxCampaignId)
      || familyCampaignId
      || readEnvExternalId("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID")
      || readEnvExternalId("RINGCX_VOICE_NEW_CAMPAIGN_ID"),
    executionMode:
      agentRoute?.executionMode
      || readEnvExternalId("RINGCX_DIAL_EXECUTION_MODE")
      || "ringcx-campaign-queue",
    agentRoute,
  };
}

function toPositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function resolveInputSettlementOfficerId(input = {}) {
  return toPositiveInteger(input.SetOfficerID ?? input.setOfficerId ?? input.settlementOfficerId);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeUsPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function toE164(value) {
  const digits = normalizeUsPhone(value);
  if (!digits) return null;
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

function normalizeExShell(shell = {}) {
  return {
    company: normalizeDomain(shell.company || "TAG"),
    email: shell.email ? String(shell.email).trim().toLowerCase() : null,
    name: shell.name ? String(shell.name).trim() : null,
    extensionNumber:
      shell.extensionNumber != null ? String(shell.extensionNumber).trim() || null : null,
    loginPhones: (Array.isArray(shell.loginPhones) ? shell.loginPhones : [])
      .map(normalizeUsPhone)
      .filter(Boolean),
    primaryPhone: normalizeUsPhone(shell.primaryPhone) || null,
    rcExtensionId: shell.rcExtensionId ? String(shell.rcExtensionId).trim() : null,
    lastResolvedAt: shell.lastResolvedAt || null,
    source: shell.source || null,
  };
}

function normalizeExShells(shells) {
  return (Array.isArray(shells) ? shells : []).map(normalizeExShell).filter((shell) => shell.email || shell.extensionNumber);
}

function getEmailPrefix(email) {
  return String(email || "").trim().toLowerCase().split("@")[0] || "";
}

function buildCandidateEmails(account = {}, user = {}) {
  return [
    account.email,
    account.tagEmail,
    account.wynnEmail,
    user.email,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function inferExShells(account = {}, user = {}) {
  const seenPrefixes = new Set();
  const shells = [];
  for (const email of buildCandidateEmails(account, user)) {
    const prefix = getEmailPrefix(email);
    if (!prefix || seenPrefixes.has(prefix)) continue;
    seenPrefixes.add(prefix);
    shells.push(...findExShellsForEmail(email));
  }
  return normalizeExShells(shells);
}

function resolveCxSettlementOfficerId(domain, account = {}, user = {}) {
  const normalizedDomain = normalizeDomain(domain || account?.company || user?.company || "TAG");
  const profileCandidates =
    normalizedDomain === "WYNN"
      ? [
          account?.wynnSOId,
          user?.wynnSOId,
          account?.wynnLogicsId,
          user?.wynnLogicsId,
        ]
      : [
          account?.tagSOId,
          user?.tagSOId,
          account?.tagLogicsId,
          user?.tagLogicsId,
          account?.logicsUserId,
          user?.logicsUserId,
        ];

  for (const value of profileCandidates) {
    const id = toPositiveInteger(value);
    if (id) return id;
  }

  const candidateEmails = [
    account?.email,
    user?.email,
    account?.tagEmail,
    account?.wynnEmail,
    user?.tagEmail,
    user?.wynnEmail,
    account?.cxAuth?.rcUserEmail,
    account?.cxSession?.rcxAgentEmail,
  ];

  for (const email of candidateEmails) {
    const agent = findLogicsAgentByEmail(email);
    const tenant = resolveLogicsForCompany(agent, normalizedDomain);
    const id = toPositiveInteger(tenant?.settlementOfficerId || tenant?.logicsId);
    if (id) return id;
  }

  return null;
}

function requireCxSettlementOfficerId(domain, account = {}, user = {}) {
  const id = resolveCxSettlementOfficerId(domain, account, user);
  if (id) return id;
  const err = new Error(
    `No ${normalizeDomain(domain || account?.company || user?.company || "TAG")} settlement officer id is configured on this agent profile.`,
  );
  err.status = 400;
  throw err;
}

const RC_EXTENSION_CACHE_TTL_MS = 5 * 60 * 1000;
let rcExtensionCache = {
  loadedAt: 0,
  records: [],
};

async function loadRingCentralExtensionDirectory(force = false) {
  if (!force && rcExtensionCache.loadedAt && Date.now() - rcExtensionCache.loadedAt < RC_EXTENSION_CACHE_TTL_MS) {
    return rcExtensionCache.records;
  }
  const client = createRingCentralClient();
  const payload = await client.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];
  rcExtensionCache = {
    loadedAt: Date.now(),
    records,
  };
  return records;
}

function parseLogicsData(payload) {
  if (!payload) return null;
  const raw =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function extractCaseId(value) {
  const raw =
    value?.CaseID ??
    value?.caseId ??
    value?.caseID ??
    value?.ID ??
    value?.Id ??
    value?.id ??
    value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLogicsDate(value) {
  const candidates = [
    value?.CaseCreatedDate,
    value?.CreatedDate,
    value?.CreateDate,
    value?.LastModifiedDate,
    value?.ModifiedDate,
    value?.SaleDate,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = new Date(candidate).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function pickFreshestLogicsRecord(payload) {
  const data = parseLogicsData(payload);
  if (Array.isArray(data)) {
    if (data.length === 0) return null;
    return data
      .slice()
      .sort((left, right) => extractLogicsDate(right) - extractLogicsDate(left))[0] || null;
  }
  return data && typeof data === "object" ? data : null;
}

function normalizeActor(user) {
  return {
    actorEmail: user?.email || null,
    actorName: user?.name || user?.email || null,
  };
}

function buildActorAuditLine(user) {
  const actor = normalizeActor(user);
  if (!actor.actorEmail && !actor.actorName) return "Requested via CX workspace";
  if (actor.actorName && actor.actorEmail) {
    return `Requested via CX workspace by ${actor.actorName} <${actor.actorEmail}>`;
  }
  return `Requested via CX workspace by ${actor.actorName || actor.actorEmail}`;
}

function buildCxRetryDedupeKey(domain, subtype, aggregateType, aggregateId, caseId = null) {
  return [
    normalizeDomain(domain),
    "cx-logics-retry",
    subtype,
    aggregateType,
    String(aggregateId),
    caseId != null ? String(caseId) : "na",
  ].join(":");
}

function computeCxRetryPriority(subtype) {
  switch (String(subtype || "").trim()) {
    case "logics-update-case":
    case "logics-update-status":
      return 85;
    case "logics-create-invoice":
    case "logics-create-amortization":
      return 80;
    case "logics-task":
    case "logics-create-activity":
    case "logics-update-activity":
      return 70;
    default:
      return 60;
  }
}

async function queueCxLogicsRetryJob({
  context,
  user,
  subtype,
  aggregateType,
  aggregateId,
  caseId,
  title,
  summary,
  payload,
  requested,
  failedWorkflowId,
  error,
  immediateRetryUsed = 0,
}) {
  try {
    const actor = normalizeActor(user);
    return await emitHourlyJobEvent({
      lane: "hourly",
      domain: context.domain,
      eventType: `cx.${subtype}.retry`,
      targetService: "control-plane",
      handlerKey: "retryCxLogicsAction",
      aggregateType,
      aggregateId,
      caseId,
      payload: {
        subtype,
        title,
        summary,
        logicsPayload: payload,
        requested,
        actorEmail: actor.actorEmail,
        actorName: actor.actorName,
        notifyOnResolution: false,
      },
      resolutionCheckKey: caseId != null ? "logics-case-visible" : "cx-logics-action-state",
      resolutionContext: {
        subtype,
        aggregateType,
        aggregateId,
        caseId,
      },
      dedupeKey: buildCxRetryDedupeKey(context.domain, subtype, aggregateType, aggregateId, caseId),
      sourceWorkflowId: failedWorkflowId,
      emittedBy: "control-plane",
      priority: computeCxRetryPriority(subtype),
      severity: "warning",
      alertTitle: `${title} retry queued`,
      alertSummary: `${summary} failed; hourly retry queued`,
      immediateRetryAttempts: 1,
      immediateRetryDelayMs: 500,
      immediateRetryUsed,
      provideSummary: false,
      summaryLabel: title,
      firstError: error?.message || String(error || "Unknown Logics error"),
      notes: "Queued from CX Logics action failure",
    });
  } catch {
    return null;
  }
}

function toUtcDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function buildWelcomeEmailTemplate() {
  return {
    subject: "Welcome to {{companyName}}",
    body:
      "Hi {{firstName}},\n\nThis is {{agentName}} with {{companyName}}. I'm reaching out directly so you have a clear point of contact here.\n\nIf you need anything before our next step, just reply to this email or text me at {{agentPhone}}.\n\nBest,\n{{agentName}}\n{{agentEmail}}",
  };
}

function renderHbs(template, context = {}) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    context[key] != null ? String(context[key]) : "",
  );
}

function buildTemplateContext(domain, user, input = {}) {
  const company = getCompanyConfig(domain);
  const fullName = String(input.name || "").trim();
  const firstName = fullName ? fullName.split(" ")[0] : "there";
  return {
    companyName: company.name || domain,
    domainLabel: domain,
    firstName,
    name: fullName || "there",
    agentName: user?.name || user?.email || "Agent",
    agentEmail: user?.email || company.fromEmail || "",
    agentPhone: company.clientContactPhone || "",
  };
}

async function recordCommunicationThread(domain, caseId, channel, entry = {}) {
  if (!caseId) return null;
  await caseProfileRepository.upsertCaseProfile(domain, caseId, {});
  return caseProfileRepository.appendCommunicationThread(domain, caseId, channel, {
    ...entry,
    sentAt: entry.sentAt || new Date(),
  });
}

async function syncCaseProfileFromLogics(domain, caseId) {
  if (!caseId) return null;
  const client = createLogicsClient(domain);
  const payload = await client.getCaseInfo(caseId);
  const data = parseLogicsData(payload);
  if (!data || typeof data !== "object") return null;

  const firstName = data.FirstName || null;
  const lastName = data.LastName || null;
  const name = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
  const normalizedPhones = [data.CellPhone, data.HomePhone, data.WorkPhone]
    .map((value) => normalizePhone(value))
    .filter(Boolean);
  const statusId = data.StatusID != null ? Number(data.StatusID) : data.Status != null ? Number(data.Status) : null;
  const statusInfo = resolveStatus(domain, statusId);

  return caseProfileRepository.upsertCaseProfile(domain, caseId, {
    firstName,
    lastName,
    name,
    email: data.Email || null,
    primaryPhone: data.CellPhone || data.HomePhone || data.WorkPhone || null,
    normalizedPhones,
    sourceName: data.SourceName || data.sourceName || null,
    notes: data.Notes || data.notes || null,
    statusId,
    statusCategory: statusInfo?.category || null,
    convertedAt: data.SaleDate ? new Date(data.SaleDate) : null,
    lastStatusCheckAt: new Date(),
  });
}

function resolveRequestedStatus(domain, input = {}) {
  if (input.statusId != null || input.StatusID != null || input.logicsStatusId != null) {
    const explicit = Number(input.statusId ?? input.StatusID ?? input.logicsStatusId);
    return Number.isFinite(explicit) ? explicit : null;
  }
  const statusText = String(input.status || input.logicsStatus || "").trim();
  if (!statusText) return null;
  const resolved = resolveExportStatus(domain, statusText);
  return resolved?.statusId ?? null;
}

function normalizePostDateText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function isPostDateStatusRequest(domain, input = {}, result = {}) {
  const statusId =
    result.statusId != null
      ? Number(result.statusId)
      : resolveRequestedStatus(domain, input);
  const resolved = Number.isFinite(statusId) ? resolveStatus(domain, statusId) : null;
  if (resolved?.category === "postdate") return true;
  const statusText = normalizePostDateText(
    input.status || input.logicsStatus || result.disposition || result.statusLabel || "",
  );
  return statusText === "postdate" || statusText === "post date" || statusText.includes("post date");
}

function readPaymentScheduleDate(row = {}) {
  const raw =
    row.PaidDate
    || row.PaymentDate
    || row.ScheduledDate
    || row.ScheduleDate
    || row.ProcessDate
    || row.DueDate
    || row.Date
    || null;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function summarizePaymentScheduleRow(row = {}) {
  const date = readPaymentScheduleDate(row);
  return {
    casePaymentId: row.CasePaymentID != null ? Number(row.CasePaymentID) : null,
    amount: row.Amount != null ? Number(row.Amount) : null,
    paymentType: row.PaymentType || row.PaymentTypeName || row.Type || null,
    transactionStatus: row.TransactionStatus || null,
    date: date ? date.toISOString() : null,
    dateKey:
      String(
        row.PaidDate
        || row.PaymentDate
        || row.ScheduledDate
        || row.ScheduleDate
        || row.ProcessDate
        || row.DueDate
        || row.Date
        || "",
      ).slice(0, 10) || (date ? date.toISOString().slice(0, 10) : null),
  };
}

function pickFirstPaymentScheduleRow(rows = [], now = new Date()) {
  const todayKey = getPacificDateKey(now);
  const candidates = rows
    .map((row) => ({ raw: row, summary: summarizePaymentScheduleRow(row) }))
    .filter((entry) => entry.summary.dateKey)
    .sort((left, right) => {
      const leftKey = left.summary.dateKey || "";
      const rightKey = right.summary.dateKey || "";
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      return (Number(left.summary.casePaymentId) || 0) - (Number(right.summary.casePaymentId) || 0);
    });
  if (candidates.length === 0) return null;
  return candidates.find((entry) => String(entry.summary.dateKey) >= todayKey) || candidates[0];
}

async function resolvePostDatePaymentSchedule(domain, caseId) {
  const client = createLogicsClient(domain);
  try {
    const rawPayments = await client.getCasePayments(caseId);
    const rows = extractPaymentRows(rawPayments);
    const picked = pickFirstPaymentScheduleRow(rows);
    const compactRows = rows
      .map(summarizePaymentScheduleRow)
      .filter((row) => row.dateKey)
      .sort((left, right) => String(left.dateKey).localeCompare(String(right.dateKey)))
      .slice(0, 8);
    if (!picked) {
      return {
        status: rows.length > 0 ? "no-dated-payments" : "no-payments",
        firstPaymentDate: null,
        firstPaymentDateKey: null,
        snapshot: {
          source: "logics-case-payments",
          rowCount: rows.length,
          rows: compactRows,
        },
      };
    }
    return {
      status: "found",
      firstPaymentDate: picked.summary.date ? new Date(picked.summary.date) : null,
      firstPaymentDateKey: picked.summary.dateKey || null,
      snapshot: {
        source: "logics-case-payments",
        rowCount: rows.length,
        selected: picked.summary,
        rows: compactRows,
      },
    };
  } catch (error) {
    if (error?.details?.responseStatus === 404) {
      return {
        status: "no-payments",
        firstPaymentDate: null,
        firstPaymentDateKey: null,
        snapshot: {
          source: "logics-case-payments",
          rowCount: 0,
          rows: [],
        },
      };
    }
    return {
      status: "logics-error",
      firstPaymentDate: null,
      firstPaymentDateKey: null,
      snapshot: {
        source: "logics-case-payments",
        error: error.message,
      },
    };
  }
}

async function recordCxPostDateHold(domain, user, input = {}, result = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const caseId = Number(input.caseId ?? input.CaseID);
  if (!normalizedDomain || !Number.isFinite(caseId)) return null;

  const now = new Date();
  const [profile, queueItem, schedule] = await Promise.all([
    caseProfileRepository.findCaseProfile(normalizedDomain, caseId).catch(() => null),
    (input.queueItemId || input.queueTicketId)
      ? cxDialQueueRepository.findQueueItemById(input.queueItemId || input.queueTicketId).catch(() => null)
      : cxDialQueueRepository.findActiveQueueItem(normalizedDomain, caseId).catch(() => null),
    resolvePostDatePaymentSchedule(normalizedDomain, caseId),
  ]);
  const queueObject = queueItem && typeof queueItem.toObject === "function"
    ? queueItem.toObject()
    : queueItem;
  const statusId = result.statusId != null
    ? Number(result.statusId)
    : resolveRequestedStatus(normalizedDomain, input);
  const statusInfo = Number.isFinite(statusId) ? resolveStatus(normalizedDomain, statusId) : null;
  const caseName =
    profile?.name
    || [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim()
    || input.leadName
    || input.name
    || null;
  const phone =
    input.phone
    || input.searchPhone
    || profile?.primaryPhone
    || queueObject?.phone
    || null;

  return postDateHoldRepository.upsertActivePostDateHold(normalizedDomain, caseId, {
    postDatedAt: now,
    postDatedDateKey: getPacificDateKey(now),
    postDatedByEmail: user?.email || null,
    postDatedByName: user?.name || null,
    caseName,
    phone,
    email: profile?.email || input.email || null,
    sourceName: profile?.sourceName || queueObject?.sourceName || input.sourceName || null,
    intakeSource: queueObject?.intakeSource || input.intakeSource || null,
    intakeRoute: queueObject?.intakeRoute || input.intakeRoute || null,
    queueFamily: queueObject?.queueFamily || queueObject?.metadata?.queueFamily || input.queueFamily || null,
    queueItemId: input.queueItemId || input.queueTicketId || (queueObject?._id ? String(queueObject._id) : null),
    queueActionKey: extractQueueActionKey(input) || queueObject?.metadata?.actionKey || null,
    logicsStatusId: Number.isFinite(statusId) ? statusId : null,
    logicsStatusLabel: statusInfo?.label || result.disposition || "Post-Date",
    settlementOfficerId: result.settlementOfficerId || resolveInputSettlementOfficerId(input) || null,
    statusWorkflowId: result.completionWorkflowId || result.workflowId || null,
    firstPaymentDate: schedule.firstPaymentDate || null,
    firstPaymentDateKey: schedule.firstPaymentDateKey || null,
    paymentScheduleStatus: schedule.status,
    paymentScheduleSnapshot: schedule.snapshot,
    metadata: {
      source: "cx-logics-status-update",
      queueOutcome: result.queueOutcome || null,
      statusCategory: result.statusCategory || statusInfo?.category || null,
    },
    historyEntry: {
      type: "postdate-recorded",
      actorEmail: user?.email || null,
      note: "Post-date status set in Logics.",
      payload: {
        workflowId: result.completionWorkflowId || result.workflowId || null,
        firstPaymentDateKey: schedule.firstPaymentDateKey || null,
        paymentScheduleStatus: schedule.status,
      },
    },
  });
}

function normalizeCxDisposition(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "callback" ||
    normalized === "call back" ||
    normalized === "call-back"
  ) {
    return "call-back";
  }
  if (
    normalized === "no answer" ||
    normalized === "no-answer" ||
    normalized === "did not answer" ||
    normalized === "did-not-answer" ||
    normalized === "did_not_answer" ||
    normalized === "did not connect" ||
    normalized === "did-not-connect" ||
    normalized === "did_not_connect" ||
    normalized === "no connect" ||
    normalized === "no-connect"
  ) {
    return "did-not-answer";
  }
  if (normalized === "answered" || normalized === "answer" || normalized === "connected") return "answered";
  if (normalized === "dnc" || normalized.includes("do not call")) return "dnc";
  if (normalized === "postdate" || normalized === "post-date" || normalized === "post date") {
    return "postdate";
  }
  if (
    normalized === "deal" ||
    normalized === "sale" ||
    normalized === "sold" ||
    normalized === "payment" ||
    normalized === "payment handoff" ||
    normalized === "payment-handoff"
  ) {
    return "deal";
  }
  return normalized;
}

function buildCxStageToken(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token ? `cx-${token}` : "cx-complete";
}

function isTerminalCxStatusCategory(category) {
  const normalized = String(category || "").trim().toLowerCase();
  return [
    "client",
    "tier1",
    "tier2",
    "tier3",
    "tier4",
    "tier5",
    "dnc",
    "inactive",
    "postdate",
    "other",
    "exhausted",
    "redline",
  ].includes(normalized);
}

function extractLogicsStatusId(record) {
  if (!record || typeof record !== "object") return null;
  const raw = record.StatusID ?? record.Status ?? null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractQueueActionKey(input = {}) {
  const direct = String(input.queueActionKey || input.actionKey || input.queueKey || "").trim();
  if (direct) return direct;
  const cxAction = input.cxAction && typeof input.cxAction === "object" ? input.cxAction : null;
  const nested = cxAction?.key != null ? String(cxAction.key).trim() : "";
  return nested || null;
}

function resolveCallbackScheduledFor(input = {}) {
  const explicit = input.callbackAt || input.scheduledFor || input.followUpAt || null;
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + 30 * 60 * 1000);
}

function resolveSafeCallbackReleaseAt(input = {}, queueItem = null, now = new Date()) {
  const explicit = input.callbackAt || input.scheduledFor || input.followUpAt || null;
  if (explicit) return resolveCallbackScheduledFor(input);
  if (queueItem) {
    const fromQueue = getCooldownReleaseAt(queueItem, now);
    const parsed = fromQueue ? new Date(fromQueue) : null;
    if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  }
  return resolveCallbackScheduledFor(input);
}

async function resolveActiveCxQueueAction(domain, caseId, preferredActionKey = null) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(normalizedCaseId)) return null;

  const doc = await LeadCadence.findOne({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
  }).lean();
  if (!doc) return null;

  const pendingActions = (Array.isArray(doc.schedule?.actions) ? doc.schedule.actions : [])
    .filter((entry) => entry?.channel === "cx" && (entry.status === "pending" || entry.status === "requested"));
  if (pendingActions.length === 0) return null;

  if (preferredActionKey) {
    const exact = pendingActions.find((entry) => String(entry.key || "").trim() === String(preferredActionKey).trim());
    if (exact) {
      return {
        cadence: doc,
        action: exact,
        actionKey: String(exact.key),
      };
    }
  }

  const sorted = pendingActions
    .slice()
    .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime());
  const action = sorted[0] || null;
  if (!action?.key) return null;
  return {
    cadence: doc,
    action,
    actionKey: String(action.key),
  };
}

async function finalizeCxDispositionCallback(domain, input = {}) {
  const caseId = Number(input.caseId);
  if (!Number.isFinite(caseId)) return null;

  const actionKey = extractQueueActionKey(input);
  const queueAction = await resolveActiveCxQueueAction(domain, caseId, actionKey);
  const queueItem = await resolveCxDialQueueItem(domain, caseId, input).catch(() => null);
  const scheduledFor = resolveSafeCallbackReleaseAt(input, queueItem);
  if (queueAction?.actionKey) {
    await leadCadenceRepository.rescheduleScheduledAction(
      domain,
      caseId,
      queueAction.actionKey,
      scheduledFor,
      {
        active: true,
        currentStage: "callback-pending",
      },
    );
  }
  const queueMutation = await rescheduleCxQueueItem({
    domain,
    caseId,
    queueItemId: queueItem?._id ? String(queueItem._id) : input.queueItemId || input.queueTicketId || null,
    releaseAt: scheduledFor,
    reason: "callback",
    actorEmail: input.actorEmail || null,
    cancelRingcxInBackground: true,
    extraUpdate: {
      metadata: {
        lastCallbackEjectedAt: new Date(),
        lastCallbackEjectedBy: input.actorEmail || null,
      },
    },
  }).catch(() => null);
  const queueItemId =
    queueItem?._id ? String(queueItem._id) : String(input.queueItemId || input.queueTicketId || "").trim() || null;
  const callbackEjected = Boolean(queueMutation?.mutated || queueItemId || queueAction?.actionKey);

  return {
    caseId,
    domain,
    queueItemId,
    queueTicketId: queueItemId,
    disposition: "Call Back",
    queueOutcome: callbackEjected ? "rescheduled" : "noop",
    callbackEjected,
    queueEjection: queueMutation || null,
    actionKey: queueAction?.actionKey || actionKey || null,
    rescheduledFor: scheduledFor.toISOString(),
  };
}

function latestNonNullDate(...values) {
  const dates = values
    .map((value) => value ? new Date(value) : null)
    .filter((date) => date && !Number.isNaN(date.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function resolveNoAnswerReleaseAt(queueItem = {}, now = new Date()) {
  const cooldownAt = getCooldownReleaseAt(queueItem, now);
  const timing = resolveQueueDialTimeWindow(queueItem, cooldownAt || now);
  return latestNonNullDate(cooldownAt, timing.nextAllowedAt) || now;
}

function readQueueDispositionCounters(queueItem = {}) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object" ? queueItem.metadata : {};
  return {
    answeredContacts: Math.max(Number(
      queueItem?.answeredContacts
        ?? metadata.answeredContacts
        ?? metadata.cxAnsweredContacts
        ?? metadata.answeredCalls
        ?? metadata.contactCount
        ?? 0,
    ) || 0, 0),
    noAnswerCalls: Math.max(Number(
      queueItem?.unansweredCalls
        ?? metadata.unansweredCalls
        ?? metadata.noAnswerCalls
        ?? metadata.didNotAnswerCalls
        ?? metadata.cxNoAnswerCalls
        ?? 0,
    ) || 0, 0),
  };
}

async function readLeadCxDispositionCounters(domain, caseId, queueItem = null) {
  const queueCounters = readQueueDispositionCounters(queueItem || {});
  const cadence = await LeadCadence.findOne(
    { domain: normalizeDomain(domain), caseId: Number(caseId) },
    {
      "counterCadence.cxAnsweredContacts": 1,
      "counterCadence.cxNoAnswerCalls": 1,
      "payloadSnapshot.cxAnsweredContacts": 1,
      "payloadSnapshot.cxNoAnswerCalls": 1,
    },
  ).lean().catch(() => null);
  return {
    answeredContacts: Math.max(
      queueCounters.answeredContacts,
      Number(cadence?.counterCadence?.cxAnsweredContacts || 0) || 0,
      Number(cadence?.payloadSnapshot?.cxAnsweredContacts || 0) || 0,
    ),
    noAnswerCalls: Math.max(
      queueCounters.noAnswerCalls,
      Number(cadence?.counterCadence?.cxNoAnswerCalls || 0) || 0,
      Number(cadence?.payloadSnapshot?.cxNoAnswerCalls || 0) || 0,
    ),
  };
}

async function stampLeadCxDispositionCounters(domain, caseId, patch = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId)) return null;
  return LeadCadence.updateOne(
    { domain: normalizedDomain, caseId: numericCaseId },
    { $set: patch },
  ).catch(() => null);
}

async function finalizeCxDispositionDidNotAnswer(domain, input = {}) {
  const caseId = Number(input.caseId);
  if (!Number.isFinite(caseId)) return null;
  const now = new Date();
  const actionKey = extractQueueActionKey(input);
  const queueAction = await resolveActiveCxQueueAction(domain, caseId, actionKey);
  const queueItem = await resolveCxDialQueueItem(domain, caseId, input).catch(() => null);
  const counters = await readLeadCxDispositionCounters(domain, caseId, queueItem || {});
  const nextNoAnswerCount = counters.noAnswerCalls + 1;
  const projectedQueueItem = queueItem
    ? {
      ...queueItem,
      metadata: {
        ...(queueItem.metadata || {}),
        unansweredCalls: nextNoAnswerCount,
        noAnswerCalls: nextNoAnswerCount,
        cxNoAnswerCalls: nextNoAnswerCount,
        answeredContacts: counters.answeredContacts,
        cxAnsweredContacts: counters.answeredContacts,
      },
    }
    : null;
  const dialability = projectedQueueItem
    ? resolveQueueDialability(projectedQueueItem, now)
    : null;
  const terminalPolicyHold = Boolean(dialability?.ok === false && dialability.lifecycleHold?.terminal);
  const releaseAt =
    terminalPolicyHold
      ? null
      : dialability?.ok === false
      ? dialability.nextEligibleAt || resolveNoAnswerReleaseAt(projectedQueueItem || queueItem || {}, now)
      : resolveNoAnswerReleaseAt(projectedQueueItem || queueItem || {}, now);

  if (queueAction?.actionKey) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, queueAction.actionKey, "completed", {
      active: true,
      currentStage: "cx-did-not-answer",
    }).catch(() => null);
    await leadCadenceRepository.syncLeadCadenceState(domain, caseId).catch(() => null);
  }

  await stampLeadCxDispositionCounters(domain, caseId, {
    "counterCadence.cxNoAnswerCalls": nextNoAnswerCount,
    "counterCadence.lastCxNoAnswerAt": now,
    "payloadSnapshot.cxNoAnswerCalls": nextNoAnswerCount,
    "payloadSnapshot.lastCxNoAnswerAt": now,
    "payloadSnapshot.cxAnsweredContacts": counters.answeredContacts,
  });

  const queueMetadata = {
    lastDidNotAnswerAt: now,
    lastDidNotAnswerBy: input.actorEmail || null,
    unansweredCalls: nextNoAnswerCount,
    noAnswerCalls: nextNoAnswerCount,
    cxNoAnswerCalls: nextNoAnswerCount,
    answeredContacts: counters.answeredContacts,
    cxAnsweredContacts: counters.answeredContacts,
    lastPolicyHoldReason: dialability?.ok === false ? dialability.reason : null,
    lastPolicyHoldReleaseAt: dialability?.ok === false ? dialability.nextEligibleAt || null : null,
    lastQueueAttemptHeldForDisposition: false,
    wrapUpRequired: false,
  };
  const queueMutation = terminalPolicyHold
    ? await completeCxQueueItem({
      domain,
      caseId,
      queueItemId: queueItem?._id ? String(queueItem._id) : input.queueItemId || input.queueTicketId || null,
      queueActionKey: actionKey,
      queueOutcome: "cadence-finished",
      disposition: "did-not-answer",
      actorEmail: input.actorEmail || null,
      extraUpdate: {
        metadata: queueMetadata,
      },
    }).catch(() => null)
    : await rescheduleCxQueueItem({
      domain,
      caseId,
      queueItemId: queueItem?._id ? String(queueItem._id) : input.queueItemId || input.queueTicketId || null,
      queueActionKey: actionKey,
      releaseAt,
      reason: "did-not-answer",
      actorEmail: input.actorEmail || null,
      cancelRingcxInBackground: true,
      extraUpdate: {
        metadata: queueMetadata,
      },
    }).catch(() => null);
  const appointmentResolution = await resolveCxAppointmentAfterDisposition({
    domain,
    caseId,
    queueItem,
    queueItemId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    disposition: "did-not-answer",
    actorEmail: input.actorEmail || null,
  }).catch((error) => ({ ok: false, error: error.message }));

  return {
    caseId,
    domain,
    disposition: "Did not answer",
    queueOutcome: terminalPolicyHold
      ? "cadence-finished"
      : queueMutation?.mutated ? "rescheduled" : queueAction?.actionKey ? "rescheduled" : "noop",
    queueItemId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    queueTicketId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    actionKey: queueAction?.actionKey || actionKey || null,
    rescheduledFor: releaseAt ? new Date(releaseAt).toISOString() : null,
    unansweredCalls: nextNoAnswerCount,
    policyReason: dialability?.ok === false ? dialability.reason : null,
    queueEjection: queueMutation || null,
    appointmentResolution,
  };
}

async function finalizeCxDispositionAnswered(domain, input = {}) {
  const caseId = Number(input.caseId);
  if (!Number.isFinite(caseId)) return null;
  const now = new Date();
  const actionKey = extractQueueActionKey(input);
  const queueAction = await resolveActiveCxQueueAction(domain, caseId, actionKey);
  const queueItem = await resolveCxDialQueueItem(domain, caseId, input).catch(() => null);
  const counters = await readLeadCxDispositionCounters(domain, caseId, queueItem || {});
  const nextAnsweredContacts = counters.answeredContacts + 1;
  if (queueAction?.actionKey) {
    await leadCadenceRepository.markScheduledActionStatus(domain, caseId, queueAction.actionKey, "completed", {
      active: true,
      currentStage: "cx-answered",
    }).catch(() => null);
    await leadCadenceRepository.syncLeadCadenceState(domain, caseId).catch(() => null);
  }
  await stampLeadCxDispositionCounters(domain, caseId, {
    "counterCadence.cxAnsweredContacts": nextAnsweredContacts,
    "counterCadence.cxNoAnswerCalls": 0,
    "counterCadence.lastCxAnsweredAt": now,
    "payloadSnapshot.cxAnsweredContacts": nextAnsweredContacts,
    "payloadSnapshot.cxNoAnswerCalls": 0,
    "payloadSnapshot.lastCxAnsweredAt": now,
  });
  const queueMutation = await completeCxQueueItem({
    domain,
    caseId,
    queueItemId: input.queueItemId || input.queueTicketId || null,
    queueActionKey: actionKey,
    queueOutcome: "answered",
    disposition: "answered",
    actorEmail: input.actorEmail || null,
    extraUpdate: {
      metadata: {
        lastAnsweredAt: now,
        lastAnsweredBy: input.actorEmail || null,
        answeredContacts: nextAnsweredContacts,
        cxAnsweredContacts: nextAnsweredContacts,
        unansweredCalls: 0,
        noAnswerCalls: 0,
        didNotAnswerCalls: 0,
        lastQueueAttemptHeldForDisposition: false,
        wrapUpRequired: false,
      },
    },
  }).catch(() => null);
  const appointmentResolution = await resolveCxAppointmentAfterDisposition({
    domain,
    caseId,
    queueItem,
    queueItemId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    disposition: "answered",
    actorEmail: input.actorEmail || null,
  }).catch((error) => ({ ok: false, error: error.message }));
  return {
    caseId,
    domain,
    disposition: "Answered",
    queueOutcome: queueMutation?.mutated ? "completed" : queueAction?.actionKey ? "completed" : "noop",
    queueItemId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    queueTicketId: queueMutation?.queueItemId || input.queueItemId || input.queueTicketId || null,
    actionKey: queueAction?.actionKey || actionKey || null,
    rescheduledFor: null,
    queueEjection: queueMutation || null,
    appointmentResolution,
  };
}

function queueCxCallbackBackgroundCleanup({
  context,
  user,
  input = {},
  queueItem = null,
  caseId = null,
  outcome = null,
  requested = null,
  title = "Disposition requested",
  summary = "Apply disposition call back",
} = {}) {
  Promise.resolve()
    .then(async () => {
      const hangup = await hangupCxCallAfterDisposition({
        context,
        user,
        input: {
          ...input,
          callbackAt: input.callbackAt || input.scheduledFor || outcome?.rescheduledFor || null,
          skipAgentStateClearAfterRelay: Boolean(input.nextDial),
        },
        queueItem,
        caseId,
        disposition: "call-back",
      });
      const postHangupEjection = await rescheduleCxQueueItem({
        domain: context.domain,
        caseId,
        queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
        releaseAt: outcome?.rescheduledFor || input.callbackAt || input.scheduledFor || input.followUpAt || null,
        reason: "callback-post-hangup-eject",
        actorEmail: context.account?.email || user?.email || null,
        cancelRingcxInBackground: true,
        extraUpdate: {
          metadata: {
            lastCallbackPostHangupEjectedAt: new Date(),
            lastCallbackPostHangupEjectedBy: context.account?.email || user?.email || null,
          },
        },
      }).catch(() => null);
      await recordWorkflowStage({
        domain: context.domain,
        family: "cx",
        subtype: "disposition",
        stage: "completed",
        aggregateType: "case-profile",
        aggregateId: input.caseId,
        caseId: input.caseId,
        sourceService: "control-plane",
        title,
        summary: `${summary} completed`,
        result: {
          requested,
          response: outcome,
          postHangupEjection,
          hangup,
        },
      });
    })
    .catch((error) => {
      console.warn("[cx-callback-background-cleanup] failed", {
        caseId,
        queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
        error: error.message || String(error),
      });
    });
}

async function requestCxNextDialHandoff({ context, user, input = {} }) {
  const requestedNextDial = input.nextDial && typeof input.nextDial === "object"
    ? input.nextDial
    : null;
  if (!requestedNextDial?.phone) return null;

  const nextDialDomain = normalizeDomain(
    requestedNextDial.domain ||
      requestedNextDial.queueDomain ||
      context.domain,
  ) || context.domain;
  const {
    domain: _ignoredDomain,
    queueDomain: _ignoredQueueDomain,
    ...nextDialInput
  } = requestedNextDial;

  try {
    return await requestCxDial(nextDialDomain, user, {
      ...nextDialInput,
      assignedExtensionId:
        nextDialInput.assignedExtensionId ||
        context.account?.extensionId ||
        user?.extensionId ||
        input.assignedExtensionId ||
        null,
      requestedBySurface: "cx-next-call-handoff",
    });
  } catch (error) {
    return {
      ok: false,
      accepted: false,
      domain: nextDialDomain,
      status: error.status || 500,
      reason: error.message || "Next CX dial handoff failed",
      details: error.details || null,
    };
  }
}

function queueCxTerminalDispositionBackgroundCleanup({
  context,
  user,
  input = {},
  queueItem = null,
  caseId = null,
  outcome = null,
  requested = null,
  title = "Disposition requested",
  summary = "Apply disposition",
  disposition = null,
} = {}) {
  Promise.resolve()
    .then(async () => {
      const hangup = await hangupCxCallAfterDisposition({
        context,
        user,
        input: {
          ...input,
          skipAgentStateClearAfterRelay: Boolean(input.nextDial),
        },
        queueItem,
        caseId,
        disposition,
      });
      await recordWorkflowStage({
        domain: context.domain,
        family: "cx",
        subtype: "disposition",
        stage: "completed",
        aggregateType: "case-profile",
        aggregateId: input.caseId,
        caseId: input.caseId,
        sourceService: "control-plane",
        title,
        summary: `${summary} completed`,
        result: {
          requested,
          response: outcome,
          hangup,
        },
      });
    })
    .catch((error) => {
      console.warn("[cx-terminal-disposition-background-cleanup] failed", {
        caseId,
        queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
        disposition,
        error: error.message || String(error),
      });
    });
}

function writeShadowCxCallState(extensionId, patch, options = {}) {
  if (!isCxCanonicalCallWriteEnabled()) return null;
  if (!extensionId || !patch) return null;
  return writeCxCallLifecycleShadowState({
    agentStateRepository,
    extensionId,
    patch,
    logger: options.logger || null,
    reason: options.reason || null,
    event: options.event || null,
  });
}

async function clearAgentCxCallState(extensionId, source = "cx-call-state-clear", options = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) return null;
  const now = new Date();
  const existing = await agentStateRepository
    .findAgentStateByExtensionId(normalizedExtensionId)
    .catch(() => null);
  const existingCall = existing?.currentCall && typeof existing.currentCall === "object"
    ? existing.currentCall
    : {};
  const { skip: cxClearSkip, existingIdentity, requestedIdentity } = evaluateCxClear(
    existing,
    options.uii || options.rcxUii || null,
  );
  if (cxClearSkip) {
    return {
      skipped: true,
      reason: cxClearSkip,
      extensionId: normalizedExtensionId,
      existingIdentity,
      requestedIdentity,
    };
  }
  const dailyStats = applyCallEndedDailyStats(
    existing || {},
    normalizeDailyStats(existing?.dailyStats, now),
    { missed: false, date: now },
  );
  const clearLongCallHold =
    String(existing?.cxRouting?.reason || "").trim().toLowerCase() === "long-call-hold";
  const updated = await agentStateRepository.updateAgentState(normalizedExtensionId, {
    status: "available",
    activityState: "idle",
    activePlatform: "none",
    currentCall: {},
    dailyStats,
    ...(clearLongCallHold
      ? {
        "cxRouting.desiredAvailability": "available",
        "cxRouting.reason": "cx-call-ended",
        "cxRouting.syncedAt": now,
        "cxRouting.lastSource": source,
        "cxRouting.manualUnavailableAt": null,
        "cxRouting.pauseType": null,
        "cxRouting.pauseStartedAt": null,
        "cxRouting.pauseReleaseAt": null,
      }
      : {}),
    lastCallEndedAt: now,
    lastCallOutcome: "ended",
    lastActivityAt: now,
    lastStatusChange: now,
    "upstream.source": source,
    "upstream.mirroredAt": now,
  }).catch(() => null);
  writeShadowCxCallState(
    normalizedExtensionId,
    buildCxCallLifecyclePatch({
      writer: "cx-workspace",
      queueItemId: options.queueItemId || options.queueTicketId || null,
      caseId: options.caseId != null ? options.caseId : existing?.caseId || null,
      phone: options.phone || existingCall?.to || existingCall?.from || null,
      uii: options.uii || options.rcxUii || null,
      phase: "released",
      lastObservedAt: now,
      lastWriter: source,
    }),
    {
      logger: options.logger || null,
      reason: source || "cx-call-state-clear",
      event: "release",
    },
  );
  observeCxBucketTerminalOutcome({
    extensionId: normalizedExtensionId,
    queueItemId: options.queueItemId || options.queueTicketId || null,
    caseId: options.caseId != null ? options.caseId : existing?.caseId || null,
    phone: options.phone || existingCall?.to || existingCall?.from || null,
    uii: options.uii || options.rcxUii || null,
    outcome: source || "cx-call-state-clear",
    drainCurrentCall: true,
    logger: options.logger || null,
  }).catch((error) => {
    options.logger?.warn?.("cx.bucket.terminal_observed.failed", {
      extensionId: normalizedExtensionId,
      queueItemId: options.queueItemId || options.queueTicketId || null,
      error: error.message || String(error),
    });
  });
  if (
    updated?.activityState === "idle"
    && String(updated?.cxRouting?.desiredAvailability || "available").toLowerCase() === "available"
  ) {
    try {
      const { onAgentBecomesEligible } = require("./freshLeadAssignmentService");
      await onAgentBecomesEligible(normalizedExtensionId);
    } catch {
      // Best-effort: call-state cleanup must not fail because lead refill did.
    }
  }
  return updated;
}

async function ensureCxDealCaseProfile(domain, caseId, input = {}, dealHandoff = {}) {
  const normalizedCaseId = Number(caseId);
  if (!Number.isFinite(normalizedCaseId)) return null;

  let synced = null;
  try {
    synced = await syncCaseProfileFromLogics(domain, normalizedCaseId);
  } catch {
    synced = null;
  }

  const leadName = String(input.leadName || input.name || "").trim();
  const phone = input.phone || input.searchPhone || null;
  const normalizedPhone = normalizeUsPhone(phone);
  const [firstName, ...restName] = leadName.split(/\s+/).filter(Boolean);
  const fallbackPatch = synced
    ? {}
    : {
      name: leadName || null,
      firstName: input.firstName || firstName || null,
      lastName: input.lastName || restName.join(" ") || null,
      primaryPhone: phone || null,
      normalizedPhones: normalizedPhone ? [normalizedPhone] : undefined,
    };

  return caseProfileRepository.upsertCaseProfile(domain, normalizedCaseId, {
    ...fallbackPatch,
    paymentHandoff: dealHandoff,
  });
}

async function finalizeCxDispositionDeal(domain, input = {}) {
  const caseId = Number(input.caseId);
  if (!Number.isFinite(caseId)) return null;

  const now = new Date();
  const actionKey = extractQueueActionKey(input);
  const queueAction = await resolveActiveCxQueueAction(domain, caseId, actionKey);
  const actorEmail = input.actorEmail || null;
  const queueItemId = input.queueItemId || input.queueTicketId || null;
  const dealHandoff = {
    requestedAt: now,
    requestedBy: actorEmail,
    status: "pending-payment-processing",
    workflowId: input.workflowId || null,
    reviewItemId: input.reviewItemId || null,
    settlementOfficerId: resolveInputSettlementOfficerId(input),
    queueActionKey: queueAction?.actionKey || actionKey || null,
    queueItemId,
    leadName: input.leadName || input.name || null,
    notes: input.notes || null,
    phone: input.phone || null,
    requiredActions: {
      invoice: "required",
      amortization: "required",
      paymentSchedule: "pending",
    },
    processorAlertStatus: input.reviewItemId ? "review-queue-open" : "pending",
    source: "cx-disposition",
  };

  const caseProfile = await ensureCxDealCaseProfile(domain, caseId, input, {
    ...dealHandoff,
    caseProfileEnsuredAt: now,
  }).catch(() => null);

  await leadCadenceRepository.upsertLeadCadence(domain, caseId, {
    active: true,
    currentStage: "cx-deal-handoff-pending",
    "payloadSnapshot.dealHandoff": dealHandoff,
  }).catch(() => null);

  if (queueItemId) {
    await cxDialQueueRepository.updateQueueItem(queueItemId, {
      state: "serving",
      claimUntil: null,
      "metadata.dealHandoff": dealHandoff,
      "metadata.dealHandoffAt": now,
      "metadata.dealHandoffHold": true,
      "metadata.logicsStatusChanged": false,
    }).catch(() => null);
  }

  return {
    caseId,
    disposition: "Deal handoff",
    queueOutcome: queueAction?.actionKey || queueItemId ? "handoff-pending" : "noop",
    actionKey: queueAction?.actionKey || actionKey || null,
    paymentHandoffStatus: "pending",
    settlementOfficerId: dealHandoff.settlementOfficerId || null,
    caseProfileId: caseProfile?._id ? String(caseProfile._id) : null,
    logicsStatusChanged: false,
    callHeldOpen: true,
    rescheduledFor: null,
  };
}

async function finalizeCxQueueFromLogicsState(domain, caseId, input = {}, logicsRecord = null) {
  const normalizedCaseId = Number(caseId);
  if (!Number.isFinite(normalizedCaseId)) return null;

  const queueAction = await resolveActiveCxQueueAction(domain, normalizedCaseId, extractQueueActionKey(input));
  let latestRecord = logicsRecord && typeof logicsRecord === "object" ? logicsRecord : null;
  let statusId = extractLogicsStatusId(latestRecord);
  if (statusId == null) {
    try {
      const client = createLogicsClient(domain);
      latestRecord = parseLogicsData(await client.getCaseInfo(normalizedCaseId));
      statusId = extractLogicsStatusId(latestRecord);
    } catch {
      // Best-effort refresh — if Logics blips here we still finish the queue
      // with the partial data we have instead of failing the entire action.
    }
  }
  const statusInfo = resolveStatus(domain, statusId);
  const disposition = latestRecord?.StatusLabel || statusInfo?.label || `Status ${statusId ?? "Unknown"}`;
  const statusCategory = statusInfo?.category || "other";
  const stageToken = buildCxStageToken(statusCategory || disposition);

  if (isTerminalCxStatusCategory(statusCategory)) {
    if (queueAction?.actionKey) {
      await leadCadenceRepository.cancelPendingActions(domain, normalizedCaseId, {
        active: false,
        currentStage: stageToken,
        statusId,
      });
    }
    const queueMutation = await cancelCxQueueItem({
      domain,
      caseId: normalizedCaseId,
      queueItemId: input.queueItemId || input.queueTicketId || null,
      queueActionKey: extractQueueActionKey(input),
      reason: statusCategory || "terminal-status",
      queueOutcome: "cancelled",
      disposition,
      statusId,
      statusCategory,
      statusLabel: disposition,
      actorEmail: input.actorEmail || null,
    }).catch(() => null);
    const appointmentResolution = await cancelCxAppointmentsForCase(domain, normalizedCaseId, {
      reason: statusCategory || "terminal-status",
      actorEmail: input.actorEmail || null,
    }).catch((error) => ({ ok: false, error: error.message }));
    return {
      caseId: normalizedCaseId,
      disposition,
      statusId,
      statusCategory,
      queueOutcome: queueMutation?.mutated ? "cancelled" : queueAction?.actionKey ? "cancelled" : "noop",
      actionKey: queueAction?.actionKey || null,
      rescheduledFor: null,
      appointmentResolution,
    };
  }

  if (queueAction?.actionKey) {
    await leadCadenceRepository.markScheduledActionStatus(
      domain,
      normalizedCaseId,
      queueAction.actionKey,
      "completed",
      {
        active: true,
        currentStage: stageToken,
        statusId,
      },
    );
    await leadCadenceRepository.syncLeadCadenceState(domain, normalizedCaseId).catch(() => null);
  }
  const queueMutation = await completeCxQueueItem({
    domain,
    caseId: normalizedCaseId,
    queueItemId: input.queueItemId || input.queueTicketId || null,
    queueActionKey: extractQueueActionKey(input),
    queueOutcome: "completed",
    disposition,
    statusId,
    statusCategory,
    statusLabel: disposition,
    actorEmail: input.actorEmail || null,
  }).catch(() => null);

  return {
    caseId: normalizedCaseId,
    disposition,
    statusId,
    statusCategory,
    queueOutcome: queueMutation?.mutated ? "completed" : queueAction?.actionKey ? "completed" : "noop",
    actionKey: queueAction?.actionKey || null,
    rescheduledFor: null,
  };
}

function requireUserContext(user) {
  if (!user?.email) {
    const err = new Error("Authenticated user context is required");
    err.status = 401;
    throw err;
  }
}

async function resolveCxUserContext(domain, user) {
  requireUserContext(user);
  const normalizedDomain = normalizeDomain(domain || user.company || "TAG");
  let account =
    await userAccountRepository.findUserAccountByEmail(user.email) || {
      email: user.email,
      name: user.name || user.email,
      company: normalizedDomain,
      extensionId: user.extensionId || null,
      cxAgentId: user.cxAgentId || null,
      workspace: user.workspace || "cx",
      stationLabel: user.stationLabel || null,
      role: user.role,
      audience: user.audience,
    };
  const inferredExShells = inferExShells(account, user);
  if ((!Array.isArray(account.exShells) || account.exShells.length === 0) && inferredExShells.length > 0) {
    if (account.id) {
      account = await userAccountRepository.updateUserAccount(account.id, {
        exShells: inferredExShells,
      });
    } else {
      account = {
        ...account,
        exShells: inferredExShells,
      };
    }
  } else {
    account = {
      ...account,
      exShells: normalizeExShells(account.exShells || inferredExShells),
    };
  }
  const agentState = account.extensionId
    ? await agentStateRepository.findAgentStateByExtensionId(account.extensionId)
    : null;

  return {
    domain: normalizedDomain,
    account,
    agentState,
  };
}

async function ensureCxAgentExtensionContext(context, user) {
  let nextContext = context;
  let extensionId =
    nextContext.account?.extensionId ||
    user?.extensionId ||
    null;

  if (!extensionId) {
    const emailKey = String(nextContext.account?.email || user?.email || "anon")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, 32);
    extensionId = `sim-${emailKey}`;

    if (nextContext.account?.id) {
      const updatedAccount = await userAccountRepository.updateUserAccount(nextContext.account.id, {
        extensionId,
      });
      nextContext = {
        ...nextContext,
        account: updatedAccount,
      };
    } else {
      nextContext = {
        ...nextContext,
        account: {
          ...nextContext.account,
          extensionId,
        },
      };
    }
  }

  const agentState = extensionId
    ? await agentStateRepository.findAgentStateByExtensionId(extensionId)
    : null;

  return {
    ...nextContext,
    account: {
      ...nextContext.account,
      extensionId,
    },
    agentState,
  };
}

async function touchCxWorkspacePresenceForContext(context, user) {
  const extensionId = String(context?.account?.extensionId || user?.extensionId || "").trim();
  if (!extensionId) return context;
  ensureRingcxAgentOffhookAllowed(context?.account || user, {
    source: "cx-workspace-refresh",
    logger: console,
  }).catch((error) => {
    console.warn("ringcx.offhook.self_heal.workspace_failed", {
      email: context?.account?.email || user?.email || null,
      error: error.message,
    });
  });
  const agentState = await touchCxWorkspacePresence(extensionId, {
    active: true,
    source: "cx-workspace",
    userEmail: context?.account?.email || user?.email || null,
  }).catch(() => null);
  return agentState
    ? {
        ...context,
        agentState,
      }
    : context;
}

function resolveActiveExShell(context) {
  const shells = normalizeExShells(context?.account?.exShells || []);
  if (shells.length === 0) return null;
  const domain = normalizeDomain(context?.domain || context?.account?.company || "TAG");
  return (
    shells.find((shell) => shell.company === domain) ||
    shells.find((shell) => shell.company === normalizeDomain(context?.account?.company || "")) ||
    shells[0]
  );
}

function summarizeExShell(shell) {
  if (!shell) return null;
  return {
    company: shell.company || null,
    email: shell.email || null,
    name: shell.name || null,
    extensionNumber: shell.extensionNumber || null,
    loginPhones: Array.isArray(shell.loginPhones) ? shell.loginPhones : [],
    primaryPhone: shell.primaryPhone || null,
    rcExtensionId: shell.rcExtensionId || null,
    source: shell.source || null,
  };
}

function resolveTextTransportShell(context, userShell = null, options = {}) {
  if (!options.allowPipe) return userShell;
  const rcConfig = getRingCentralConfig();
  if (rcConfig.smsPipeEnabled) {
    const configuredShells = normalizeExShells(findExShellsForEmail(rcConfig.smsPipeEmail));
    const byExtensionNumber = configuredShells.find(
      (shell) =>
        rcConfig.smsPipeExtensionNumber &&
        String(shell.extensionNumber || "").trim() === String(rcConfig.smsPipeExtensionNumber || "").trim(),
    );
    const byEmail = configuredShells.find(
      (shell) => String(shell.email || "").trim().toLowerCase() === String(rcConfig.smsPipeEmail || "").trim().toLowerCase(),
    );
    return (
      byExtensionNumber ||
      byEmail ||
      normalizeExShell({
        company: "TAG",
        email: rcConfig.smsPipeEmail || "mgray@taxadvocategroup.com",
        name: "Universal SMS Pipe",
        extensionNumber: rcConfig.smsPipeExtensionNumber || "101",
        loginPhones: rcConfig.smsPipePhone ? [rcConfig.smsPipePhone] : [],
        primaryPhone: rcConfig.smsPipePhone || null,
        source: "ringcentral-sms-pipe",
      })
    );
  }
  return userShell;
}

async function listCxOpenItems(domain, user, category = null, limit = 25) {
  const items = await reviewQueueRepository.listReviewQueueItems(domain, {
    workflow: "cx-user",
    status: "open",
    category: category || undefined,
    limit: Math.max(Number(limit) * 3, Number(limit) || 25),
  });
  return items
    .filter((item) => {
      const assigneeEmail = String(item.payload?.assigneeEmail || "").trim().toLowerCase();
      return !assigneeEmail || assigneeEmail === String(user.email || "").trim().toLowerCase();
    })
    .slice(0, Math.min(Number(limit) || 25, 100));
}

function summarizeCallQueueItem(item) {
  const actions = Array.isArray(item.schedule?.actions) ? item.schedule.actions : [];
  const nextAction = actions
    .filter((entry) => entry.channel === "cx" && (entry.status === "pending" || entry.status === "requested"))
    .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime())[0];
  const payloadSnapshot = item.payloadSnapshot || null;
  const callPlan = payloadSnapshot?.callPlan || null;
  const activeDay = Number.isFinite(Number(callPlan?.activeDay)) ? Number(callPlan.activeDay) : null;
  const explicitFamily =
    payloadSnapshot?.queueFamily ||
    payloadSnapshot?.queueTier ||
    payloadSnapshot?.leadQueueFamily ||
    null;
  const createdAtFamily = deriveQueueFamilyFromLeadCreatedAt(
    payloadSnapshot?.leadCreatedAt
      || payloadSnapshot?.createdAt
      || item.leadCreatedAt
      || item.createdAt
      || null,
    new Date(),
    {
      placedCalls:
        item.placedCalls
        ?? item.metadata?.placedCalls
        ?? payloadSnapshot?.placedCalls
        ?? payloadSnapshot?.metadata?.placedCalls
        ?? 0,
    },
  );
  const derivedFamily = createdAtFamily
    || explicitFamily
    || (activeDay != null && activeDay <= 2 ? "fresh-day1" : null)
    || (activeDay != null && activeDay > 2 && activeDay <= 15 ? "fresh-day2to10" : null)
    || (activeDay != null && activeDay > 15 && activeDay <= 30 ? "fresh-day16to30" : null)
    || (activeDay != null && activeDay > 120 ? "dead" : null)
    || (activeDay != null && activeDay > 30 ? "aged" : null)
    || (String(item.currentStage || "").toLowerCase().includes("aged") ? "aged" : null);
  const progressiveStageKey =
    item.progressiveStageKey ||
    payloadSnapshot?.progressiveStageKey ||
    (nextAction?.key === "cx-day0-1" ? "just-came-in" : null) ||
    (nextAction?.key === "cx-day0-2" ? "second-contact" : null) ||
    (nextAction?.key === "cx-day0-3" ? "third-contact" : null) ||
    null;
  const progressiveStageIndex =
    Number.isFinite(Number(item.progressiveStageIndex)) ? Number(item.progressiveStageIndex) :
      Number.isFinite(Number(payloadSnapshot?.progressiveStageIndex)) ? Number(payloadSnapshot.progressiveStageIndex) :
        progressiveStageKey === "just-came-in" ? 0 :
          progressiveStageKey === "second-contact" ? 1 :
            progressiveStageKey === "third-contact" ? 2 :
              99;
  const ageBucket = deriveUcqAgeBucket({
    ...item,
    queueFamily: derivedFamily,
    progressiveStageKey,
    progressiveStageIndex,
  });

  return {
    domain: item.domain,
    caseId: item.caseId,
    intakeSource: item.intakeSource || null,
    intakeRoute: item.intakeRoute || null,
    active: item.active,
    currentStage: item.currentStage || null,
    nextActionType: item.schedule?.nextActionType || null,
    nextActionAt: item.schedule?.nextActionAt || null,
    cxAction: nextAction || null,
    score: item.priorityScore || null,
    queueFamily: derivedFamily,
    ageBucket,
    progressiveStageKey,
    progressiveStageIndex,
    progressiveStageLabel: item.progressiveStageLabel || payloadSnapshot?.progressiveStageLabel || null,
    queueDayIndex: activeDay,
    payloadSnapshot,
    leadBody: payloadSnapshot?.leadBody || payloadSnapshot,
    interviewSnapshot: item.interviewSnapshot || null,
  };
}

function isCxAdminViewer(user = {}, context = {}) {
  const role = String(user?.role || context?.account?.role || "").trim().toLowerCase();
  const audience = String(user?.audience || context?.account?.audience || "").trim().toLowerCase();
  return role === "admin" || audience === "admin";
}

function isFallbackAfterFirstContactViewer(context = {}) {
  const account = context?.account && typeof context.account === "object"
    ? context.account
    : {};
  const metadata = account.metadata && typeof account.metadata === "object"
    ? account.metadata
    : {};
  const mode = String(
    metadata.cxQueueVisibilityMode
      || metadata.cxQueueMode
      || "",
  ).trim().toLowerCase();
  return (
    mode === "fallback_after_first_contact"
    || metadata.cxFallbackAfterFirstContact === true
  );
}

function isQueueItemUnassigned(queueItem = {}) {
  return !String(queueItem?.assignment?.extensionId || "").trim();
}

function isPostFirstContactQueueItem(queueItem = {}) {
  const family = normalizeCxQueueFamily(
    queueItem.queueFamily
      || queueItem.assignment?.queueFamilySnapshot
      || queueItem.metadata?.queueFamily
      || "",
  );
  if (family === "fresh-day2to10" || family === "fresh-day16to30" || family === "aged") return true;

  const stageIndex = Number(queueItem.progressiveStageIndex);
  if (Number.isFinite(stageIndex) && stageIndex > 0 && stageIndex < 99) return true;

  const stageKey = String(queueItem.progressiveStageKey || "").trim().toLowerCase();
  if (["second-contact", "third-contact"].includes(stageKey)) return true;

  const placedCalls = Number(queueItem.placedCalls || queueItem.metadata?.placedCalls || 0);
  if (Number.isFinite(placedCalls) && placedCalls > 0) return true;

  if (queueItem.metadata?.lastQueueAttemptAt) return true;
  const phaseIndex = Number(queueItem.callPlan?.phaseIndex || 0);
  return Number.isFinite(phaseIndex) && phaseIndex > 0;
}

function getQueueItemRouteCampaignKey(queueItem = {}) {
  return String(
    queueItem?.metadata?.routeCampaignKey ||
      queueItem?.routeCampaignKey ||
      "",
  ).trim().toLowerCase();
}

function isQueueItemAllowedByAgentRouteCampaign(queueItem = {}, context = {}) {
  const family = normalizeCxQueueFamily(
    queueItem.queueFamily ||
      queueItem.assignment?.queueFamilySnapshot ||
      queueItem.metadata?.queueFamily ||
      "",
  );
  if (family !== "fresh-day1") return true;

  const policy = resolveAccountQueuePolicy(context.account || {});
  const routeCampaigns = normalizeRouteCampaigns(policy.routeCampaigns);
  if (!routeCampaigns || routeCampaigns.length === 0) return true;

  const routeKey = getQueueItemRouteCampaignKey(queueItem);
  return routeKey ? routeCampaigns.includes(routeKey) : false;
}

function isQueueItemHeldForFutureAppointment(queueItem = {}) {
  const metadata = queueItem?.metadata || {};
  const holdReason = String(metadata.dialabilityHoldReason || "").trim().toLowerCase();
  const appointmentStatus = String(metadata.appointmentStatus || "").trim().toLowerCase();
  if (holdReason !== "appointment" || !["scheduled", "blocked"].includes(appointmentStatus)) {
    return false;
  }
  const holdUntil = metadata.dialabilityHoldUntil || queueItem.releaseAt || metadata.appointmentLegalDialAt;
  const holdUntilMs = holdUntil ? new Date(holdUntil).getTime() : null;
  return !Number.isFinite(holdUntilMs) || holdUntilMs > Date.now();
}

function canViewQueueItemForAgent(queueItem = {}, context = {}) {
  const agentExtensionId = String(context?.account?.extensionId || "").trim();
  if (!agentExtensionId) return false;
  const assignedExtensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (assignedExtensionId) {
    if (assignedExtensionId !== agentExtensionId) return false;
    if (getQueueItemState(queueItem) === "serving") return true;
    if (isQueueItemHeldForFutureAppointment(queueItem)) return false;
    return isQueueItemAllowedByAgentRouteCampaign(queueItem, context);
  }
  return Boolean(
    isFallbackAfterFirstContactViewer(context)
      && String(queueItem.state || "").trim().toLowerCase() === "ready"
      && isQueueItemUnassigned(queueItem)
      && isPostFirstContactQueueItem(queueItem),
  );
}

function summarizeQueueDebugItem(item = {}) {
  return {
    id: item?._id ? String(item._id) : null,
    domain: item.domain || null,
    caseId: item.caseId || null,
    state: item.state || null,
    queueFamily: item.queueFamily || item.metadata?.queueFamily || null,
    routeCampaignKey: getQueueItemRouteCampaignKey(item) || null,
    assignedExtensionId: item.assignment?.extensionId || null,
    actionKey: item.metadata?.actionKey || null,
  };
}

function writeCxWorkspaceQueueDebug(event, meta = {}) {
  if (!readBooleanEnv("RC_CX_WORKSPACE_QUEUE_DEBUG", false)) return;
  console.log(`cx.workspace.queue.${event}`, meta);
}

function parseQueueFamilyList(value, fallback = []) {
  return normalizeLeadQueueFamilyList(value, fallback);
}

function parseDomainList(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const domains = Array.from(
    new Set(
      raw
        .map((entry) => normalizeDomain(entry))
        .filter(Boolean),
    ),
  );
  return domains.length > 0 ? domains : fallback;
}

function applyRouteCampaignFilter(query = {}, routeCampaigns = null) {
  const normalized = normalizeRouteCampaigns(routeCampaigns);
  if (normalized && normalized.length > 0) {
    query.routeCampaignKey = { $in: normalized };
  }
  return query;
}

function resolveCxQueueDomains(context = {}) {
  const configured = parseDomainList(
    process.env.RC_CX_QUEUE_DOMAINS || process.env.RC_CX_AGENT_QUEUE_DOMAINS,
    [],
  );
  if (configured.length > 0) return configured;
  return ["WYNN"];
}

async function listActiveCxQueueItemsForAgent(context, agentExtensionId) {
  const readAllAssignedDomains =
    String(process.env.RC_CX_AGENT_QUEUE_ALL_DOMAINS || "true").toLowerCase() !== "false";
  return cxDialQueueRepository.listQueueItems({
    ...(readAllAssignedDomains ? {} : { domain: context.domain }),
    states: ["queued", "ready", "claimed", "serving", "paused"],
    visibleExtensionId: agentExtensionId,
    includeUnassignedVisible: isFallbackAfterFirstContactViewer(context),
    limitAll: true,
  });
}

function buildQueueCadenceKey(domain, caseId) {
  const normalizedDomain = normalizeDomain(domain || "");
  const normalizedCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(normalizedCaseId)) return null;
  return `${normalizedDomain}:${normalizedCaseId}`;
}

function getQueueItemFamily(queueItem = {}) {
  return normalizeCxQueueFamily(deriveQueueFamily(queueItem));
}

function countVisibleQueueItemsByFamily(visibleQueueItems = [], queueFamilies = []) {
  const familySet = new Set(
    queueFamilies.map((family) => normalizeCxQueueFamily(family)),
  );
  return visibleQueueItems.filter((item) => familySet.has(getQueueItemFamily(item))).length;
}

function isQueueItemAssignedToAgent(queueItem = {}, agentExtensionId = null) {
  const wanted = String(agentExtensionId || "").trim();
  if (!wanted) return true;
  return String(
    queueItem?.assignment?.extensionId ||
      queueItem?.assignedExtensionId ||
      queueItem?.metadata?.assignedExtensionId ||
      "",
  ).trim() === wanted;
}

function listQueueItemsByFamily(visibleQueueItems = [], queueFamilies = [], agentExtensionId = null) {
  const familySet = new Set(
    queueFamilies.map((family) => normalizeCxQueueFamily(family)),
  );
  return visibleQueueItems.filter((item) =>
    familySet.has(getQueueItemFamily(item)) &&
    isQueueItemAssignedToAgent(item, agentExtensionId));
}

function getQueueItemAssignmentPackId(queueItem = {}) {
  return String(
    queueItem?.metadata?.assignmentPackId ||
      queueItem?.assignmentPackId ||
      "",
  ).trim();
}

function getQueueItemAssignmentPackSealedAt(queueItem = {}) {
  return queueItem?.metadata?.assignmentPackSealedAt || null;
}

function hasSealedAssignmentPackMarker(queueItems = []) {
  return queueItems.some((item) =>
    Boolean(getQueueItemAssignmentPackId(item)) &&
    Boolean(getQueueItemAssignmentPackSealedAt(item)));
}

function buildAssignmentPack({
  context = {},
  agentExtensionId = null,
  queueFamilies = [],
  targetCount = 0,
  source = "cx-workspace-refill",
} = {}) {
  const createdAt = new Date();
  const normalizedFamilies = normalizeLeadQueueFamilyList(queueFamilies);
  const family = normalizedFamilies.join("+") || "queue";
  const safeFamily = family.replace(/[^a-z0-9+_-]/gi, "-");
  return {
    id: [
      "cx-pack",
      normalizeDomain(context.domain || context.account?.company || "NA"),
      String(agentExtensionId || "agent").trim() || "agent",
      safeFamily,
      Math.max(Number(targetCount) || 0, 0),
      createdAt.getTime(),
      Math.random().toString(36).slice(2, 8),
    ].join(":"),
    family,
    target: Math.max(Number(targetCount) || 0, 0),
    createdAt,
    sealedAt: null,
    source,
  };
}

function buildAssignmentPackUpdate(pack) {
  if (!pack?.id) return {};
  return {
    "metadata.assignmentPackId": pack.id,
    "metadata.assignmentPackFamily": pack.family || null,
    "metadata.assignmentPackTarget": pack.target || null,
    "metadata.assignmentPackCreatedAt": pack.createdAt || new Date(),
    "metadata.assignmentPackSealedAt": pack.sealedAt || null,
    "metadata.assignmentPackSource": pack.source || "cx-workspace-refill",
  };
}

async function stampQueueItemsWithAssignmentPack(queueItems = [], pack = null) {
  if (!pack?.id || !Array.isArray(queueItems) || queueItems.length === 0) return { stamped: 0 };
  let stamped = 0;
  await Promise.all(
    queueItems
      .filter((item) => item?._id)
      .map(async (item) => {
        const updated = await cxDialQueueRepository.updateQueueItem(
          item._id,
          buildAssignmentPackUpdate(pack),
        ).catch(() => null);
        if (updated) stamped += 1;
      }),
  );
  return { stamped };
}

function getPositiveEnvNumber(name, fallback) {
  return Math.max(Number(process.env[name]) || fallback, 1);
}

function readBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getNonNegativeEnvNumber(name, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, name)) {
    const number = Number(process.env[name]);
    if (Number.isFinite(number) && number >= 0) return Math.trunc(number);
  }
  return Math.max(Number(fallback) || 0, 0);
}

function readExplicitAccountTargetOpen(account = null, family = null) {
  const policy = account?.cxQueuePolicy && typeof account.cxQueuePolicy === "object"
    ? account.cxQueuePolicy
    : null;
  if (!policy) return null;
  const normalizedFamily = normalizeCxQueueFamily(family);
  const raw =
    normalizedFamily === "fresh-day1"
      ? policy.fresh?.targetOpen
      : normalizedFamily === "fresh-day2to10"
        ? policy.day2to15?.targetOpen
        : normalizedFamily === "fresh-day16to30"
          ? policy.day16to30?.targetOpen
          : normalizedFamily === "aged"
            ? policy.aged?.targetOpen
            : null;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function resolveQueueFamilyTargetOpen(context = {}, queuePolicy = {}, family = null, envName = null) {
  const explicit = readExplicitAccountTargetOpen(context.account || null, family);
  if (explicit != null) return explicit;
  const fallback =
    normalizeCxQueueFamily(family) === "fresh-day1"
      ? queuePolicy.fresh?.targetOpen
      : normalizeCxQueueFamily(family) === "fresh-day2to10"
        ? queuePolicy.day2to15?.targetOpen
        : normalizeCxQueueFamily(family) === "fresh-day16to30"
          ? queuePolicy.day16to30?.targetOpen
          : normalizeCxQueueFamily(family) === "aged"
            ? queuePolicy.aged?.targetOpen
            : 0;
  return envName ? getNonNegativeEnvNumber(envName, fallback) : Math.max(Number(fallback) || 0, 0);
}

function getQueueItemState(queueItem = {}) {
  return String(queueItem?.state || "").trim().toLowerCase();
}

function isBulkLoadReservedQueueItem(queueItem = {}) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object" ? queueItem.metadata : {};
  return String(metadata.reservationRail || "").trim() === "bulk_load" || Boolean(metadata.bulkLoadSessionId);
}

function isQueueItemReleasableFromWorkspacePack(queueItem = {}) {
  if (isBulkLoadReservedQueueItem(queueItem)) return false;
  const state = getQueueItemState(queueItem);
  return ["claimed", "queued", "ready", "paused"].includes(state);
}

function sortQueueItemsForWorkspacePack(left = {}, right = {}) {
  const leftServing = getQueueItemState(left) === "serving";
  const rightServing = getQueueItemState(right) === "serving";
  if (leftServing !== rightServing) return leftServing ? -1 : 1;

  const now = new Date();
  const leftRank = getCxQueueServeRank(left, { now });
  const rightRank = getCxQueueServeRank(right, { now });
  if (leftRank !== rightRank) return leftRank - rightRank;

  const leftStage = Number.isFinite(Number(left.progressiveStageIndex)) ? Number(left.progressiveStageIndex) : 99;
  const rightStage = Number.isFinite(Number(right.progressiveStageIndex)) ? Number(right.progressiveStageIndex) : 99;
  if (leftStage !== rightStage) return leftStage - rightStage;

  const leftTime = left.releaseAt ? new Date(left.releaseAt).getTime() : Number.MAX_SAFE_INTEGER;
  const rightTime = right.releaseAt ? new Date(right.releaseAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (leftTime !== rightTime) return leftTime - rightTime;

  return String(left.caseId || "").localeCompare(String(right.caseId || ""));
}

function countOpenAssignedQueueItems(queueItems = [], agentExtensionId = null) {
  return queueItems.filter((item) =>
    isQueueItemAssignedToAgent(item, agentExtensionId) &&
      ["claimed", "serving", "queued", "ready", "paused"].includes(getQueueItemState(item))).length;
}

async function reconcileAgentQueueAssignmentStats(agentExtensionId, visibleQueueItems = []) {
  const normalizedExtensionId = String(agentExtensionId || "").trim();
  if (!normalizedExtensionId) return { ok: true, skipped: true, reason: "missing-extension-id" };

  const agentState = await agentStateRepository.findAgentStateByExtensionId(normalizedExtensionId)
    .catch(() => null);
  if (!agentState) return { ok: true, skipped: true, reason: "agent-not-found" };

  const existingStats = agentState?.cxRouting?.assignmentStats && typeof agentState.cxRouting.assignmentStats === "object"
    ? agentState.cxRouting.assignmentStats
    : {};
  const actualOpenAssignments = countOpenAssignedQueueItems(visibleQueueItems, normalizedExtensionId);
  if (Number(existingStats.openAssignments || 0) === actualOpenAssignments) {
    return { ok: true, updated: false, openAssignments: actualOpenAssignments };
  }

  const nextStats = {
    ...existingStats,
    date: existingStats.date || getPacificDateKey(new Date()),
    openAssignments: actualOpenAssignments,
  };
  await agentStateRepository.updateAgentState(normalizedExtensionId, {
    "cxRouting.assignmentStats": nextStats,
    "cxRouting.syncedAt": new Date(),
  }).catch(() => null);
  return { ok: true, updated: true, openAssignments: actualOpenAssignments };
}

async function reconcileRouteCampaignAssignmentsForAgent({
  context = {},
  agentExtensionId,
  activeQueueItems = [],
} = {}) {
  const normalizedExtensionId = String(agentExtensionId || "").trim();
  if (!normalizedExtensionId) {
    return { ok: true, released: 0, skipped: true, reason: "missing-extension-id" };
  }

  const policy = resolveAccountQueuePolicy(context.account || {});
  const routeCampaigns = normalizeRouteCampaigns(policy.routeCampaigns);
  if (!routeCampaigns || routeCampaigns.length === 0) {
    return { ok: true, released: 0, skipped: true, reason: "all-green-routes-allowed" };
  }

  const releaseCandidates = activeQueueItems.filter((item) =>
    isQueueItemAssignedToAgent(item, normalizedExtensionId) &&
      !isQueueItemAllowedByAgentRouteCampaign(item, context) &&
      isQueueItemReleasableFromWorkspacePack(item));
  if (releaseCandidates.length === 0) {
    return { ok: true, released: 0, skipped: true, reason: "no-route-mismatch" };
  }

  const releaseResults = [];
  for (const item of releaseCandidates) {
    const queueItemId = String(item?._id || "");
    if (!queueItemId) continue;
    const result = await releaseCxQueueItem({
      queueItemId,
      reason: "queue-route-campaign-mismatch",
      actorEmail: context.account?.email || null,
    }).catch((error) => ({
      ok: false,
      queueItemId,
      error: error.message,
    }));
    releaseResults.push(result);
  }

  return {
    ok: true,
    released: releaseResults.filter((entry) => entry?.mutated).length,
    attempted: releaseCandidates.length,
    routeCampaigns,
    results: releaseResults,
  };
}

async function reconcileWorkspaceQueuePacksForAgent({
  agentExtensionId,
  visibleQueueItems = [],
  familyTargets = [],
  reason = "queue-over-target-trim",
  actorEmail = null,
} = {}) {
  const normalizedExtensionId = String(agentExtensionId || "").trim();
  if (!normalizedExtensionId) {
    return { ok: true, released: 0, visibleQueueItems, skipped: true, reason: "missing-extension-id" };
  }

  const releaseIds = new Set();
  const releaseResults = [];
  for (const targetConfig of familyTargets) {
    const queueFamilies = parseQueueFamilyList(targetConfig.queueFamilies || [], []);
    const targetCount = Math.max(Number(targetConfig.targetCount || 0), 0);
    if (queueFamilies.length === 0) continue;

    const currentItems = listQueueItemsByFamily(visibleQueueItems, queueFamilies, normalizedExtensionId)
      .slice()
      .sort(sortQueueItemsForWorkspacePack);
    if (currentItems.length <= targetCount) continue;

    const keepIds = new Set(
      currentItems
        .slice(0, targetCount)
        .map((item) => String(item?._id || ""))
        .filter(Boolean),
    );
    for (const item of currentItems) {
      const itemId = String(item?._id || "");
      if (!itemId || keepIds.has(itemId)) continue;
      if (!isQueueItemReleasableFromWorkspacePack(item)) continue;
      releaseIds.add(itemId);
    }
  }

  for (const queueItemId of releaseIds) {
    const result = await releaseCxQueueItem({
      queueItemId,
      reason,
      actorEmail,
    }).catch((error) => ({
      ok: false,
      queueItemId,
      error: error.message,
    }));
    releaseResults.push(result);
  }

  const releasedIds = new Set(
    releaseResults
      .filter((entry) => entry?.mutated)
      .map((entry) => String(entry.queueItemId || ""))
      .filter(Boolean),
  );
  const nextVisibleQueueItems = releasedIds.size > 0
    ? visibleQueueItems.filter((item) => !releasedIds.has(String(item?._id || "")))
    : visibleQueueItems;
  const stats = await reconcileAgentQueueAssignmentStats(normalizedExtensionId, nextVisibleQueueItems);

  return {
    ok: true,
    released: releasedIds.size,
    attempted: releaseIds.size,
    visibleQueueItems: nextVisibleQueueItems,
    results: releaseResults,
    stats,
  };
}

const ACTIVE_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
let lastQueueOrderingBackfillAt = 0;
const cxWorkspaceRefillInFlight = new Map();
const NON_DIALABLE_STAGE_PATTERN = /\b(dnc|do not call|post\s*date|post-date|sold|deal|bad inactive|inactive)\b/i;

function getPacificMonthTag(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return `filler-${year}-${month}`;
}

function getLeadAgeDays(createdAt, now = new Date()) {
  return getPacificBusinessDayAge(createdAt, now);
}

function pickLeadCadencePhone(doc = {}) {
  return normalizeUsPhone(doc.normalizedPhone || doc.primaryPhone);
}

function pickMasterProspectPhone(doc = {}) {
  const phones = Array.isArray(doc.normalizedPhones) ? doc.normalizedPhones : [];
  return normalizeUsPhone(phones[0] || doc.cellPhone || doc.homePhone || doc.workPhone);
}

function pickLeadName(doc = {}) {
  return String(
    doc.name ||
      [doc.firstName, doc.lastName].filter(Boolean).join(" ") ||
      "Lead Prospect",
  ).trim();
}

function isCxBlockedLeadCadence(doc = {}) {
  if (!doc.active) return true;
  const stage = String(doc.currentStage || "").trim();
  if (stage && NON_DIALABLE_STAGE_PATTERN.test(stage)) return true;
  const cxDnc = doc.cadenceState?.channelDnc?.cx;
  return Boolean(cxDnc?.blocked || doc.dncCheckpoints?.hit);
}

function readCadenceCxTouchState(cadence = {}) {
  const counter = cadence?.counterCadence && typeof cadence.counterCadence === "object"
    ? cadence.counterCadence
    : {};
  const payload = cadence?.payloadSnapshot && typeof cadence.payloadSnapshot === "object"
    ? cadence.payloadSnapshot
    : {};
  return {
    leadState: cadence.state || payload.state || null,
    leadTimeZone:
      payload.timezone ||
      payload.timeZone ||
      null,
    lastTouchedAt:
      cadence?.lastTouched?.cx ||
      counter.lastCxDialedAt ||
      payload.lastCxDialedAt ||
      null,
    lastTouchedExtensionId: String(
      counter.lastCxDialedByExtensionId ||
        payload.lastCxDialedByExtensionId ||
        "",
    ).trim() || null,
    lastTouchedAgentName:
      counter.lastCxDialedByAgentName ||
      payload.lastCxDialedByAgentName ||
      null,
    totalCalls: Math.max(Number(cadence?.cadenceCounters?.cx || 0) || 0, 0),
    answeredContacts: Math.max(Number(
      counter.cxAnsweredContacts ||
        payload.cxAnsweredContacts ||
        0,
    ) || 0, 0),
    noAnswerCalls: Math.max(Number(
      counter.cxNoAnswerCalls ||
        payload.cxNoAnswerCalls ||
        0,
    ) || 0, 0),
    dailyDateKey: String(counter.cxDailyDateKey || "").trim() || null,
    dailyCalls: Math.max(Number(counter.cxDailyCalls || 0) || 0, 0),
    monthlyMonthKey: String(counter.cxMonthlyMonthKey || "").trim() || null,
    monthlyCalls: Math.max(Number(counter.cxMonthlyCalls || 0) || 0, 0),
  };
}

function readProspectCxTouchState(prospect = {}) {
  const filler = prospect?.filler && typeof prospect.filler === "object"
    ? prospect.filler
    : {};
  const payload = prospect?.payloadSnapshot && typeof prospect.payloadSnapshot === "object"
    ? prospect.payloadSnapshot
    : {};
  return {
    leadState: prospect.state || payload.state || null,
    leadTimeZone:
      prospect.timeZone ||
      prospect.timezone ||
      payload.timeZone ||
      payload.timezone ||
      null,
    lastTouchedAt: filler.lastDialAttempt || null,
    lastTouchedExtensionId: String(filler.lastDialedByExtensionId || "").trim() || null,
    lastTouchedAgentName: filler.lastDialedByAgentName || null,
    totalCalls: Math.max(Number(filler.attemptCount || 0) || 0, 0),
    answeredContacts: Math.max(Number(filler.answeredContacts || 0) || 0, 0),
    noAnswerCalls: Math.max(Number(filler.noAnswerCalls || 0) || 0, 0),
    dailyDateKey: String(filler.dailyDateKey || "").trim() || null,
    dailyCalls: Math.max(Number(filler.dailyAttempts || 0) || 0, 0),
    monthlyMonthKey: String(filler.monthlyMonthKey || "").trim() || null,
    monthlyCalls: Math.max(Number(filler.monthlyAttempts || 0) || 0, 0),
  };
}

function buildMaterializedTouchPatch(touchState = {}, now = new Date()) {
  const dateKey = getPacificDateKey(now);
  const monthKey = getPacificMonthKey(now);
  return {
    placedCalls: Number(touchState.totalCalls || 0) || 0,
    lastPlacedAt: touchState.lastTouchedAt || null,
    dailyPlacedDateKey: touchState.dailyDateKey || null,
    dailyPlacedCalls: touchState.dailyDateKey === dateKey
      ? Math.max(Number(touchState.dailyCalls || 0) || 0, 0)
      : 0,
    monthlyPlacedMonthKey: touchState.monthlyMonthKey || null,
    monthlyPlacedCalls: touchState.monthlyMonthKey === monthKey
      ? Math.max(Number(touchState.monthlyCalls || 0) || 0, 0)
      : 0,
    "metadata.answeredContacts": Math.max(Number(touchState.answeredContacts || 0) || 0, 0),
    "metadata.cxAnsweredContacts": Math.max(Number(touchState.answeredContacts || 0) || 0, 0),
    "metadata.unansweredCalls": Math.max(Number(touchState.noAnswerCalls || 0) || 0, 0),
    "metadata.noAnswerCalls": Math.max(Number(touchState.noAnswerCalls || 0) || 0, 0),
    "metadata.cxNoAnswerCalls": Math.max(Number(touchState.noAnswerCalls || 0) || 0, 0),
    "metadata.lastQueueAttemptAt": touchState.lastTouchedAt || null,
    "metadata.lastTouchedAt": touchState.lastTouchedAt || null,
    "metadata.lastTouchedExtensionId": touchState.lastTouchedExtensionId || null,
    "metadata.lastTouchedAgentName": touchState.lastTouchedAgentName || null,
    "metadata.lastCxDialedByExtensionId": touchState.lastTouchedExtensionId || null,
    "metadata.lastCxDialedByAgentName": touchState.lastTouchedAgentName || null,
    "metadata.leadState": touchState.leadState || null,
    "metadata.leadTimeZone": touchState.leadTimeZone || null,
  };
}

function leadCxTouchViolatesAgentOrPolicy({
  touchState = {},
  queueFamily,
  agentExtensionId = null,
  now = new Date(),
}) {
  const normalizedAgentExtensionId = String(agentExtensionId || "").trim();
  if (
    normalizedAgentExtensionId &&
    touchState.lastTouchedExtensionId &&
    normalizedAgentExtensionId === String(touchState.lastTouchedExtensionId)
  ) {
    return {
      blocked: true,
      reason: "last-agent-called-lead",
      nextEligibleAt: null,
    };
  }

  const synthetic = {
    queueFamily,
    placedCalls: Number(touchState.totalCalls || 0) || 0,
    lastPlacedAt: touchState.lastTouchedAt || null,
    dailyPlacedDateKey: touchState.dailyDateKey || null,
    dailyPlacedCalls: Number(touchState.dailyCalls || 0) || 0,
    monthlyPlacedMonthKey: touchState.monthlyMonthKey || null,
    monthlyPlacedCalls: Number(touchState.monthlyCalls || 0) || 0,
    metadata: {
      queueFamily,
      leadState: touchState.leadState || null,
      leadTimeZone: touchState.leadTimeZone || null,
      lastQueueAttemptAt: touchState.lastTouchedAt || null,
      dailyPlacedDateKey: touchState.dailyDateKey || null,
      dailyPlacedCalls: Number(touchState.dailyCalls || 0) || 0,
      monthlyPlacedMonthKey: touchState.monthlyMonthKey || null,
      monthlyPlacedCalls: Number(touchState.monthlyCalls || 0) || 0,
      answeredContacts: Number(touchState.answeredContacts || 0) || 0,
      cxAnsweredContacts: Number(touchState.answeredContacts || 0) || 0,
      unansweredCalls: Number(touchState.noAnswerCalls || 0) || 0,
      noAnswerCalls: Number(touchState.noAnswerCalls || 0) || 0,
      cxNoAnswerCalls: Number(touchState.noAnswerCalls || 0) || 0,
    },
  };
  const dialability = resolveQueueDialability(synthetic, now);
  if (!dialability.ok) {
    return {
      blocked: true,
      reason: dialability.reason,
      nextEligibleAt: dialability.nextEligibleAt || null,
      detail: dialability.detail || null,
    };
  }
  return {
    blocked: false,
    reason: "eligible",
    nextEligibleAt: null,
  };
}

function buildQueueRoutingPatch(queueFamily) {
  const routing = resolveRcxRoutingForQueueIntent({ queueFamily });
  return {
    rcxAccountId: routing.accountId,
    rcxDialGroupId: routing.dialGroupId,
    rcxCampaignId: routing.campaignId,
  };
}

async function queueActionAlreadyExists(domain, caseId, actionKey) {
  if (!actionKey) return false;
  const existing = await CxDialQueue.findOne(
    {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
      "metadata.actionKey": actionKey,
    },
    { _id: 1 },
  ).lean();
  return Boolean(existing);
}

async function activeQueueCaseExists(domain, caseId) {
  const existing = await CxDialQueue.findOne(
    {
      domain: normalizeDomain(domain),
      caseId: Number(caseId),
      state: { $in: ACTIVE_QUEUE_STATES },
    },
    { _id: 1 },
  ).lean();
  return Boolean(existing);
}

async function materializeDay2To15QueueItems(domain, neededCount, options = {}) {
  const count = Math.max(Number(neededCount) || 0, 0);
  if (count <= 0) return { ok: true, created: 0, scanned: 0, source: "lead-cadence" };

  const now = options.now || new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const currentFreshWindowStart = getPacificBusinessDayStart(now);
  const windowStart = new Date(currentFreshWindowStart.getTime() - 16 * dayMs);
  const windowEnd = currentFreshWindowStart;
  const dateKey = getPacificDateKey(now);
  const normalizedDomain = normalizeDomain(domain);
  const scanLimit = Math.min(Math.max(count * 8, 40), 300);
  const routingPatch = buildQueueRoutingPatch("fresh-day2to10");
  const cadenceQuery = applyRouteCampaignFilter({
    domain: normalizedDomain,
    active: true,
    createdAt: { $gte: windowStart, $lt: windowEnd },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  }, options.routeCampaigns);
  const candidates = await LeadCadence.find(cadenceQuery)
    .sort({
      "lastTouched.cx": 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .limit(scanLimit)
    .lean();

  let created = 0;
  let scanned = 0;
  for (const cadence of candidates) {
    if (created >= count) break;
    scanned += 1;
    if (isCxBlockedLeadCadence(cadence)) continue;

    const phone = pickLeadCadencePhone(cadence);
    if (!phone) continue;

    const caseId = Number(cadence.caseId);
    if (!Number.isFinite(caseId)) continue;

    const actionKey = `cx-day2to15-${dateKey}-${caseId}`;
    if (await queueActionAlreadyExists(normalizedDomain, caseId, actionKey)) continue;
    if (await activeQueueCaseExists(normalizedDomain, caseId)) continue;

    const businessAgeDays = getLeadAgeDays(cadence.createdAt, now);
    if (!Number.isFinite(businessAgeDays) || businessAgeDays < 2 || businessAgeDays > 14) continue;
    const touchState = readCadenceCxTouchState(cadence);
    const policyBlock = leadCxTouchViolatesAgentOrPolicy({
      touchState,
      queueFamily: "fresh-day2to10",
      agentExtensionId: options.agentExtensionId,
      now,
    });
    if (policyBlock.blocked) continue;
    const activeDay = businessAgeDays + 1;
    await cxDialQueueRepository.upsertQueueItem(
      normalizedDomain,
      caseId,
      {
        domain: normalizedDomain,
        caseId,
        leadCadenceId: String(cadence._id),
        phone,
        name: pickLeadName(cadence),
        intakeSource: cadence.intakeSource || "lead-cadence",
        intakeRoute: cadence.intakeRoute || "day2to15-cx-refill",
        sourceName: cadence.sourceName || cadence.vendorSourceName || null,
        ...routingPatch,
        state: "ready",
        queueFamily: "fresh-day2to10",
        queueFamilyRank: getQueueFamilySortRank("fresh-day2to10"),
        queueTier: "later",
        progressiveStageKey: "day2to15",
        progressiveStageIndex: Math.max(activeDay, 2),
        progressiveStageLabel: "3-15",
        priorityScore: 100,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [120, 120, 120],
          activeDay,
          nextDelayMinutes: 120,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "fresh-day2to10",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "lead-cadence",
        "metadata.materializedAt": now,
        "metadata.routeCampaignKey": cadence.routeCampaignKey || null,
        "metadata.routeCampaignName": cadence.routeCampaignName || null,
        ...buildMaterializedTouchPatch(touchState, now),
      },
      { actionKey },
    );
    created += 1;
  }

  return { ok: true, created, scanned, source: "lead-cadence" };
}

async function materializeDay16To30QueueItems(domain, neededCount, options = {}) {
  const count = Math.max(Number(neededCount) || 0, 0);
  if (count <= 0) return { ok: true, created: 0, scanned: 0, source: "lead-cadence" };

  const now = options.now || new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const currentFreshWindowStart = getPacificBusinessDayStart(now);
  const windowStart = new Date(currentFreshWindowStart.getTime() - 31 * dayMs);
  const windowEnd = new Date(currentFreshWindowStart.getTime() - 14 * dayMs);
  const dateKey = getPacificDateKey(now);
  const normalizedDomain = normalizeDomain(domain);
  const scanLimit = Math.min(Math.max(count * 8, 40), 300);
  const routingPatch = buildQueueRoutingPatch("fresh-day16to30");
  const cadenceQuery = applyRouteCampaignFilter({
    domain: normalizedDomain,
    active: true,
    createdAt: { $gte: windowStart, $lt: windowEnd },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  }, options.routeCampaigns);
  const candidates = await LeadCadence.find(cadenceQuery)
    .sort({
      "lastTouched.cx": 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .limit(scanLimit)
    .lean();

  let created = 0;
  let scanned = 0;
  for (const cadence of candidates) {
    if (created >= count) break;
    scanned += 1;
    if (isCxBlockedLeadCadence(cadence)) continue;

    const phone = pickLeadCadencePhone(cadence);
    if (!phone) continue;

    const caseId = Number(cadence.caseId);
    if (!Number.isFinite(caseId)) continue;

    const actionKey = `cx-day16to30-${dateKey}-${caseId}`;
    if (await queueActionAlreadyExists(normalizedDomain, caseId, actionKey)) continue;
    if (await activeQueueCaseExists(normalizedDomain, caseId)) continue;

    const businessAgeDays = getLeadAgeDays(cadence.createdAt, now);
    if (!Number.isFinite(businessAgeDays) || businessAgeDays < 15 || businessAgeDays > 29) continue;
    const touchState = readCadenceCxTouchState(cadence);
    const policyBlock = leadCxTouchViolatesAgentOrPolicy({
      touchState,
      queueFamily: "fresh-day16to30",
      agentExtensionId: options.agentExtensionId,
      now,
    });
    if (policyBlock.blocked) continue;
    const activeDay = businessAgeDays + 1;
    await cxDialQueueRepository.upsertQueueItem(
      normalizedDomain,
      caseId,
      {
        domain: normalizedDomain,
        caseId,
        leadCadenceId: String(cadence._id),
        phone,
        name: pickLeadName(cadence),
        intakeSource: cadence.intakeSource || "lead-cadence",
        intakeRoute: cadence.intakeRoute || "day16to30-cx-refill",
        sourceName: cadence.sourceName || cadence.vendorSourceName || null,
        ...routingPatch,
        state: "ready",
        queueFamily: "fresh-day16to30",
        queueFamilyRank: getQueueFamilySortRank("fresh-day16to30"),
        queueTier: "later",
        progressiveStageKey: "day16to30",
        progressiveStageIndex: activeDay,
        progressiveStageLabel: "16-30",
        priorityScore: 90,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [1440],
          activeDay,
          nextDelayMinutes: 1440,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "fresh-day16to30",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "lead-cadence",
        "metadata.materializedAt": now,
        "metadata.routeCampaignKey": cadence.routeCampaignKey || null,
        "metadata.routeCampaignName": cadence.routeCampaignName || null,
        ...buildMaterializedTouchPatch(touchState, now),
      },
      { actionKey },
    );
    created += 1;
  }

  return { ok: true, created, scanned, source: "lead-cadence" };
}

async function materializeAgedQueueItems(domain, neededCount, options = {}) {
  const count = Math.max(Number(neededCount) || 0, 0);
  if (count <= 0) return { ok: true, created: 0, scanned: 0, source: "filler-pool" };

  const now = options.now || new Date();
  const normalizedDomain = normalizeDomain(domain);
  const dateKey = getPacificDateKey(now);
  const poolTag = String(process.env.RC_CX_FILLER_POOL_TAG || "").trim() || getPacificMonthTag(now);
  const scanLimit = Math.min(Math.max(count * 8, 40), 300);
  const routingPatch = buildQueueRoutingPatch("aged");
  const dayMs = 24 * 60 * 60 * 1000;
  const currentFreshWindowStart = getPacificBusinessDayStart(now);
  const agedWindowEnd = new Date(currentFreshWindowStart.getTime() - 29 * dayMs);

  let created = 0;
  let scanned = 0;
  let cadenceCreated = 0;
  let prospectCreated = 0;

  const cadenceQuery = applyRouteCampaignFilter({
    domain: normalizedDomain,
    active: true,
    createdAt: { $lt: agedWindowEnd },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  }, options.routeCampaigns);
  const cadenceCandidates = await LeadCadence.find(cadenceQuery)
    .sort({
      "lastTouched.cx": 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .limit(scanLimit)
    .lean();

  for (const cadence of cadenceCandidates) {
    if (created >= count) break;
    scanned += 1;
    if (isCxBlockedLeadCadence(cadence)) continue;

    const phone = pickLeadCadencePhone(cadence);
    if (!phone) continue;

    const caseId = Number(cadence.caseId);
    if (!Number.isFinite(caseId)) continue;

    const businessAgeDays = getLeadAgeDays(cadence.createdAt, now);
    if (!Number.isFinite(businessAgeDays) || businessAgeDays <= 29 || businessAgeDays > 120) continue;
    const activeDay = businessAgeDays + 1;

    const actionKey = `cx-aged-${dateKey}-${caseId}`;
    if (await queueActionAlreadyExists(normalizedDomain, caseId, actionKey)) continue;
    if (await activeQueueCaseExists(normalizedDomain, caseId)) continue;
    const touchState = readCadenceCxTouchState(cadence);
    const policyBlock = leadCxTouchViolatesAgentOrPolicy({
      touchState,
      queueFamily: "aged",
      agentExtensionId: options.agentExtensionId,
      now,
    });
    if (policyBlock.blocked) continue;

    await cxDialQueueRepository.upsertQueueItem(
      normalizedDomain,
      caseId,
      {
        domain: normalizedDomain,
        caseId,
        leadCadenceId: String(cadence._id),
        phone,
        name: pickLeadName(cadence),
        intakeSource: cadence.intakeSource || "lead-cadence",
        intakeRoute: cadence.intakeRoute || "aged-cadence-cx-refill",
        sourceName: cadence.sourceName || cadence.vendorSourceName || null,
        ...routingPatch,
        state: "ready",
        queueFamily: "aged",
        queueFamilyRank: getQueueFamilySortRank("aged"),
        queueTier: "later",
        progressiveStageKey: "aged-cadence",
        progressiveStageIndex: 99,
        progressiveStageLabel: "31-120",
        priorityScore: 85,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [20160],
          activeDay,
          nextDelayMinutes: 20160,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "aged",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "aged-lead-cadence",
        "metadata.materializedAt": now,
        "metadata.routeCampaignKey": cadence.routeCampaignKey || null,
        "metadata.routeCampaignName": cadence.routeCampaignName || null,
        ...buildMaterializedTouchPatch(touchState, now),
      },
      { actionKey },
    );
    created += 1;
    cadenceCreated += 1;
  }

  const remaining = Math.max(count - created, 0);
  const candidates = remaining > 0 ? await MasterProspectIndex.find({
    domain: normalizedDomain,
    "pool.tag": poolTag,
    normalizedPhones: { $exists: true, $ne: [] },
  })
    .sort({
      "filler.lastDialAttempt": 1,
      lastSeenAt: -1,
      updatedAt: 1,
    })
    .limit(Math.min(Math.max(remaining * 8, 40), 300))
    .lean() : [];

  for (const prospect of candidates) {
    if (created >= count) break;
    scanned += 1;

    const phone = pickMasterProspectPhone(prospect);
    if (!phone) continue;

    const caseId = Number(prospect.caseId);
    if (!Number.isFinite(caseId)) continue;

    const actionKey = `cx-aged-${dateKey}-${caseId}`;
    if (await queueActionAlreadyExists(normalizedDomain, caseId, actionKey)) continue;
    if (await activeQueueCaseExists(normalizedDomain, caseId)) continue;
    const touchState = readProspectCxTouchState(prospect);
    const policyBlock = leadCxTouchViolatesAgentOrPolicy({
      touchState,
      queueFamily: "aged",
      agentExtensionId: options.agentExtensionId,
      now,
    });
    if (policyBlock.blocked) continue;

    await cxDialQueueRepository.upsertQueueItem(
      normalizedDomain,
      caseId,
      {
        domain: normalizedDomain,
        caseId,
        phone,
        name: pickLeadName(prospect),
        intakeSource: prospect.metadata?.intakeSource || "filler",
        intakeRoute: prospect.intakeRoute || "filler-pool-cx-refill",
        sourceName: prospect.metadata?.sourceName || "Filler Pool",
        ...routingPatch,
        state: "ready",
        queueFamily: "aged",
        queueFamilyRank: getQueueFamilySortRank("aged"),
        queueTier: "later",
        progressiveStageKey: "aged-filler",
        progressiveStageIndex: 99,
        progressiveStageLabel: "31-120",
        priorityScore: 80,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [20160],
          activeDay: 99,
          nextDelayMinutes: 20160,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "aged",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "filler-pool",
        "metadata.materializedPoolTag": poolTag,
        "metadata.materializedAt": now,
        "metadata.routeCampaignKey": prospect.metadata?.routeCampaignKey || null,
        "metadata.routeCampaignName": prospect.metadata?.routeCampaignName || null,
        ...buildMaterializedTouchPatch(touchState, now),
      },
      { actionKey },
    );
    created += 1;
    prospectCreated += 1;
  }

  return {
    ok: true,
    created,
    scanned,
    source: "aged-overflow",
    cadenceCreated,
    prospectCreated,
    poolTag,
  };
}

// Non-green materialization is shared; blue/yellow/red do not split by LD bucket.
// `routeCampaigns` is accepted for call-shape compatibility, but this
// path always passes null to the post-first-contact materializers.
async function materializeQueueSupplyForAgent({
  domain,
  domains = null,
  agentExtensionId = null,
  queueFamilies = [],
  deficit = 0,
  routeCampaigns = null,
}) {
  const enabled =
    String(process.env.RC_CX_AUTO_MATERIALIZE_NONFRESH_ENABLED || "true").toLowerCase() !== "false";
  const normalizedFamilies = queueFamilies.map((family) => normalizeCxQueueFamily(family));
  const wantsDay2To15 = normalizedFamilies.includes("fresh-day2to10");
  const wantsDay16To30 = normalizedFamilies.includes("fresh-day16to30");
  const wantsAged = normalizedFamilies.includes("aged");
  const needed = Math.max(Number(deficit) || 0, 0);
  if (!enabled || needed <= 0 || (!wantsDay2To15 && !wantsDay16To30 && !wantsAged)) {
    return { ok: true, created: 0, skipped: true, reason: enabled ? "not-nonfresh" : "disabled" };
  }

  const cap = Math.min(
    needed,
    Math.max(Number(process.env.RC_CX_NONFRESH_MATERIALIZE_MAX_PER_REFILL) || needed, 1),
  );
  const supplyDomains = parseDomainList(domains, parseDomainList(domain, ["WYNN"]));
  const results = [];
  let remaining = cap;

  for (const supplyDomain of supplyDomains) {
    if (remaining <= 0) break;
    if (wantsDay2To15 && remaining > 0) {
      const day2Result = await materializeDay2To15QueueItems(supplyDomain, remaining, {
        routeCampaigns: null,
        agentExtensionId,
      });
      results.push({ domain: supplyDomain, ...day2Result });
      remaining -= Number(day2Result.created || 0);
    }
    if (wantsDay16To30 && remaining > 0) {
      const day16Result = await materializeDay16To30QueueItems(supplyDomain, remaining, {
        routeCampaigns: null,
        agentExtensionId,
      });
      results.push({ domain: supplyDomain, ...day16Result });
      remaining -= Number(day16Result.created || 0);
    }
    if (wantsAged && remaining > 0) {
      const agedResult = await materializeAgedQueueItems(supplyDomain, remaining, {
        routeCampaigns: null,
        agentExtensionId,
      });
      results.push({ domain: supplyDomain, ...agedResult });
      remaining -= Number(agedResult.created || 0);
    }
  }

  return {
    ok: true,
    created: results.reduce((total, result) => total + (Number(result.created) || 0), 0),
    results,
  };
}

async function refillQueueFamilyForAgent({
  context,
  agentExtensionId,
  queueFamilies,
  currentCount,
  currentItems = [],
  targetCount,
  countEnvName,
  claimMinutes,
  randomize,
  maxOpenAssignmentsScope,
  requestKeyPrefix,
  routeCampaigns = null,
  ignoreDrainBeforeRefill = false,
}) {
  const deficit = Math.max(targetCount - currentCount, 0);
  const drainBeforeRefill = !ignoreDrainBeforeRefill && readBooleanEnv("RC_CX_DRAIN_BEFORE_REFILL_ENABLED", true);
  const hasSealedPack = hasSealedAssignmentPackMarker(currentItems);
  if (drainBeforeRefill && currentCount > 0 && (hasSealedPack || currentCount >= targetCount)) {
    if (!hasSealedPack && currentCount >= targetCount) {
      const pack = buildAssignmentPack({
        context,
        agentExtensionId,
        queueFamilies,
        targetCount,
        source: "cx-workspace-existing-full-pack",
      });
      pack.sealedAt = new Date();
      await stampQueueItemsWithAssignmentPack(currentItems, pack);
    }
    return {
      ok: true,
      assigned: 0,
      materialized: 0,
      skipped: true,
      reason: hasSealedPack ? "drain-before-refill" : "target-met-pack-sealed",
      currentCount,
      targetCount,
      queueFamilies,
    };
  }
  if (deficit <= 0) {
    return {
      ok: true,
      assigned: 0,
      materialized: 0,
      skipped: true,
      reason: "target-met",
      currentCount,
      targetCount,
      queueFamilies,
    };
  }

  const assignmentPack = buildAssignmentPack({
    context,
    agentExtensionId,
    queueFamilies,
    targetCount,
    source: currentCount > 0 ? "cx-workspace-complete-partial-pack" : "cx-workspace-new-pack",
  });
  const queueDomains = resolveCxQueueDomains(context);
  const materialized = await materializeQueueSupplyForAgent({
    domain: context.domain,
    domains: queueDomains,
    agentExtensionId,
    queueFamilies,
    deficit,
    routeCampaigns,
  }).catch((error) => ({
    ok: false,
    error: error.message,
    created: 0,
  }));

  const maxToAssign = Math.min(deficit, getPositiveEnvNumber(countEnvName, targetCount));
  let remainingToAssign = maxToAssign;
  const assignmentResults = [];
  for (const queueDomain of queueDomains) {
    if (remainingToAssign <= 0) break;
    const result = await assignCxQueueBatch({
      domain: queueDomain,
      extensionId: agentExtensionId,
      maxCount: remainingToAssign,
      claimMinutes,
      queueFamilies,
      routeCampaigns: normalizeRouteCampaigns(routeCampaigns) || [],
      randomize,
      maxOpenAssignments: targetCount,
      maxOpenAssignmentsScope,
      ignoreActivityState: true,
      ignoreDrainBeforeRefill: true,
      assignmentPackId: assignmentPack.id,
      assignmentPackFamily: assignmentPack.family,
      assignmentPackTarget: assignmentPack.target,
      assignmentPackCreatedAt: assignmentPack.createdAt,
      assignmentPackSource: assignmentPack.source,
      requestKeyPrefix: `${requestKeyPrefix}:${queueDomain}`,
    });
    assignmentResults.push({ domain: queueDomain, ...result });
    remainingToAssign -= Number(result?.assigned || 0);
  }

  const assigned = {
    ok: true,
    requested: maxToAssign,
    assigned: assignmentResults.reduce((total, result) => total + (Number(result.assigned) || 0), 0),
    skipped: assignmentResults.reduce((total, result) => total + (Number(result.skipped) || 0), 0),
    results: assignmentResults.flatMap((result) => result.results || []),
    domainResults: assignmentResults,
  };
  const assignedItems = assigned.results
    .map((entry) => entry?.item)
    .filter(Boolean);
  let stampedExisting = 0;
  if (currentCount + Number(assigned.assigned || 0) >= targetCount) {
    assignmentPack.sealedAt = new Date();
    const stamped = await stampQueueItemsWithAssignmentPack(
      [...currentItems, ...assignedItems],
      assignmentPack,
    );
    stampedExisting = stamped.stamped;
  }

  return {
    ...assigned,
    materialized: Number(materialized?.created || 0),
    materialize: materialized,
    assignmentPack,
    stampedExisting,
    queueDomains,
  };
}

async function refillFreshHotLaneForAgent({
  context,
  currentCount,
  currentItems = [],
  targetCount,
  claimMinutes,
  requestKeyPrefix,
  routeCampaigns = null,
  ignoreDrainBeforeRefill = false,
}) {
  const deficit = Math.max(targetCount - currentCount, 0);
  const drainBeforeRefill = !ignoreDrainBeforeRefill && readBooleanEnv("RC_CX_DRAIN_BEFORE_REFILL_ENABLED", true);
  const hasSealedPack = hasSealedAssignmentPackMarker(currentItems);
  if (drainBeforeRefill && currentCount > 0 && (hasSealedPack || currentCount >= targetCount)) {
    if (!hasSealedPack && currentCount >= targetCount) {
      const pack = buildAssignmentPack({
        context,
        agentExtensionId: context?.account?.extensionId || null,
        queueFamilies: ["fresh-day1"],
        targetCount,
        source: "cx-workspace-existing-full-pack",
      });
      pack.sealedAt = new Date();
      await stampQueueItemsWithAssignmentPack(currentItems, pack);
    }
    return {
      ok: true,
      assigned: 0,
      skipped: true,
      reason: hasSealedPack ? "drain-before-refill" : "target-met-pack-sealed",
      currentCount,
      targetCount,
      queueFamilies: ["fresh-day1"],
    };
  }
  if (deficit <= 0) {
    return {
      ok: true,
      assigned: 0,
      skipped: true,
      reason: "target-met",
      currentCount,
      targetCount,
      queueFamilies: ["fresh-day1"],
    };
  }

  const queueDomains = resolveCxQueueDomains(context);
  const batchSize = deficit;
  const assignmentPack = buildAssignmentPack({
    context,
    agentExtensionId: context?.account?.extensionId || null,
    queueFamilies: ["fresh-day1"],
    targetCount,
    source: currentCount > 0 ? "cx-workspace-complete-partial-pack" : "cx-workspace-new-pack",
  });
  // Lazy require keeps the hot-lane worker and workspace read path from
  // fighting module load order. Mongo still owns the actual claim state.
  // eslint-disable-next-line global-require
  const { runFreshHotLaneAllocator } = require("./cxFreshHotLaneService");
  const result = await runFreshHotLaneAllocator({
    mode: "workspace-fresh-refill",
    domains: queueDomains,
    maxCount: batchSize,
    claimMinutes,
    candidateExtensionIds: [String(context?.account?.extensionId || "").trim()].filter(Boolean),
    routeCampaigns: normalizeRouteCampaigns(routeCampaigns) || [],
    maxOpenAssignments: targetCount,
    ignoreActivityState: true,
    ignoreDrainBeforeRefill: true,
    assignmentPackId: assignmentPack.id,
    assignmentPackFamily: assignmentPack.family,
    assignmentPackTarget: assignmentPack.target,
    assignmentPackCreatedAt: assignmentPack.createdAt,
    assignmentPackSource: assignmentPack.source,
    requestKeyPrefix,
  });
  const assignedResults = Array.isArray(result?.assignments)
    ? result.assignments.flatMap((entry) => entry.results || [])
    : [];
  const assignedItems = assignedResults
    .map((entry) => entry?.item)
    .filter(Boolean);
  const assignedCount = Number(result?.assigned || 0);
  let stampedExisting = 0;
  if (currentCount + assignedCount >= targetCount) {
    assignmentPack.sealedAt = new Date();
    const stamped = await stampQueueItemsWithAssignmentPack(
      [...currentItems, ...assignedItems],
      assignmentPack,
    );
    stampedExisting = stamped.stamped;
  }

  return {
    ok: true,
    requested: batchSize,
    assigned: assignedCount,
    skipped: Number(result?.assignments?.reduce((total, entry) => total + Number(entry.skipped || 0), 0) || 0),
    results: assignedResults,
    assignmentPack,
    stampedExisting,
    hotLane: result,
    queueDomains,
  };
}

// Priority-stack refill: route-filtered green, then shared blue/yellow/red.
//
// `routeCampaigns` is only applied to the fresh hot lane. Blue/yellow/red
// explicitly pass null so aged and post-first-contact leads are shared.
async function maybeRefillCxQueueForAgent(context, agentExtensionId, visibleQueueItems = []) {
  const enabled = String(process.env.RC_CX_EMPTY_QUEUE_REFILL_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return { skipped: true, reason: "disabled" };
  if (!agentExtensionId) return { skipped: true, reason: "missing-extension-id" };

  const queuePolicy = resolveAccountQueuePolicy(context.account || {});
  const routeCampaigns = queuePolicy.routeCampaigns || null;
  const freshFamilies = parseQueueFamilyList(
    process.env.RC_CX_FRESH_REFILL_FAMILIES,
    ["fresh-day1"],
  );
  const nonFreshFamilies = parseQueueFamilyList(
    process.env.RC_CX_EMPTY_QUEUE_REFILL_FAMILIES,
    ["fresh-day2to10", "fresh-day16to30", "aged"],
  );
  const day2To15Families = parseQueueFamilyList(
    process.env.RC_CX_DAY2TO15_REFILL_FAMILIES,
    ["fresh-day2to10"],
  );
  const day16To30Families = parseQueueFamilyList(
    process.env.RC_CX_DAY16TO30_REFILL_FAMILIES || process.env.RC_CX_YELLOW_REFILL_FAMILIES,
    ["fresh-day16to30"],
  );
  const agedFamilies = parseQueueFamilyList(
    process.env.RC_CX_AGED_REFILL_FAMILIES,
    ["aged"],
  );
  const rawTotalOpen = queuePolicy.enabled
    ? getNonNegativeEnvNumber("RC_CX_TOTAL_OPEN_ASSIGNMENTS", queuePolicy.totalOpen || 0)
    : 0;
  const freshTarget = queuePolicy.enabled
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "fresh-day1", "RC_CX_FRESH_TARGET_OPEN")
    : 0;
  const day2To15Target = queuePolicy.enabled
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "fresh-day2to10", "RC_CX_DAY2TO15_TARGET_OPEN")
    : 0;
  const day16To30Target = queuePolicy.enabled
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "fresh-day16to30", "RC_CX_DAY16TO30_TARGET_OPEN")
    : 0;
  const agedTarget = queuePolicy.enabled
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "aged", "RC_CX_AGED_TARGET_OPEN")
    : 0;
  const familyTargetTotal = freshTarget + day2To15Target + day16To30Target + agedTarget;
  const totalOpen = familyTargetTotal > 0 ? familyTargetTotal : rawTotalOpen;
  const agedReconciliationTarget = queuePolicy.aged?.fillRemainder === true
    ? totalOpen
    : agedTarget;
  const reconciliationTargets = [
    { queueFamilies: freshFamilies, targetCount: freshTarget },
    { queueFamilies: day2To15Families, targetCount: day2To15Target },
    { queueFamilies: day16To30Families, targetCount: day16To30Target },
    { queueFamilies: agedFamilies, targetCount: agedReconciliationTarget },
    {
      queueFamilies: Array.from(new Set([
        ...freshFamilies,
        ...day2To15Families,
        ...day16To30Families,
        ...agedFamilies,
      ])),
      targetCount: totalOpen,
    },
  ];
  const reconciliation = await reconcileWorkspaceQueuePacksForAgent({
    agentExtensionId,
    visibleQueueItems,
    familyTargets: reconciliationTargets,
    reason: queuePolicy.enabled ? "queue-over-target-trim" : "queue-policy-disabled",
    actorEmail: context.account?.email || null,
  });
  visibleQueueItems = reconciliation.visibleQueueItems || visibleQueueItems;

  if (!queuePolicy.enabled) {
    return {
      ok: true,
      assigned: 0,
      released: reconciliation.released || 0,
      skipped: true,
      reason: "queue-policy-no-leads",
      policy: queuePolicy,
      reconciliation,
    };
  }

  const freshCurrentItems = listQueueItemsByFamily(visibleQueueItems, freshFamilies, agentExtensionId);
  const nonFreshCurrentItems = listQueueItemsByFamily(visibleQueueItems, nonFreshFamilies, agentExtensionId);
  const day2To15CurrentItems = listQueueItemsByFamily(visibleQueueItems, day2To15Families, agentExtensionId);
  const day16To30CurrentItems = listQueueItemsByFamily(visibleQueueItems, day16To30Families, agentExtensionId);
  const agedCurrentItems = listQueueItemsByFamily(visibleQueueItems, agedFamilies, agentExtensionId);
  const freshCurrent = freshCurrentItems.length;
  const nonFreshCurrent = nonFreshCurrentItems.length;
  const day2To15Current = day2To15CurrentItems.length;
  const day16To30Current = day16To30CurrentItems.length;
  const agedCurrent = agedCurrentItems.length;
  const currentOpen = freshCurrent + day2To15Current + day16To30Current + agedCurrent;
  let deficit = Math.max(totalOpen - currentOpen, 0);
  const timestamp = Date.now();
  const batches = [];

  const freshDeficit = Math.min(Math.max(freshTarget - freshCurrent, 0), deficit);
  if (freshDeficit > 0 && queuePolicy.fresh?.eligible !== false) {
    const freshBatch = await refillFreshHotLaneForAgent({
      context,
      currentCount: freshCurrent,
      currentItems: freshCurrentItems,
      targetCount: freshCurrent + freshDeficit,
      claimMinutes: Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
      requestKeyPrefix: `cx-fresh-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
      routeCampaigns,
      ignoreDrainBeforeRefill: true,
    });
    batches.push(freshBatch);
    deficit -= Number(freshBatch?.assigned || 0);
  }

  const day2To15Deficit = Math.min(Math.max(day2To15Target - day2To15Current, 0), deficit);
  if (day2To15Deficit > 0) {
    const day2Batch = await refillQueueFamilyForAgent({
      context,
      agentExtensionId,
      queueFamilies: day2To15Families,
      currentCount: day2To15Current,
      currentItems: day2To15CurrentItems,
      targetCount: day2To15Current + day2To15Deficit,
      claimMinutes: Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
      randomize: false,
      maxOpenAssignmentsScope: "queue-family",
      requestKeyPrefix: `cx-day2to15-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
      routeCampaigns: null,
      ignoreDrainBeforeRefill: true,
    });
    batches.push(day2Batch);
    deficit -= Number(day2Batch?.assigned || 0);
  }

  const day16To30Deficit = Math.min(Math.max(day16To30Target - day16To30Current, 0), deficit);
  if (day16To30Deficit > 0) {
    const day16Batch = await refillQueueFamilyForAgent({
      context,
      agentExtensionId,
      queueFamilies: day16To30Families,
      currentCount: day16To30Current,
      currentItems: day16To30CurrentItems,
      targetCount: day16To30Current + day16To30Deficit,
      claimMinutes: Number(process.env.RC_CX_YELLOW_CLAIM_MINUTES) || Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
      randomize: false,
      maxOpenAssignmentsScope: "queue-family",
      requestKeyPrefix: `cx-day16to30-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
      routeCampaigns: null,
      ignoreDrainBeforeRefill: true,
    });
    batches.push(day16Batch);
    deficit -= Number(day16Batch?.assigned || 0);
  }

  let effectiveAgedCurrent = agedCurrent;
  const agedDeficit = Math.min(Math.max(agedTarget - effectiveAgedCurrent, 0), deficit);
  if (agedDeficit > 0 && readBooleanEnv("RC_CX_AGED_OVERFLOW_ENABLED", true)) {
    const agedBatch = await refillQueueFamilyForAgent({
      context,
      agentExtensionId,
      queueFamilies: agedFamilies,
      currentCount: effectiveAgedCurrent,
      currentItems: agedCurrentItems,
      targetCount: effectiveAgedCurrent + agedDeficit,
      claimMinutes: Number(process.env.RC_CX_AGED_CLAIM_MINUTES) || Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
      randomize: false,
      maxOpenAssignmentsScope: "queue-family",
      requestKeyPrefix: `cx-aged-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
      routeCampaigns: null,
      ignoreDrainBeforeRefill: true,
    });
    batches.push(agedBatch);
    const agedAssigned = Number(agedBatch?.assigned || 0);
    effectiveAgedCurrent += agedAssigned;
    deficit -= agedAssigned;
  }

  if (
    deficit > 0
    && queuePolicy.aged?.fillRemainder === true
    && readBooleanEnv("RC_CX_AGED_OVERFLOW_ENABLED", true)
  ) {
    const agedRemainderBatch = await refillQueueFamilyForAgent({
      context,
      agentExtensionId,
      queueFamilies: agedFamilies,
      currentCount: effectiveAgedCurrent,
      currentItems: agedCurrentItems,
      targetCount: effectiveAgedCurrent + deficit,
      claimMinutes: Number(process.env.RC_CX_AGED_CLAIM_MINUTES) || Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
      randomize: false,
      maxOpenAssignmentsScope: "queue-family",
      requestKeyPrefix: `cx-aged-remainder-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
      routeCampaigns: null,
      ignoreDrainBeforeRefill: true,
    });
    batches.push(agedRemainderBatch);
    deficit -= Number(agedRemainderBatch?.assigned || 0);
  }

  return {
    ok: true,
    assigned: batches.reduce((total, batch) => total + (Number(batch?.assigned) || 0), 0),
    released: reconciliation.released || 0,
    batches,
    policy: queuePolicy,
    reconciliation,
    counts: {
      freshCurrent,
      freshTarget,
      nonFreshCurrent,
      nonFreshTarget: day2To15Target + day16To30Target + agedTarget,
      day2To15Current,
      day2To15Target,
      day16To30Current,
      day16To30Target,
      agedCurrent,
      agedTarget,
      currentOpen,
      totalOpen,
      remainingDeficit: Math.max(deficit, 0),
      routeCampaigns,
    },
  };
}

function queueCxWorkspaceRefill(context, agentExtensionId, visibleQueueItems = []) {
  const normalizedExtensionId = String(agentExtensionId || "").trim();
  if (!normalizedExtensionId) return { ok: true, queued: false, reason: "missing-extension-id" };
  const key = `${normalizeDomain(context?.domain || context?.account?.company || "WYNN")}:${normalizedExtensionId}`;
  const now = Date.now();
  const staleMs = Math.max(Number(process.env.RC_CX_WORKSPACE_REFILL_IN_FLIGHT_STALE_MS) || 120_000, 10_000);
  const existingStartedAt = Number(cxWorkspaceRefillInFlight.get(key) || 0);
  if (existingStartedAt > 0 && now - existingStartedAt < staleMs) {
    return { ok: true, queued: false, reason: "refill-already-running" };
  }

  cxWorkspaceRefillInFlight.set(key, now);
  Promise.resolve()
    .then(() => maybeRefillCxQueueForAgent(context, normalizedExtensionId, visibleQueueItems))
    .catch((error) => {
      console.warn("[cx-workspace-refill] failed", {
        extensionId: normalizedExtensionId,
        domain: context?.domain || null,
        error: error.message,
      });
    })
    .finally(() => {
      if (Number(cxWorkspaceRefillInFlight.get(key) || 0) === now) {
        cxWorkspaceRefillInFlight.delete(key);
      }
    });

  return { ok: true, queued: true, reason: "background-refill" };
}

function buildLeadBodyFromQueueSources(queueItem = {}, cadenceDoc = null) {
  const payloadSnapshot = cadenceDoc?.payloadSnapshot && typeof cadenceDoc.payloadSnapshot === "object"
    ? cadenceDoc.payloadSnapshot
    : null;
  if (payloadSnapshot?.leadBody && typeof payloadSnapshot.leadBody === "object") {
    return payloadSnapshot.leadBody;
  }
  return {
    caseId: queueItem.caseId != null ? String(queueItem.caseId) : null,
    name: queueItem.name || cadenceDoc?.name || null,
    firstName: cadenceDoc?.firstName || null,
    lastName: cadenceDoc?.lastName || null,
    email: cadenceDoc?.email || null,
    phone: queueItem.phone || cadenceDoc?.primaryPhone || cadenceDoc?.normalizedPhone || null,
    sourceName: queueItem.sourceName || cadenceDoc?.sourceName || null,
    intakeSource: queueItem.intakeSource || cadenceDoc?.intakeSource || null,
    intakeRoute: queueItem.intakeRoute || cadenceDoc?.intakeRoute || null,
    queueFamily: getQueueItemFamily(queueItem),
    queueTier: queueItem.queueTier || null,
    currentStage: cadenceDoc?.currentStage || null,
    callPlan: queueItem.callPlan || null,
  };
}

function summarizeServedQueueItem(queueItem, cadenceDoc = null) {
  const payloadSnapshot = cadenceDoc?.payloadSnapshot && typeof cadenceDoc.payloadSnapshot === "object"
    ? cadenceDoc.payloadSnapshot
    : null;
  const leadBody = buildLeadBodyFromQueueSources(queueItem, cadenceDoc);
  const effectiveQueueFamily = getQueueItemFamily(queueItem);
  const effectiveRcxRouting = resolveRcxRoutingForQueueIntent({
    queueFamily: effectiveQueueFamily,
    assignedExtensionId: queueItem.assignment?.extensionId || null,
    assignedAgentName: queueItem.assignment?.agentName || null,
  }, queueItem);
  const nextPendingAction = Array.isArray(cadenceDoc?.schedule?.actions)
    ? cadenceDoc.schedule.actions
      .filter((entry) => entry.channel === "cx" && (entry.status === "pending" || entry.status === "requested"))
      .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime())[0]
    : null;
  const callPlan = queueItem?.callPlan || payloadSnapshot?.callPlan || leadBody.callPlan || null;
  const activeDay = Number.isFinite(Number(callPlan?.activeDay)) ? Number(callPlan.activeDay) : null;
  const progressiveStageKey =
    queueItem.progressiveStageKey ||
    payloadSnapshot?.progressiveStageKey ||
    (nextPendingAction?.key === "cx-day0-1" ? "just-came-in" : null) ||
    (nextPendingAction?.key === "cx-day0-2" ? "second-contact" : null) ||
    (nextPendingAction?.key === "cx-day0-3" ? "third-contact" : null) ||
    null;
  const progressiveStageIndex =
    Number.isFinite(Number(queueItem.progressiveStageIndex)) ? Number(queueItem.progressiveStageIndex) :
      Number.isFinite(Number(payloadSnapshot?.progressiveStageIndex)) ? Number(payloadSnapshot.progressiveStageIndex) :
        progressiveStageKey === "just-came-in" ? 0 :
          progressiveStageKey === "second-contact" ? 1 :
            progressiveStageKey === "third-contact" ? 2 :
              99;
  const ageBucket = deriveUcqAgeBucket({
    ...queueItem,
    queueFamily: effectiveQueueFamily,
    progressiveStageKey,
    progressiveStageIndex,
  });
  return {
    domain: queueItem.domain,
    caseId: String(queueItem.caseId),
    intakeSource: queueItem.intakeSource || cadenceDoc?.intakeSource || null,
    intakeRoute: queueItem.intakeRoute || cadenceDoc?.intakeRoute || null,
    active: cadenceDoc?.active ?? true,
    currentStage: cadenceDoc?.currentStage || queueItem.state || null,
    nextActionType: cadenceDoc?.schedule?.nextActionType || "dial",
    nextActionAt: queueItem.releaseAt || cadenceDoc?.schedule?.nextActionAt || null,
    cxAction: nextPendingAction || {
      key: `queue:${String(queueItem._id || queueItem.caseId)}`,
      type: "dial",
      channel: "cx",
      scheduledFor: queueItem.releaseAt || null,
      status: queueItem.state || null,
    },
    score: queueItem.priorityScore ?? null,
    queueFamily: effectiveQueueFamily,
    ageBucket,
    progressiveStageKey,
    progressiveStageIndex,
    progressiveStageLabel: queueItem.progressiveStageLabel || payloadSnapshot?.progressiveStageLabel || null,
    placedCalls: Number(queueItem.placedCalls || queueItem.metadata?.placedCalls || 0) || 0,
    dailyPlacedCalls: Number(queueItem.dailyPlacedCalls || queueItem.metadata?.dailyPlacedCalls || 0) || 0,
    hourlyPlacedHourKey: queueItem.hourlyPlacedHourKey || queueItem.metadata?.hourlyPlacedHourKey || null,
    hourlyPlacedCalls: Number(queueItem.hourlyPlacedCalls || queueItem.metadata?.hourlyPlacedCalls || 0) || 0,
    smsCallbackUrgency: queueItem.metadata?.smsCallbackUrgency || null,
    callbackWindow: queueItem.metadata?.callbackWindow || null,
    callbackQueueMode: queueItem.metadata?.callbackQueueMode || null,
    hotIntentReason: queueItem.metadata?.hotIntentReason || null,
    lastPlacedAt: queueItem.lastPlacedAt || queueItem.metadata?.lastQueueAttemptAt || null,
    queueDayIndex: activeDay,
    payloadSnapshot,
    leadBody,
    queueState: queueItem.state || null,
    queueTicketId: queueItem._id ? String(queueItem._id) : null,
    rcxAccountId:
      String(effectiveRcxRouting.accountId || queueItem.rcxAccountId || payloadSnapshot?.rcxAccountId || "").trim() || null,
    rcxDialGroupId:
      String(effectiveRcxRouting.dialGroupId || queueItem.rcxDialGroupId || payloadSnapshot?.rcxDialGroupId || "").trim() || null,
    rcxCampaignId:
      String(effectiveRcxRouting.campaignId || queueItem.rcxCampaignId || payloadSnapshot?.rcxCampaignId || "").trim() || null,
    assignedExtensionId: queueItem.assignment?.extensionId || null,
    assignedAgentName: queueItem.assignment?.agentName || null,
  };
}

async function buildCxQueueItems(context, limit = 50) {
  const agentExtensionId = String(context?.account?.extensionId || "").trim();
  if (!agentExtensionId) return [];
  const queueDebugStartedAt = Date.now();
  await bumpLastActivityAt(agentExtensionId, { source: "cx-workspace" }).catch(() => null);
  const backfillIntervalMs = Math.max(
    Number(process.env.RC_CX_WORKSPACE_ORDERING_BACKFILL_INTERVAL_MS) || 60_000,
    0,
  );
  if (backfillIntervalMs > 0 && Date.now() - lastQueueOrderingBackfillAt > backfillIntervalMs) {
    lastQueueOrderingBackfillAt = Date.now();
    const backfillLimit = Math.min(
      Math.max(Number(process.env.RC_CX_WORKSPACE_ORDERING_BACKFILL_LIMIT) || 250, 25),
      5000,
    );
    backfillCxQueueOrdering(null, backfillLimit).catch(() => null);
  }

  let activeQueueItems = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
  const initialActiveCount = activeQueueItems.length;
  const routeReconciliation = await reconcileRouteCampaignAssignmentsForAgent({
    context,
    agentExtensionId,
    activeQueueItems,
  }).catch((error) => ({
    ok: false,
    released: 0,
    error: error.message,
  }));
  if (routeReconciliation?.released > 0) {
    activeQueueItems = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
  }
  let visibleQueueItems = activeQueueItems.filter((item) =>
    canViewQueueItemForAgent(item, context));
  const initialVisibleCount = visibleQueueItems.length;
  const asyncRefill =
    readBooleanEnv("RC_CX_WORKSPACE_REFILL_ASYNC_ENABLED", true) &&
    !(visibleQueueItems.length === 0 && readBooleanEnv("RC_CX_WORKSPACE_REFILL_SYNC_WHEN_EMPTY", false));
  const refill = asyncRefill
    ? queueCxWorkspaceRefill(context, agentExtensionId, visibleQueueItems)
    : await maybeRefillCxQueueForAgent(context, agentExtensionId, visibleQueueItems).catch((error) => ({
      ok: false,
      error: error.message,
    }));
  if (!asyncRefill && (refill?.assigned > 0 || refill?.released > 0)) {
    activeQueueItems = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
    visibleQueueItems = activeQueueItems.filter((item) =>
      canViewQueueItemForAgent(item, context));
  }

  const visibleCaseIdsByDomain = new Map();
  for (const item of visibleQueueItems) {
    const keyDomain = normalizeDomain(item?.domain || context.domain);
    const keyCaseId = Number(item?.caseId);
    if (!keyDomain || !Number.isFinite(keyCaseId)) continue;
    if (!visibleCaseIdsByDomain.has(keyDomain)) visibleCaseIdsByDomain.set(keyDomain, new Set());
    visibleCaseIdsByDomain.get(keyDomain).add(keyCaseId);
  }

  const cadenceFilters = Array.from(visibleCaseIdsByDomain.entries()).map(([domain, caseIds]) => ({
    domain,
    caseId: { $in: Array.from(caseIds) },
  }));
  const cadenceDocs = cadenceFilters.length > 0
    ? await LeadCadence.find({ $or: cadenceFilters }).lean()
    : [];
  const cadenceByCaseId = new Map(
    cadenceDocs
      .map((doc) => [buildQueueCadenceKey(doc.domain, doc.caseId), doc])
      .filter(([key]) => Boolean(key)),
  );

  const servedItems = visibleQueueItems.map((item) =>
    summarizeServedQueueItem(
      item,
      cadenceByCaseId.get(buildQueueCadenceKey(item.domain || context.domain, item.caseId)) || null,
    ));
  writeCxWorkspaceQueueDebug("build", {
    durationMs: Date.now() - queueDebugStartedAt,
    domain: context.domain || null,
    extensionId: agentExtensionId,
    accountEmail: context.account?.email || null,
    initialActiveCount,
    activeCount: activeQueueItems.length,
    initialVisibleCount,
    visibleCount: visibleQueueItems.length,
    servedCount: servedItems.length,
    routeReconciliation: routeReconciliation
      ? {
          ok: routeReconciliation.ok,
          released: routeReconciliation.released || 0,
          attempted: routeReconciliation.attempted || 0,
          reason: routeReconciliation.reason || null,
          routeCampaigns: routeReconciliation.routeCampaigns || null,
          error: routeReconciliation.error || null,
        }
      : null,
    refill: refill
      ? {
          ok: refill.ok,
          assigned: refill.assigned || 0,
          released: refill.released || 0,
          skipped: Boolean(refill.skipped),
          reason: refill.reason || null,
          error: refill.error || null,
        }
      : null,
    sample: visibleQueueItems.slice(0, 3).map(summarizeQueueDebugItem),
  });

  const sortNow = new Date();

  const sortedServedItems = servedItems
    .sort((left, right) => {
      const leftFamily = getCxQueueServeRank(left, { now: sortNow });
      const rightFamily = getCxQueueServeRank(right, { now: sortNow });
      if (leftFamily !== rightFamily) return leftFamily - rightFamily;

      const leftStage = Number.isFinite(Number(left.progressiveStageIndex)) ? Number(left.progressiveStageIndex) : 99;
      const rightStage = Number.isFinite(Number(right.progressiveStageIndex)) ? Number(right.progressiveStageIndex) : 99;
      if (leftStage !== rightStage) return leftStage - rightStage;

      const leftTime = left.nextActionAt ? new Date(left.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.nextActionAt ? new Date(right.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.caseId || "").localeCompare(String(right.caseId || ""));
    });
  primeCxBucketNewCalls({
    extensionId: agentExtensionId,
    queueItems: visibleQueueItems,
    source: "workspace-queue",
    now: sortNow,
  }).catch((error) => {
    writeCxWorkspaceQueueDebug("bucket-prime-failed", {
      extensionId: agentExtensionId,
      error: error.message || String(error),
    });
  });
  return sortedServedItems;
}

function normalizeCxQueueFamily(value) {
  const family = normalizeLeadQueueFamily(value);
  return family === "unassigned" ? "fresh-day1" : family;
}

function getSmokeQueueFamilyConfig(queueFamily) {
  switch (normalizeCxQueueFamily(queueFamily)) {
    case "fresh-day2to10":
      return {
        queueFamily: "fresh-day2to10",
        queueTier: "later",
        activeDay: 3,
        currentStage: "day2to15",
        nextActionType: "cx:followup",
      };
    case "fresh-day16to30":
      return {
        queueFamily: "fresh-day16to30",
        queueTier: "later",
        activeDay: 16,
        currentStage: "day16to30",
        nextActionType: "cx:followup",
      };
    case "aged":
      return {
        queueFamily: "aged",
        queueTier: "later",
        activeDay: 31,
        currentStage: "aged",
        nextActionType: "cx:aged",
      };
    case "dead":
      return {
        queueFamily: "dead",
        queueTier: "dead",
        activeDay: 121,
        currentStage: "dead",
        nextActionType: "cx:dead",
      };
    case "fresh-day1":
    default:
      return {
        queueFamily: "fresh-day1",
        queueTier: "day0",
        activeDay: 0,
        currentStage: "day0",
        nextActionType: "cx:dial",
      };
  }
}

async function enqueueCxSmokeLead(domain, user, input = {}) {
  const context = await resolveCxUserContext(domain, user);
  const rawPhone = String(input.phone || input.cellPhone || input.primaryPhone || "").trim();
  const normalizedPhone = normalizeUsPhone(rawPhone);
  const requestedCaseId = Number(input.caseId ?? input.caseID);
  const client = createLogicsClient(context.domain);

  let record = null;
  let caseId = Number.isFinite(requestedCaseId) && requestedCaseId > 0 ? requestedCaseId : null;

  if (caseId != null) {
    const payload = await client.getCaseInfo(caseId);
    record = parseLogicsData(payload);
  } else if (normalizedPhone) {
    const payload = await client.findCaseByPhone(normalizedPhone);
    record = pickFreshestLogicsRecord(payload);
    caseId = extractCaseId(record);
  } else {
    const err = new Error("phone or caseId is required for CX smoke queue seeding");
    err.status = 400;
    throw err;
  }

  const queueConfig = getSmokeQueueFamilyConfig(input.queueFamily);

  if (!Number.isFinite(caseId) || caseId <= 0 || !record || typeof record !== "object") {
    const err = new Error(
      normalizedPhone
        ? `Could not resolve a ${context.domain} Logics case from phone ${normalizedPhone}`
        : `Could not load Logics case ${caseId}`,
    );
    err.status = 404;
    throw err;
  }

  const primaryPhone =
    record.CellPhone ||
    record.HomePhone ||
    record.WorkPhone ||
    normalizedPhone ||
    null;
  const normalizedPrimaryPhone = normalizeUsPhone(primaryPhone);
  if (!normalizedPrimaryPhone) {
    const err = new Error(`Case ${caseId} does not have a usable phone number for CX smoke testing`);
    err.status = 400;
    throw err;
  }

  const now = new Date();
  const existing = await LeadCadence.findOne({
    domain: context.domain,
    caseId,
  }).lean();

  const smokeActionKey = String(input.actionKey || `smoke-cx:${caseId}:${now.getTime()}`);
  const preservedActions = Array.isArray(existing?.schedule?.actions)
    ? existing.schedule.actions.filter((action) => !String(action?.key || "").startsWith("smoke-cx:"))
    : [];
  const smokeAction = {
    key: smokeActionKey,
    type: String(input.actionType || "dial"),
    channel: "cx",
    scheduledFor: now,
    status: "pending",
  };
  const actions = [smokeAction, ...preservedActions].sort(
    (left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime(),
  );

  const leadBody = {
    caseId: String(caseId),
    name: [record.FirstName, record.LastName].filter(Boolean).join(" ").trim() || null,
    firstName: record.FirstName || null,
    lastName: record.LastName || null,
    email: record.Email || null,
    phone: primaryPhone,
    cellPhone: record.CellPhone || primaryPhone,
    homePhone: record.HomePhone || null,
    workPhone: record.WorkPhone || null,
    sourceName: record.SourceName || record.sourceName || null,
    intakeSource: input.intakeSource || record.SourceName || record.sourceName || "CX Smoke Test",
    intakeRoute: "cx-smoke-route",
    queueFamily: queueConfig.queueFamily,
    queueTier: queueConfig.queueTier,
    currentStage: queueConfig.currentStage,
    callPlan: {
      phaseIndex: 0,
      delaysMinutes: [5, 115, 120],
      activeDay: queueConfig.activeDay,
      nextDelayMinutes: 5,
    },
    smokeTest: true,
    smokeQueuedAt: now.toISOString(),
  };

  const updated = await LeadCadence.findOneAndUpdate(
    {
      domain: context.domain,
      caseId,
    },
    {
      $set: {
        active: true,
        intakeSource: leadBody.intakeSource,
        intakeRoute: leadBody.intakeRoute,
        firstName: leadBody.firstName,
        lastName: leadBody.lastName,
        name: leadBody.name,
        email: leadBody.email,
        primaryPhone,
        normalizedPhone: normalizedPrimaryPhone,
        sourceName: leadBody.sourceName,
        statusId:
          record.StatusID != null
            ? Number(record.StatusID)
            : record.Status != null
              ? Number(record.Status)
              : null,
        currentStage: queueConfig.currentStage,
        schedule: {
          planVersion: existing?.schedule?.planVersion || "v1",
          timezone: existing?.schedule?.timezone || "America/Los_Angeles",
          nextActionType: queueConfig.nextActionType,
          nextActionAt: now,
          actions,
        },
        payloadSnapshot: {
          ...(existing?.payloadSnapshot || {}),
          ...leadBody,
          leadBody,
        },
      },
      $setOnInsert: {
        domain: context.domain,
        caseId,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  ).lean();

  await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "smoke-queue",
    stage: "built",
    aggregateType: "lead-cadence",
    aggregateId: String(caseId),
    caseId,
    sourceService: "control-plane",
    title: "CX smoke queue seeded",
    summary: `Queued case ${caseId} in ${queueConfig.queueFamily}`,
    payload: {
      queueFamily: queueConfig.queueFamily,
      actionKey: smokeActionKey,
      phone: primaryPhone,
    },
    happenedAt: now,
  });

  return {
    ok: true,
    domain: context.domain,
    caseId,
    queueFamily: queueConfig.queueFamily,
    phone: primaryPhone,
    item: summarizeCallQueueItem(updated),
  };
}

function findRingCentralExtensionRecord(records, shell, account) {
  const shellEmail = String(shell?.email || "").trim().toLowerCase();
  const shellExtensionNumber = String(shell?.extensionNumber || "").trim();
  const accountExtensionId = String(account?.extensionId || "").trim();

  if (shell?.rcExtensionId) {
    const byId = records.find((entry) => String(entry.id || "") === String(shell.rcExtensionId));
    if (byId) return byId;
  }
  if (shellEmail) {
    const byEmail = records.find(
      (entry) => String(entry?.contact?.email || "").trim().toLowerCase() === shellEmail,
    );
    if (byEmail) return byEmail;
  }
  if (shellExtensionNumber) {
    const byExtensionNumber = records.find(
      (entry) => String(entry.extensionNumber || "").trim() === shellExtensionNumber,
    );
    if (byExtensionNumber) return byExtensionNumber;
  }
  if (accountExtensionId && normalizeDomain(account?.company || "") === normalizeDomain(shell?.company || "")) {
    const byAccountExtension = records.find((entry) => String(entry.id || "") === accountExtensionId);
    if (byAccountExtension) return byAccountExtension;
  }
  return null;
}

function hasSmsCapability(record = {}) {
  const features = Array.isArray(record.features) ? record.features : [];
  return features.includes("SmsSender") || features.includes("A2PSmsSender") || features.includes("MmsSender");
}

function summarizePhoneNumberRecord(record = {}) {
  return {
    phoneNumber: record.phoneNumber || null,
    normalizedPhone: normalizeUsPhone(record.phoneNumber),
    usageType: record.usageType || null,
    type: record.type || null,
    features: Array.isArray(record.features) ? record.features : [],
  };
}

async function resolveCxTextRoute(context, shell) {
  const records = await loadRingCentralExtensionDirectory();
  const extension = findRingCentralExtensionRecord(records, shell, context.account);
  if (!extension) {
    const err = new Error(`No RingCentral extension could be resolved for ${shell?.email || context.account.email} in ${context.domain}`);
    err.status = 409;
    throw err;
  }

  const client = createRingCentralClient();
  const extensionId = String(extension.id);
  const phonePayload = await client.listExtensionPhoneNumbers(extensionId);
  const phoneRecords = Array.isArray(phonePayload.records) ? phonePayload.records : [];
  const preferredPhones = new Set(
    [
      ...(Array.isArray(shell?.loginPhones) ? shell.loginPhones : []),
      shell?.primaryPhone,
    ].map(normalizeUsPhone).filter(Boolean),
  );

  const smsEligible = phoneRecords.filter(hasSmsCapability);
  const preferredSmsEligible = preferredPhones.size > 0
    ? smsEligible.filter((record) => preferredPhones.has(normalizeUsPhone(record.phoneNumber)))
    : smsEligible;
  const primaryPhone = normalizeUsPhone(shell?.primaryPhone);
  const fromRecord =
    preferredSmsEligible.find((record) => normalizeUsPhone(record.phoneNumber) === primaryPhone) ||
    preferredSmsEligible[0] ||
    null;

  if (!fromRecord?.phoneNumber) {
    const assignedPhones = Array.from(preferredPhones);
    const smsCapablePhones = smsEligible.map(summarizePhoneNumberRecord);
    const err = new Error(
      assignedPhones.length > 0
        ? `No assigned EX phone number on extension ${extension.extensionNumber || extensionId} is SMS-enabled.`
        : `No EX text-capable phone number is assigned to extension ${extension.extensionNumber || extensionId}.`,
    );
    err.status = 409;
    err.details = {
      extensionId,
      extensionNumber: String(extension.extensionNumber || shell?.extensionNumber || "").trim() || null,
      assignedPhones,
      smsCapablePhones,
      requestedShell: summarizeExShell(shell),
    };
    throw err;
  }

  return {
    client,
    extensionId,
    extensionNumber: String(extension.extensionNumber || shell?.extensionNumber || "").trim() || null,
    shell: {
      ...normalizeExShell(shell),
      rcExtensionId: extensionId,
      lastResolvedAt: new Date(),
    },
    fromPhone: normalizeUsPhone(fromRecord.phoneNumber),
    fromPhoneE164: toE164(fromRecord.phoneNumber),
    fromPhoneRecord: fromRecord,
  };
}

async function buildCxWorkspace(domain, user) {
  let context = await resolveCxUserContext(domain, user);
  context = await touchCxWorkspacePresenceForContext(context, user);
  const requestedExShell = resolveActiveExShell(context);
  const activeExShell = resolveTextTransportShell(context, requestedExShell);
  const [callQueueDocs, openTasks, openReminders, recentWorkflowStages] = await Promise.all([
    buildCxQueueItems(context, 25),
    listCxOpenItems(context.domain, context.account, "cx-task", 25),
    listCxOpenItems(context.domain, context.account, "cx-reminder", 25),
    workflowRecordRepository.listWorkflowRecords({
      domain: context.domain,
      family: "cx",
      limit: 25,
    }),
  ]);

  const callQueue = callQueueDocs;
  const assignedWorkflowStages = recentWorkflowStages.filter((stage) => {
    const actorEmail = String(stage.payload?.actorEmail || "").trim().toLowerCase();
    return !actorEmail || actorEmail === String(context.account.email).trim().toLowerCase();
  });
  const agentStateSnapshot = context.agentState || {
    extensionId: context.account.extensionId || null,
    cxAgentId: context.account.cxAgentId || null,
    name: context.account.name || user?.name || user?.email || "CX agent",
    company: context.account.company || context.domain,
    status: "offline",
    exTelephonyStatus: "NoCall",
    exPresenceStatus: "Offline",
    currentCall: {},
    cxRouting: null,
  };
  const freshLeadGate = deriveFreshLeadGate(
    agentStateSnapshot,
    agentStateSnapshot.cxRouting || null,
  );
  const queuePolicy = resolveAccountQueuePolicy(context.account || null);
  const appointments = Array.isArray(agentStateSnapshot.appointments)
    ? [...agentStateSnapshot.appointments]
      .sort((left, right) => new Date(left.legalDialAt || left.appointmentAt || 0) - new Date(right.legalDialAt || right.appointmentAt || 0))
      .slice(0, 25)
    : [];

  return {
    domain: context.domain,
    agent: {
      email: context.account.email,
      name: context.account.name,
      extensionId: context.account.extensionId || null,
      cxAgentId: context.account.cxAgentId || null,
      stationLabel: context.account.stationLabel || null,
      workspace: context.account.workspace || null,
      company: context.account.company || context.domain,
      queuePolicy,
      exShells: normalizeExShells(context.account.exShells || []).map(summarizeExShell),
      requestedExShell: summarizeExShell(requestedExShell),
      activeExShell: summarizeExShell(activeExShell),
      appointments,
    },
    ex: {
      status: context.agentState?.status || "offline",
      exPresenceStatus: context.agentState?.exPresenceStatus || "Offline",
      exTelephonyStatus: context.agentState?.exTelephonyStatus || "NoCall",
      currentCall: context.agentState?.currentCall || null,
      cxRouting: context.agentState?.cxRouting || null,
      freshLeadGate,
      lastStatusChange: context.agentState?.lastStatusChange || null,
      lastEventReceived: context.agentState?.lastEventReceived || null,
      dailyStats: context.agentState?.dailyStats || null,
      activePlatform: context.agentState?.activePlatform || null,
    },
    counts: {
      callQueue: callQueue.length,
      appointments: appointments.length,
      tasks: openTasks.length,
      reminders: openReminders.length,
      workflowStages: assignedWorkflowStages.length,
    },
    callQueue,
    tasks: openTasks,
    reminders: openReminders,
    recentWorkflowStages: assignedWorkflowStages,
    capabilities: {
      canSetCxStatus: true,
      canDispositionCalls: true,
      canCreateTasks: true,
      canCreateReminders: true,
      canDialFromCx: true,
      canTextFromEx: true,
      canEmailFromSendgrid: true,
      canCreateLogicsCase: true,
      canFindLogicsMatch: true,
      canUpdateLogicsLeadStatus: true,
    },
    executionPlan: {
      text: "ringcentral-ex",
      email: "sendgrid",
      dial: "cx-campaign-queue",
      status: "cx-status-management",
      caseLookup: "logics-phone-lookup",
    },
    notes: [
      "RingCentral EX texting currently routes through the universal SMS pipe shell so diagnostics stay centralized while Parallel keeps the case and brand context.",
      "CX email sends through SendGrid while preserving agent context in the control-plane workflow trail.",
      "Outbound calling is modeled as a CX campaign-queue request with the agent's EX number as the caller identity.",
    ],
  };
}

async function buildCxCallQueue(domain, user) {
  let context = await resolveCxUserContext(domain, user);
  context = await touchCxWorkspacePresenceForContext(context, user);
  const docs = await buildCxQueueItems(context, 50);
  return {
    domain: context.domain,
    items: docs,
  };
}

function summarizeCxQueueFamilyCounts(queueItems = []) {
  const byFamily = {
    "fresh-day1": 0,
    "fresh-day2to10": 0,
    "fresh-day16to30": 0,
    aged: 0,
    dead: 0,
    unassigned: 0,
  };
  const byState = {};

  for (const item of queueItems || []) {
    const family = getQueueItemFamily(item);
    byFamily[family] = (byFamily[family] || 0) + 1;
    const state = getQueueItemState(item) || "unknown";
    byState[state] = (byState[state] || 0) + 1;
  }

  return {
    total: queueItems.length,
    byFamily,
    byState,
  };
}

function queuePolicyTargetTotal(policy = {}) {
  return (
    Number(policy.fresh?.targetOpen || 0) +
    Number(policy.day2to15?.targetOpen || 0) +
    Number(policy.day16to30?.targetOpen || 0) +
    Number(policy.aged?.targetOpen || 0)
  ) || Number(policy.totalOpen || 0) || 0;
}

async function listCxQueueBuildAccounts(domain, extensionIds = []) {
  const requestedExtensions = Array.from(
    new Set(
      (Array.isArray(extensionIds) ? extensionIds : String(extensionIds || "").split(","))
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );

  if (requestedExtensions.length > 0) {
    const accounts = [];
    const missing = [];
    for (const extensionId of requestedExtensions) {
      const account = await userAccountRepository.findUserAccountByExtensionId(extensionId);
      if (account?.email) {
        accounts.push(account);
      } else {
        missing.push(extensionId);
      }
    }
    return { accounts, missing };
  }

  const accounts = await userAccountRepository.listUserAccounts({ status: "active" });
  return {
    accounts: accounts.filter((account) => {
      if (!account?.extensionId) return false;
      const policy = resolveAccountQueuePolicy(account);
      return policy.enabled && queuePolicyTargetTotal(policy) > 0;
    }),
    missing: [],
  };
}

async function buildCxQueueForAgent(domain, extensionId, options = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) {
    const err = new Error("extensionId is required");
    err.status = 400;
    throw err;
  }

  const account = await userAccountRepository.findUserAccountByExtensionId(normalizedExtensionId);
  if (!account?.email) {
    const err = new Error(`No user account is paired to extension ${normalizedExtensionId}`);
    err.status = 404;
    throw err;
  }

  const user = {
    email: account.email,
    name: account.name || account.email,
    company: account.company || domain || "WYNN",
    extensionId: account.extensionId || normalizedExtensionId,
    cxAgentId: account.cxAgentId || null,
    workspace: account.workspace || "cx",
    stationLabel: account.stationLabel || null,
    role: account.role,
    audience: account.audience,
  };
  const context = await ensureCxAgentExtensionContext(
    await resolveCxUserContext(domain || account.company || "WYNN", user),
    user,
  );
  const agentExtensionId = String(context.account?.extensionId || normalizedExtensionId).trim();
  const beforeActive = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
  const beforeVisible = beforeActive.filter((item) => canViewQueueItemForAgent(item, context));
  const before = summarizeCxQueueFamilyCounts(beforeVisible);

  const refill = await maybeRefillCxQueueForAgent(context, agentExtensionId, beforeVisible).catch((error) => ({
    ok: false,
    error: error.message,
  }));
  const afterActive = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
  const afterVisible = afterActive.filter((item) => canViewQueueItemForAgent(item, context));
  const after = summarizeCxQueueFamilyCounts(afterVisible);
  const policy = resolveAccountQueuePolicy(context.account || account);
  const previewLimit = Math.min(Number(options.previewLimit) || 8, 25);

  return {
    ok: true,
    domain: context.domain,
    agent: {
      email: context.account.email,
      name: context.account.name || account.name || null,
      extensionId: agentExtensionId,
      cxAgentId: context.account.cxAgentId || null,
    },
    policy,
    before,
    after,
    built: Math.max(after.total - before.total, 0),
    refill,
    targetOpen: queuePolicyTargetTotal(policy),
    items: afterVisible
      .slice()
      .sort(sortQueueItemsForWorkspacePack)
      .slice(0, previewLimit)
      .map((item) => ({
      queueTicketId: item._id ? String(item._id) : null,
      caseId: item.caseId != null ? String(item.caseId) : null,
      name: item.name || null,
      phone: item.phone || null,
      queueFamily: item.queueFamily || null,
      ageBucket: deriveUcqAgeBucket(item),
      assignedExtensionId: item.assignment?.extensionId || null,
      assignedAgentName: item.assignment?.agentName || null,
    })),
  };
}

async function buildCxQueuesForAgents(input = {}) {
  const domain = normalizeDomain(input.domain || "WYNN");
  const { accounts, missing } = await listCxQueueBuildAccounts(domain, input.extensionIds || []);
  const maxAgents = Math.min(Number(input.maxAgents) || accounts.length || 0, 100);
  const selectedAccounts = accounts.slice(0, maxAgents);
  const results = [];
  const errors = [];

  for (const account of selectedAccounts) {
    try {
      results.push(await buildCxQueueForAgent(domain, account.extensionId, input));
    } catch (error) {
      errors.push({
        extensionId: account.extensionId || null,
        email: account.email || null,
        error: error.message,
        status: error.status || 500,
      });
    }
  }

  return {
    ok: errors.length === 0,
    domain,
    requested: Array.isArray(input.extensionIds) ? input.extensionIds.length : 0,
    attempted: selectedAccounts.length,
    missing,
    errors,
    results,
    totals: {
      before: results.reduce((sum, item) => sum + Number(item.before?.total || 0), 0),
      after: results.reduce((sum, item) => sum + Number(item.after?.total || 0), 0),
      built: results.reduce((sum, item) => sum + Number(item.built || 0), 0),
      targetOpen: results.reduce((sum, item) => sum + Number(item.targetOpen || 0), 0),
    },
  };
}

/**
 * Cheap, always-fresh per-agent "today's activity" rollup.
 *
 * Aggregates CxDialQueue items touched today (Pacific-time date key)
 * and groups by the extensionIds in `metadata.dailyAgentTouchedExtensionIds`.
 * Returns one row per agent with a count of distinct leads touched today
 * and the last placement time. Domain filter is optional — pass nothing
 * to roll up across both TAG and WYNN.
 *
 * Why this exists alongside getOrComputeAgentCallStats:
 *   - getOrComputeAgentCallStats reads CallLog with a 5-min snapshot cache;
 *     it's authoritative for the today/week/month/lifetime breakdown but
 *     can lag behind real time (the call-placed flow now invalidates the
 *     snapshot, but recompute still costs a CallLog aggregation).
 *   - This rollup reads queue metadata directly with no cache — single
 *     aggregation, intended for a "who's dialing right now" dashboard
 *     that admins want fresh on every poll.
 *
 * Non-destructive: read-only aggregation. No writes.
 */
async function listCxPlacedCallsToday({ domain = null } = {}) {
  const todayKey = getPacificDateKey(new Date());
  const match = { "metadata.dailyAgentTouchDateKey": todayKey };
  if (domain) {
    const normalizedDomain = String(domain || "").trim().toUpperCase();
    if (normalizedDomain) match.domain = normalizedDomain;
  }
  const rows = await CxDialQueue.aggregate([
    { $match: match },
    {
      $project: {
        domain: 1,
        lastPlacedAt: 1,
        dailyPlacedCalls: { $ifNull: ["$dailyPlacedCalls", 0] },
        touchedExtensionIds: {
          $ifNull: ["$metadata.dailyAgentTouchedExtensionIds", []],
        },
      },
    },
    { $unwind: "$touchedExtensionIds" },
    {
      $group: {
        _id: "$touchedExtensionIds",
        leadsTouchedToday: { $sum: 1 },
        placedCallsToday: { $sum: "$dailyPlacedCalls" },
        lastPlacedAt: { $max: "$lastPlacedAt" },
        domains: { $addToSet: "$domain" },
      },
    },
    {
      $project: {
        _id: 0,
        extensionId: "$_id",
        leadsTouchedToday: 1,
        placedCallsToday: 1,
        lastPlacedAt: 1,
        domains: 1,
      },
    },
    { $sort: { leadsTouchedToday: -1, extensionId: 1 } },
  ]);
  return {
    dateKey: todayKey,
    domain: match.domain || null,
    items: rows,
  };
}

async function listCxTasks(domain, user) {
  const context = await resolveCxUserContext(domain, user);
  const [tasks, reminders] = await Promise.all([
    listCxOpenItems(context.domain, context.account, "cx-task", 50),
    listCxOpenItems(context.domain, context.account, "cx-reminder", 50),
  ]);

  return {
    domain: context.domain,
    tasks,
    reminders,
  };
}

/**
 * CX case search with a four-tier ladder:
 *   1. CaseProfile  — our authoritative case records
 *   2. MasterProspectIndex — pre-promotion lead identity
 *   3. LeadCadence  — scheduled-action record (catches brand-new leads)
 *   4. Logics       — only hit when Mongo returned NO matches AND the
 *                     query looks like a concrete lookup key (case id,
 *                     10-digit phone, or E.164)
 *
 * Every returned row carries a `source` tag so the dropdown can render
 * a small pill telling the operator where the record lives. Clicking
 * a Logics-only row hands off to the existing `lookupCxLead` auto-
 * populate path — the case form fills from Logics data with a "not
 * yet in Mongo" badge so the operator can Save-to-Mongo if desired.
 */
async function searchCxCases(domain, user, filters = {}) {
  const context = await resolveCxUserContext(domain, user);
  const normalizedDomain = context.domain;
  const search = String(filters.search || "").trim();
  const limit = Math.min(Number(filters.limit) || 20, 50);

  // Tiers 1 + 2: existing CaseProfile + MasterProspect search via the
  // admin read service. Keeps the shape (prospects, caseProfiles,
  // merged) intact so existing consumers don't break.
  const base = await searchClientWorkspace(normalizedDomain, { search, limit });

  // Tag every existing merged row with its source. searchClientWorkspace
  // merges CaseProfile over MasterProspect when both exist, so a row
  // that appears in `caseProfiles` takes priority as "caseProfile".
  const caseProfileIds = new Set(
    (base.caseProfiles || [])
      .map((row) => Number(row.caseId))
      .filter(Number.isFinite),
  );
  const tagged = new Map();
  for (const row of base.merged || []) {
    const caseIdNum = Number(row.caseId);
    const source = Number.isFinite(caseIdNum) && caseProfileIds.has(caseIdNum)
      ? "caseProfile"
      : "masterProspect";
    tagged.set(String(row.caseId), { ...row, source });
  }

  // Tier 3: LeadCadence. Only search when we still have headroom in
  // the result cap — no point in running a third query if we've
  // already hit the limit from tiers 1+2.
  if (search && tagged.size < limit) {
    try {
      const cadenceRows = await leadCadenceRepository.listLeadCadence(
        normalizedDomain,
        { search, limit },
      );
      for (const cadence of cadenceRows) {
        const caseIdStr = String(cadence.caseId);
        if (tagged.has(caseIdStr)) continue; // already represented by a higher tier
        if (tagged.size >= limit) break;
        tagged.set(caseIdStr, {
          caseId: caseIdStr,
          name: cadence.name ||
            [cadence.firstName, cadence.lastName].filter(Boolean).join(" ") ||
            null,
          phone: cadence.primaryPhone || cadence.normalizedPhone || null,
          email: cadence.email || null,
          status: cadence.currentStage || null,
          domain: normalizedDomain,
          source: "leadCadence",
        });
      }
    } catch {
      // Cadence lookup failing shouldn't break search — degrade silently.
    }
  }

  // Tier 4: Logics fallback. Only runs when tiers 1-3 found NOTHING
  // AND the query looks like a concrete lookup key. Name searches
  // don't fall through — Logics has no name-search endpoint we can
  // hit cheaply, and it's fine for those to simply return empty.
  if (search && tagged.size === 0) {
    const digits = search.replace(/\D/g, "");
    const caseIdFromNumeric = /^\d+$/.test(search) && search.length < 10
      ? Number(search)
      : null;
    const phoneCandidate = digits.length === 10 || digits.length === 11
      ? digits.slice(-10)
      : null;

    try {
      const client = createLogicsClient(normalizedDomain);
      let logicsRecord = null;

      if (caseIdFromNumeric != null) {
        const payload = await client.getCaseInfo(caseIdFromNumeric).catch((err) => {
          if (err?.details?.responseStatus === 404) return null;
          throw err;
        });
        logicsRecord = extractLogicsRecord(payload);
      } else if (phoneCandidate) {
        const payload = await client
          .findCaseByPhone(`+1${phoneCandidate}`)
          .catch((err) => {
            if (err?.details?.responseStatus === 404) return null;
            throw err;
          });
        logicsRecord = extractLogicsRecord(payload);
      }

      if (logicsRecord && logicsRecord.CaseID != null) {
        const caseIdStr = String(logicsRecord.CaseID);
        tagged.set(caseIdStr, {
          caseId: caseIdStr,
          name: [logicsRecord.FirstName, logicsRecord.LastName].filter(Boolean).join(" ") || null,
          phone: logicsRecord.CellPhone || logicsRecord.HomePhone || logicsRecord.WorkPhone || null,
          email: logicsRecord.Email || null,
          status: logicsRecord.StatusLabel || (logicsRecord.StatusID != null ? `StatusID ${logicsRecord.StatusID}` : null),
          domain: normalizedDomain,
          source: "logics",
        });
      }
    } catch {
      // Logics failure is non-fatal — degraded to "no match" result.
    }
  }

  const merged = Array.from(tagged.values()).slice(0, limit);
  return {
    ...base,
    merged,
  };
}

// Parse the various envelope shapes Logics hands back (`payload.data`,
// `payload.Data`, raw object, or a one-element array of matches).
function extractLogicsRecord(payload) {
  if (!payload) return null;
  const raw =
    payload.data !== undefined && payload.data !== null
      ? payload.data
      : payload.Data !== undefined && payload.Data !== null
        ? payload.Data
        : payload;
  const record = Array.isArray(raw) ? raw[0] : raw;
  return record && typeof record === "object" ? record : null;
}

async function lookupCxLogicsMatch(domain, user, filters = {}) {
  const context = await resolveCxUserContext(domain, user);
  const client = createLogicsClient(context.domain);
  const phone = String(filters.phone || "").trim();
  const caseId = filters.caseId != null ? Number(filters.caseId) : null;

  if (!phone && !caseId) {
    const err = new Error("phone or caseId is required");
    err.status = 400;
    throw err;
  }

  const result = phone ? await client.findCaseByPhone(phone) : await client.getCase(caseId);

  return {
    domain: context.domain,
    phone: phone || null,
    caseId,
    result,
  };
}

async function listCxLogicsTasks(domain, user, filters = {}) {
  const context = await resolveCxUserContext(domain, user);
  const client = createLogicsClient(context.domain);
  const startDate = String(filters.startDate || "").trim();
  const endDate = String(filters.endDate || "").trim();

  if (!startDate || !endDate) {
    const err = new Error("startDate and endDate are required");
    err.status = 400;
    throw err;
  }

  const result = await client.getTasksByDateRange(startDate, endDate);

  return {
    domain: context.domain,
    startDate,
    endDate,
    result,
  };
}

async function recordCxCommand({
  domain,
  user,
  subtype,
  aggregateType,
  aggregateId,
  caseId = null,
  title,
  summary,
  payload = null,
  reviewCategory = null,
  reviewTitle = null,
  reviewSummary = null,
}) {
  const context = await resolveCxUserContext(domain, user);
  const happenedAt = new Date();

  const workflow = await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype,
    stage: "requested",
    aggregateType,
    aggregateId,
    caseId,
    sourceService: "control-plane",
    title,
    summary,
    payload: {
      ...payload,
      actorEmail: context.account.email,
      actorName: context.account.name || null,
      extensionId: context.account.extensionId || null,
      cxAgentId: context.account.cxAgentId || null,
    },
    happenedAt,
  });

  let reviewItem = null;
  if (reviewCategory) {
    reviewItem = await reviewQueueRepository.createReviewQueueItem({
      domain: context.domain,
      caseId: caseId != null ? Number(caseId) : null,
      sourceService: "control-plane",
      workflow: "cx-user",
      category: reviewCategory,
      severity: "info",
      status: "open",
      title: reviewTitle || title,
      summary: reviewSummary || summary || null,
      happenedAt,
      payload: {
        ...(payload || {}),
        assigneeEmail: context.account.email,
        assigneeName: context.account.name || null,
        extensionId: context.account.extensionId || null,
        commandSubtype: subtype,
      },
      tags: ["cx", subtype],
    });
  }

  return {
    domain: context.domain,
    requested: true,
    workflowId: String(workflow._id),
    reviewItemId: reviewItem ? String(reviewItem._id) : null,
  };
}

async function requestCxStatusChange(domain, user, input = {}) {
  const nextStatus = String(input.status || "").trim().toLowerCase();
  if (!nextStatus) {
    const err = new Error("status is required");
    err.status = 400;
    throw err;
  }

  const desiredAvailability =
    nextStatus === "unavailable" || nextStatus === "pause" || nextStatus === "paused"
      ? "unavailable"
      : nextStatus === "available" || nextStatus === "resume" || nextStatus === "active"
        ? "available"
        : null;

  if (!desiredAvailability) {
    const err = new Error('status must be "available" or "unavailable"');
    err.status = 400;
    throw err;
  }
  const requestedBreakType = desiredAvailability === "unavailable"
    ? normalizeCxPauseType(input.breakType || input.pauseType) || "short-break"
    : null;

  const context = await ensureCxAgentExtensionContext(await resolveCxUserContext(domain, user), user);
  const requested = await recordCxCommand({
    domain: context.domain,
    user,
    subtype: "set-status",
    aggregateType: "cx-user",
    aggregateId: user.email,
    title: "CX status change requested",
    summary: `Set CX routing to ${desiredAvailability}`,
    payload: {
      status: desiredAvailability,
      reason: input.reason || null,
      breakType: requestedBreakType,
    },
  });

  const currentCall = context.agentState?.currentCall && typeof context.agentState.currentCall === "object"
    ? context.agentState.currentCall
    : {};
  const stateSnapshot = {
    extensionId: context.account.extensionId,
    cxAgentId: context.account.cxAgentId || context.agentState?.cxAgentId || null,
    name: context.account.name || user.name || user.email,
    company: context.account.company || context.domain,
    status: context.agentState?.status || "offline",
    exTelephonyStatus: context.agentState?.exTelephonyStatus || "NoCall",
    exPresenceStatus: context.agentState?.exPresenceStatus || "Offline",
    currentCall,
    activePlatform: context.agentState?.activePlatform || "none",
    lastStatusChange: context.agentState?.lastStatusChange || new Date(),
    lastEventReceived: context.agentState?.lastEventReceived || null,
    dailyStats: context.agentState?.dailyStats || {},
    upstream: context.agentState?.upstream || {
      source: "cx-workspace",
      mirroredAt: new Date(),
    },
  };
  const effectiveRouting = buildManualCxRouting(
    { ...(context.agentState || {}), ...stateSnapshot, cxRouting: context.agentState?.cxRouting || null },
    desiredAvailability,
    { breakType: requestedBreakType },
  );
  effectiveRouting.lastQueueReleaseAt = context.agentState?.cxRouting?.lastQueueReleaseAt || null;
  const freshLeadGate = deriveFreshLeadGate(stateSnapshot, effectiveRouting);
  const hasActiveExCall = freshLeadGate.source === "ex-call";
  const effectiveAvailability = effectiveRouting.desiredAvailability;
  const platformHoldActive = hasActiveExCall || effectiveRouting.reason === "long-call-hold";
  const activityState = platformHoldActive
    ? deriveActivityState(stateSnapshot, null)
    : desiredAvailability === "unavailable"
      ? "unavailable"
      : "idle";

  const updatedState = await agentStateRepository.upsertAgentState({
    ...stateSnapshot,
    activityState,
    lastActivityAt: new Date(),
    cxRouting: effectiveRouting,
    upstream: {
      source: "cx-workspace",
      mirroredAt: new Date(),
    },
  });
  const now = new Date();
  const pauseReleaseAt = updatedState?.cxRouting?.pauseReleaseAt
    ? new Date(updatedState.cxRouting.pauseReleaseAt)
    : null;
  const manualUnavailableReleaseDelayMs =
    pauseReleaseAt && !Number.isNaN(pauseReleaseAt.getTime())
      ? Math.max(pauseReleaseAt.getTime() - now.getTime(), 0)
      : 0;
  const queueRelease = desiredAvailability === "unavailable"
    ? {
      ok: true,
      pending: true,
      released: 0,
      reason: "manual-unavailable-delay",
      delayMs: manualUnavailableReleaseDelayMs,
      releaseAt:
        pauseReleaseAt && !Number.isNaN(pauseReleaseAt.getTime())
          ? pauseReleaseAt
          : null,
    }
    : null;
  const breakUsage = getBreakUsageSummary(updatedState?.cxRouting?.breakUsage || {});
  let eligibilityKick = null;
  if (
    desiredAvailability === "available"
    && updatedState?.activityState === "idle"
    && updatedState?.cxRouting?.desiredAvailability === "available"
  ) {
    try {
      const { onAgentBecomesEligible } = require("./freshLeadAssignmentService");
      eligibilityKick = await onAgentBecomesEligible(context.account.extensionId);
    } catch (error) {
      eligibilityKick = { ok: false, error: error.message };
    }
  }

  const completed = await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "set-status",
    stage: "completed",
    aggregateType: "cx-user",
    aggregateId: user.email,
    sourceService: "control-plane",
    title: "CX status updated",
    summary:
      effectiveAvailability === "available"
        ? "Agent is available for CX lead serving"
        : hasActiveExCall
          ? "Agent remains unavailable for CX while an EX call is active"
          : "Agent is manually unavailable for CX lead serving",
    result: {
      requested,
      cxRouting: updatedState?.cxRouting || null,
      freshLeadGate,
      queueRelease,
      breakUsage,
      eligibilityKick,
    },
  });

  return {
    ...requested,
    completed: true,
    completionWorkflowId: completed ? String(completed._id) : null,
    response: {
      extensionId: context.account.extensionId,
      cxRouting: updatedState?.cxRouting || null,
      freshLeadGate,
      queueRelease,
      breakUsage,
      eligibilityKick,
    },
  };
}

async function requestCxDisposition(domain, user, input = {}) {
  if (!input.caseId) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const context = await ensureCxAgentExtensionContext(await resolveCxUserContext(domain, user), user);
  const normalizedCaseId = Number(input.caseId);
  const queueItem = Number.isFinite(normalizedCaseId)
    ? await resolveCxDialQueueItem(context.domain, normalizedCaseId, input)
    : null;
  assertQueueItemBelongsToAgent(queueItem, context, user);

  const normalizedDisposition = normalizeCxDisposition(input.disposition);
  const settlementOfficerId =
    normalizedDisposition === "postdate" || normalizedDisposition === "deal"
      ? requireCxSettlementOfficerId(context.domain, context.account, user)
      : null;
  if (normalizedDisposition === "dnc" || normalizedDisposition === "postdate" || input.logicsStatusId != null) {
    const result = await requestCxLeadStatusUpdate(context.domain, user, {
      caseId: input.caseId,
      status:
        normalizedDisposition === "postdate"
          ? "post-date"
          : normalizedDisposition === "dnc"
            ? "dnc"
            : input.status || input.logicsStatus || null,
      logicsStatusId: input.logicsStatusId || null,
      notes: input.notes || null,
      phone: input.phone || null,
      searchPhone: input.searchPhone || input.phone || null,
      queueActionKey: extractQueueActionKey(input),
      queueItemId: input.queueItemId || input.queueTicketId || null,
      assignedExtensionId: input.assignedExtensionId || null,
      SetOfficerID: normalizedDisposition === "postdate" ? settlementOfficerId : null,
    });
    const hangup = await hangupCxCallAfterDisposition({
      context,
      user,
      input,
      queueItem,
      caseId: normalizedCaseId,
      disposition: normalizedDisposition || input.disposition || null,
    });
    const queueOutcome = String(result?.queueOutcome || "").trim().toLowerCase();
    return {
      ...result,
      completed: ["completed", "cancelled"].includes(queueOutcome),
      wrapUpRequired: false,
      callHeldOpen: false,
      hangup,
    };
  }

  if (normalizedDisposition === "deal") {
    const title = "Deal handoff requested";
    const summary = `Prepare payment handoff for case ${input.caseId}`;
    const requested = await recordCxCommand({
      domain: context.domain,
      user,
      subtype: "deal-handoff",
      aggregateType: "case-profile",
      aggregateId: input.caseId,
      caseId: input.caseId,
      title,
      summary,
      payload: {
        disposition: "deal",
        notes: input.notes || null,
        phone: input.phone || null,
        searchPhone: input.searchPhone || input.phone || null,
        queueActionKey: extractQueueActionKey(input),
        queueItemId: input.queueItemId || input.queueTicketId || null,
        queueTicketId: input.queueItemId || input.queueTicketId || null,
        leadName: input.leadName || input.name || null,
        settlementOfficerId,
        paymentContext:
          input.paymentContext && typeof input.paymentContext === "object"
            ? input.paymentContext
            : null,
      },
      reviewCategory: "cx-deal-handoff",
      reviewTitle: "Deal payment handoff",
      reviewSummary: `Payment handoff needed for case ${input.caseId}`,
    });
    const settlementOfficerUpdate = await executeCxLogicsUpdateCase(context.domain, user, {
      caseId: normalizedCaseId,
      CaseID: normalizedCaseId,
      SetOfficerID: settlementOfficerId,
      skipQueueFinalize: true,
    });
    const outcome = await finalizeCxDispositionDeal(context.domain, {
      ...input,
      actorEmail: context.account?.email || user?.email || null,
      workflowId: requested.workflowId || null,
      reviewItemId: requested.reviewItemId || null,
      settlementOfficerId,
    });
    const completed = await recordWorkflowStage({
      domain: context.domain,
      family: "cx",
      subtype: "deal-handoff",
      stage: "completed",
      aggregateType: "case-profile",
      aggregateId: input.caseId,
      caseId: input.caseId,
      sourceService: "control-plane",
      title,
      summary: `${summary} completed`,
      result: {
        requested,
        settlementOfficerUpdate,
        response: outcome,
        hangup: {
          skipped: true,
          reason: "deal-handoff-call-held-open",
        },
      },
    });
    return {
      ...requested,
      completed: true,
      completionWorkflowId: String(completed._id),
      disposition: outcome?.disposition || "Deal handoff",
      queueOutcome: outcome?.queueOutcome || null,
      paymentHandoffStatus: outcome?.paymentHandoffStatus || "pending",
      settlementOfficerId,
      settlementOfficerUpdate,
      callHeldOpen: true,
      response: outcome,
      hangup: {
        skipped: true,
        reason: "deal-handoff-call-held-open",
      },
    };
  }

  if (normalizedDisposition === "did-not-answer" || normalizedDisposition === "answered") {
    const title = "Disposition requested";
    const friendlyDisposition = normalizedDisposition === "answered" ? "answered" : "did not answer";
    const summary = `Apply disposition ${friendlyDisposition} to case ${input.caseId}`;
    const requested = await recordCxCommand({
      domain: context.domain,
      user,
      subtype: "disposition",
      aggregateType: "case-profile",
      aggregateId: input.caseId,
      caseId: input.caseId,
      title,
      summary,
      payload: {
        disposition: normalizedDisposition,
        notes: input.notes || null,
        queueActionKey: extractQueueActionKey(input),
        queueItemId: input.queueItemId || input.queueTicketId || null,
        phone: input.phone || null,
      },
    });
    const outcome = normalizedDisposition === "answered"
      ? await finalizeCxDispositionAnswered(context.domain, {
        ...input,
        actorEmail: context.account?.email || user?.email || null,
      })
      : await finalizeCxDispositionDidNotAnswer(context.domain, {
        ...input,
        actorEmail: context.account?.email || user?.email || null,
      });
  const clearResult = await clearAgentCxCallState(
      context.account?.extensionId || user?.extensionId || input.assignedExtensionId || null,
      `cx-${normalizedDisposition}`,
      {
        uii: input.uii || input.rcxUii || queueItem?.metadata?.lastDialExecutionUii || null,
        caseId: queueItem?.caseId || null,
        phone: input.phone || queueItem?.phone || null,
        queueItemId: queueItem?._id ? String(queueItem._id) : null,
      },
  );
    const hasNextDialRequest = Boolean(input.nextDial && typeof input.nextDial === "object" && input.nextDial.phone);
    // Do NOT serve the next lead if the CX clear was SKIPPED because the agent is still on a live
    // CX call (missing-uii / different-active-cx-call) — advancing then is the Tracey->Veronica leak.
    const clearSkipped = Boolean(clearResult?.skipped);
    let hangup = null;
    let nextDial = null;
    if (clearSkipped) {
      queueCxTerminalDispositionBackgroundCleanup({
        context,
        user,
        input,
        queueItem,
        caseId: normalizedCaseId,
        title,
        summary,
        disposition: normalizedDisposition,
        outcome,
        requested,
      });
      nextDial = { ok: false, skipped: true, reason: clearResult.reason || "cx-clear-skipped" };
    } else if (hasNextDialRequest) {
      hangup = await hangupCxCallAfterDisposition({
        context,
        user,
        input: {
          ...input,
          skipAgentStateClearAfterRelay: true,
        },
        queueItem,
        caseId: normalizedCaseId,
        disposition: normalizedDisposition,
      });
      await recordWorkflowStage({
        domain: context.domain,
        family: "cx",
        subtype: "disposition",
        stage: "completed",
        aggregateType: "case-profile",
        aggregateId: input.caseId,
        caseId: input.caseId,
        sourceService: "control-plane",
        title,
        summary: `${summary} completed`,
        result: {
          requested,
          response: outcome,
          hangup,
        },
      }).catch(() => null);
      nextDial = dispositionHangupRelayAccepted(hangup)
        ? await requestCxNextDialHandoff({ context, user, input })
        : {
            ok: false,
            skipped: true,
            reason: hangup?.reason || hangup?.error || "disposition-hangup-not-accepted",
            hangup,
          };
    } else {
      queueCxTerminalDispositionBackgroundCleanup({
        context,
        user,
        input,
        queueItem,
        caseId: normalizedCaseId,
        title,
        summary,
        disposition: normalizedDisposition,
        outcome,
        requested,
      });
      nextDial = await requestCxNextDialHandoff({ context, user, input });
    }
    return {
      ...requested,
      completed: !clearSkipped,
      completionWorkflowId: null,
      disposition: outcome?.disposition || friendlyDisposition,
      queueOutcome: outcome?.queueOutcome || null,
      rescheduledFor: outcome?.rescheduledFor || null,
      unansweredCalls: outcome?.unansweredCalls || null,
      queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      queueTicketId: outcome?.queueTicketId || outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      response: outcome,
      clearResult,
      nextDial,
      callHeldOpen: clearSkipped,
      wrapUpRequired: false,
      hangup: hangup || {
        ok: !clearSkipped,
        acceptedLocally: !clearSkipped,
        backgroundPending: !clearSkipped,
        reason: clearSkipped
          ? clearResult.reason || "cx-clear-skipped"
          : "disposition-hangup-backgrounded",
      },
    };
  }

  if (normalizedDisposition === "call-back") {
    const title = "Disposition requested";
    const summary = `Apply disposition call back to case ${input.caseId}`;
    const requested = await recordCxCommand({
      domain: context.domain,
      user,
      subtype: "disposition",
      aggregateType: "case-profile",
      aggregateId: input.caseId,
      caseId: input.caseId,
      title,
      summary,
      payload: {
        disposition: "call-back",
        notes: input.notes || null,
        queueActionKey: extractQueueActionKey(input),
        queueItemId: input.queueItemId || input.queueTicketId || null,
        phone: input.phone || null,
      },
    });
    const outcome = await finalizeCxDispositionCallback(context.domain, {
      ...input,
      actorEmail: context.account?.email || user?.email || null,
    });
  const clearResult = await clearAgentCxCallState(
      context.account?.extensionId || user?.extensionId || input.assignedExtensionId || null,
      "cx-callback-eject",
      {
        uii: input.uii || input.rcxUii || queueItem?.metadata?.lastDialExecutionUii || null,
        caseId: queueItem?.caseId || null,
        phone: input.phone || queueItem?.phone || null,
        queueItemId: queueItem?._id ? String(queueItem._id) : null,
      },
  );
    queueCxCallbackBackgroundCleanup({
      context,
      user,
      input,
      queueItem,
      caseId: normalizedCaseId,
      title,
      summary,
      outcome,
      requested,
    });
    // Do NOT serve the next lead if the CX clear was SKIPPED because the agent is still on a live
    // CX call (missing-uii / different-active-cx-call) — advancing then is the Tracey->Veronica leak.
    const clearSkipped = Boolean(clearResult?.skipped);
    const nextDial = clearSkipped
      ? { ok: false, skipped: true, reason: clearResult.reason || "cx-clear-skipped" }
      : await requestCxNextDialHandoff({ context, user, input });
    return {
      ...requested,
      completed: !clearSkipped,
      completionWorkflowId: null,
      disposition: outcome?.disposition || "Call Back",
      queueOutcome: outcome?.queueOutcome || null,
      rescheduledFor: outcome?.rescheduledFor || null,
      callbackEjected: Boolean(outcome?.callbackEjected),
      queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      queueTicketId: outcome?.queueTicketId || outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      queueEjection: outcome?.queueEjection || null,
      response: outcome,
      clearResult,
      nextDial,
      callHeldOpen: clearSkipped,
      wrapUpRequired: false,
      hangup: {
        ok: !clearSkipped,
        acceptedLocally: !clearSkipped,
        backgroundPending: !clearSkipped,
        reason: clearSkipped
          ? clearResult.reason || "cx-clear-skipped"
          : "callback-hangup-backgrounded",
      },
    };
  }

  const requested = await recordCxCommand({
    domain: context.domain,
    user,
    subtype: "disposition",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: "Disposition requested",
    summary: `Apply disposition ${normalizedDisposition || input.disposition || "unknown"} to case ${input.caseId}`,
    payload: {
      disposition: normalizedDisposition || input.disposition || null,
      logicsStatusId: input.logicsStatusId || null,
      notes: input.notes || null,
      queueActionKey: extractQueueActionKey(input),
      queueItemId: input.queueItemId || input.queueTicketId || null,
    },
    reviewCategory: "cx-disposition",
  });
  const hangup = await hangupCxCallAfterDisposition({
    context,
    user,
    input,
    queueItem,
    caseId: normalizedCaseId,
    disposition: normalizedDisposition || input.disposition || null,
  });
  return {
    ...requested,
    hangup,
  };
}

async function requestCxTask(domain, user, input = {}) {
  const title = String(input.title || "").trim();
  if (!title) {
    const err = new Error("title is required");
    err.status = 400;
    throw err;
  }

  return recordCxCommand({
    domain,
    user,
    subtype: "create-task",
    aggregateType: "cx-user",
    aggregateId: user.email,
    caseId: input.caseId || null,
    title: "Task requested",
    summary: title,
    payload: {
      title,
      dueAt: input.dueAt || null,
      notes: input.notes || null,
    },
    reviewCategory: "cx-task",
  });
}

async function requestCxReminder(domain, user, input = {}) {
  const title = String(
    input.title ||
      input.reminder ||
      input.subject ||
      `Follow up ${input.caseId ? `case ${input.caseId}` : "contact"}`,
  ).trim();
  if (!title) {
    const err = new Error("title is required");
    err.status = 400;
    throw err;
  }

  return recordCxCommand({
    domain,
    user,
    subtype: "create-reminder",
    aggregateType: "cx-user",
    aggregateId: user.email,
    caseId: input.caseId || null,
    title: "Reminder requested",
    summary: title,
    payload: {
      title,
      remindAt: input.remindAt || input.at || null,
      channel: input.channel || null,
      email: input.email || null,
      notes: input.notes || null,
    },
    reviewCategory: "cx-reminder",
  });
}

async function requestCxText(domain, user, input = {}) {
  const context = await resolveCxUserContext(domain, user);
  const phone = String(input.phone || "").trim();
  const message = String(input.message || input.body || "").trim();
  if (!phone || !message) {
    const err = new Error("phone and message/body are required");
    err.status = 400;
    throw err;
  }

  const requestedShell = resolveActiveExShell(context);
  const exShell = resolveTextTransportShell(context, requestedShell);
  if (!exShell) {
    const err = new Error(`No EX text transport shell is configured for ${context.account.email} in ${context.domain}`);
    err.status = 409;
    throw err;
  }

  const result = await recordCxCommand({
    domain: context.domain,
    user,
    subtype: "text",
    aggregateType: "conversation",
    aggregateId: phone,
    caseId: input.caseId || null,
    title: "EX text send requested",
    summary: `Send outbound EX text to ${phone}`,
    payload: {
      phone,
      message,
      body: message,
      templateKey: input.templateKey || input.templateId || null,
      provider: "ringcentral-ex",
      exShell: summarizeExShell(exShell),
      requestedShell: summarizeExShell(requestedShell),
      complianceState: "direct-ex-send",
    },
    reviewCategory: "cx-text",
  });

  const actor = normalizeActor(user);
  let route = null;
  const sendAttempt = await runWithImmediateRetries(
    async () => {
      route = await resolveCxTextRoute(context, exShell);
      return route.client.sendExtensionSms(route.extensionId, {
        fromPhoneNumber: route.fromPhoneE164 || toE164(route.fromPhone),
        toPhoneNumber: toE164(phone) || phone,
        text: message,
      });
    },
    {
      immediateRetryAttempts: 1,
      immediateRetryDelayMs: 500,
    },
  );

  if (!sendAttempt.ok) {
    const error = sendAttempt.error;
    const workflow = await conversationWorkflowRepository.upsertConversationWorkflow(
      context.domain,
      phone,
      {
        caseId: input.caseId != null ? Number(input.caseId) : null,
        channel: "sms",
        status: "manual-review",
        sourceService: "control-plane",
        metadata: {
          lastOutboundText: message,
          lastOutboundTemplateKey: input.templateKey || input.templateId || null,
          provider: "ringcentral-ex",
          actorEmail: actor.actorEmail,
          shell: summarizeExShell(route?.shell || exShell),
          requestedShell: summarizeExShell(requestedShell),
          fromPhone: route?.fromPhone || exShell.primaryPhone || null,
          sendError: error?.message || String(error || "EX text send failed"),
        },
      },
    );
    const workflowId = workflow?._id ? String(workflow._id) : null;
    await Promise.all([
      recordCommunicationThread(context.domain, input.caseId, "sms", {
        provider: "ringcentral-ex",
        threadKey: phone,
        direction: "outbound",
        phone,
        body: message,
        templateKey: input.templateKey || input.templateId || null,
        status: "failed",
        workflowId: result.workflowId || null,
        actorEmail: actor.actorEmail,
        actorName: actor.actorName,
        metadata: {
          shell: summarizeExShell(route?.shell || exShell),
          requestedShell: summarizeExShell(requestedShell),
          fromPhone: route?.fromPhone || exShell.primaryPhone || null,
          immediateRetryUsed: sendAttempt.attemptsUsed || 0,
          error: error?.message || String(error || "EX text send failed"),
        },
      }),
      workflowId
        ? conversationMessageRepository.createOutboundMessage({
            workflowId,
            domain: context.domain,
            phone,
            caseId: input.caseId != null ? Number(input.caseId) : null,
            channel: "sms",
            body: message,
            provider: "ringcentral-ex",
            providerStatus: "failed",
            providerError: error?.message || String(error || "EX text send failed"),
            approvedByEmail: actor.actorEmail,
          })
        : Promise.resolve(null),
      recordWorkflowStage({
        domain: context.domain,
        family: "cx",
        subtype: "text",
        stage: "failed",
        aggregateType: "conversation",
        aggregateId: phone,
        caseId: input.caseId || null,
        sourceService: "control-plane",
        title: "EX text send failed",
        summary: `Could not send EX text to ${phone}`,
        payload: {
          requestedWorkflowId: result.workflowId,
          phone,
          fromPhone: route?.fromPhone || exShell.primaryPhone || null,
          shell: summarizeExShell(route?.shell || exShell),
          requestedShell: summarizeExShell(requestedShell),
          immediateRetryUsed: sendAttempt.attemptsUsed || 0,
        },
        result: {
          error: error?.message || String(error || "EX text send failed"),
        },
      }),
    ]);
    throw error;
  }

  const response = sendAttempt.result;
  const providerMessageId = response?.id != null ? String(response.id) : null;
  const workflow = await conversationWorkflowRepository.upsertConversationWorkflow(
    context.domain,
    phone,
    {
      caseId: input.caseId != null ? Number(input.caseId) : null,
      channel: "sms",
      status: "sent",
      sourceService: "control-plane",
      metadata: {
        lastOutboundText: message,
        lastOutboundTemplateKey: input.templateKey || input.templateId || null,
        provider: "ringcentral-ex",
        providerMessageId,
        actorEmail: actor.actorEmail,
        shell: summarizeExShell(route?.shell || exShell),
        requestedShell: summarizeExShell(requestedShell),
        fromPhone: route?.fromPhone || exShell.primaryPhone || null,
      },
    },
  );
  const workflowId = workflow?._id ? String(workflow._id) : null;
  await Promise.all([
    recordCommunicationThread(context.domain, input.caseId, "sms", {
      provider: "ringcentral-ex",
      threadKey: providerMessageId || phone,
      direction: "outbound",
      phone,
      body: message,
      templateKey: input.templateKey || input.templateId || null,
      status: "sent",
      workflowId: result.workflowId || null,
      actorEmail: actor.actorEmail,
      actorName: actor.actorName,
      metadata: {
        shell: summarizeExShell(route?.shell || exShell),
        requestedShell: summarizeExShell(requestedShell),
        fromPhone: route?.fromPhone || exShell.primaryPhone || null,
        providerMessageId,
        immediateRetryUsed: sendAttempt.attemptsUsed || 0,
      },
    }),
    workflowId
      ? conversationMessageRepository.createOutboundMessage({
          workflowId,
          domain: context.domain,
          phone,
          caseId: input.caseId != null ? Number(input.caseId) : null,
          channel: "sms",
          body: message,
          provider: "ringcentral-ex",
          providerMessageId,
          providerStatus: "sent",
          approvedByEmail: actor.actorEmail,
        })
      : Promise.resolve(null),
  ]);

  const completed = await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "text",
    stage: "completed",
    aggregateType: "conversation",
    aggregateId: phone,
    caseId: input.caseId || null,
    sourceService: "control-plane",
    title: "EX text sent",
    summary: `Sent EX text to ${phone}`,
    result: {
      requested: result,
      provider: "ringcentral-ex",
      providerMessageId,
      fromPhone: route?.fromPhone || exShell.primaryPhone || null,
      shell: summarizeExShell(route?.shell || exShell),
      requestedShell: summarizeExShell(requestedShell),
      response,
    },
  });

  const routeUsesPipe = route?.shell?.source === "ringcentral-sms-pipe";
  if (route?.shell?.rcExtensionId && context.account?.id && !routeUsesPipe) {
    const existingShells = normalizeExShells(context.account.exShells || []);
    const mergedShells = existingShells.map((shell) =>
      shell.company === route.shell.company && shell.email === route.shell.email
        ? route.shell
        : shell,
    );
    const shellExists = mergedShells.some(
      (shell) => shell.company === route.shell.company && shell.email === route.shell.email,
    );
    await userAccountRepository.updateUserAccount(context.account.id, {
      exShells: shellExists ? mergedShells : [...mergedShells, route.shell],
    });
  }

  return {
    ...result,
    completed: true,
    completionWorkflowId: String(completed._id),
    response,
  };
}

async function requestCxEmail(domain, user, input = {}) {
  const context = await resolveCxUserContext(domain, user);
  const company = getCompanyConfig(context.domain);
  const to = String(input.to || input.email || "").trim();

  // Three compose paths, in priority order:
  //   1. `templateKey` names a file-backed HBS template → server-side
  //      render of subject/text/html using brand + user + variables.
  //   2. Legacy inline welcome template (kept for backwards compat).
  //   3. Free-form `subject` + `body` from the caller.
  let subject;
  let body;
  let htmlBody = null;
  let resolvedTemplateKey = input.templateKey || null;
  const clientTemplateId = input.templateId || input.clientTemplateId || null;

  if (resolvedTemplateKey && isKnownEmailTemplateKey(resolvedTemplateKey)) {
    const rendered = renderEmailTemplate({
      templateKey: resolvedTemplateKey,
      domain: context.domain,
      user,
      variables: input.variables || input,
    });
    subject = String(input.subject || rendered.subject).trim();
    body = String(input.body || rendered.text).trim();
    htmlBody = input.html || rendered.html || null;
  } else if (input.subject || input.body) {
    subject = String(input.subject || "").trim();
    body = String(input.body || "").trim();
    resolvedTemplateKey = null;
  } else {
    const template = buildWelcomeEmailTemplate();
    const templateContext = buildTemplateContext(context.domain, user, input);
    subject = String(input.subject || renderHbs(template.subject, templateContext)).trim();
    body = String(input.body || renderHbs(template.body, templateContext)).trim();
    if (!resolvedTemplateKey) resolvedTemplateKey = "cx-welcome";
  }

  if (!to || !subject) {
    const err = new Error("to and subject are required");
    err.status = 400;
    throw err;
  }

  const result = await recordCxCommand({
    domain: context.domain,
    user,
    subtype: "email",
    aggregateType: "email-thread",
    aggregateId: to,
    caseId: input.caseId || null,
    title: "Mailbox email requested",
    summary: `Queue templated email to ${to}`,
    payload: {
      to,
      subject,
      body,
      html: htmlBody,
      templateKey: resolvedTemplateKey || clientTemplateId || null,
      serverTemplateKey: resolvedTemplateKey,
      clientTemplateId,
      sendAs: getMarketingFromEmail(),
    },
    reviewCategory: "cx-email",
  });

  const sendgrid = createSendgridClient(context.domain);
  const fromEmail = getMarketingFromEmail();
  const fromName = String(user?.name || company.name || context.domain).trim();
  const payload = {
    personalizations: [
      {
        to: [{ email: to }],
        custom_args: {
          company: context.domain,
          channel: "cx-email",
          caseId: input.caseId != null ? String(input.caseId) : "",
          workflowId: result.workflowId,
        },
      },
    ],
    from: {
      email: fromEmail,
      name: fromName,
    },
    reply_to: {
      email: fromEmail,
      name: fromName,
    },
    subject,
    content: [
      {
        type: "text/plain",
        value: body,
      },
      ...(htmlBody
        ? [{ type: "text/html", value: htmlBody }]
        : []),
    ],
  };

  const response = await sendgrid.sendEmail(payload);
  const actor = normalizeActor(user);
  await Promise.all([
    recordCommunicationThread(context.domain, input.caseId, "email", {
      provider: "sendgrid",
      threadKey: to,
      direction: "outbound",
      email: to,
      subject,
      body,
      templateKey: resolvedTemplateKey || clientTemplateId || null,
      status: "sent",
      workflowId: result.workflowId || null,
      actorEmail: actor.actorEmail,
      actorName: actor.actorName,
      metadata: {
        serverTemplateKey: resolvedTemplateKey,
        clientTemplateId,
        sendgridStatus: response.status,
      },
    }),
    input.caseId ? syncCaseProfileFromLogics(context.domain, Number(input.caseId)).catch(() => null) : Promise.resolve(null),
  ]);

  const completed = await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "email",
    stage: "completed",
    aggregateType: "email-thread",
    aggregateId: to,
    caseId: input.caseId || null,
    sourceService: "control-plane",
    title: "Mailbox email sent",
    summary: `Sent CX email to ${to}`,
    result: {
      requested: result,
      response,
    },
  });

  return {
    ...result,
    completed: true,
    completionWorkflowId: String(completed._id),
    response,
  };
}

async function resolveCxDialQueueItem(domain, caseId, input = {}) {
  const expectedDomain = normalizeDomain(domain);
  const expectedCaseId = Number(caseId);
  const queueItemId = String(input.queueItemId || input.queueTicketId || "").trim();
  if (queueItemId) {
    const byId = await cxDialQueueRepository.findQueueItemById(queueItemId);
    if (byId) {
      const item = byId.toObject ? byId.toObject() : byId;
      const actualDomain = normalizeDomain(item.domain);
      if (expectedDomain && actualDomain && expectedDomain !== actualDomain) {
        const err = new Error("CX queue item does not belong to the requested domain.");
        err.status = 409;
        throw err;
      }
      if (
        Number.isFinite(expectedCaseId)
        && Number.isFinite(Number(item.caseId))
        && Number(item.caseId) !== expectedCaseId
      ) {
        const err = new Error("CX queue item does not belong to the requested case.");
        err.status = 409;
        throw err;
      }
      return item;
    }
  }

  if (caseId != null && Number.isFinite(Number(caseId))) {
    const actionKey = extractQueueActionKey(input);
    let byCase = await cxDialQueueRepository.findActiveQueueItem(
      domain,
      Number(caseId),
      actionKey ? { actionKey } : {},
    );
    if (!byCase && actionKey) {
      byCase = await cxDialQueueRepository.findActiveQueueItem(domain, Number(caseId));
    }
    if (byCase) {
      return byCase.toObject ? byCase.toObject() : byCase;
    }
  }

  return null;
}

function buildCxDispatchIntent({
  context,
  user,
  input = {},
  phone,
  caseId,
  queueAction = null,
  queueItem = null,
  requested = null,
  eventId = null,
}) {
  const activeExShell = resolveActiveExShell(context);
  const actorEmail = context.account?.email || user?.email || null;
  const actorName = context.account?.name || user?.name || user?.email || null;
  const actorExtensionId =
    String(context.account?.extensionId || user?.extensionId || "").trim() || null;
  const actorCxAgentId =
    context.account?.cxAgentId || context.agentState?.cxAgentId || user?.cxAgentId || null;
  const normalizedPhone = normalizeUsPhone(phone) || normalizePhone(phone) || String(phone || "").trim() || null;
  const queueItemId = String(
    queueItem?._id || input.queueItemId || input.queueTicketId || "",
  ).trim() || null;
  const actionKey =
    queueAction?.actionKey ||
    String(queueItem?.metadata?.actionKey || "").trim() ||
    null;
  const name =
    String(
      input.name ||
      input.contactName ||
      input.leadSnapshot?.name ||
      queueItem?.name ||
      "",
    ).trim() || null;
  const email =
    String(
      input.email ||
      input.leadSnapshot?.email ||
      queueItem?.email ||
      "",
    ).trim() || null;
  const sourceName =
    String(
      input.sourceName ||
      input.leadSnapshot?.sourceName ||
      queueItem?.sourceName ||
      queueAction?.cadence?.sourceName ||
      "",
    ).trim() || null;
  const intakeSource =
    String(
      input.intakeSource ||
      input.leadSnapshot?.intakeSource ||
      queueItem?.intakeSource ||
      queueAction?.cadence?.intakeSource ||
      "",
    ).trim() || null;
  const intakeRoute =
    String(
      input.intakeRoute ||
      input.leadSnapshot?.intakeRoute ||
      queueItem?.intakeRoute ||
      queueAction?.cadence?.intakeRoute ||
      "",
    ).trim() || null;
  const assignedExtensionId =
    String(
      queueItem?.assignment?.extensionId ||
      actorExtensionId ||
      "",
    ).trim() || null;
  const assignedAgentName =
    String(
      queueItem?.assignment?.agentName ||
      actorName ||
      "",
    ).trim() || null;
  const leadCadenceId = queueAction?.cadence?._id
    ? String(queueAction.cadence._id)
    : queueItem?.leadCadenceId
      ? String(queueItem.leadCadenceId)
      : null;
  const routingInput = {
    ...input,
    assignedExtensionId,
    assignedAgentName,
    dialerExtensionId: actorExtensionId,
    dialerEmail: actorEmail,
    dialerCxAgentId: actorCxAgentId,
    agent: {
      ...(input.agent && typeof input.agent === "object" ? input.agent : {}),
      email: actorEmail,
      name: actorName,
      extensionId: actorExtensionId,
      cxAgentId: actorCxAgentId,
      assignedExtensionId,
      assignedAgentName,
    },
  };
  const rcxRouting = resolveRcxRoutingForQueueIntent(routingInput, queueItem);
  const executionMode =
    String(rcxRouting.executionMode || "ringcx-campaign-queue").trim()
    || "ringcx-campaign-queue";

  return {
    type: "cx-dial-and-scramble",
    mode: executionMode === "ringcx-campaign-queue" ? "campaign-queue" : "manual-oneoff",
    executionMode,
    domain: context.domain,
    caseId,
    leadCadenceId,
    queueItemId,
    queueTicketId: queueItemId,
    consumeQueueItem: Boolean(queueItemId),
    queueState: String(input.queueState || queueItem?.state || "").trim() || null,
    queueFamily: String(input.queueFamily || queueItem?.queueFamily || "").trim() || null,
    rcxAccountId: rcxRouting.accountId,
    rcxDialGroupId: rcxRouting.dialGroupId,
    rcxCampaignId: rcxRouting.campaignId,
    progressiveStageKey:
      String(input.progressiveStageKey || queueItem?.progressiveStageKey || "").trim() || null,
    progressiveStageLabel:
      String(input.progressiveStageLabel || queueItem?.progressiveStageLabel || "").trim() || null,
    actionKey,
    assignedExtensionId,
    assignedAgentName,
    dialerExtensionId: actorExtensionId,
    dialerEmail: actorEmail,
    dialerName: actorName,
    dialerCxAgentId: actorCxAgentId,
    phone: normalizedPhone || phone,
    name,
    email,
    sourceName,
    intakeSource,
    intakeRoute,
    notes: String(input.notes || "").trim() || null,
    priority: input.priority || null,
    ringcxDialPriority: String(
      input.ringcxDialPriority ||
        input.leadLoaderDialPriority ||
        input.dialPriority ||
        "",
    ).trim().toUpperCase() || null,
    requestedBy: "cx-workspace",
    requestedBySurface: String(input.requestedBySurface || "cx-queue-card").trim(),
    requestedByUserEmail: actorEmail,
    executionOwner: "ringcentral-cx",
    futureAdapterPort: PORTS.ringcentralCx,
    workflowId: requested?.workflowId || null,
    eventId: eventId || null,
    callerIdMode: "ex-number",
    agent: routingInput.agent,
    exShell: activeExShell
      ? {
        company: activeExShell.company || null,
        email: activeExShell.email || null,
        name: activeExShell.name || null,
        primaryPhone: activeExShell.primaryPhone || null,
        extensionNumber: activeExShell.extensionNumber || null,
        rcExtensionId: activeExShell.rcExtensionId || null,
      }
      : null,
    leadSnapshot: {
      name,
      phone: normalizedPhone || phone,
      email,
      sourceName,
      intakeSource,
      intakeRoute,
    },
    scramble: {
      mode: "logics-case",
      source: "cx-queue-item",
      shouldScrambleLead: true,
      shouldRequestDial: true,
      autoOpenLogics: true,
      connectToLogics: true,
      preferredLookup: {
        domain: context.domain,
        caseId,
        phone: normalizedPhone || phone,
      },
      caseId,
      phone: normalizedPhone || phone,
      queueActionKey: actionKey,
      queueItemId,
      queueState: String(input.queueState || queueItem?.state || "").trim() || null,
      queueFamily: String(input.queueFamily || queueItem?.queueFamily || "").trim() || null,
      rcxAccountId: rcxRouting.accountId,
      rcxDialGroupId: rcxRouting.dialGroupId,
      rcxCampaignId: rcxRouting.campaignId,
      progressiveStageKey:
        String(input.progressiveStageKey || queueItem?.progressiveStageKey || "").trim() || null,
    },
  };
}

async function relayCxDispatchIntentToServing(dispatchIntent) {
  const config = getSharedConfig();
  const secret = String(config.internalServiceSecret || "").trim();
  if (!secret) {
    return {
      ok: false,
      skipped: true,
      status: null,
      reason: "missing-internal-service-secret",
    };
  }

  const controller = new AbortController();
  const relayTimeoutMs = Number(process.env.CX_DISPATCH_RELAY_TIMEOUT_MS) || 25000;
  const timeout = setTimeout(() => controller.abort(), relayTimeoutMs);
  try {
    const response = await fetch(
      `http://127.0.0.1:${PORTS.ringcentralCx}/api/ringcentral/cx-serving/dispatch-intent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-service-secret": secret,
        },
        body: JSON.stringify(dispatchIntent),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        status: response.status,
        reason: data?.error || `ringcentral-cx returned ${response.status}`,
        details: data || null,
      };
    }

    const execution = data?.result?.execution || data?.result?.result?.execution || null;
    if (execution && execution.ok === false) {
      return {
        ok: false,
        skipped: Boolean(execution.skipped),
        status: response.status,
        reason: execution.reason || execution.error || "ringcentral-cx dispatch execution failed",
        details: data || null,
      };
    }

    return {
      ok: true,
      skipped: false,
      status: response.status,
      response: data || null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      status: null,
      reason: error?.name === "AbortError" ? "dispatch-intent relay timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isManualThenCampaignCxDialMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return [
    "manual-then-campaign",
    "manual-fallback",
    "manual-fallback-campaign",
    "try-manual",
    "try-manual-then-campaign",
    "hybrid",
  ].includes(raw);
}

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldFallbackOnUnverifiedManualCxDial() {
  return boolEnv("CX_DIAL_FALLBACK_ON_UNVERIFIED", true);
}

function summarizeCxDialRelayFailure(relayResult = {}) {
  const details = relayResult?.details && typeof relayResult.details === "object"
    ? relayResult.details
    : null;
  const execution =
    details?.result?.execution ||
    details?.result?.result?.execution ||
    details?.execution ||
    null;
  return {
    ok: Boolean(relayResult?.ok),
    skipped: Boolean(relayResult?.skipped),
    status: relayResult?.status || null,
    reason: relayResult?.reason || null,
    responseError: details?.error || details?.message || null,
    execution: execution && typeof execution === "object"
      ? {
        ok: execution.ok ?? null,
        skipped: Boolean(execution.skipped),
        status: execution.status || null,
        reason: execution.reason || null,
        error: execution.error || null,
        retryable: execution.retryable ?? null,
        details: execution.details || null,
      }
      : null,
  };
}

function stringifyCxDialRelayFailure(relayResult = {}) {
  try {
    return JSON.stringify(summarizeCxDialRelayFailure(relayResult)).toLowerCase();
  } catch {
    return String(relayResult?.reason || "").toLowerCase();
  }
}

function shouldFallbackManualCxDial(relayResult = {}) {
  if (!relayResult || relayResult.ok) return false;
  const haystack = stringifyCxDialRelayFailure(relayResult);
  if (!haystack) return false;
  const disallowed = [
    "timed out",
    "timeout",
    "contact-blocked",
    "contact blocked",
    "dialer mismatch",
    "dialer-mismatch",
    "currently assigned",
    "assigned-to-other",
    "queue-item-assigned",
    "missing-phone",
    "phone is required",
    "not paired",
    "missing-agent-extension",
    "different-active-cx-call",
  ];
  if (!shouldFallbackOnUnverifiedManualCxDial()) {
    disallowed.push("placement-unverified", "unverified");
  }
  if (disallowed.some((needle) => haystack.includes(needle))) return false;
  const manualSessionFailures = [
    "ringcx-manual-preflight-failed",
    "manual preflight",
    "agent-not-logged-into-cx",
    "not logged into cx",
    "agent-has-no-offhook-session",
    "no offhook",
    "no off-hook",
    "no live session",
    "no voice session",
    "no phone session",
    "createmanualagentcall",
    "placeManualCall failed".toLowerCase(),
    "manual-call",
    "manual outbound",
    "manual-outbound",
  ];
  if (
    shouldFallbackOnUnverifiedManualCxDial()
    && (haystack.includes("placement-unverified") || haystack.includes("no-active-ringcx-call"))
  ) {
    return true;
  }
  return manualSessionFailures.some((needle) => haystack.includes(needle));
}

async function relayCxEndCallToServing(payload) {
  const config = getSharedConfig();
  const secret = String(config.internalServiceSecret || "").trim();
  if (!secret) {
    return {
      ok: false,
      skipped: true,
      status: null,
      reason: "missing-internal-service-secret",
    };
  }

  const controller = new AbortController();
  const relayTimeoutMs = Number(process.env.CX_END_CALL_RELAY_TIMEOUT_MS) || 15000;
  const timeout = setTimeout(() => controller.abort(), relayTimeoutMs);
  try {
    const response = await fetch(
      `http://127.0.0.1:${PORTS.ringcentralCx}/api/ringcentral/cx-serving/end-call`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-service-secret": secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        status: response.status,
        reason: data?.error || `ringcentral-cx returned ${response.status}`,
        details: data || null,
      };
    }

    const execution = data?.result?.execution || data?.result?.result?.execution || null;
    if (execution && execution.ok === false) {
      return {
        ok: false,
        skipped: Boolean(execution.skipped),
        status: response.status,
        reason: execution.reason || execution.error || "ringcentral-cx hangup execution failed",
        details: data || null,
      };
    }

    return {
      ok: true,
      skipped: false,
      status: response.status,
      response: data || null,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      status: null,
      reason: error?.name === "AbortError" ? "end-call relay timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractCxEndCallRelayExecution(relay = {}) {
  const data = relay?.details || relay?.response || relay || null;
  return (
    data?.result?.execution ||
    data?.result?.result?.execution ||
    data?.execution ||
    null
  );
}

function cxEndCallRelayAccepted(relay = {}) {
  if (relay?.ok) return true;
  const execution = extractCxEndCallRelayExecution(relay);
  if (!execution) return false;
  if (execution.ok === true) return true;
  const reason = String(execution.reason || execution.error || relay.reason || "").trim().toLowerCase();
  if (
    reason === "no-active-call-after-disposition" ||
    reason === "missing-uii" ||
    reason === "skipped-missing-uii" ||
    reason.includes("no active call")
  ) {
    return true;
  }
  return String(execution.hangupStatus || "").trim().toLowerCase() === "accepted";
}

function dispositionHangupRelayAccepted(relay = {}) {
  if (cxEndCallRelayAccepted(relay)) return true;
  const reason = String(relay?.reason || "").trim().toLowerCase();
  return (
    reason === "no-active-call-after-disposition" ||
    reason === "missing-uii" ||
    reason === "skipped-missing-uii" ||
    reason.includes("no active call")
  );
}

function withTimeoutResult(promise, timeoutMs, fallback) {
  const safeTimeoutMs = Number(timeoutMs);
  if (!Number.isFinite(safeTimeoutMs) || safeTimeoutMs <= 0) return promise;
  let timeout = null;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(fallback), safeTimeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function assertQueueItemBelongsToAgent(queueItem = null, context = {}, user = {}) {
  if (!queueItem) return;
  const assignedExtensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!assignedExtensionId) return;
  const actorExtensionId = String(
    context.account?.extensionId || user?.extensionId || "",
  ).trim();
  if (!actorExtensionId) {
    const err = new Error("Your account is not paired to a RingCentral extension.");
    err.status = 403;
    throw err;
  }
  if (assignedExtensionId === actorExtensionId) return;

  const err = new Error(
    `This lead is currently assigned to ${queueItem?.assignment?.agentName || assignedExtensionId}`,
  );
  err.status = 409;
  throw err;
}

async function assertNoUnresolvedCxDispositionBeforeDial(context = {}, user = {}, queueItem = null) {
  const actorExtensionId = String(
    context.account?.extensionId || user?.extensionId || "",
  ).trim();
  if (!actorExtensionId) return;
  const requestedQueueItemId = String(queueItem?._id || "").trim();
  const currentCallBlock = decideCxCurrentCallDialBlock({
    agentState: context.agentState || null,
    requestedQueueItemId,
    requestedIdentities: [
      queueItem?.metadata?.lastDialExecutionUii,
      queueItem?.metadata?.lastDialExecutionCallSessionId,
      queueItem?.metadata?.lastQueueAttemptUii,
      queueItem?.metadata?.lastHangupRequestUii,
      queueItem?.metadata?.lastTerminalOutcomeUii,
    ],
    requestedPhone: queueItem?.phone || queueItem?.metadata?.lastDialExecutionPhone || null,
  });
  if (currentCallBlock.block) {
    const err = new Error(
      "Finish the current lead before starting another call.",
    );
    err.status = 409;
    err.details = {
      reason: currentCallBlock.reason,
      ...(currentCallBlock.details || {}),
    };
    throw err;
  }

  if (isCxCanonicalCallReadEnabled()) {
    const requestedPhone = queueItem?.phone || queueItem?.metadata?.lastDialExecutionPhone || null;
    const canonicalGate = describeCxCallGate(context.agentState?.cxCall, requestedQueueItemId, {
      blockReason: "active-cx-call-in-canonical-state",
      now: new Date(),
    });
    const canonicalBlocked = Boolean(canonicalGate.blocked);
    const legacyDecision = currentCallBlock.block ? "block" : "allow";
    const canonicalDecision = canonicalBlocked ? "block" : "allow";

    if (isCxCanonicalCallVerboseLoggingEnabled()) {
      context?.logger?.info?.("cx.lifecycle.shadow_gate", {
        extensionId: actorExtensionId,
        requestedQueueItemId,
        requestedPhone,
        requestedCaseId: queueItem?.caseId || null,
        legacyDecision,
        legacyReason: currentCallBlock.reason || null,
        canonicalDecision,
        canonicalReason: canonicalGate.reason || null,
        canonicalPhase: canonicalGate.phase || null,
        canonicalTransitionId: canonicalGate.transitionId || null,
        canonicalExpiresAt: canonicalGate.expiresAt || null,
        canonicalExpiredShell: canonicalGate.expiredShell === true,
      });
    }

    if (canonicalBlocked && isCxCanonicalCallStrictGateEnabled()) {
      const canonicalErr = new Error("Finish the current lead before starting another call.");
      canonicalErr.status = 409;
      canonicalErr.details = {
        reason: "canonical-call-state",
        phase: canonicalGate.phase,
        transitionId: canonicalGate.transitionId,
        queueItemId: canonicalGate.queueItemId,
        phone: canonicalGate.phone,
        uii: canonicalGate.uii,
        caseId: canonicalGate.caseId,
        expiresAt: canonicalGate.expiresAt || null,
        expiredShell: canonicalGate.expiredShell === true,
      };
      if (isCxCanonicalCallVerboseLoggingEnabled()) {
        context?.logger?.warn?.("cx-call-canonical-gate.blocked", {
          extensionId: actorExtensionId,
          requestedQueueItemId,
          requestedPhone,
          reason: canonicalGate.reason,
        });
      }
      throw canonicalErr;
    }
  }

  const servingItems = await cxDialQueueRepository.listQueueItems({
    assignedExtensionId: actorExtensionId,
    states: ["serving"],
    limit: 10,
  });
  const blockingItem = (servingItems || []).find((item) => (
    String(item?._id || "").trim() !== requestedQueueItemId
  ));
  if (!blockingItem) return;

  const err = new Error(
    "Finish the current lead before starting another call.",
  );
  err.status = 409;
  err.details = {
    blockingQueueItemId: String(blockingItem._id || ""),
    blockingCaseId: blockingItem.caseId || null,
    blockingDomain: blockingItem.domain || null,
  };
  throw err;
}

async function hangupCxCallAfterDisposition({
  context,
  user,
  input = {},
  queueItem = null,
  caseId = null,
  disposition = null,
} = {}) {
  const queueItemId = String(
    queueItem?._id || input.queueItemId || input.queueTicketId || "",
  ).trim() || null;
  const uii = String(
    input.uii ||
      input.rcxUii ||
      queueItem?.metadata?.lastDialExecutionUii ||
      "",
  ).trim() || null;
  const phone = String(
    input.phone ||
      queueItem?.metadata?.lastDialExecutionPhone ||
      queueItem?.phone ||
      "",
  ).trim() || null;
  const assignedExtensionId = String(
    queueItem?.assignment?.extensionId ||
      context.account?.extensionId ||
      user?.extensionId ||
      "",
  ).trim() || null;
  const workflowPublishedRoute = await resolveLastPublishedRouteFromWorkflow(queueItemId);
  const activeCallRoute = resolveRingcxActiveCallRoute(queueItem, input, workflowPublishedRoute);

  const payload = {
    domain: context.domain,
    caseId,
    queueItemId,
    queueTicketId: queueItemId,
    queueActionKey: extractQueueActionKey(input),
    assignedExtensionId,
    phone,
    uii,
    campaignId: activeCallRoute.campaignId,
    dialGroupId: activeCallRoute.dialGroupId,
    externId: activeCallRoute.externId,
    dialerEmail: context.account?.email || user?.email || null,
    dialerCxAgentId: context.account?.cxAgentId || context.agentState?.cxAgentId || user?.cxAgentId || null,
    callbackAt: input.callbackAt || input.scheduledFor || input.followUpAt || null,
    disposition,
    requestedBy: "cx-disposition",
    requestedByUserEmail: context.account?.email || user?.email || null,
  };

  const relayTimeoutMs = Number(process.env.CX_DISPOSITION_HANGUP_TIMEOUT_MS) || 4_500;
  const relayPromise = relayCxEndCallToServing(payload);
  const relay = await withTimeoutResult(relayPromise, relayTimeoutMs, {
    ok: true,
    skipped: false,
    acceptedLocally: true,
    backgroundPending: true,
    status: null,
    reason: "disposition-hangup-backgrounded",
  });
  if (relay?.backgroundPending && queueItemId) {
    relayPromise
      .then((backgroundRelay) =>
        cxDialQueueRepository.updateQueueItem(queueItemId, {
          "metadata.lastDispositionHangupBackgroundRelay": backgroundRelay,
          "metadata.lastDispositionHangupBackgroundRelayAt": new Date(),
          "metadata.lastDispositionHangupBackgroundRelayAccepted": dispositionHangupRelayAccepted(backgroundRelay),
        }).catch(() => null),
      )
      .catch(() => null);
  }
  const relayAccepted = dispositionHangupRelayAccepted(relay);
  if (queueItemId) {
    await cxDialQueueRepository.updateQueueItem(queueItemId, {
      "metadata.lastDispositionHangupIntent": payload,
      "metadata.lastDispositionHangupIntentAt": new Date(),
      "metadata.lastDispositionHangupIntentStatus": relayAccepted ? "accepted" : "relay-failed",
      "metadata.lastDispositionHangupIntentRelay": relay,
    }).catch(() => null);
  }
  if (relayAccepted && assignedExtensionId && input.skipAgentStateClearAfterRelay !== true) {
    await clearAgentCxCallState(assignedExtensionId, "cx-disposition-complete", {
      uii,
      caseId,
      phone,
      queueItemId,
    });
  }

  await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype: "disposition-hangup",
    stage: relayAccepted ? "completed" : "failed",
    aggregateType: "dial-request",
    aggregateId: String(queueItemId || caseId || uii),
    caseId,
    sourceService: "control-plane",
    title: "CX hangup after disposition",
    summary: relayAccepted
      ? `Ended CX call after ${disposition || "disposition"}`
      : `Could not end CX call after ${disposition || "disposition"}: ${relay.reason || "unknown"}`,
    status: relayAccepted ? undefined : "error",
    payload,
    result: relay,
  }).catch(() => null);

  // Defense-in-depth: ensure the CallLog row for this CX session exists.
  // The primary write path is the RingCentral webhook → CallLog hygiene
  // sweep, which catches the vast majority of CX-connected calls. But a
  // missed webhook would leave the call invisible to the
  // CallLog → CaseProfile bridge and the payment reconciler.
  //
  // The agent submitting a disposition is the canonical "I had a real
  // call" signal — by the time this runs, the call already happened and
  // the agent is moving on. If the row already exists (typical case),
  // upsertCallLog is a no-op merge of these fields. If it doesn't, we
  // create a stub keyed by telephonySessionId; the next attribution
  // sweep / hygiene pass will enrich it.
  if (uii) {
    const endedAt = new Date();
    const startedAt = resolveQueueItemCallStartTime(queueItem);
    const durationSec = startedAt
      ? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))
      : null;
    const callLogDoc = await callLogRepository.upsertCallLog({
      domain: context.domain,
      telephonySessionId: uii,
      direction: "outbound",
      caseId: caseId != null ? Number(caseId) : null,
      phone: phone || null,
      extensionId: assignedExtensionId,
      agentName: queueItem?.assignment?.agentName || context.account?.name || user?.name || null,
      executionOwner: "ringcentral-cx",
      callEndTime: endedAt,
      ...(startedAt ? { callStartTime: startedAt } : {}),
      ...(durationSec != null ? { durationSec } : {}),
      // CX dispositions are the authoritative "this was a CX call" signal.
      // Use $set (the default in upsertCallLog) so this wins over any
      // earlier EX-stamp from the hourly RC native sweep.
      platform: "cx",
      // Mark this as defensively created so the hygiene sweep / resolver
      // knows it's a stub, not a fully-attributed row. The resolver will
      // upgrade it with a real strategy/sourceCanonicalId when it next
      // processes this session.
      audit: {
        dispatchSource: "cx-disposition-hangup",
        intent: "cx-call-defensive-write",
        dialerEmail: payload.dialerEmail || null,
        cxAgentId: payload.dialerCxAgentId || null,
        disposition,
      },
    }).catch((error) => {
      // Defensive write failures are non-fatal. The hygiene sweep is
      // still the primary safety net; this is just a smaller-window
      // backup. Log so a missed webhook + missed defensive write would
      // surface in observability.
      console.warn(
        "[cx-call-defensive-write] upsertCallLog failed",
        { caseId, uii, error: error.message },
      );
      return null;
    });
    if (callLogDoc) {
      await queueCallRecordingArchiveJob(callLogDoc, { lane: "hourly" }).catch((error) => {
        console.warn(
          "[cx-call-recording-archive] queue failed",
          { caseId, uii, error: error.message },
        );
      });
    }
  }

  return {
    ...relay,
    payload,
  };
}

async function requestCxDial(domain, user, input = {}) {
  const context = await ensureCxAgentExtensionContext(await resolveCxUserContext(domain, user), user);
  const phone = String(input.phone || "").trim();
  if (!phone) {
    const err = new Error("phone is required");
    err.status = 400;
    throw err;
  }

  const normalizedCaseId =
    input.caseId != null && Number.isFinite(Number(input.caseId))
      ? Number(input.caseId)
      : null;
  const preferredActionKey = extractQueueActionKey(input);
  const queueAction = normalizedCaseId != null
    ? await resolveActiveCxQueueAction(context.domain, normalizedCaseId, preferredActionKey)
    : null;
  const queueItem = await resolveCxDialQueueItem(context.domain, normalizedCaseId, input);
  const contextExtensionId = String(
    context.account?.extensionId || user?.extensionId || "",
  ).trim() || null;
  if (!contextExtensionId) {
    const err = new Error("Your account is not paired to a RingCentral extension, so it cannot dial CX leads.");
    err.status = 403;
    throw err;
  }
  const queueAssignedExtensionId = String(
    queueItem?.assignment?.extensionId || "",
  ).trim() || null;
  const requestedAssignedExtensionId = String(input.assignedExtensionId || "").trim() || null;
  if (
    requestedAssignedExtensionId
    && requestedAssignedExtensionId !== contextExtensionId
    && requestedAssignedExtensionId !== queueAssignedExtensionId
  ) {
    const err = new Error("Dialer mismatch: this request is not for the logged-in agent.");
    err.status = 403;
    throw err;
  }
  if (
    queueAssignedExtensionId
    && queueAssignedExtensionId !== contextExtensionId
  ) {
    const err = new Error(
      `This lead is currently assigned to ${queueItem?.assignment?.agentName || queueAssignedExtensionId}`,
    );
    err.status = 409;
    throw err;
  }
  await assertNoUnresolvedCxDispositionBeforeDial(context, user, queueItem);
  const actionKey =
    queueAction?.actionKey ||
    String(queueItem?.metadata?.actionKey || "").trim() ||
    null;

  const requested = await recordCxCommand({
    domain: context.domain,
    user,
    subtype: "dial",
    aggregateType: "dial-request",
    aggregateId: phone,
    caseId: normalizedCaseId,
    title: "Outbound dial requested",
    summary: `Queue outbound CX dial to ${phone}`,
    payload: {
      phone,
      queueKey: actionKey,
      queueTicketId: String(input.queueTicketId || input.queueItemId || "").trim() || null,
      queueState: String(input.queueState || queueItem?.state || "").trim() || null,
      queueFamily: String(input.queueFamily || queueItem?.queueFamily || "").trim() || null,
      rcxAccountId:
        String(
          input.rcxAccountId ||
          queueItem?.rcxAccountId ||
          queueItem?.metadata?.rcxAccountId ||
          "",
        ).trim() || null,
      rcxDialGroupId:
        String(
          input.rcxDialGroupId ||
          queueItem?.rcxDialGroupId ||
          queueItem?.metadata?.rcxDialGroupId ||
          "",
        ).trim() || null,
      rcxCampaignId:
        String(
          input.rcxCampaignId ||
          queueItem?.rcxCampaignId ||
          queueItem?.metadata?.rcxCampaignId ||
          "",
        ).trim() || null,
      progressiveStageKey:
        String(input.progressiveStageKey || queueItem?.progressiveStageKey || "").trim() || null,
      assignedExtensionId:
        String(queueItem?.assignment?.extensionId || contextExtensionId || "").trim() || null,
      dialerExtensionId: contextExtensionId,
      dialerEmail: context.account?.email || user?.email || null,
      priority: input.priority || null,
      ringcxDialPriority:
        input.ringcxDialPriority ||
        input.leadLoaderDialPriority ||
        input.dialPriority ||
        null,
      notes: input.notes || null,
      callerIdMode: "ex-number",
      executionOwner: "ringcentral-cx",
    },
    reviewCategory: "cx-dial",
  });

  let dispatchIntent = buildCxDispatchIntent({
    context,
    user,
    input,
    phone,
    caseId: normalizedCaseId,
    queueAction,
    queueItem,
    requested,
  });
  const eventResult = await createEvent({
    eventType: "cx.dial.requested",
    sourceService: "control-plane",
    aggregateType: "case",
    aggregateId: String(normalizedCaseId || phone),
    dedupeKey: actionKey
      ? `${context.domain}:${normalizedCaseId || "na"}:${actionKey}:cx-dial`
      : requested?.workflowId
        ? `cx-workspace-dial:${requested.workflowId}`
        : null,
    payload: dispatchIntent,
  });
  const eventId = String(eventResult?.event?._id || eventResult?._id || "");
  dispatchIntent = {
    ...dispatchIntent,
    eventId,
  };

  const localStageResult = await stageCxDispatchIntent({
    queueItemId: dispatchIntent.queueItemId,
    domain: context.domain,
    caseId: normalizedCaseId,
    dispatchIntent,
    source: "control-plane",
    status: "queued",
  });

  const effectiveQueueItemId = String(
    localStageResult?.queueItemId || dispatchIntent.queueItemId || "",
  ).trim() || null;
  if (effectiveQueueItemId && effectiveQueueItemId !== dispatchIntent.queueItemId) {
    dispatchIntent = {
      ...dispatchIntent,
      queueItemId: effectiveQueueItemId,
      queueTicketId: effectiveQueueItemId,
      scramble: {
        ...(dispatchIntent.scramble || {}),
        queueItemId: effectiveQueueItemId,
      },
    };
  }

  const originalExecutionMode = dispatchIntent.executionMode;
  let relayResult = await relayCxDispatchIntentToServing(dispatchIntent);
  if (
    !relayResult.ok
    && isManualThenCampaignCxDialMode(originalExecutionMode)
    && shouldFallbackManualCxDial(relayResult)
  ) {
    const manualAttempt = summarizeCxDialRelayFailure(relayResult);
    const fallbackDispatchIntent = {
      ...dispatchIntent,
      mode: "campaign-queue",
      executionMode: "ringcx-campaign-queue",
      requestedExecutionMode: originalExecutionMode,
      manualFallback: {
        attempted: true,
        attemptedAt: new Date().toISOString(),
        originalExecutionMode,
        reason: manualAttempt.reason || manualAttempt.responseError || null,
        relay: manualAttempt,
      },
      scramble: {
        ...(dispatchIntent.scramble || {}),
        executionMode: "ringcx-campaign-queue",
        requestedExecutionMode: originalExecutionMode,
      },
    };
    const fallbackRelayResult = await relayCxDispatchIntentToServing(fallbackDispatchIntent);
    dispatchIntent = fallbackDispatchIntent;
    relayResult = {
      ...fallbackRelayResult,
      fallbackFromManual: true,
      originalExecutionMode,
      fallbackExecutionMode: "ringcx-campaign-queue",
      manualAttempt,
    };
  }
  if (effectiveQueueItemId) {
    await cxDialQueueRepository.updateQueueItem(effectiveQueueItemId, {
      "metadata.lastDialIntent": dispatchIntent,
      "metadata.lastDialIntentAt": new Date(),
      "metadata.lastDialIntentWorkflowId": requested?.workflowId || null,
      "metadata.lastDialIntentEventId": eventId,
      "metadata.lastDialIntentStatus": relayResult.ok ? "relayed" : "relay-failed",
      "metadata.lastDialIntentRelay": relayResult,
      "metadata.lastDialIntentFallbackFromManual": Boolean(relayResult.fallbackFromManual),
      "metadata.lastDialIntentManualAttempt": relayResult.manualAttempt || null,
      "metadata.lastDialIntentOriginalExecutionMode": relayResult.originalExecutionMode || null,
      "metadata.lastDialIntentLocalStage": localStageResult || null,
      ...(relayResult.ok ? {
        "metadata.lastDialIntentReleaseReason": null,
        "metadata.lastDialIntentReleasedAt": null,
        "metadata.lastDialIntentTimeoutAt": null,
      } : {}),
    }).catch(() => null);
  }

  if (!relayResult.ok) {
    const relayTimedOut = String(relayResult.reason || "")
      .toLowerCase()
      .includes("timed out");
    if (relayTimedOut) {
      const timeoutStageResult = effectiveQueueItemId
        ? await stageCxDispatchIntent({
            queueItemId: effectiveQueueItemId,
            domain: context.domain,
            caseId: normalizedCaseId,
            dispatchIntent,
            source: "control-plane",
            status: "serving",
            markServing: true,
          }).catch((error) => ({
            ok: false,
            staged: false,
            reason: error.message,
          }))
        : null;
      if (effectiveQueueItemId) {
        await cxDialQueueRepository.updateQueueItem(effectiveQueueItemId, {
          "metadata.lastDialIntentStatus": "relay-timeout-pending",
          "metadata.lastDialIntentReleaseReason": null,
          "metadata.lastDialIntentTimeoutAt": new Date(),
          "metadata.lastDialIntentTimeoutStage": timeoutStageResult,
        }).catch(() => null);
      }
      await setActivityState(contextExtensionId, "dialing", {
        source: "cx-dial-timeout-pending",
      }).catch(() => null);
      return {
        ...requested,
        accepted: true,
        pending: true,
        eventId,
        actionKey,
        queueItemId: effectiveQueueItemId,
        dispatchIntent,
        consumeStage: timeoutStageResult,
        relay: relayResult,
      };
    }
    if (effectiveQueueItemId) {
      await releaseCxQueueItem({
        queueItemId: effectiveQueueItemId,
        reason: "dial-relay-failed",
        actorEmail: context.account?.email || user?.email || null,
        extraUpdate: {
          metadata: {
            lastDialIntentStatus: "relay-failed",
            lastDialIntentReleaseReason: relayResult.reason || "dispatch-relay-failed",
            lastDialIntentReleasedAt: new Date(),
          },
        },
      }).catch(() =>
        cxDialQueueRepository.updateQueueItem(effectiveQueueItemId, {
          state: "ready",
          claimUntil: null,
          assignment: {
            extensionId: null,
            agentName: null,
            assignedAt: null,
            queueFamilySnapshot: null,
          },
          "metadata.lastDialIntentStatus": "relay-failed",
          "metadata.lastDialIntentReleaseReason": relayResult.reason || "dispatch-relay-failed",
          "metadata.lastDialIntentReleasedAt": new Date(),
        }).catch(() => null),
      );
    }
    await clearAgentCxCallState(contextExtensionId, "cx-dial-relay-failed", {
      phone,
      queueItemId: effectiveQueueItemId,
    });
    const err = new Error(relayResult.reason || "CX dial dispatch failed");
    err.status = relayResult.status || 502;
    err.details = relayResult.details || null;
    throw err;
  }

  const consumeStageResult = effectiveQueueItemId
    ? await stageCxDispatchIntent({
        queueItemId: effectiveQueueItemId,
        domain: context.domain,
        caseId: normalizedCaseId,
        dispatchIntent,
        source: "control-plane",
        status: "serving",
        markServing: true,
      }).catch((error) => ({
        ok: false,
        staged: false,
        reason: error.message,
      }))
    : null;

  await setActivityState(contextExtensionId, "dialing", {
    source: "cx-dial-request",
  }).catch(() => null);

  if (queueAction?.actionKey) {
    await leadCadenceRepository.markScheduledActionStatus(
      context.domain,
      normalizedCaseId,
      queueAction.actionKey,
      "requested",
      {
        currentStage: "cx-serving",
      },
    );
    await leadCadenceRepository.syncLeadCadenceState(context.domain, normalizedCaseId).catch(() => null);
  }

  return {
    ...requested,
    accepted: true,
    eventId,
    actionKey,
    queueItemId: effectiveQueueItemId,
    dispatchIntent,
    consumeStage: consumeStageResult,
    relay: relayResult,
  };
}

async function requestCxEndCall(domain, user, input = {}) {
  const context = await ensureCxAgentExtensionContext(await resolveCxUserContext(domain, user), user);
  const normalizedCaseId =
    input.caseId != null && Number.isFinite(Number(input.caseId))
      ? Number(input.caseId)
      : null;
  const queueItem = await resolveCxDialQueueItem(context.domain, normalizedCaseId, input);
  const contextExtensionId = String(
    context.account?.extensionId || user?.extensionId || "",
  ).trim() || null;
  if (!contextExtensionId) {
    const err = new Error("Your account is not paired to a RingCentral extension, so it cannot end CX calls.");
    err.status = 403;
    throw err;
  }
  const queueAssignedExtensionId = String(
    queueItem?.assignment?.extensionId || "",
  ).trim() || null;
  const requestedAssignedExtensionId = String(input.assignedExtensionId || "").trim() || null;
  if (
    requestedAssignedExtensionId
    && requestedAssignedExtensionId !== contextExtensionId
    && requestedAssignedExtensionId !== queueAssignedExtensionId
  ) {
    const err = new Error("Dialer mismatch: this request is not for the logged-in agent.");
    err.status = 403;
    throw err;
  }
  if (
    queueAssignedExtensionId
    && queueAssignedExtensionId !== contextExtensionId
  ) {
    const err = new Error(
      `This lead is currently assigned to ${queueItem?.assignment?.agentName || queueAssignedExtensionId}`,
    );
    err.status = 409;
    throw err;
  }
  const effectiveDomain = normalizeDomain(queueItem?.domain || context.domain);

  const queueItemId = String(
    queueItem?._id || input.queueItemId || input.queueTicketId || "",
  ).trim() || null;
  const uii = String(
    input.uii || queueItem?.metadata?.lastDialExecutionUii || "",
  ).trim() || null;

  const phone = String(
    input.phone || queueItem?.metadata?.lastDialExecutionPhone || queueItem?.phone || "",
  ).trim() || null;
  const requested = await recordCxCommand({
    domain: effectiveDomain,
    user,
    subtype: "end-call",
    aggregateType: "dial-request",
    aggregateId: String(queueItemId || normalizedCaseId || uii),
    caseId: normalizedCaseId,
    title: "CX hangup requested",
    summary: `Request CX hangup for ${phone || `call ${uii}`}`,
    payload: {
      queueTicketId: queueItemId,
      queueItemId,
      phone,
      uii,
      assignedExtensionId:
        String(queueAssignedExtensionId || contextExtensionId || "").trim() || null,
      executionOwner: "ringcentral-cx",
    },
    reviewCategory: "cx-end-call",
  });
  const workflowPublishedRoute = await resolveLastPublishedRouteFromWorkflow(queueItemId);
  const activeCallRoute = resolveRingcxActiveCallRoute(queueItem, input, workflowPublishedRoute);

  const requestPayload = {
    domain: effectiveDomain,
    caseId: normalizedCaseId,
    queueItemId,
    queueTicketId: queueItemId,
    queueActionKey: extractQueueActionKey(input),
    assignedExtensionId:
      String(queueAssignedExtensionId || contextExtensionId || "").trim() || null,
    phone,
    uii,
    campaignId: activeCallRoute.campaignId,
    dialGroupId: activeCallRoute.dialGroupId,
    externId: activeCallRoute.externId,
    dialerEmail: context.account?.email || user?.email || null,
    dialerCxAgentId: context.account?.cxAgentId || context.agentState?.cxAgentId || user?.cxAgentId || null,
    requestedBy: "cx-workspace",
    requestedByUserEmail: context.account?.email || user?.email || null,
    workflowId: requested?.workflowId || null,
  };

  const relayResult = await relayCxEndCallToServing(requestPayload);
  const relayAccepted = cxEndCallRelayAccepted(relayResult);
  if (queueItemId) {
    await cxDialQueueRepository.updateQueueItem(queueItemId, {
      "metadata.lastHangupIntent": requestPayload,
      "metadata.lastHangupIntentAt": new Date(),
      "metadata.lastHangupIntentWorkflowId": requested?.workflowId || null,
      "metadata.lastHangupIntentStatus": relayResult.ok
        ? "relayed"
        : relayAccepted
          ? "hangup-accepted"
          : "relay-failed",
      "metadata.lastHangupIntentRelay": relayResult,
    }).catch(() => null);
  }

  if (!relayAccepted) {
    const err = new Error(relayResult.reason || "CX end-call dispatch failed");
    err.status = relayResult.status || 502;
    err.details = relayResult.details || null;
    throw err;
  }

  const wrapUpAt = new Date();
  const wrapUpMatch = {
    domain: effectiveDomain,
    ...(Number.isFinite(normalizedCaseId) ? { caseId: normalizedCaseId } : {}),
    ...(queueAssignedExtensionId
      ? { "assignment.extensionId": queueAssignedExtensionId }
      : {
        $or: [
          { "assignment.extensionId": { $exists: false } },
          { "assignment.extensionId": null },
          { "assignment.extensionId": "" },
        ],
      }),
  };
  const queueOutcome = queueItemId
    ? await cxDialQueueRepository.transitionQueueItemState(queueItemId, ["claimed", "serving"], {
        state: "serving",
        claimUntil: null,
        "metadata.lastQueueAttemptHeldForDisposition": true,
        "metadata.wrapUpRequired": true,
        "metadata.wrapUpStartedAt": wrapUpAt,
        "metadata.wrapUpStartedWorkflowId": requested?.workflowId || null,
        "metadata.wrapUpReason": "agent-ended-call",
        "metadata.assignmentReleasedByHangup": false,
      }, {
        match: wrapUpMatch,
        returnNew: true,
      }).then((updated) => ({
        ok: true,
        mutated: Boolean(updated),
        queueOutcome: "wrap-up",
        disposition: "hang-up",
        statusCategory: "cx-wrap-up",
        statusLabel: "Wrap-up required",
        wrapUpRequired: true,
      })).catch((error) => ({
        ok: false,
        mutated: false,
        queueOutcome: "wrap-up-failed",
        reason: error.message || "queue-wrap-up-hold-failed",
        wrapUpRequired: true,
      }))
    : null;

  if (contextExtensionId && (!queueItemId || queueOutcome?.mutated)) {
    await setActivityState(contextExtensionId, "dispositioning", {
      source: "cx-end-call-wrap-up",
    }).catch(() => null);
  }

  return {
    ...requested,
    accepted: true,
    completed: false,
    wrapUpRequired: true,
    queueItemId,
    uii,
    relay: relayResult,
    queueOutcome,
    response: relayResult.response || null,
  };
}

async function requestCxLogicsCreateCase(domain, user, input = {}) {
  return recordCxCommand({
    domain,
    user,
    subtype: "logics-create-case",
    aggregateType: "logics-case-request",
    aggregateId: String(input.phone || input.email || user.email),
    title: "Logics case creation requested",
    summary: `Create Logics case for ${input.name || input.phone || input.email || "prospect"}`,
    payload: input,
    reviewCategory: "cx-logics",
  });
}

async function requestCxLogicsFindMatch(domain, user, input = {}) {
  const needle = String(input.phone || input.email || input.caseId || "").trim();
  if (!needle) {
    const err = new Error("phone, email, or caseId is required");
    err.status = 400;
    throw err;
  }

  return recordCxCommand({
    domain,
    user,
    subtype: "logics-find-match",
    aggregateType: "logics-match-request",
    aggregateId: needle,
    caseId: input.caseId || null,
    title: "Logics match requested",
    summary: `Find Logics match for ${needle}`,
    payload: input,
    reviewCategory: "cx-logics",
  });
}

async function executeCxLogicsCreateCase(domain, user, input = {}) {
  const fullName = String(input.name || "").trim();
  const firstName = String(input.firstName || (fullName ? fullName.split(" ")[0] : "")).trim();
  const derivedLastName =
    String(
      input.lastName ||
        (fullName.includes(" ") ? fullName.split(" ").slice(1).join(" ") : ""),
    ).trim();
  const lastName = derivedLastName || "Parallel";
  if (!lastName) {
    const err = new Error("lastName is required");
    err.status = 400;
    throw err;
  }

  const phone = normalizePhone(input.cellPhone || input.primaryPhone || input.phone);
  const payload = {
    FirstName: firstName || "Mickey",
    LastName: lastName,
    Email: input.email || undefined,
    CellPhone: formatLogicsPhone(phone),
    HomePhone: formatLogicsPhone(input.homePhone),
    SSN: formatLogicsSsn(input.ssn),
    Address: input.address || undefined,
    City: input.city || undefined,
    State: input.state ? String(input.state).toUpperCase().slice(0, 2) : undefined,
    Zip: input.zip || undefined,
    SourceName: input.sourceName || input.source || input.intakeSource || undefined,
    Notes: input.notes || undefined,
  };

  const result = await executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-create-case",
    aggregateType: "logics-case-request",
    aggregateId: String(phone || input.workPhone || input.email || lastName),
    title: "Logics case creation requested",
    summary: `Create Logics case for ${payload.FirstName || ""} ${lastName}`.trim(),
    payload,
    reviewCategory: "cx-logics",
    executor: (client) => client.createCase(payload),
  });

  // Spouse fields aren't in Logics' CreateCase API — append them as a
  // structured "Spouse intake" activity-note on the freshly assigned
  // case so the data is searchable upstream. Encrypted full SSN is
  // already on CaseProfile (the actual record of truth).
  const newCaseId = extractCaseId(result?.response) ?? result?.response?.CaseID ?? null;
  if (newCaseId && hasAnySpouseField(input)) {
    await appendSpouseIntakeNote(domain, Number(newCaseId), user, input);
  }
  // SSN + spouse + address go to our CaseProfile for safekeeping
  // (encrypted at rest where applicable). Logics' post-create sync
  // already wrote name/phone/email/status; this layer adds the
  // sensitive fields Logics doesn't carry back.
  if (newCaseId) {
    await persistCxIdentityToCaseProfile(domain, Number(newCaseId), input).catch(() => null);
  }
  const queueOutcome =
    newCaseId && !input.skipQueueFinalize
      ? await finalizeCxQueueFromLogicsState(
        domain,
        Number(newCaseId),
        {
          ...input,
          actorEmail: user?.email || null,
        },
        result?.response,
      ).catch(() => null)
      : null;

  return {
    ...result,
    disposition: queueOutcome?.disposition || null,
    queueOutcome: queueOutcome?.queueOutcome || null,
    rescheduledFor: queueOutcome?.rescheduledFor || null,
    statusId: queueOutcome?.statusId || null,
    statusCategory: queueOutcome?.statusCategory || null,
  };
}

/**
 * Promote a Logics-only case into our Mongo as a CaseProfile.
 *
 * The CX search ladder falls through to Logics when nothing exists in
 * CaseProfile / MasterProspect / LeadCadence. From the operator's POV
 * the case "exists" — it's just not ours yet. This handler bridges the
 * gap: take the Logics record (already pulled by the lookup), upsert
 * it as a CaseProfile, and stamp a workflow stage so the action shows
 * up in the audit trail. Unlike executeCxLogicsCreateCase, no Logics
 * write happens — the case is already there.
 *
 * Input shape: { caseId, firstName?, lastName?, email?, cellPhone?,
 * primaryPhone?, sourceName?, notes?, logicsRaw? }
 *
 * `logicsRaw` is the raw record returned by tryLogics during lookup;
 * we re-sync from Logics for safety but if the network call fails we
 * still upsert from `logicsRaw` so the operator's click isn't lost.
 */
async function executeCxSaveCaseProfileFromLogics(domain, user, input = {}) {
  const caseId = input.caseId != null ? Number(input.caseId) : null;
  if (!Number.isFinite(caseId)) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const context = await resolveCxUserContext(domain, user);
  const subtype = "save-case-profile-from-logics";
  const aggregateType = "case-profile";
  const title = "Save CaseProfile from Logics";
  const summary = `Promote Logics case ${caseId} to CaseProfile`;

  const requested = await recordCxCommand({
    domain: context.domain,
    user,
    subtype,
    aggregateType,
    aggregateId: caseId,
    caseId,
    title,
    summary,
    payload: {
      caseId,
      firstName: input.firstName || null,
      lastName: input.lastName || null,
      email: input.email || null,
      cellPhone: input.cellPhone || null,
      primaryPhone: input.primaryPhone || null,
      sourceName: input.sourceName || null,
      notes: input.notes || null,
    },
    reviewCategory: "cx-logics",
  });

  let synced = null;
  try {
    synced = await syncCaseProfileFromLogics(context.domain, caseId);
  } catch (error) {
    // Network blip — fall back to seeding from the lookup payload the
    // operator already saw on screen. Either way we want a row in
    // Mongo so the next CX hit lands in tier 1 instead of tier 4.
    synced = null;
  }

  const editPatch = {};
  if (input.firstName) editPatch.firstName = input.firstName;
  if (input.lastName) editPatch.lastName = input.lastName;
  if (input.firstName || input.lastName) {
    editPatch.name = [input.firstName, input.lastName].filter(Boolean).join(" ").trim() || null;
  }
  if (input.email) editPatch.email = input.email;
  if (input.cellPhone || input.primaryPhone) {
    editPatch.primaryPhone = input.cellPhone || input.primaryPhone;
  }
  if (input.sourceName) editPatch.sourceName = input.sourceName;
  if (input.notes) editPatch.notes = input.notes;

  if (!synced || Object.keys(editPatch).length > 0) {
    const seedFromRaw = !synced && input.logicsRaw && typeof input.logicsRaw === "object"
      ? {
          firstName: input.logicsRaw.FirstName || null,
          lastName: input.logicsRaw.LastName || null,
          name: [input.logicsRaw.FirstName, input.logicsRaw.LastName].filter(Boolean).join(" ").trim() || null,
          email: input.logicsRaw.Email || null,
          primaryPhone:
            input.logicsRaw.CellPhone || input.logicsRaw.HomePhone || input.logicsRaw.WorkPhone || null,
          statusId:
            input.logicsRaw.StatusID != null
              ? Number(input.logicsRaw.StatusID)
              : input.logicsRaw.Status != null
                ? Number(input.logicsRaw.Status)
                : null,
        }
      : {};
    synced = await caseProfileRepository.upsertCaseProfile(context.domain, caseId, {
      ...seedFromRaw,
      ...editPatch,
    });
  }

  const completed = await recordWorkflowStage({
    domain: context.domain,
    family: "cx",
    subtype,
    stage: "completed",
    aggregateType,
    aggregateId: caseId,
    caseId,
    sourceService: "control-plane",
    title,
    summary: `${summary} completed`,
    result: {
      requested,
      caseProfileId: synced?._id ? String(synced._id) : null,
    },
  });

  const plain = synced && typeof synced.toObject === "function" ? synced.toObject() : synced;

  return {
    ...requested,
    completed: true,
    completionWorkflowId: String(completed._id),
    caseProfile: plain,
  };
}

async function executeCxLogicsFindMatch(domain, user, input = {}) {
  const phone = String(input.phone || "").trim();
  const caseId = input.caseId != null ? Number(input.caseId) : null;
  if (!phone && !caseId) {
    const err = new Error("phone or caseId is required");
    err.status = 400;
    throw err;
  }

  return executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-find-match",
    aggregateType: "logics-match-request",
    aggregateId: phone || caseId,
    caseId,
    title: "Logics match requested",
    summary: `Find Logics match for ${phone || caseId}`,
    payload: input,
    reviewCategory: "cx-logics",
    executor: (client) => (phone ? client.findCaseByPhone(phone) : client.getCase(caseId)),
  });
}

async function executeCxLogicsAction({
  domain,
  user,
  subtype,
  aggregateType,
  aggregateId,
  caseId = null,
  title,
  summary,
  payload = null,
  reviewCategory = null,
  executor,
}) {
  const context = await resolveCxUserContext(domain, user);
  const requested = await recordCxCommand({
    domain: context.domain,
    user,
    subtype,
    aggregateType,
    aggregateId,
    caseId,
    title,
    summary,
    payload,
    reviewCategory,
  });

  const client = createLogicsClient(context.domain);

  try {
    const retryOutcome = await runWithImmediateRetries(
      () => executor(client),
      {
        immediateRetryAttempts: 1,
        immediateRetryDelayMs: 500,
      },
    );
    if (!retryOutcome.ok) {
      throw Object.assign(retryOutcome.error || new Error("Logics action failed"), {
        immediateRetryUsed: retryOutcome.attemptsUsed,
      });
    }

    const response = retryOutcome.result;
    const responseData = parseLogicsData(response);
    const resolvedCaseId = caseId != null ? Number(caseId) : extractCaseId(responseData);
    if (Number.isFinite(resolvedCaseId)) {
      // CaseProfile here is the "refined list" — people we've actually
      // talked to / acted on in Logics. The sync MUST be air-tight: if
      // we silently swallow failures, the refined-list integrity drifts
      // (CX action succeeded in Logics → no parallel-side row → metrics
      // and downstream services miss this case).
      //
      // Inline failure path: log a visible workflow stage AND emit an
      // hourly retry job that re-runs the sync from Logics. The Logics
      // action itself already succeeded, so we keep returning success
      // to the caller — only the parallel-side mirroring is retried.
      try {
        await syncCaseProfileFromLogics(context.domain, resolvedCaseId);
      } catch (syncError) {
        await recordWorkflowStage({
          domain: context.domain,
          family: "cx",
          subtype: `${subtype}-case-profile-sync`,
          stage: "failed",
          aggregateType,
          aggregateId,
          caseId: resolvedCaseId,
          sourceService: "control-plane",
          title: "CaseProfile sync after CX Logics action failed",
          summary: `${summary} succeeded but CaseProfile sync failed: ${syncError.message}`,
          status: "error",
          result: {
            error: syncError.message,
            details: syncError.details || null,
          },
        }).catch(() => null);

        await emitHourlyJobEvent({
          eventType: "cx.case-profile-sync.requested",
          targetService: "control-plane",
          handlerKey: "syncCaseProfileFromLogics",
          domain: context.domain,
          aggregateType: "case-profile",
          aggregateId: String(resolvedCaseId),
          caseId: resolvedCaseId,
          payload: {
            domain: context.domain,
            caseId: resolvedCaseId,
            originatingSubtype: subtype,
          },
          // Idempotent: if another action on the same case also fails
          // sync, we don't want two retry jobs racing.
          dedupeKey: `cx-case-profile-sync:${context.domain}:${resolvedCaseId}`,
          firstError: syncError.message,
          lastError: syncError.message,
          maxAttempts: 6,
          provideSummary: false,
        }).catch(() => null);
      }
    }
    const completed = await recordWorkflowStage({
      domain: context.domain,
      family: "cx",
      subtype,
      stage: "completed",
      aggregateType,
      aggregateId,
      caseId,
      sourceService: "control-plane",
      title,
      summary: `${summary} completed`,
      result: {
        requested,
        response: responseData,
      },
    });

    return {
      ...requested,
      completed: true,
      completionWorkflowId: String(completed._id),
      response: responseData,
    };
  } catch (error) {
    const failed = await recordWorkflowStage({
      domain: context.domain,
      family: "cx",
      subtype,
      stage: "failed",
      aggregateType,
      aggregateId,
      caseId,
      sourceService: "control-plane",
      title,
      summary: `${summary} failed`,
      status: "error",
      result: {
        requested,
        error: error.message,
        details: error.details || null,
      },
    });

    const retryJob = await queueCxLogicsRetryJob({
      context,
      user,
      subtype,
      aggregateType,
      aggregateId,
      caseId,
      title,
      summary,
      payload,
      requested,
      failedWorkflowId: String(failed._id),
      error,
      immediateRetryUsed: Number(error.immediateRetryUsed) || 0,
    });

    throw Object.assign(new Error(error.message), {
      status: error.status || 502,
      details: {
        failureWorkflowId: String(failed._id),
        retryJobId: retryJob?.job?._id ? String(retryJob.job._id) : null,
        upstream: error.details || null,
      },
    });
  }
}

async function requestCxLeadStatusUpdate(domain, user, input = {}) {
  const normalizedCaseId = Number(input.caseId ?? input.CaseID);
  if (!Number.isFinite(normalizedCaseId) || normalizedCaseId <= 0) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const nextStatus = String(input.status || input.logicsStatus || "").trim();
  const resolvedStatusId = resolveRequestedStatus(domain, input);
  const settlementOfficerId = resolveInputSettlementOfficerId(input);
  if (!nextStatus && !Number.isFinite(resolvedStatusId)) {
    const err = new Error("status is required");
    err.status = 400;
    throw err;
  }

  if (Number.isFinite(resolvedStatusId)) {
    return executeCxLogicsUpdateCase(domain, user, {
      caseId: normalizedCaseId,
      CaseID: normalizedCaseId,
      StatusID: resolvedStatusId,
      Notes:
        input.notes ||
        (nextStatus ? `Status updated to ${nextStatus}` : "Status updated from CX workspace"),
      SetOfficerID: settlementOfficerId,
      queueActionKey: extractQueueActionKey(input),
      queueItemId: input.queueItemId || input.queueTicketId || null,
      queueTicketId: input.queueItemId || input.queueTicketId || null,
      assignedExtensionId: input.assignedExtensionId || null,
      searchPhone: input.searchPhone || input.phone || null,
    });
  }

  return recordCxCommand({
    domain,
    user,
    subtype: "logics-update-status",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: "Lead status update requested",
    summary: `Update case ${input.caseId} to ${nextStatus}`,
    payload: {
      status: nextStatus,
      logicsStatusId: input.logicsStatusId || resolvedStatusId || null,
      settlementOfficerId,
      notes: input.notes || null,
      statusFamily: input.statusFamily || null,
    },
    reviewCategory: "cx-logics-status",
  });
}

async function requestCxAssignCaseToMe(domain, user, input = {}) {
  const normalizedCaseId = Number(input.caseId ?? input.CaseID);
  if (!Number.isFinite(normalizedCaseId) || normalizedCaseId <= 0) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const context = await resolveCxUserContext(domain, user);
  const settlementOfficerId = requireCxSettlementOfficerId(context.domain, context.account, user);
  const result = await executeCxLogicsUpdateCase(context.domain, user, {
    caseId: normalizedCaseId,
    CaseID: normalizedCaseId,
    SetOfficerID: settlementOfficerId,
    skipQueueFinalize: true,
  });

  return {
    ...result,
    assignedToSelf: true,
    settlementOfficerId,
  };
}

function cleanWorkbenchText(value, maxLength = 800) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength)
    || null;
}

function toPlainRecord(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : plainObject(value);
}

function formatWorkbenchDate(value, timeZone = "America/Los_Angeles") {
  const date = parseDateOrNull(value);
  if (!date) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "America/Los_Angeles",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function buildAppointmentWorkbenchNote(appointment = {}) {
  const scheduled = formatWorkbenchDate(
    appointment.appointmentAt,
    appointment.appointmentTimezone || appointment.requestedTimezone || "America/Los_Angeles",
  );
  const legalDial = formatWorkbenchDate(
    appointment.legalDialAt,
    appointment.legalDialTimezone || appointment.appointmentTimezone || "America/Los_Angeles",
  );
  return [
    "CX appointment scheduled.",
    appointment.prospectName ? `Prospect: ${appointment.prospectName}` : "",
    appointment.phone ? `Phone: ${appointment.phone}` : "",
    scheduled ? `Appointment: ${scheduled}` : "",
    legalDial && legalDial !== scheduled ? `Legal dial: ${legalDial}` : "",
    appointment.agentName || appointment.agentEmail
      ? `Agent: ${appointment.agentName || appointment.agentEmail}`
      : "",
    appointment.note ? `Note: ${appointment.note}` : "",
  ].filter(Boolean).join("\n");
}

async function executeCxAppointmentWorkbenchActions(domain, user, input = {}) {
  const appointment = toPlainRecord(input.appointment || input.result?.appointment || input);
  const appointmentId = String(appointment.appointmentId || "").trim();
  const caseId = Number(appointment.caseId || input.caseId);
  if (!appointmentId || !Number.isFinite(caseId) || caseId <= 0) {
    return { ok: false, skipped: true, reason: "missing-appointment-identity" };
  }

  const metadata = plainObject(appointment.metadata);
  const workbench = plainObject(metadata.workbench);
  const dueDate = appointment.legalDialAt || appointment.appointmentAt;
  if (!dueDate) return { ok: false, skipped: true, reason: "missing-appointment-time" };

  const note = buildAppointmentWorkbenchNote(appointment);
  const subject = cleanWorkbenchText(
    `CX appointment${appointment.prospectName ? ` - ${appointment.prospectName}` : ""}`,
    120,
  ) || "CX appointment";

  const result = {
    ok: true,
    appointmentId,
    task: workbench.logicsTaskCompletedAt ? { skipped: true, reason: "already-created" } : null,
    activity: workbench.logicsActivityCompletedAt ? { skipped: true, reason: "already-created" } : null,
  };

  if (!result.task) {
    try {
      result.task = await executeCxLogicsTask(domain, user, {
        caseId,
        subject,
        comments: note,
        dueDate,
        reminderAt: dueDate,
        taskType: 1,
      });
    } catch (error) {
      result.ok = false;
      result.task = { ok: false, error: error.message, details: error.details || null };
    }
  }

  if (!result.activity) {
    try {
      result.activity = await executeCxLogicsActivity(domain, user, {
        caseId,
        subject: "CX appointment scheduled",
        activityType: "General",
        note,
      });
    } catch (error) {
      result.ok = false;
      result.activity = { ok: false, error: error.message, details: error.details || null };
    }
  }

  const patch = {
    "metadata.workbench.lastAttemptAt": new Date(),
    "metadata.workbench.lastAttemptOk": result.ok,
  };
  if (result.task?.completed) {
    patch["metadata.workbench.logicsTaskCompletedAt"] = new Date();
    patch["metadata.workbench.logicsTaskWorkflowId"] = result.task.completionWorkflowId || null;
  } else if (result.task?.error) {
    patch["metadata.workbench.logicsTaskError"] = result.task.error;
  }
  if (result.activity?.completed) {
    patch["metadata.workbench.logicsActivityCompletedAt"] = new Date();
    patch["metadata.workbench.logicsActivityWorkflowId"] = result.activity.completionWorkflowId || null;
  } else if (result.activity?.error) {
    patch["metadata.workbench.logicsActivityError"] = result.activity.error;
  }
  await cxAppointmentRepository.patchAppointment(appointmentId, patch, {
    type: "appointment-workbench-sync",
    actorEmail: user?.email || null,
    note: result.ok ? "Logics task/activity synced" : "Logics task/activity sync attempted",
    payload: {
      taskCompleted: Boolean(result.task?.completed),
      activityCompleted: Boolean(result.activity?.completed),
      taskError: result.task?.error || null,
      activityError: result.activity?.error || null,
    },
  }).catch(() => null);

  return result;
}

async function executeCxLogicsTask(domain, user, input = {}) {
  if (!input.caseId) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const subject = String(input.subject || input.title || "").trim();
  if (!subject) {
    const err = new Error("subject is required");
    err.status = 400;
    throw err;
  }
  const context = await resolveCxUserContext(domain, user);
  const actorAuditLine = buildActorAuditLine(user);
  const comments = [String(input.comments || "").trim(), actorAuditLine].filter(Boolean).join("\n\n");
  const taskType = Number(input.taskType || 1);
  const dueDate = toUtcDateTime(input.dueDate || input.at);
  const reminderAt = toUtcDateTime(input.reminderAt || input.reminder || input.dueDate || input.at);
  const endDate = toUtcDateTime(input.endDate);
  const assignedUserIds = Array.isArray(input.userIds)
    ? input.userIds.map((value) => Number(value)).filter(Number.isFinite)
    : [];
  if (assignedUserIds.length === 0) {
    // Pick the tenant-specific Logics id that matches the case's domain.
    // TAG cases use tagLogicsId; Wynn cases use wynnLogicsId. Fall back
    // to the legacy flat logicsUserId only if the tenant-specific one
    // is missing (older seeded accounts pre-dual-tenant schema).
    const tenantLogicsId =
      context.domain === "WYNN"
        ? context.account?.wynnLogicsId
        : context.account?.tagLogicsId;
    const candidate = tenantLogicsId ?? context.account?.logicsUserId;
    if (Number.isFinite(Number(candidate))) {
      assignedUserIds.push(Number(candidate));
    }
  }
  if (assignedUserIds.length === 0) {
    const err = new Error("A Logics user mapping is required before creating tasks from CX.");
    err.status = 400;
    throw err;
  }
  if (!dueDate || !reminderAt) {
    const err = new Error("dueDate and reminderAt/reminder are required for Logics tasks.");
    err.status = 400;
    throw err;
  }
  if (taskType === 2 && !endDate) {
    const err = new Error("endDate is required for Logics events.");
    err.status = 400;
    throw err;
  }

  return executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-task",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: "Logics task requested",
    summary: `Create Logics ${Number(input.taskType) === 2 ? "event" : "task"} for case ${input.caseId}`,
    payload: input,
    reviewCategory: "cx-logics-task",
    executor: (client) =>
      client.createTask({
        CaseID: Number(input.caseId),
        Subject: subject,
        Reminder: reminderAt,
        TaskType: taskType,
        DueDate: dueDate,
        EndDate: taskType === 2 ? endDate : null,
        UserID: assignedUserIds,
        PriorityID: input.priorityId != null ? Number(input.priorityId) : undefined,
        StatusID: input.statusId != null ? Number(input.statusId) : undefined,
        TaskCategoryID: input.taskCategoryId != null ? Number(input.taskCategoryId) : undefined,
        Comments: comments || null,
        AllDayEvent: Boolean(input.allDayEvent),
      }),
  });
}

/**
 * Dev/QA helper — inject a synthetic "currentCall" onto the user's agent
 * state so the CX workspace's auto-scramble chain (lookup → form
 * populate) fires without an actual RingCentral telephony event. The
 * RC subscription watchdog is still gated off in dev, so this is the
 * only way to exercise the connect-to-load path until live RC events
 * are wired up.
 *
 * Direction defaults to "inbound" (most common test case). For inbound
 * we set `from = e164`; for outbound `to = e164` — that mirrors what
 * the real snapshot would carry from RC.
 *
 * Calling this without `phone` clears the currentCall (handy for
 * resetting between tests).
 */
async function simulateCxIncomingCall(domain, user, input = {}) {
  const context = await resolveCxUserContext(domain, user);
  let extensionId =
    context.account?.extensionId ||
    user?.extensionId ||
    null;

  // Auto-pair a synthetic extensionId to the account if none exists.
  // This is a dev/QA helper — admin users testing the CX scramble
  // shouldn't have to manually go pair an RC extension in admin
  // before they can verify the auto-scramble UX. The synthetic id is
  // deterministic per email so subsequent calls (and the workspace
  // read path that reads agent state by extensionId) both find the
  // same row.
  if (!extensionId) {
    const emailKey = String(context.account?.email || user?.email || "anon")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      .slice(0, 32);
    extensionId = `sim-${emailKey}`;
    if (context.account?.id) {
      await userAccountRepository.updateUserAccount(context.account.id, {
        extensionId,
      });
    }
  }

  const rawPhone = String(input.phone || "").trim();
  const direction = String(input.direction || "inbound").toLowerCase();
  // Channel: "ex" = simulating an RC EX desk app call (TAG-first
  // lookup), "cx" = simulating a CX queue / cadence call (WYNN-first).
  // Defaults to "ex" since that's the most common inbound path.
  const channel =
    String(input.channel || "ex").toLowerCase() === "cx" ? "cx" : "ex";

  if (!rawPhone) {
    // Clear path — useful for "hang up the simulated call".
    const cleared = await agentStateRepository.upsertAgentState({
      extensionId,
      currentCall: {},
    });
    return {
      ok: true,
      cleared: true,
      extensionId,
      currentCall: cleared.currentCall || {},
    };
  }

  const digits = rawPhone.replace(/\D/g, "");
  const tenDigit =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.slice(-10);
  const e164 = tenDigit.length === 10 ? `+1${tenDigit}` : `+${digits}`;

  const sessionId = `sim-${Date.now()}`;
  const callSnapshot = {
    sessionId,
    telephonySessionId: sessionId,
    direction,
    from: direction === "inbound" ? e164 : null,
    fromName: input.fromName || null,
    to: direction === "outbound" ? e164 : null,
    channel,
    startTime: new Date(),
  };

  const updated = await agentStateRepository.upsertAgentState({
    extensionId,
    currentCall: callSnapshot,
  });

  return {
    ok: true,
    simulated: true,
    extensionId,
    domain: context.domain,
    currentCall: updated.currentCall || callSnapshot,
  };
}

async function executeCxLogicsActivity(domain, user, input = {}) {
  if (!input.caseId) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const isUpdate = input.activityId != null;
  const noteBody = String(input.note || input.comment || "").trim();
  const subject = String(input.subject || noteBody.slice(0, 80) || "CX workspace note").trim();
  const activityType = String(input.activityType || "General").trim();
  if (!isUpdate && (!subject || !activityType)) {
    const err = new Error("activityType and subject are required");
    err.status = 400;
    throw err;
  }

  // Build the Comment payload Logics will store.
  //
  // Both paths use the same signed-block shape — one clean signature
  // line, no separate "Requested via CX workspace by …" audit tag (the
  // signature already names the operator and the integration channel
  // is implicit from the session). Logics auths as a service account
  // and tags every save with "Comment posted By Public API on …", so
  // the agent identity has to live in the body anyway.
  //
  // CREATE: front a fresh `— Name @ stamp\n<note>` block with whatever
  //         the operator typed.
  // UPDATE: the frontend already built `<existing>\n\n— Name @ stamp\n
  //         <new>` and we pass it through verbatim.
  let rawComment;
  if (isUpdate) {
    rawComment = String(input.comment || "").trim() || null;
  } else {
    const actor = normalizeActor(user);
    const agentLabel = actor.actorName || actor.actorEmail || "CX agent";
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
    const explicitComment = String(input.comment || "").trim();
    const body = explicitComment || noteBody;
    // Dashed top + bottom rule frames each entry — same shape Logics
    // itself uses internally, so the chain reads consistently when
    // mixed with comments posted from the Logics UI.
    const RULE = "------------------------------";
    rawComment = body
      ? `${RULE}\n${body}\n— ${agentLabel} @ ${stamp}\n${RULE}`
      : null;
  }

  return executeCxLogicsAction({
    domain,
    user,
    subtype: input.activityId ? "logics-update-activity" : "logics-create-activity",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: input.activityId ? "Logics activity update requested" : "Logics activity requested",
    summary: `${input.activityId ? "Update" : "Create"} activity on case ${input.caseId}`,
    payload: input,
    reviewCategory: "cx-logics-activity",
    executor: async (client) =>
      (input.activityId ? client.updateActivity : client.createActivity)({
        ActivityID: input.activityId != null ? Number(input.activityId) : undefined,
        CaseID: Number(input.caseId),
        ActivityType: isUpdate ? undefined : activityType,
        Subject: isUpdate ? undefined : subject,
        Comment: rawComment,
        Popup: input.popup != null ? Boolean(input.popup) : undefined,
        Pin: input.pin != null ? Boolean(input.pin) : undefined,
      }),
  });
}

// Map our camelCase identity fields → the PascalCase keys Logics
// expects on CreateCase / UpdateCase. Logics ignores fields it doesn't
// recognize, so passing camelCase silently no-ops — that's why earlier
// identity edits from the CX form looked accepted but never landed
// upstream.
//
// Format constraints from the Logics public API docs:
//   • Phone: "(NNN)NNN-NNNN"
//   • SSN:   "xxx-xx-xxxx"
//   • State: 2-char code
// Spouse fields are NOT in the documented Logics API — they get
// appended to the case as a structured "Spouse intake" activity-note
// elsewhere (see appendSpouseIntakeNote). They're omitted from this
// map so we don't accidentally send them as fields Logics will drop.
async function writeCxWorkspaceCallWrap(domain, user, input = {}, options = {}) {
  const actor = normalizeActor(user);
  return writeCxCallWrapSummary(
    {
      ...input,
      domain,
      actor,
      agentEmail: input.agentEmail || actor.actorEmail,
      agentName: input.agentName || actor.actorName,
    },
    {
      caseProfileRepository,
      writeLogicsActivity: (activityDomain, _actor, activityInput) =>
        executeCxLogicsActivity(activityDomain, user, activityInput),
    },
    options,
  );
}

// Persist a call summary to CaseProfile communications and Logics through the shared call-wrap writer.
async function executeCxCallSummary(domain, user, input = {}) {
  const context = await resolveCxUserContext(domain, user);
  const caseId = Number(input.caseId ?? input.CaseID);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const result = await writeCxWorkspaceCallWrap(context.domain, user, {
    ...input,
    caseId,
    source: input.source || "cx-call-summary",
    provider: input.provider || "cx-workspace",
    subject: input.subject || "CX call summary",
  }, {
    allowSparse: input.allowSparse !== false,
    writeCaseProfileCommunication: input.writeCaseProfileCommunication !== false,
    writeLogicsActivity: input.writeLogicsActivity !== false,
  });

  if (result.reason === "missing-call-wrap-body") {
    const err = new Error("summary, note, or allowSparse summary input is required");
    err.status = 400;
    throw err;
  }

  return {
    ok: result.ok !== false,
    domain: context.domain,
    caseId,
    communication: result.communication,
    logicsActivity: result.logicsActivity,
    callWrap: {
      skipped: result.skipped === true,
      reason: result.reason || null,
      threadKey: result.packet?.threadKey || null,
    },
  };
}

async function executeCxInterviewSnapshot(domain, user, input = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const caseId = Number(input.caseId);
  if (!Number.isFinite(caseId) || caseId <= 0) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  const activityNote = String(input.activityNote || input.note || input.comment || "").trim();
  if (!activityNote) {
    const err = new Error("activityNote is required");
    err.status = 400;
    throw err;
  }

  const now = new Date();
  const actor = normalizeActor(user);
  const snapshotPayload = {
    source: "cx-workspace-interview-snapshot",
    caseId,
    domain: normalizedDomain,
    prospectName: String(input.prospectName || "").trim().slice(0, 160) || null,
    phone: String(input.phone || "").trim().slice(0, 80) || null,
    queue: {
      actionKey: String(input.queueActionKey || "").trim().slice(0, 120) || null,
      itemId: String(input.queueItemId || "").trim().slice(0, 120) || null,
      ticketId: String(input.queueTicketId || "").trim().slice(0, 120) || null,
    },
    updatedAt: now,
    updatedBy: actor,
    snapshot: sanitizeInterviewSnapshotValue(plainObject(input.snapshot)),
    // Opus call strategy, persisted SERVER-SIDE with the snapshot (cadence row
    // + Logics activity) so rich form-derived data doesn't have to live in
    // browser storage. Kept separate from `snapshot` so it never round-trips
    // into the form state. Capped to the compact-strategy budget.
    callStrategy: String(input.callStrategy || "").trim().slice(0, 2000) || null,
    activityNote,
  };

  const cadenceResult = await leadCadenceRepository.saveLeadCadenceInterviewSnapshot(
    normalizedDomain,
    caseId,
    snapshotPayload,
  );

  const workflowId = String(input.interviewSnapshotWorkflowId || input.workflowId || "").trim();
  const interviewThreadKey = String(input.threadKey || "").trim()
    || (workflowId ? `cx-interview:${workflowId}` : "")
    || (input.uii ? "" : `cx-interview:${caseId}:${now.toISOString()}`);
  const wrapResult = await writeCxWorkspaceCallWrap(normalizedDomain, user, {
    caseId,
    subject: "CX interview snapshot",
    provider: "cx-workspace",
    source: snapshotPayload.source,
    status: "interview-snapshot",
    terminalOutcome: input.terminalOutcome || "interview-snapshot",
    activityType: "General",
    note: activityNote,
    activityNote,
    phone: snapshotPayload.phone,
    prospectName: snapshotPayload.prospectName,
    queueItemId: snapshotPayload.queue.itemId,
    queueTicketId: snapshotPayload.queue.ticketId,
    uii: input.uii || input.telephonySessionId || input.callSessionId || "",
    threadKey: interviewThreadKey || undefined,
    interviewSnapshotWorkflowId: workflowId,
    interviewSnapshot: snapshotPayload.snapshot,
    callStrategy: snapshotPayload.callStrategy,
    metadata: {
      queue: snapshotPayload.queue,
      updatedBy: actor,
    },
  }, {
    allowSparse: true,
    writeCaseProfileCommunication: input.writeCaseProfileCommunication !== false,
    writeLogicsActivity: input.writeLogicsActivity !== false,
  });

  return {
    completed: wrapResult?.logicsActivity?.completed === true,
    response: {
      cadence: cadenceResult,
      cadenceMatched: Number(cadenceResult?.matchedCount || 0) > 0,
      communication: wrapResult.communication,
      logics: wrapResult.logicsActivity,
      callWrap: {
        skipped: wrapResult.skipped === true,
        reason: wrapResult.reason || null,
        threadKey: wrapResult.packet?.threadKey || null,
      },
    },
  };
}

const LOGICS_UPDATE_FIELD_MAP = {
  firstName: "FirstName",
  lastName: "LastName",
  email: "Email",
  cellPhone: "CellPhone",
  homePhone: "HomePhone",
  workPhone: "WorkPhone",
  ssn: "SSN",
  city: "City",
  state: "State",
  zip: "Zip",
  address: "Address",
  sourceName: "SourceName",
  notes: "Notes",
};

// Field-level encryption for sensitive PII at rest in CaseProfile.
// Only required at runtime — at module load we don't decrypt anything,
// just hold a reference for write paths.
const { encryptField } = require("../../shared-auth/src/fieldCrypto");

function formatLogicsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 10) return value || undefined;
  const last10 = digits.slice(-10);
  return `(${last10.slice(0, 3)})${last10.slice(3, 6)}-${last10.slice(6)}`;
}

// Logics' public API expects SSN as `xxx-xx-xxxx`. Returns undefined
// when the input doesn't have 9 digits — better to omit than to send
// a malformed value that Logics will reject.
function formatLogicsSsn(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 9) return undefined;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}

// Spouse fields aren't in the Logics CreateCase / UpdateCase API
// (per the public API docs). To still get the data into the case
// in some retrievable form, we append a structured "Spouse intake"
// activity-note when any spouse field is set on save. The note body
// is human-readable + parseable, and the SSN is masked
// ("XXX-XX-1234") so the activity log doesn't store full PII —
// the unmasked encrypted SSN lives in CaseProfile.spouse.ssnEncrypted.
function buildSpouseIntakeNote(input = {}) {
  const lines = [];
  const fullName = [input.spouseFirstName, input.spouseLastName]
    .map((s) => (s ? String(s).trim() : ""))
    .filter(Boolean)
    .join(" ");
  if (fullName) lines.push(`Name: ${fullName}`);
  if (input.spouseEmail) lines.push(`Email: ${String(input.spouseEmail).trim()}`);
  if (input.spouseCellPhone)
    lines.push(`Cell: ${formatLogicsPhone(input.spouseCellPhone) || input.spouseCellPhone}`);
  if (input.spouseHomePhone)
    lines.push(`Home: ${formatLogicsPhone(input.spouseHomePhone) || input.spouseHomePhone}`);
  if (input.spouseSsn) {
    const digits = String(input.spouseSsn).replace(/\D/g, "");
    const masked = digits.length >= 4 ? `XXX-XX-${digits.slice(-4)}` : "XXX-XX-XXXX";
    lines.push(`SSN: ${masked} (full value encrypted in CaseProfile)`);
  }
  return lines.length > 0
    ? `Spouse intake captured via CX workspace:\n${lines.join("\n")}`
    : null;
}

function hasAnySpouseField(input = {}) {
  return Boolean(
    input.spouseFirstName ||
      input.spouseLastName ||
      input.spouseEmail ||
      input.spouseCellPhone ||
      input.spouseHomePhone ||
      input.spouseSsn,
  );
}

/**
 * Append a structured "Spouse intake" activity to the Logics case so
 * the spouse data is searchable upstream (Logics has no first-class
 * Spouse* fields). Best-effort — does NOT throw on Logics failures so
 * a flaky activity post doesn't fail the whole save flow.
 */
/**
 * After a Logics create/update, persist the sensitive + Logics-not-
 * carried fields to our CaseProfile. SSN + spouse SSN are encrypted
 * via FIELD_ENCRYPTION_KEY before write — plaintext never lives in
 * Mongo. Mailing address + spouse identity go in plain (low-risk).
 *
 * Best-effort + idempotent: if encryption key is unset OR no
 * sensitive fields are present, this is a no-op for those branches.
 */
async function persistCxIdentityToCaseProfile(domain, caseId, input = {}) {
  if (!caseId) return null;
  const update = {};

  // SSN: encrypt the full 9-digit form before storage. Caller passes
  // raw/dashed/spaced — strip + validate length first so we don't
  // store half-typed values.
  if (input.ssn) {
    const digits = String(input.ssn).replace(/\D/g, "");
    if (digits.length === 9) {
      try {
        update.ssnEncrypted = encryptField(digits);
      } catch {
        // Encryption failed (key unconfigured or invalid) — skip
        // rather than store plaintext. Surfaces as missing data, not
        // a leak.
      }
    }
  }

  // Spouse — encrypt SSN; everything else is plain.
  const spouse = {};
  if (input.spouseFirstName) spouse.firstName = String(input.spouseFirstName).trim();
  if (input.spouseLastName) spouse.lastName = String(input.spouseLastName).trim();
  if (input.spouseEmail) spouse.email = String(input.spouseEmail).trim();
  if (input.spouseCellPhone) spouse.cellPhone = String(input.spouseCellPhone).trim();
  if (input.spouseHomePhone) spouse.homePhone = String(input.spouseHomePhone).trim();
  if (input.spouseSsn) {
    const digits = String(input.spouseSsn).replace(/\D/g, "");
    if (digits.length === 9) {
      try {
        spouse.ssnEncrypted = encryptField(digits);
      } catch {
        // Same defensive skip as primary SSN.
      }
    }
  }
  if (Object.keys(spouse).length > 0) update.spouse = spouse;

  // Address fields Logics carries but the post-success sync currently
  // only pulls name/phone/email — fold them in here so the CaseProfile
  // mirrors the operator's edit immediately.
  if (input.address) update.address = String(input.address).trim();
  if (input.city) update.city = String(input.city).trim();
  if (input.state) update.state = String(input.state).trim().toUpperCase().slice(0, 2);
  if (input.zip) update.zip = String(input.zip).trim();
  if (input.homePhone) update.homePhone = String(input.homePhone).trim();

  if (Object.keys(update).length === 0) return null;
  return caseProfileRepository.upsertCaseProfile(domain, caseId, update);
}

async function appendSpouseIntakeNote(domain, caseId, user, input = {}) {
  if (!caseId || !hasAnySpouseField(input)) return null;
  const note = buildSpouseIntakeNote(input);
  if (!note) return null;
  try {
    return await executeCxLogicsActivity(domain, user, {
      caseId,
      activityType: "General",
      subject: "Spouse intake (CX)",
      note,
    });
  } catch (error) {
    // Don't surface as a save failure — spouse-note is supplementary.
    return null;
  }
}

async function executeCxLogicsUpdateCase(domain, user, input = {}) {
  const caseId = input.caseId != null || input.CaseID != null
    ? Number(input.caseId ?? input.CaseID)
    : null;
  if (!Number.isFinite(caseId) || caseId <= 0) {
    const err = new Error("caseId is required for Logics UpdateCase");
    err.status = 400;
    throw err;
  }

  const resolvedStatusId = resolveRequestedStatus(domain, input);

  // Build the Logics UpdateCase payload from camelCase input. Only
  // include fields the operator has data in — empty strings / nulls
  // get stripped so Logics preserves whatever's already on the case
  // (non-destructive update, the rule the CX UI relies on).
  const payload = {};
  for (const [our, theirs] of Object.entries(LOGICS_UPDATE_FIELD_MAP)) {
    const raw = input[our];
    const value = raw == null ? "" : String(raw).trim();
    if (!value) continue;
    if (our === "cellPhone" || our === "homePhone" || our === "workPhone") {
      payload[theirs] = formatLogicsPhone(value);
    } else if (our === "ssn") {
      const formatted = formatLogicsSsn(value);
      if (formatted) payload[theirs] = formatted;
    } else if (our === "state") {
      payload[theirs] = value.toUpperCase().slice(0, 2);
    } else {
      payload[theirs] = value;
    }
  }
  // Forward any explicit PascalCase keys the caller already passed
  // (e.g. callers that build payloads directly), without letting
  // empties through.
  for (const [k, v] of Object.entries(input)) {
    if (k === "SearchPhone") continue;
    if (/^[A-Z]/.test(k) && v != null && String(v).trim() !== "") {
      payload[k] = v;
    }
  }
  const settlementOfficerId = resolveInputSettlementOfficerId(input);
  if (settlementOfficerId) payload.SetOfficerID = settlementOfficerId;
  payload.CaseID = caseId || undefined;
  const statusId =
    input.StatusID != null
      ? Number(input.StatusID)
      : input.statusId != null
        ? Number(input.statusId)
        : input.logicsStatusId != null
          ? Number(input.logicsStatusId)
          : resolvedStatusId != null
            ? Number(resolvedStatusId)
            : undefined;
  if (statusId !== undefined) payload.StatusID = statusId;

  const result = await executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-update-case",
    aggregateType: "case-profile",
    aggregateId: caseId,
    caseId,
    title: "Logics case update requested",
    summary: `Update case ${caseId}`,
    payload,
    reviewCategory: "cx-logics-update-case",
    executor: (client) => client.updateCase(payload),
  });

  // Same as create: append spouse intake note when present.
  const resolvedCaseId =
    caseId ||
    extractCaseId(result?.response) ||
    null;

  if (resolvedCaseId && hasAnySpouseField(input)) {
    await appendSpouseIntakeNote(domain, resolvedCaseId, user, input);
  }

  // Persist SSN (encrypted) + spouse fields + address to CaseProfile.
  // The post-success Logics sync writes Logics-known fields (name,
  // phone, email, status), but Logics doesn't carry SSN/spouse fields
  // back — so they have to land here on the way through.
  if (resolvedCaseId) {
    await persistCxIdentityToCaseProfile(domain, resolvedCaseId, input).catch(() => null);
  }
  const queueOutcome =
    resolvedCaseId && !input.skipQueueFinalize
      ? await finalizeCxQueueFromLogicsState(
        domain,
        resolvedCaseId,
        {
          ...input,
          actorEmail: user?.email || null,
        },
        result?.response,
      ).catch(() => null)
      : null;
  const statusCategory =
    queueOutcome?.statusCategory
    || (statusId != null ? resolveStatus(domain, statusId)?.category : null)
    || null;
  let postDateHold = null;
  if (resolvedCaseId && (statusCategory === "postdate" || isPostDateStatusRequest(domain, input, queueOutcome || result))) {
    postDateHold = await recordCxPostDateHold(domain, user, {
      ...input,
      caseId: resolvedCaseId,
    }, {
      ...result,
      ...(queueOutcome || {}),
      statusId,
      settlementOfficerId: settlementOfficerId || null,
    }).catch((error) => ({
      ok: false,
      error: error.message,
    }));
  }

  return {
    ...result,
    disposition: queueOutcome?.disposition || null,
    queueOutcome: queueOutcome?.queueOutcome || null,
    rescheduledFor: queueOutcome?.rescheduledFor || null,
    statusId: queueOutcome?.statusId || statusId || null,
    statusCategory,
    settlementOfficerId: settlementOfficerId || null,
    postDateHold,
  };
}

async function executeCxLogicsInvoice(domain, user, input = {}) {
  if (!input.caseId) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }
  const invoiceTypeId =
    input.invoiceTypeId != null && input.invoiceTypeId !== ""
      ? Number(input.invoiceTypeId)
      : undefined;
  const invoiceTypeName =
    String(input.invoiceTypeName || "").trim() || (invoiceTypeId == null ? "Other Fee" : undefined);

  return executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-create-invoice",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: "Logics invoice requested",
    summary: `Create invoice on case ${input.caseId}`,
    payload: input,
    reviewCategory: "cx-logics-invoice",
    executor: (client) =>
      client.createCaseInvoice({
        CaseID: Number(input.caseId),
        Quantity: Number(input.quantity || 1),
        UnitPrice: Number(input.unitPrice || input.amount),
        InvoiceTypeID: invoiceTypeId,
        Date: input.date || new Date().toISOString().slice(0, 10),
        InvoiceTypeName: invoiceTypeName,
        Description: input.description || undefined,
        TagID: input.tagId != null ? Number(input.tagId) : undefined,
        TagName: input.tagName || undefined,
        RelatedInvoiceId: input.relatedInvoiceId != null ? Number(input.relatedInvoiceId) : undefined,
      }),
  });
}

async function executeCxLogicsAmortization(domain, user, input = {}) {
  if (!input.caseId) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }

  return executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-create-amortization",
    aggregateType: "case-profile",
    aggregateId: input.caseId,
    caseId: input.caseId,
    title: "Logics amortization requested",
    summary: `Create amortization on case ${input.caseId}`,
    payload: input,
    reviewCategory: "cx-logics-amortization",
    executor: (client) =>
      client.createCaseAmortization({
        CaseID: Number(input.caseId),
        Amount: Number(input.amount),
        ScheduledDate: input.scheduledDate || input.firstPaymentDate || input.date,
      }),
  });
}

function resolvePostDateReleaseStatus(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const envSpecific = process.env[`POSTDATE_RELEASE_STATUS_ID_${normalizedDomain}`];
  const envGlobal = process.env.POSTDATE_RELEASE_STATUS_ID;
  const explicit = Number(envSpecific || envGlobal);
  if (Number.isFinite(explicit) && explicit > 0) {
    return {
      statusId: explicit,
      ...resolveStatus(normalizedDomain, explicit),
      matchedBy: envSpecific ? `env-POSTDATE_RELEASE_STATUS_ID_${normalizedDomain}` : "env-POSTDATE_RELEASE_STATUS_ID",
    };
  }
  const candidates = normalizedDomain === "WYNN"
    ? ["active prospect opened", "opened", "prospect"]
    : ["prospect", "new lead", "opened"];
  for (const candidate of candidates) {
    const resolved = resolveExportStatus(normalizedDomain, candidate);
    if (resolved?.statusId) return resolved;
  }
  return {
    statusId: 2,
    ...resolveStatus(normalizedDomain, 2),
    matchedBy: "fallback",
  };
}

function getPostDateHoldDisplayName(hold = {}) {
  return (
    hold.caseName
    || [hold.firstName, hold.lastName].filter(Boolean).join(" ").trim()
    || `Case ${hold.caseId}`
  );
}

async function requeueReleasedPostDateHold(domain, hold = {}, user = {}) {
  const normalizedDomain = normalizeDomain(domain || hold.domain);
  const caseId = Number(hold.caseId);
  if (!normalizedDomain || !Number.isFinite(caseId)) {
    return { queued: false, skipped: true, reason: "invalid-case" };
  }
  const now = new Date();
  const existing = await leadCadenceRepository.findLeadCadence(normalizedDomain, caseId).catch(() => null);
  const actionKey = `postdate-release:${caseId}:${now.getTime()}`;
  const preservedActions = Array.isArray(existing?.schedule?.actions)
    ? existing.schedule.actions.filter((action) => {
        if (String(action?.key || "").startsWith("postdate-release:")) return false;
        return !(action?.channel === "cx" && ["pending", "requested"].includes(String(action?.status || "")));
      })
    : [];
  const releaseAction = {
    key: actionKey,
    type: "dial",
    channel: "cx",
    scheduledFor: now,
    status: "pending",
  };
  const schedule = {
    planVersion: existing?.schedule?.planVersion || "postdate-release-v1",
    timezone: existing?.schedule?.timezone || "America/Los_Angeles",
    nextActionType: "dial",
    nextActionAt: now,
    actions: [releaseAction, ...preservedActions].sort(
      (left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime(),
    ),
  };
  const leadBody = {
    caseId: String(caseId),
    name: getPostDateHoldDisplayName(hold),
    phone: hold.phone || existing?.primaryPhone || null,
    email: hold.email || existing?.email || null,
    sourceName: hold.sourceName || existing?.sourceName || null,
    intakeSource: hold.intakeSource || existing?.intakeSource || hold.sourceName || null,
    intakeRoute: hold.intakeRoute || existing?.intakeRoute || "postdate-release",
    queueFamily: hold.queueFamily || "fresh-day2to10",
    queueTier: "later",
    currentStage: "cx-postdate-released",
  };
  const cadence = await leadCadenceRepository.upsertLeadCadence(normalizedDomain, caseId, {
    active: true,
    name: leadBody.name,
    email: leadBody.email,
    primaryPhone: leadBody.phone,
    normalizedPhone: normalizePhone(leadBody.phone),
    sourceName: leadBody.sourceName,
    intakeSource: leadBody.intakeSource,
    intakeRoute: leadBody.intakeRoute,
    currentStage: "cx-postdate-released",
    schedule,
    payloadSnapshot: {
      ...(existing?.payloadSnapshot || {}),
      ...leadBody,
      leadBody,
      postDateRelease: {
        holdId: hold._id ? String(hold._id) : null,
        releasedAt: now,
        releasedByEmail: user?.email || null,
      },
    },
  });
  const queueResult = await queueCxDialRequest({
    domain: normalizedDomain,
    caseId,
    actionKey,
    leadCadenceId: cadence?._id ? String(cadence._id) : null,
    phone: leadBody.phone,
    name: leadBody.name,
    intakeSource: leadBody.intakeSource,
    intakeRoute: leadBody.intakeRoute,
    sourceName: leadBody.sourceName,
    queueFamily: leadBody.queueFamily,
    queueTier: "later",
    requestedBy: "postdate-release",
    requestedByUserEmail: user?.email || null,
    payloadSnapshot: {
      ...leadBody,
      postDateHoldId: hold._id ? String(hold._id) : null,
    },
  }).catch((error) => ({
    queued: false,
    error: error.message,
  }));

  return {
    actionKey,
    cadenceId: cadence?._id ? String(cadence._id) : null,
    queueResult,
  };
}

async function listCxPostDateHolds(domain, _user, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const items = await postDateHoldRepository.listPostDateHolds(normalizedDomain, filters);
  const summary = items.reduce(
    (acc, item) => {
      acc.total += 1;
      acc[item.status] = (acc[item.status] || 0) + 1;
      if (item.firstPaymentDateKey) acc.withFirstPaymentDate += 1;
      if (item.status === "active" && !item.firstPaymentDateKey) acc.needsScheduleReview += 1;
      return acc;
    },
    {
      total: 0,
      active: 0,
      released: 0,
      payment_verified: 0,
      review: 0,
      release_failed: 0,
      withFirstPaymentDate: 0,
      needsScheduleReview: 0,
    },
  );
  return {
    domain: normalizedDomain,
    filters,
    summary,
    items,
  };
}

async function releaseCxPostDateHold(domain, user, input = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const hold = await postDateHoldRepository.findPostDateHold(
    normalizedDomain,
    input.holdId || input.id || input.caseId,
  );
  if (!hold) {
    const err = new Error("Active post-date hold not found");
    err.status = 404;
    throw err;
  }
  const releaseStatus = resolvePostDateReleaseStatus(normalizedDomain);
  const releaseReason = String(input.reason || "Released from post-date hold").trim();
  let logicsResult = null;
  try {
    logicsResult = await executeCxLogicsUpdateCase(normalizedDomain, user, {
      caseId: hold.caseId,
      CaseID: hold.caseId,
      StatusID: releaseStatus.statusId,
      Notes: input.notes || undefined,
      skipQueueFinalize: true,
    });
  } catch (error) {
    await postDateHoldRepository.markPostDateHoldReleaseFailed(hold._id, {
      checkedAt: new Date(),
      releasedByEmail: user?.email || null,
      releaseReason,
      releaseStatusId: releaseStatus.statusId,
      releaseStatusLabel: releaseStatus.label || null,
      error: error.message,
    }).catch(() => null);
    throw error;
  }

  const queueResult = await requeueReleasedPostDateHold(normalizedDomain, hold, user);
  const updated = await postDateHoldRepository.markPostDateHoldReleased(hold._id, {
    releasedAt: new Date(),
    releasedByEmail: user?.email || null,
    releaseReason,
    releaseWorkflowId: logicsResult?.completionWorkflowId || logicsResult?.workflowId || null,
    releaseStatusId: releaseStatus.statusId,
    releaseStatusLabel: releaseStatus.label || null,
    releaseQueueResult: queueResult,
  });

  return {
    ok: true,
    domain: normalizedDomain,
    hold: updated,
    logicsResult,
    releaseStatus,
    queueResult,
  };
}

function findSuccessfulFirstPayment(payments = [], targetDateKey) {
  const target = String(targetDateKey || "").trim();
  if (!target) return null;
  return (payments || [])
    .filter((payment) => {
      const status = String(payment.transactionStatus || "").trim().toUpperCase();
      return status === "SUCCESS" && String(payment.paymentDateKey || "") === target;
    })
    .sort((left, right) => (Number(left.casePaymentId) || 0) - (Number(right.casePaymentId) || 0))[0] || null;
}

async function runPostDateHoldEodSweep(domains, options = {}) {
  const normalizedDomains = (Array.isArray(domains) ? domains : [domains])
    .map(normalizeDomain)
    .filter(Boolean);
  const dateKey = options.dateKey || getPacificDateKey(options.now || new Date());
  const actor = options.user || {
    email: "postdate-eod@parallel.local",
    name: "Post-date EOD sweep",
  };
  const summary = {
    dateKey,
    domains: normalizedDomains,
    checked: 0,
    verified: 0,
    released: 0,
    review: 0,
    errors: 0,
    items: [],
  };

  for (const selectedDomain of normalizedDomains) {
    const activeHolds = await postDateHoldRepository.listPostDateHolds(selectedDomain, {
      status: "active",
      limit: options.limit || 250,
    });
    const holds = activeHolds.filter(
      (hold) => !hold.firstPaymentDateKey || String(hold.firstPaymentDateKey) <= String(dateKey),
    );
    for (const hold of holds) {
      summary.checked += 1;
      if (!hold.firstPaymentDateKey) {
        const updated = await postDateHoldRepository.markPostDateHoldReview(hold._id, {
          checkedAt: new Date(),
          reviewReason: "missing-first-payment-date",
        });
        summary.review += 1;
        summary.items.push({ caseId: hold.caseId, domain: selectedDomain, outcome: "review", hold: updated });
        continue;
      }
      try {
        const { reconcilePaymentsForCase } = require("./paymentReconcileService");
        await reconcilePaymentsForCase({
          domain: selectedDomain,
          caseId: hold.caseId,
          lane: "nightly",
        }).catch(() => null);
        const payments = await paymentLedgerRepository.listPayments(selectedDomain, {
          caseId: hold.caseId,
          limit: 500,
        });
        const success = findSuccessfulFirstPayment(payments, hold.firstPaymentDateKey);
        if (success) {
          const updated = await postDateHoldRepository.markPostDateHoldPaymentVerified(hold._id, {
            checkedAt: new Date(),
            "paymentCheck.successfulCasePaymentId": success.casePaymentId,
            "paymentCheck.successfulAmount": success.amount,
            "paymentCheck.successfulPaymentDateKey": success.paymentDateKey,
          });
          summary.verified += 1;
          summary.items.push({ caseId: hold.caseId, domain: selectedDomain, outcome: "payment_verified", hold: updated });
          continue;
        }
        if (options.dryRun) {
          summary.items.push({ caseId: hold.caseId, domain: selectedDomain, outcome: "would-release" });
          continue;
        }
        const released = await releaseCxPostDateHold(selectedDomain, actor, {
          holdId: hold._id,
          reason: `First payment was not successful by EOD ${dateKey}`,
        });
        summary.released += 1;
        summary.items.push({ caseId: hold.caseId, domain: selectedDomain, outcome: "released", hold: released.hold });
      } catch (error) {
        summary.errors += 1;
        await postDateHoldRepository.markPostDateHoldReleaseFailed(hold._id, {
          checkedAt: new Date(),
          releasedByEmail: actor.email,
          releaseReason: `First payment was not successful by EOD ${dateKey}`,
          error: error.message,
        }).catch(() => null);
        summary.items.push({
          caseId: hold.caseId,
          domain: selectedDomain,
          outcome: "error",
          error: error.message,
        });
      }
    }
  }

  return summary;
}

// Notes are a single free-form text field on the Logics Case object,
// distinct from the activity-comment chain (see `executeCxLogicsActivity`).
// Save semantics are OVERWRITE: the SPA pre-loads the existing value into
// the editor on open, so the operator never starts from blank — whatever
// they submit becomes the new full value of `Notes` in Logics. Append
// behavior would belong on activities, not here.
//
// We don't strip-empty here: passing an empty string IS a valid intent
// (clear the notes), unlike `executeCxLogicsUpdateCase` which uses empty
// to mean "leave unchanged." If `notes` is undefined or null the request
// is rejected; the caller should send "" explicitly to clear.
async function executeCxLogicsNotes(domain, user, input = {}) {
  const caseId = input.caseId != null ? Number(input.caseId) : null;
  if (!caseId || !Number.isFinite(caseId)) {
    const err = new Error("caseId is required");
    err.status = 400;
    throw err;
  }
  if (input.notes == null) {
    const err = new Error("notes is required (use empty string to clear)");
    err.status = 400;
    throw err;
  }
  const notes = String(input.notes);

  const result = await executeCxLogicsAction({
    domain,
    user,
    subtype: "logics-update-notes",
    aggregateType: "case-profile",
    aggregateId: caseId,
    caseId,
    title: "Logics notes update requested",
    summary: `Update Notes on case ${caseId}`,
    payload: { caseId, notes },
    reviewCategory: "cx-logics-notes",
    executor: (client) =>
      client.updateCase({
        CaseID: caseId,
        Notes: notes,
      }),
  });

  // Mirror to the local case profile so the next SPA read shows the new
  // value without waiting for a hygiene pass to pull it back from Logics.
  // Fire-and-forget — Logics is the source of truth; a profile-write
  // failure shouldn't fail the user-visible action.
  await caseProfileRepository
    .upsertCaseProfile(normalizeDomain(domain), caseId, { notes })
    .catch(() => null);

  return result;
}

module.exports = {
  buildCxCallQueue,
  buildCxQueueForAgent,
  buildCxQueuesForAgents,
  buildCxWorkspace,
  listCxPlacedCallsToday,
  executeCxAppointmentWorkbenchActions,
  executeCxCallSummary,
  executeCxLogicsCreateCase,
  executeCxSaveCaseProfileFromLogics,
  executeCxLogicsFindMatch,
  executeCxLogicsActivity,
  executeCxInterviewSnapshot,
  executeCxLogicsAmortization,
  executeCxLogicsInvoice,
  executeCxLogicsNotes,
  executeCxLogicsTask,
  executeCxLogicsUpdateCase,
  listCxPostDateHolds,
  listCxTasks,
  listCxLogicsTasks,
  lookupCxLogicsMatch,
  requestCxDial,
  requestCxEndCall,
  requestCxAssignCaseToMe,
  requestCxDisposition,
  requestCxEmail,
  requestCxLogicsCreateCase,
  requestCxLogicsFindMatch,
  requestCxLeadStatusUpdate,
  releaseCxPostDateHold,
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
  searchCxCases,
  runPostDateHoldEodSweep,
  syncCaseProfileFromLogics,
  enqueueCxSmokeLead,
  simulateCxIncomingCall,
};
