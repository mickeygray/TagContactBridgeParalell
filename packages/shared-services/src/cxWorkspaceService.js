"use strict";

const { createEvent } = require("../../event-core/src");
const {
  agentStateRepository,
  callLogRepository,
  caseProfileRepository,
  conversationMessageRepository,
  conversationWorkflowRepository,
  cxDialQueueRepository,
  leadCadenceRepository,
  reviewQueueRepository,
  userAccountRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");
const { CxDialQueue, LeadCadence, MasterProspectIndex } = require("../../shared-models/src");
const { recordWorkflowStage } = require("./workflowStateService");
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
  emitHourlyJobEvent,
  runWithImmediateRetries,
} = require("./hourlyJobEventService");
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
  stageCxDispatchIntent,
} = require("./cxCadenceService");
const { deriveQueueFamily } = require("./cxLoadBalancerService");
const {
  deriveQueueFamilyFromLeadCreatedAt,
  getCooldownReleaseAt,
  getPacificBusinessDayAge,
  getPacificBusinessDayStart,
  getPacificDateKey,
  resolveAccountQueuePolicy,
} = require("./cxQueuePolicyService");
const { getRingCentralConfig, getSharedConfig, PORTS } = require("../../shared-config/src");
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

function normalizeCxDisposition(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "callback" ||
    normalized === "call back" ||
    normalized === "call-back" ||
    normalized === "no answer" ||
    normalized === "no-answer" ||
    normalized === "no connect" ||
    normalized === "no-connect"
  ) {
    return "call-back";
  }
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
  const requestedIdentity = normalizeExternalId(options.uii || options.rcxUii || null);
  const existingIdentity = callIdentity(existingCall);
  if (
    requestedIdentity
    && existingIdentity
    && existingIdentity !== requestedIdentity
    && String(existing?.activePlatform || "").trim().toUpperCase() === "CX"
  ) {
    return {
      skipped: true,
      reason: "different-active-cx-call",
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
    return {
      caseId: normalizedCaseId,
      disposition,
      statusId,
      statusCategory,
      queueOutcome: queueMutation?.mutated ? "cancelled" : queueAction?.actionKey ? "cancelled" : "noop",
      actionKey: queueAction?.actionKey || null,
      rescheduledFor: null,
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
  );
  const derivedFamily = createdAtFamily
    || explicitFamily
    || (activeDay === 0 ? "fresh-day1" : null)
    || (activeDay != null && activeDay > 0 && activeDay <= 15 ? "fresh-day2to10" : null)
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
  if (family === "fresh-day2to10" || family === "aged") return true;

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

function canViewQueueItemForAgent(queueItem = {}, context = {}) {
  const agentExtensionId = String(context?.account?.extensionId || "").trim();
  if (!agentExtensionId) return false;
  const assignedExtensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (assignedExtensionId) return assignedExtensionId === agentExtensionId;
  return Boolean(
    isFallbackAfterFirstContactViewer(context)
      && String(queueItem.state || "").trim().toLowerCase() === "ready"
      && isQueueItemUnassigned(queueItem)
      && isPostFirstContactQueueItem(queueItem),
  );
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

function getPositiveEnvNumber(name, fallback) {
  return Math.max(Number(process.env[name]) || fallback, 1);
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
        : normalizeCxQueueFamily(family) === "aged"
          ? queuePolicy.aged?.targetOpen
          : 0;
  return envName ? getNonNegativeEnvNumber(envName, fallback) : Math.max(Number(fallback) || 0, 0);
}

const ACTIVE_QUEUE_STATES = ["queued", "ready", "claimed", "serving", "paused"];
let lastQueueOrderingBackfillAt = 0;
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
  return Boolean(cxDnc?.blocked);
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
  const candidates = await LeadCadence.find({
    domain: normalizedDomain,
    active: true,
    createdAt: { $gte: windowStart, $lt: windowEnd },
    $or: [
      { normalizedPhone: { $nin: [null, ""] } },
      { primaryPhone: { $nin: [null, ""] } },
    ],
  })
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
    if (!Number.isFinite(businessAgeDays) || businessAgeDays < 1 || businessAgeDays > 14) continue;
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
        queueFamilyRank: 1,
        queueTier: "later",
        progressiveStageKey: "day2to15",
        progressiveStageIndex: Math.max(activeDay, 2),
        progressiveStageLabel: "2-15",
        priorityScore: 100,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [25, 25, 25, 25],
          activeDay,
          nextDelayMinutes: 25,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "fresh-day2to10",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "lead-cadence",
        "metadata.materializedAt": now,
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
  const candidates = await MasterProspectIndex.find({
    domain: normalizedDomain,
    "pool.tag": poolTag,
    normalizedPhones: { $exists: true, $ne: [] },
  })
    .sort({
      "filler.lastDialAttempt": 1,
      lastSeenAt: -1,
      updatedAt: 1,
    })
    .limit(scanLimit)
    .lean();

  let created = 0;
  let scanned = 0;
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
        queueFamilyRank: 2,
        queueTier: "later",
        progressiveStageKey: "aged-filler",
        progressiveStageIndex: 99,
        progressiveStageLabel: "Aged",
        priorityScore: 80,
        releaseAt: now,
        claimUntil: null,
        callPlan: {
          phaseIndex: 0,
          delaysMinutes: [60, 120, 240],
          activeDay: 99,
          nextDelayMinutes: 60,
        },
        "metadata.actionKey": actionKey,
        "metadata.queueFamily": "aged",
        "metadata.materializedBy": "cx-workspace-refill",
        "metadata.materializedFrom": "filler-pool",
        "metadata.materializedPoolTag": poolTag,
        "metadata.materializedAt": now,
      },
      { actionKey },
    );
    created += 1;
  }

  return { ok: true, created, scanned, source: "filler-pool", poolTag };
}

async function materializeQueueSupplyForAgent({
  domain,
  domains = null,
  queueFamilies = [],
  deficit = 0,
}) {
  const enabled =
    String(process.env.RC_CX_AUTO_MATERIALIZE_NONFRESH_ENABLED || "true").toLowerCase() !== "false";
  const normalizedFamilies = queueFamilies.map((family) => normalizeCxQueueFamily(family));
  const wantsDay2To15 = normalizedFamilies.includes("fresh-day2to10");
  const wantsAged = normalizedFamilies.includes("aged");
  const needed = Math.max(Number(deficit) || 0, 0);
  if (!enabled || needed <= 0 || (!wantsDay2To15 && !wantsAged)) {
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
      const day2Result = await materializeDay2To15QueueItems(supplyDomain, remaining);
      results.push({ domain: supplyDomain, ...day2Result });
      remaining -= Number(day2Result.created || 0);
    }
    if (wantsAged && remaining > 0) {
      const agedResult = await materializeAgedQueueItems(supplyDomain, remaining);
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
  targetCount,
  countEnvName,
  claimMinutes,
  randomize,
  maxOpenAssignmentsScope,
  requestKeyPrefix,
}) {
  const deficit = Math.max(targetCount - currentCount, 0);
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

  const queueDomains = resolveCxQueueDomains(context);
  const materialized = await materializeQueueSupplyForAgent({
    domain: context.domain,
    domains: queueDomains,
    queueFamilies,
    deficit,
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
      randomize,
      maxOpenAssignments: targetCount,
      maxOpenAssignmentsScope,
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

  return {
    ...assigned,
    materialized: Number(materialized?.created || 0),
    materialize: materialized,
    queueDomains,
  };
}

async function refillFreshHotLaneForAgent({
  context,
  currentCount,
  targetCount,
  claimMinutes,
  requestKeyPrefix,
}) {
  const deficit = Math.max(targetCount - currentCount, 0);
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
  const batchSize = Math.max(
    deficit,
    getPositiveEnvNumber("RC_CX_FRESH_HOT_LANE_BATCH_SIZE", targetCount || 5),
  );
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
    maxOpenAssignments: targetCount,
    requestKeyPrefix,
  });

  return {
    ok: true,
    requested: batchSize,
    assigned: Number(result?.assigned || 0),
    skipped: Number(result?.assignments?.reduce((total, entry) => total + Number(entry.skipped || 0), 0) || 0),
    results: Array.isArray(result?.assignments)
      ? result.assignments.flatMap((entry) => entry.results || [])
      : [],
    hotLane: result,
    queueDomains,
  };
}

async function maybeRefillCxQueueForAgent(context, agentExtensionId, visibleQueueItems = []) {
  const enabled = String(process.env.RC_CX_EMPTY_QUEUE_REFILL_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) return { skipped: true, reason: "disabled" };
  if (!agentExtensionId) return { skipped: true, reason: "missing-extension-id" };

  const queuePolicy = resolveAccountQueuePolicy(context.account || {});
  if (!queuePolicy.enabled) {
    return {
      ok: true,
      assigned: 0,
      skipped: true,
      reason: "queue-policy-no-leads",
      policy: queuePolicy,
    };
  }

  const freshFamilies = parseQueueFamilyList(
    process.env.RC_CX_FRESH_REFILL_FAMILIES,
    ["fresh-day1"],
  );
  const nonFreshFamilies = parseQueueFamilyList(
    process.env.RC_CX_EMPTY_QUEUE_REFILL_FAMILIES,
    ["fresh-day2to10", "aged"],
  );
  const day2To15Families = parseQueueFamilyList(
    process.env.RC_CX_DAY2TO15_REFILL_FAMILIES,
    ["fresh-day2to10"],
  );
  const agedFamilies = parseQueueFamilyList(
    process.env.RC_CX_AGED_REFILL_FAMILIES,
    ["aged"],
  );
  const freshTarget = queuePolicy.fresh.eligible
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "fresh-day1", "RC_CX_FRESH_OPEN_ASSIGNMENTS")
    : 0;
  const day2To15Target = Number(queuePolicy.day2to15.targetOpen || 0) > 0
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "fresh-day2to10", "RC_CX_DAY2TO15_OPEN_ASSIGNMENTS")
    : 0;
  const agedTarget = Number(queuePolicy.aged.targetOpen || 0) > 0
    ? resolveQueueFamilyTargetOpen(context, queuePolicy, "aged", "RC_CX_AGED_OPEN_ASSIGNMENTS")
    : 0;
  const nonFreshTarget = day2To15Target + agedTarget;
  const freshCurrent = countVisibleQueueItemsByFamily(visibleQueueItems, freshFamilies);
  const nonFreshCurrent = countVisibleQueueItemsByFamily(visibleQueueItems, nonFreshFamilies);
  const day2To15Current = countVisibleQueueItemsByFamily(visibleQueueItems, day2To15Families);
  const agedCurrent = countVisibleQueueItemsByFamily(visibleQueueItems, agedFamilies);
  const timestamp = Date.now();
  const batches = [];

  batches.push(await refillFreshHotLaneForAgent({
    context,
    currentCount: freshCurrent,
    targetCount: freshTarget,
    claimMinutes: Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
    requestKeyPrefix: `cx-fresh-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
  }));

  batches.push(await refillQueueFamilyForAgent({
    context,
    agentExtensionId,
    queueFamilies: day2To15Families,
    currentCount: day2To15Current,
    targetCount: day2To15Target,
    countEnvName: "RC_CX_DAY2TO15_REFILL_COUNT",
    claimMinutes: Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 480,
    randomize: true,
    maxOpenAssignmentsScope: "queue-family",
    requestKeyPrefix: `cx-day2to15-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
  }));

  batches.push(await refillQueueFamilyForAgent({
    context,
    agentExtensionId,
    queueFamilies: agedFamilies,
    currentCount: agedCurrent,
    targetCount: agedTarget,
    countEnvName: "RC_CX_AGED_REFILL_COUNT",
    claimMinutes: Number(process.env.RC_CX_AGED_CLAIM_MINUTES) || 480,
    randomize: true,
    maxOpenAssignmentsScope: "queue-family",
    requestKeyPrefix: `cx-aged-queue-refill:${context.domain}:${agentExtensionId}:${timestamp}`,
  }));

  return {
    ok: true,
    assigned: batches.reduce((total, batch) => total + (Number(batch?.assigned) || 0), 0),
    batches,
    policy: queuePolicy,
    counts: {
      freshCurrent,
      freshTarget,
      nonFreshCurrent,
      nonFreshTarget,
      day2To15Current,
      day2To15Target,
      agedCurrent,
      agedTarget,
    },
  };
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
    lastPlacedAt: queueItem.lastPlacedAt || queueItem.metadata?.lastQueueAttemptAt || null,
    queueDayIndex: activeDay,
    payloadSnapshot,
    leadBody,
    queueState: queueItem.state || null,
    queueTicketId: queueItem._id ? String(queueItem._id) : null,
    rcxAccountId:
      String(queueItem.rcxAccountId || payloadSnapshot?.rcxAccountId || "").trim() || null,
    rcxDialGroupId:
      String(queueItem.rcxDialGroupId || payloadSnapshot?.rcxDialGroupId || "").trim() || null,
    rcxCampaignId:
      String(queueItem.rcxCampaignId || payloadSnapshot?.rcxCampaignId || "").trim() || null,
    assignedExtensionId: queueItem.assignment?.extensionId || null,
    assignedAgentName: queueItem.assignment?.agentName || null,
  };
}

async function buildCxQueueItems(context, limit = 50) {
  const agentExtensionId = String(context?.account?.extensionId || "").trim();
  if (!agentExtensionId) return [];
  await bumpLastActivityAt(agentExtensionId, { source: "cx-workspace" }).catch(() => null);
  if (Date.now() - lastQueueOrderingBackfillAt > 60 * 1000) {
    lastQueueOrderingBackfillAt = Date.now();
    await backfillCxQueueOrdering(null, 1000).catch(() => null);
  }

  let activeQueueItems = await listActiveCxQueueItemsForAgent(context, agentExtensionId);
  let visibleQueueItems = activeQueueItems.filter((item) =>
    canViewQueueItemForAgent(item, context));
  const refill = await maybeRefillCxQueueForAgent(context, agentExtensionId, visibleQueueItems).catch((error) => ({
    ok: false,
    error: error.message,
  }));
  if (refill?.assigned > 0) {
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

  return servedItems
    .sort((left, right) => {
      const queueSortRank = (item) => {
        const family = String(item.queueFamily || "").trim();
        const stage = Number.isFinite(Number(item.progressiveStageIndex)) ? Number(item.progressiveStageIndex) : 99;
        const placedCalls = Number(item.placedCalls || 0) || 0;
        // Green first-contact stays first; green follow-ups still outrank blue.
        if (family === "fresh-day1") return stage <= 0 && placedCalls <= 0 ? 0 : 0.5;
        if (family === "fresh-day2to10") return 1;
        if (family === "aged") return 2;
        return 99;
      };
      const leftFamily = queueSortRank(left);
      const rightFamily = queueSortRank(right);
      if (leftFamily !== rightFamily) return leftFamily - rightFamily;

      const leftStage = Number.isFinite(Number(left.progressiveStageIndex)) ? Number(left.progressiveStageIndex) : 99;
      const rightStage = Number.isFinite(Number(right.progressiveStageIndex)) ? Number(right.progressiveStageIndex) : 99;
      if (leftStage !== rightStage) return leftStage - rightStage;

      const leftTime = left.nextActionAt ? new Date(left.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightTime = right.nextActionAt ? new Date(right.nextActionAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.caseId || "").localeCompare(String(right.caseId || ""));
    });
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
        activeDay: 2,
        currentStage: "day2to15",
        nextActionType: "cx:followup",
      };
    case "aged":
      return {
        queueFamily: "aged",
        queueTier: "later",
        activeDay: 30,
        currentStage: "aged",
        nextActionType: "cx:aged",
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
    await clearAgentCxCallState(
      context.account?.extensionId || user?.extensionId || input.assignedExtensionId || null,
      "cx-callback-eject",
      {
        uii: input.uii || input.rcxUii || queueItem?.metadata?.lastDialExecutionUii || null,
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
    return {
      ...requested,
      completed: true,
      completionWorkflowId: null,
      disposition: outcome?.disposition || "Call Back",
      queueOutcome: outcome?.queueOutcome || null,
      rescheduledFor: outcome?.rescheduledFor || null,
      callbackEjected: Boolean(outcome?.callbackEjected),
      queueItemId: outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      queueTicketId: outcome?.queueTicketId || outcome?.queueItemId || input.queueItemId || input.queueTicketId || null,
      queueEjection: outcome?.queueEjection || null,
      response: outcome,
      hangup: {
        ok: true,
        acceptedLocally: true,
        backgroundPending: true,
        reason: "callback-hangup-backgrounded",
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
      templateKey: resolvedTemplateKey,
      sendAs: input.sendAs || user.email || company.fromEmail,
    },
    reviewCategory: "cx-email",
  });

  const sendgrid = createSendgridClient(context.domain);
  const fromEmail = String(input.sendAs || user.email || company.fromEmail || company.toEmail || "").trim();
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
      templateKey: resolvedTemplateKey,
      status: "sent",
      workflowId: result.workflowId || null,
      actorEmail: actor.actorEmail,
      actorName: actor.actorName,
      metadata: {
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
  if (relayAccepted && assignedExtensionId) {
    await clearAgentCxCallState(assignedExtensionId, "cx-disposition-complete", { uii });
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
    await callLogRepository.upsertCallLog({
      domain: context.domain,
      telephonySessionId: uii,
      direction: "outbound",
      caseId: caseId != null ? Number(caseId) : null,
      phone: phone || null,
      extensionId: assignedExtensionId,
      executionOwner: "ringcentral-cx",
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
    });
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
    await clearAgentCxCallState(contextExtensionId, "cx-dial-relay-failed");
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

  return {
    ...result,
    disposition: queueOutcome?.disposition || null,
    queueOutcome: queueOutcome?.queueOutcome || null,
    rescheduledFor: queueOutcome?.rescheduledFor || null,
    statusId: queueOutcome?.statusId || null,
    statusCategory: queueOutcome?.statusCategory || null,
    settlementOfficerId: settlementOfficerId || null,
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
  buildCxWorkspace,
  executeCxLogicsCreateCase,
  executeCxSaveCaseProfileFromLogics,
  executeCxLogicsFindMatch,
  executeCxLogicsActivity,
  executeCxLogicsAmortization,
  executeCxLogicsInvoice,
  executeCxLogicsNotes,
  executeCxLogicsTask,
  executeCxLogicsUpdateCase,
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
  requestCxReminder,
  requestCxStatusChange,
  requestCxTask,
  requestCxText,
  searchCxCases,
  syncCaseProfileFromLogics,
  enqueueCxSmokeLead,
  simulateCxIncomingCall,
};
