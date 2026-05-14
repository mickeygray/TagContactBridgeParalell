"use strict";

const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");
const {
  agentStateRepository,
  cxDialQueueRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  ValidationError,
} = require("../../shared-errors/src");
const {
  deriveUcqAgeBucket,
  deriveUcqPartition,
} = require("../../shared-normalizers/src");
const {
  recordWorkflowStage,
} = require("./workflowStateService");
const {
  buildEligibility,
} = require("./cxLoadBalancerService");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
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

function resolveAgentSpecificRcxRouting(queueItem = {}, metadata = {}) {
  const assignment = queueItem?.assignment && typeof queueItem.assignment === "object"
    ? queueItem.assignment
    : {};
  const tokens = compactUnique([
    assignment.extensionId,
    assignment.agentEmail,
    assignment.email,
    assignment.agentName,
    metadata.rcxVisibilityAssignedExtensionId,
    metadata.rcxVisibilityAgentId,
    metadata.rcxVisibilityAgentUsername,
    metadata.lastDialIntent?.assignedAgentUsername,
    metadata.lastDialIntent?.assignedAgentEmail,
    metadata.lastDialIntent?.assignedAgentId,
    metadata.lastDialIntent?.dialerCxAgentId,
    metadata.lastDialIntent?.dialerEmail,
    metadata.lastDialIntent?.agent?.cxAgentId,
    metadata.lastDialIntent?.agent?.email,
    metadata.assignedAgentEmail,
    metadata.assignedAgentId,
  ]);

  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const dialGroupId = readEnvExternalId(`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`);
    const campaignId = readEnvExternalId(`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`);
    if (dialGroupId || campaignId) {
      return {
        dialGroupId,
        campaignId,
        matchedToken: String(token),
      };
    }
  }

  return null;
}

function resolveQueueItemRcxRouting(queueItem = {}) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const family = String(queueItem.queueFamily || metadata.queueFamily || "").trim().toLowerCase();
  const agentRoute = resolveAgentSpecificRcxRouting(queueItem, metadata);
  const familyCampaignId =
    family === "fresh-day1" || family === "fresh"
      ? readEnvExternalId("RINGCX_VOICE_NEW_CAMPAIGN_ID")
      : family === "fresh-day2to10"
        ? readEnvExternalId("RINGCX_VOICE_OLD_CAMPAIGN_ID")
        : family === "aged"
          ? readEnvExternalId("RINGCX_VOICE_AGED_CAMPAIGN_ID")
          : null;
  const explicitDialGroupId =
    normalizeExternalId(queueItem.rcxDialGroupId);
  const explicitCampaignId =
    normalizeExternalId(queueItem.rcxCampaignId);
  const fallbackDialGroupId = agentRoute
    ? null
    : normalizeExternalId(metadata.rcxDialGroupId)
      || normalizeExternalId(metadata.rcxVisibilityDialGroupId)
      || readEnvExternalId("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID");
  const fallbackCampaignId = agentRoute
    ? null
    : normalizeExternalId(metadata.rcxCampaignId)
      || familyCampaignId
      || normalizeExternalId(metadata.rcxVisibilityCampaignId)
      || readEnvExternalId("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID")
      || readEnvExternalId("RINGCX_VOICE_NEW_CAMPAIGN_ID");

  return {
    accountId:
      normalizeExternalId(queueItem.rcxAccountId)
      || normalizeExternalId(metadata.rcxAccountId)
      || normalizeExternalId(metadata.rcxVisibilityAccountId)
      || readEnvExternalId("RINGCX_VOICE_ACCOUNT_ID"),
    dialGroupId:
      agentRoute?.dialGroupId
      || explicitDialGroupId
      || fallbackDialGroupId,
    campaignId:
      agentRoute?.campaignId
      || explicitCampaignId
      || fallbackCampaignId,
    agentRoute,
  };
}

function normalizeUsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function splitName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return {
      firstName: "Lead",
      lastName: "Prospect",
    };
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: "Prospect",
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

// Map the existing cxDialQueue `queueFamily` → new UCQ ageBucket.
// queueFamily values are normalized by cxLoadBalancerService:
//   fresh-day1 / fresh-day2to10 / aged
// Default to day2_10 for unknown values.
function mapQueueFamilyToAgeBucket(queueFamily) {
  return deriveUcqAgeBucket({ queueFamily });
}

function isFallbackAfterFirstContactAccount(account = null) {
  const metadata = account?.metadata && typeof account.metadata === "object"
    ? account.metadata
    : {};
  const mode = String(
    metadata.cxQueueVisibilityMode
      || metadata.cxQueueMode
      || metadata.leadServingMode
      || "",
  ).trim().toLowerCase();
  return mode === "fallback_after_first_contact"
    || mode === "fallback-after-first-contact"
    || metadata.cxFallbackAfterFirstContact === true;
}

function isPostFirstContactQueueItem(queueItem = {}) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const family = String(queueItem.queueFamily || metadata.queueFamily || "").trim().toLowerCase();
  if (family === "fresh-day2to10" || family === "aged") return true;

  const stageIndex = Number(queueItem.progressiveStageIndex ?? metadata.progressiveStageIndex);
  if (Number.isFinite(stageIndex) && stageIndex > 0 && stageIndex < 99) return true;

  const stageKey = String(queueItem.progressiveStageKey || metadata.progressiveStageKey || "")
    .trim()
    .toLowerCase();
  if (["second-contact", "third-contact"].includes(stageKey)) return true;

  const placedCalls = Number(queueItem.placedCalls ?? metadata.placedCalls ?? 0);
  return Number.isFinite(placedCalls) && placedCalls > 0;
}

function canBypassQueuePolicyForFallbackDial(account = null, queueItem = {}) {
  return isFallbackAfterFirstContactAccount(account) && isPostFirstContactQueueItem(queueItem);
}

function isAgentAvailableForFallbackPublish(agentState = null) {
  const routing = agentState?.cxRouting && typeof agentState.cxRouting === "object"
    ? agentState.cxRouting
    : {};
  if (routing.enabled === false) return false;
  return String(routing.desiredAvailability || "").trim().toLowerCase() === "available";
}

function buildExternId(item = {}) {
  const domain = normalizeDomain(item.domain || "TAG");
  const caseId = Number(item.caseId || 0) || 0;
  const queueItemId = item._id ? String(item._id) : "";
  if (queueItemId) return `parallel:${domain}:${caseId}:${queueItemId}`;
  return `parallel:${domain}:${caseId}`;
}

function summarizeLoadResponse(response) {
  if (!response || typeof response !== "object") {
    return { ok: false };
  }

  return {
    ok: true,
    count:
      Number(response.count)
      || Number(response.loadedCount)
      || Number(response.successCount)
      || Number(response.leadsInserted)
      || Number(response.leadsAccepted)
      || null,
    leadsSupplied: Number(response.leadsSupplied) || null,
    leadsConverted: Number(response.leadsConverted) || null,
    leadsAccepted: Number(response.leadsAccepted) || null,
    leadsInserted: Number(response.leadsInserted) || null,
    deletedCount: Number(response.deletedCount) || null,
    failedAgentAssignment: Number(response.failedAgentAssignment) || null,
    rejectedRowCount: Array.isArray(response.rejectedRows) ? response.rejectedRows.length : null,
    listId: response.listId != null ? String(response.listId) : null,
    listName: response.listName != null ? String(response.listName) : null,
    message: response.message || response.status || null,
    processingResult: response.processingResult || null,
    processingStatus: response.processingStatus || null,
  };
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function compactUnique(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeUsername(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function coerceList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.content)) return value.content;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function readAgentId(agent = {}) {
  return String(agent.agentId || agent.id || "").trim();
}

function readAgentGroupId(agent = {}) {
  return String(
    agent.groupId
      || agent.agentGroup?.id
      || agent.agentGroupId
      || agent.group?.id
      || "",
  ).trim();
}

function isUserManagedRingcxSeat(agent = {}, accountId = null) {
  const username = normalizeUsername(agent.username);
  if (!username) return false;
  if (agent.userManagedByRC === true) return true;
  if (accountId && username.includes(`+${String(accountId).trim()}_`)) return true;
  return /\+\d+_\d+@/.test(username);
}

function summarizeRingcxAgent(agent = null) {
  if (!agent || typeof agent !== "object") return null;
  return {
    agentId: readAgentId(agent) || null,
    username: normalizeUsername(agent.username) || null,
    groupId: readAgentGroupId(agent) || null,
    rcUserId: String(agent.rcUserId || "").trim() || null,
    userManagedByRC: agent.userManagedByRC === true,
  };
}

async function listAgentsForUsernameResolution(client) {
  const defaultGroupId = String(
    client?.config?.defaultAgentGroupId || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID || "",
  ).trim();
  const groupIds = [];
  if (defaultGroupId) groupIds.push(defaultGroupId);

  if (client && typeof client.listAgentGroups === "function") {
    try {
      const groups = coerceList(await client.listAgentGroups());
      for (const group of groups) {
        const groupId = String(group.agentGroupId || group.id || group.groupId || "").trim();
        if (groupId && !groupIds.includes(groupId)) groupIds.push(groupId);
      }
    } catch {
      // Fall back to the configured default group below.
    }
  }

  const agents = [];
  for (const groupId of groupIds) {
    try {
      const groupAgents = coerceList(await client.listAgents(groupId));
      for (const agent of groupAgents) {
        agents.push({
          ...agent,
          groupId: readAgentGroupId(agent) || groupId,
        });
      }
    } catch {
      // Keep searching other groups; a missing/locked group should not block dialing.
    }
  }
  return agents;
}

async function resolveAgentUsername(queueItem = {}, client) {
  const identity = await resolveAgentIdentity(queueItem, client);
  return identity?.username || null;
}

async function resolveAgentIdentity(queueItem = {}, client) {
  const extensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (!extensionId) return null;

  const account = await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null);
  const preferredUsernames = compactUnique([
    account?.metadata?.ringcxUsername,
    account?.metadata?.ringcxAgentUsername,
    account?.metadata?.cxUsername,
    account?.cxSession?.rcxAgentEmail,
  ]);
  const candidateUsernames = compactUnique([
    ...preferredUsernames,
    queueItem?.metadata?.rcxVisibilityAgentUsername,
    queueItem?.metadata?.lastDialIntent?.assignedAgentEmail,
    queueItem?.metadata?.assignedAgentEmail,
    account?.email,
  ]);

  try {
    const agents = await listAgentsForUsernameResolution(client);
    const configuredAccountId = client?.config?.accountId || process.env.RINGCX_VOICE_ACCOUNT_ID || null;
    const sameRcUserAgents = agents.filter((agent) => (
      String(agent?.rcUserId || "").trim() === extensionId
    ));
    const preferredMatch = agents.find((agent) => (
      preferredUsernames.includes(normalizeUsername(agent.username))
    ));
    if (preferredMatch?.username) return summarizeRingcxAgent(preferredMatch);

    const userManagedMatch = sameRcUserAgents.find((agent) => (
      isUserManagedRingcxSeat(agent, configuredAccountId)
    ));
    if (userManagedMatch?.username) return summarizeRingcxAgent(userManagedMatch);

    const storedAgentIds = compactUnique([
      account?.metadata?.ringcxAgentId,
      account?.cxAgentId,
    ]);
    const storedAgentMatch = storedAgentIds
      .map((storedAgentId) => sameRcUserAgents.find((agent) => readAgentId(agent) === storedAgentId))
      .find(Boolean);
    if (storedAgentMatch?.username) return summarizeRingcxAgent(storedAgentMatch);

    const exactCandidateMatch = agents.find((agent) => (
      candidateUsernames.includes(normalizeUsername(agent.username))
    ));
    if (exactCandidateMatch?.username) return summarizeRingcxAgent(exactCandidateMatch);

    const sameRcUserMatch = sameRcUserAgents[0];
    if (sameRcUserMatch?.username) return summarizeRingcxAgent(sameRcUserMatch);
  } catch {
    // If discovery fails, use the best local hint instead of dropping assignment.
  }

  return {
    agentId: String(account?.metadata?.ringcxAgentId || account?.cxAgentId || "").trim() || null,
    username: candidateUsernames[0] || null,
    groupId: null,
    rcUserId: extensionId,
    userManagedByRC: false,
  };
}

function parseReservationParamMapOverride() {
  const raw = String(process.env.RINGCX_AGENT_RESERVATION_PARAM_MAP_JSON || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function resolveReservationCallbackDts() {
  const explicit = String(process.env.RINGCX_AGENT_RESERVATION_CALLBACK_DTS || "").trim();
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const delayMs = Number(process.env.RINGCX_AGENT_RESERVATION_CALLBACK_DELAY_MS);
  const safeDelayMs = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  return new Date(Date.now() + safeDelayMs).toISOString();
}

function buildAgentReservationParamMap(agentIdentity = {}, queueItem = {}) {
  const override = parseReservationParamMapOverride();
  if (override) {
    const expanded = {};
    for (const [key, value] of Object.entries(override)) {
      expanded[key] = String(value || "")
        .replaceAll("{agentId}", agentIdentity.agentId || "")
        .replaceAll("{agentUsername}", agentIdentity.username || "")
        .replaceAll("{agentEmail}", agentIdentity.username || "")
        .replaceAll("{agentGroupId}", agentIdentity.groupId || "")
        .replaceAll("{rcUserId}", agentIdentity.rcUserId || "")
        .replaceAll("{extensionId}", String(queueItem.assignment?.extensionId || "").trim())
        .replaceAll("{caseId}", String(queueItem.caseId || ""))
        .replaceAll("{callbackDts}", resolveReservationCallbackDts());
    }
    return expanded;
  }

  // RingCX documents AGENT_RESERVATION as an agent-specific callback
  // action. Runtime validation confirms these required paramMap keys:
  //   RESERVATION_AGENT_ID, CALLBACK_DTS.
  // Keep legacy alias fields for observability/debugging, but the two
  // fields above are the ones RingCX accepts.
  return {
    RESERVATION_AGENT_ID: agentIdentity.agentId || "",
    CALLBACK_DTS: resolveReservationCallbackDts(),
    AGENT_ID: agentIdentity.agentId || "",
    AGENT_USERNAME: agentIdentity.username || "",
    AGENT_EMAIL: agentIdentity.username || "",
    USERNAME: agentIdentity.username || "",
    RC_USER_ID: agentIdentity.rcUserId || "",
    EXTENSION_ID: String(queueItem.assignment?.extensionId || "").trim(),
    AGENT_GROUP_ID: agentIdentity.groupId || "",
    RESERVED_AGENT_ID: agentIdentity.agentId || "",
    RESERVED_AGENT_USERNAME: agentIdentity.username || "",
    RESERVED_AGENT_EMAIL: agentIdentity.username || "",
  };
}

async function reservePublishedLeadForAgent({
  client,
  queueItem,
  campaignId,
  externId,
  agentIdentity,
} = {}) {
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;
  if (!queueItemId) {
    return { ok: true, reserved: false, skipped: true, reason: "queue-item-not-found" };
  }
  if (!campaignId || !externId) {
    return { ok: true, reserved: false, skipped: true, reason: "missing-campaign-or-extern-id" };
  }
  if (!agentIdentity?.agentId && !agentIdentity?.username) {
    return { ok: true, reserved: false, skipped: true, reason: "missing-agent-identity" };
  }

  const paramMap = buildAgentReservationParamMap(agentIdentity, queueItem);
  const request = {
    campaignLeadSearchCriteria: {
      campaignId,
      campaignIds: [campaignId],
      externIds: [externId],
    },
    leadActionParams: {
      paramMap,
    },
  };
  const now = new Date();

  try {
    const response = await client.leadAction("AGENT_RESERVATION", request);
    const summary = summarizeLoadResponse(response);
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxAgentReservationStatus": "reserved",
      "metadata.rcxAgentReservationAt": now,
      "metadata.rcxAgentReservationAgentId": agentIdentity.agentId || null,
      "metadata.rcxAgentReservationAgentUsername": agentIdentity.username || null,
      "metadata.rcxAgentReservationAgentGroupId": agentIdentity.groupId || null,
      "metadata.rcxAgentReservationRequest": request,
      "metadata.rcxAgentReservationResponse": summary,
      "metadata.rcxAgentReservationError": null,
    });
    return {
      ok: true,
      reserved: true,
      queueItemId,
      campaignId,
      externId,
      agentIdentity,
      response: summary,
    };
  } catch (error) {
    const serialized = {
      message: error.message || "ringcx-agent-reservation-failed",
      status: error.status || null,
      retryable: Boolean(error.retryable),
      details: error.details || null,
    };
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxAgentReservationStatus": "error",
      "metadata.rcxAgentReservationAt": now,
      "metadata.rcxAgentReservationAgentId": agentIdentity.agentId || null,
      "metadata.rcxAgentReservationAgentUsername": agentIdentity.username || null,
      "metadata.rcxAgentReservationAgentGroupId": agentIdentity.groupId || null,
      "metadata.rcxAgentReservationRequest": request,
      "metadata.rcxAgentReservationError": serialized,
    });
    return {
      ok: false,
      reserved: false,
      queueItemId,
      campaignId,
      externId,
      agentIdentity,
      error: serialized.message,
      details: serialized.details,
      retryable: serialized.retryable,
    };
  }
}

function buildLeadLoaderPayload(queueItem = {}, externId, options = {}) {
  const phone = normalizeUsPhone(queueItem.phone);
  if (!phone) {
    throw new ValidationError("CX queue item does not have a dialable phone number");
  }

  const { firstName, lastName } = splitName(queueItem.name);
  const pendingAgentIdEnabled = parseBooleanFlag(
    process.env.RINGCX_PENDING_AGENT_ID_ON_LOAD_ENABLED,
    false,
  );
  const pendingAgentId = Number(options.agentIdentity?.agentId || 0);
  const pendingAgentPatch =
    pendingAgentIdEnabled && Number.isFinite(pendingAgentId) && pendingAgentId > 0
      ? { pendingAgentId }
      : {};

  return {
    description: `Parallel ${queueItem.queueFamily || "fresh-day1"} / case ${queueItem.caseId}`,
    dialPriority: "IMMEDIATE",
    duplicateHandling: "REMOVE_FROM_LIST",
    listState: "ACTIVE",
    timeZoneOption: "NPA_NXX",
    phoneNumbersI18nEnabled: false,
    internationalNumberFormat: false,
    uploadLeads: [
      {
        externId,
        leadPhone: phone,
        firstName,
        lastName,
        ...pendingAgentPatch,
        email: queueItem.metadata?.email || undefined,
        extendedLeadData: {
          source: "parallel-cx-serving",
          domain: normalizeDomain(queueItem.domain),
          caseId: Number(queueItem.caseId || 0) || null,
          queueItemId: queueItem._id ? String(queueItem._id) : null,
          queueFamily: queueItem.queueFamily || null,
          progressiveStageKey: queueItem.progressiveStageKey || null,
          assignedExtensionId: queueItem.assignment?.extensionId || null,
          assignedAgentName: queueItem.assignment?.agentName || null,
          assignedAgentEmail: options.agentUsername || null,
          assignedAgentId: options.agentIdentity?.agentId || null,
          assignedAgentUsername: options.agentIdentity?.username || options.agentUsername || null,
          assignedAgentGroupId: options.agentIdentity?.groupId || null,
          assignedRcUserId: options.agentIdentity?.rcUserId || queueItem.assignment?.extensionId || null,
          dialerEmail: options.agentUsername || null,
        },
      },
    ],
    dncTags: [],
  };
}

function isRecentlyPublished(queueItem = {}, campaignId, assignedExtensionId) {
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const status = String(metadata.rcxVisibilityStatus || "").trim().toLowerCase();
  const syncedCampaignId = normalizeExternalId(metadata.rcxVisibilityCampaignId);
  const syncedExtensionId = String(metadata.rcxVisibilityAssignedExtensionId || "").trim();
  const syncedAt = metadata.rcxVisibilitySyncedAt ? new Date(metadata.rcxVisibilitySyncedAt) : null;
  if (status !== "published") return false;
  if (syncedCampaignId !== normalizeExternalId(campaignId)) return false;
  if (syncedExtensionId !== String(assignedExtensionId || "").trim()) return false;
  if (!syncedAt || Number.isNaN(syncedAt.getTime())) return false;
  return Date.now() - syncedAt.getTime() < 60_000;
}

async function stampQueueItemSync(queueItemId, patch = {}) {
  if (!queueItemId) return null;
  return cxDialQueueRepository.updateQueueItem(queueItemId, patch).catch(() => null);
}

async function cancelPublishedQueueItemInRingcx(itemOrId, options = {}) {
  const item = typeof itemOrId === "string"
    ? await cxDialQueueRepository.findQueueItemById(itemOrId)
    : itemOrId;
  const queueItem = item?.toObject ? item.toObject() : item;
  if (!queueItem?._id) {
    return { ok: true, cancelled: false, skipped: true, reason: "queue-item-not-found" };
  }

  const metadata = queueItem.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const queueItemId = String(queueItem._id);
  const campaignId = normalizeExternalId(
    options.campaignId
      || metadata.rcxVisibilityCampaignId
      || metadata.lastDialExecutionCampaignId
      || queueItem.rcxCampaignId
      || "",
  );
  const externId = normalizeExternalId(
    options.externId
      || metadata.rcxVisibilityExternId
      || metadata.lastDialExecutionExternId
      || buildExternId(queueItem)
      || "",
  );
  if (!campaignId || !externId) {
    return {
      ok: true,
      cancelled: false,
      skipped: true,
      reason: "missing-campaign-or-extern-id",
      queueItemId,
      campaignId,
      externId,
    };
  }

  const now = new Date();
  try {
    const client = createRingcxVoiceClient();
    const response = await client.leadAction("CANCEL_LEADS", {
      campaignLeadSearchCriteria: {
        campaignId,
        campaignIds: [campaignId],
        externIds: [externId],
      },
    });
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityStatus": "stale-cancelled",
      "metadata.rcxVisibilityReason": options.reason || "parallel-queue-release",
      "metadata.rcxVisibilityCancelledAt": now,
      "metadata.rcxVisibilityCancelResponse": response || null,
      "metadata.rcxVisibilityCancelError": null,
    });
    return {
      ok: true,
      cancelled: true,
      queueItemId,
      campaignId,
      externId,
      response,
    };
  } catch (error) {
    const serialized = {
      message: error.message || "ringcx-cancel-lead-failed",
      status: error.status || null,
      retryable: Boolean(error.retryable),
      details: error.details || null,
    };
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityCancelAttemptAt": now,
      "metadata.rcxVisibilityCancelError": serialized,
    });
    return {
      ok: false,
      cancelled: false,
      queueItemId,
      campaignId,
      externId,
      error: serialized.message,
      details: serialized.details,
      retryable: serialized.retryable,
    };
  }
}

// PACING_QUEUE_ENABLED — when true, the new Universal Call Queue is
// the source of truth and we no longer push leads into RingCX. Lead
// becomes a QueueItem in Mongo; agents click-to-dial via DialService.
// When false (default), the legacy RingCX push path runs.
function isPacingQueueEnabled() {
  return String(process.env.PACING_QUEUE_ENABLED || "").toLowerCase() === "true";
}

// Lazy require to avoid circular module deps at load time.
function getEnqueueLead() {
  // eslint-disable-next-line global-require
  return require("./universalQueueService").enqueueLead;
}

async function publishQueueItemToRingcx(options = {}) {
  const item = options.item
    || (options.queueItemId
      ? await cxDialQueueRepository.findQueueItemById(options.queueItemId)
      : null);
  const queueItem = item?.toObject ? item.toObject() : item;

  // ── New path: enqueue into UCQ instead of pushing to RingCX ────
  if (isPacingQueueEnabled() && queueItem?._id) {
    const enqueueLead = getEnqueueLead();
    const ageBucket = deriveUcqAgeBucket(queueItem);
    const leadPayload = {
      leadId: String(queueItem.caseId || queueItem._id),
      phoneNumber: queueItem.phoneNumber || queueItem.phone || "",
      domain: queueItem.domain || "TAG",
      partition: queueItem.partition || deriveUcqPartition(ageBucket),
      ageBucket,
      cadenceDueAt: queueItem.releaseAt || null,
      sourceCadenceTaskId: String(queueItem._id),
      sourceLogicsCaseId: queueItem.caseId ? String(queueItem.caseId) : null,
    };
    const result = await enqueueLead(leadPayload);
    await stampQueueItemSync(String(queueItem._id), {
      "metadata.rcxVisibilityStatus": "ucq-enqueued",
      "metadata.rcxVisibilityReason": result.skipped ? result.reason : "enqueued",
      "metadata.rcxVisibilitySyncedAt": new Date(),
    });
    return {
      ok: true,
      published: false,
      ucqEnqueued: !result.skipped,
      reason: result.skipped ? result.reason : "ucq-enqueued",
      queueItemId: String(queueItem._id),
    };
  }

  if (!queueItem?._id) {
    return {
      ok: true,
      published: false,
      skipped: true,
      reason: "queue-item-not-found",
    };
  }

  const queueItemId = String(queueItem._id);
  const metadata = queueItem.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const routing = resolveQueueItemRcxRouting(queueItem);
  const campaignId = routing.campaignId;
  const dialGroupId = routing.dialGroupId;
  const accountId = routing.accountId;
  const assignedExtensionId = String(queueItem.assignment?.extensionId || "").trim();

  if (!campaignId) {
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityStatus": "skipped",
      "metadata.rcxVisibilityReason": "missing-campaign-id",
      "metadata.rcxVisibilitySyncedAt": new Date(),
    });
    return {
      ok: true,
      published: false,
      skipped: true,
      reason: "missing-campaign-id",
      queueItemId,
    };
  }

  const allowedStates = Array.isArray(options.allowedStates) && options.allowedStates.length > 0
    ? options.allowedStates.map((state) => String(state || "").trim().toLowerCase()).filter(Boolean)
    : ["claimed"];
  const queueState = String(queueItem.state || "").trim().toLowerCase();
  if (!allowedStates.includes(queueState)) {
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityStatus": "skipped",
      "metadata.rcxVisibilityReason": `queue-item-bad-state:${queueState || "unknown"}`,
      "metadata.rcxVisibilitySyncedAt": new Date(),
    });
    return {
      ok: true,
      published: false,
      skipped: true,
      reason: `queue-item-bad-state:${queueState || "unknown"}`,
      queueItemId,
      state: queueItem.state || null,
      allowedStates,
    };
  }

  // ── EX-wins gate ──────────────────────────────────────────────
  // Before pushing this lead into RingCX, check the assigned
  // agent's cxRouting.desiredAvailability. If they're "unavailable"
  // (e.g., because their RC EX line is in CallConnected/Ringing/OnHold)
  // we DEFER the push. The presence-bridge will trigger a re-attempt
  // once cxRouting flips back to "available."
  //
  // No call to RingCX is made; the queue item stays "claimed" so
  // the next sweep picks it up. We stamp the deferral reason on the
  // queue item for observability.
  if (assignedExtensionId && options.respectPresenceGate !== false) {
    try {
      const agentState = await agentStateRepository.findAgentStateByExtensionId(assignedExtensionId);
      const userAccount = assignedExtensionId
        ? await userAccountRepository.findUserAccountByExtensionId(assignedExtensionId).catch(() => null)
        : null;
      const enrichedAgentState = agentState
        ? {
          ...agentState,
          email: agentState.email || userAccount?.email || null,
          userEmail: agentState.userEmail || userAccount?.email || null,
          accountEmail: agentState.accountEmail || userAccount?.email || null,
          userAccount: userAccount
            ? {
              email: userAccount.email || null,
              role: userAccount.role || null,
              audience: userAccount.audience || null,
              status: userAccount.status || null,
              cxQueuePolicy: userAccount.cxQueuePolicy || null,
            }
            : null,
          cxQueuePolicy: agentState.cxQueuePolicy || userAccount?.cxQueuePolicy || null,
          cxQueuePolicyExplicit: Boolean(agentState.cxQueuePolicy?.tier || userAccount?.cxQueuePolicy?.tier),
        }
        : null;
      const eligibility = buildEligibility(enrichedAgentState, {
        queueFamily: queueItem.queueFamily || metadata.queueFamily || null,
        openAssignments: 0,
        maxOpenAssignments: 999999,
      });
      if (!eligibility.eligible) {
        const reason = String(eligibility.reason || "unknown").trim().toLowerCase();
        const canPublishFallbackDial = reason.startsWith("queue-policy")
          && canBypassQueuePolicyForFallbackDial(userAccount, queueItem)
          && isAgentAvailableForFallbackPublish(agentState);
        if (canPublishFallbackDial) {
          await stampQueueItemSync(queueItemId, {
            "metadata.rcxVisibilityFallbackPolicyBypassAt": new Date(),
            "metadata.rcxVisibilityFallbackPolicyBypassReason": eligibility.reason || "queue-policy",
          });
        } else {
          await stampQueueItemSync(queueItemId, {
            "metadata.rcxVisibilityStatus": "deferred",
            "metadata.rcxVisibilityReason": `agent-ineligible:${eligibility.reason || "unknown"}`,
            "metadata.rcxVisibilitySyncedAt": new Date(),
          });
          return {
            ok: true,
            published: false,
            deferred: true,
            reason: `agent-ineligible:${eligibility.reason || "unknown"}`,
            queueItemId,
            extensionId: assignedExtensionId,
            eligibility,
          };
        }
      }
    } catch (error) {
      // Don't fail the publish on a presence-lookup error — log it
      // and proceed. The agent might still be reachable; worst case
      // RingCX delivers the call to a busy agent and we get a
      // no-answer disposition (acceptable per the EX-wins rule).
      // The error is non-fatal so we annotate but don't return.
      await stampQueueItemSync(queueItemId, {
        "metadata.rcxVisibilityPresenceCheckError": String(error?.message || error),
      });
    }
  }

  if (!options.force && isRecentlyPublished(queueItem, campaignId, assignedExtensionId)) {
    return {
      ok: true,
      published: true,
      reused: true,
      queueItemId,
      campaignId,
      dialGroupId,
      accountId,
      agentRoute: routing.agentRoute || null,
      assignedExtensionId: assignedExtensionId || null,
      externId: buildExternId(queueItem),
    };
  }

  const client = createRingcxVoiceClient();
  const agentIdentity = await resolveAgentIdentity(queueItem, client);
  const agentUsername = agentIdentity?.username || null;
  const externId = buildExternId(queueItem);
  const loadPayload = buildLeadLoaderPayload(queueItem, externId, { agentUsername, agentIdentity });

  try {
    const response = await client.loadLeads(campaignId, loadPayload);
    const now = new Date();
    const summary = summarizeLoadResponse(response);
    const reservationEnabled =
      parseBooleanFlag(process.env.RINGCX_AGENT_RESERVATION_ENABLED, false);
    const reservationRequired =
      parseBooleanFlag(process.env.RINGCX_AGENT_RESERVATION_REQUIRED, false);
    const reservation = reservationEnabled
      ? await reservePublishedLeadForAgent({
        client,
        queueItem,
        campaignId,
        externId,
        agentIdentity,
      })
      : {
        ok: true,
        reserved: false,
        skipped: true,
        reason: "agent-reservation-disabled",
      };
    if (reservationRequired && !reservation.reserved) {
      const error = new Error(
        reservation.error
          ? `ringcx-agent-reservation-failed:${reservation.error}`
          : `ringcx-agent-reservation-not-applied:${reservation.reason || "unknown"}`,
      );
      error.details = reservation;
      error.retryable = Boolean(reservation.retryable);
      throw error;
    }

    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityStatus": "published",
      "metadata.rcxVisibilityReason": null,
      "metadata.rcxVisibilitySyncedAt": now,
      "metadata.rcxVisibilityCampaignId": campaignId,
      "metadata.rcxVisibilityDialGroupId": dialGroupId,
      "metadata.rcxVisibilityAccountId": accountId,
      "metadata.rcxVisibilityAssignedExtensionId": assignedExtensionId || null,
      "metadata.rcxVisibilityAgentUsername": agentUsername,
      "metadata.rcxVisibilityAgentId": agentIdentity?.agentId || null,
      "metadata.rcxVisibilityAgentGroupId": agentIdentity?.groupId || null,
      "metadata.rcxVisibilityRouteMatchedToken": routing.agentRoute?.matchedToken || null,
      "metadata.rcxVisibilityExternId": externId,
      "metadata.rcxVisibilityLoadSummary": summary,
      "metadata.rcxVisibilityLastError": null,
      "metadata.rcxVisibilityReservation": reservation,
      "metadata.lastRingcxPublishedAt": now,
      "metadata.lastRingcxPublishedCampaignId": campaignId,
      "metadata.lastRingcxPublishedDialGroupId": dialGroupId,
      "metadata.lastRingcxPublishedAccountId": accountId,
      "metadata.lastRingcxPublishedExternId": externId,
      "metadata.lastRingcxPublishedRoute": {
        campaignId,
        dialGroupId,
        accountId,
        externId,
        assignedExtensionId: assignedExtensionId || null,
        agentUsername,
        agentId: agentIdentity?.agentId || null,
        routeMatchedToken: routing.agentRoute?.matchedToken || null,
      },
    });

    await recordWorkflowStage({
      domain: queueItem.domain,
      family: "cx",
      subtype: "rcx-visibility",
      stage: "published",
      aggregateType: "cx-dial-queue",
      aggregateId: queueItemId,
      caseId: Number(queueItem.caseId || 0) || null,
      sourceService: "ringcentral-cx",
      summary: `Published case ${queueItem.caseId} to RingCX campaign ${campaignId}`,
      payload: {
        campaignId,
        dialGroupId,
        accountId,
        externId,
        assignedExtensionId: assignedExtensionId || null,
        agentUsername,
        agentIdentity,
        loadSummary: summary,
        reservation,
      },
    }).catch(() => null);

    return {
      ok: true,
      published: true,
      queueItemId,
      campaignId,
      dialGroupId,
      accountId,
      assignedExtensionId: assignedExtensionId || null,
      agentUsername,
      agentIdentity,
      externId,
      loadSummary: summary,
      reservation,
    };
  } catch (error) {
    const now = new Date();
    await stampQueueItemSync(queueItemId, {
      "metadata.rcxVisibilityStatus": "error",
      "metadata.rcxVisibilityReason": error.message || "ringcx-load-failed",
      "metadata.rcxVisibilitySyncedAt": now,
      "metadata.rcxVisibilityCampaignId": campaignId,
      "metadata.rcxVisibilityDialGroupId": dialGroupId,
      "metadata.rcxVisibilityAccountId": accountId,
      "metadata.rcxVisibilityAssignedExtensionId": assignedExtensionId || null,
      "metadata.rcxVisibilityAgentUsername": agentUsername,
      "metadata.rcxVisibilityExternId": externId,
      "metadata.rcxVisibilityLastError": {
        message: error.message || "RingCX load failed",
        status: error.status || null,
        retryable: Boolean(error.retryable),
        details: error.details || null,
        happenedAt: now.toISOString(),
      },
    });

    await recordWorkflowStage({
      domain: queueItem.domain,
      family: "cx",
      subtype: "rcx-visibility",
      stage: "error",
      aggregateType: "cx-dial-queue",
      aggregateId: queueItemId,
      caseId: Number(queueItem.caseId || 0) || null,
      sourceService: "ringcentral-cx",
      summary: `Failed to publish case ${queueItem.caseId} to RingCX campaign ${campaignId}`,
      payload: {
        campaignId,
        dialGroupId,
        accountId,
        externId,
        assignedExtensionId: assignedExtensionId || null,
        agentUsername,
        error: error.message || "RingCX load failed",
        details: error.details || null,
      },
    }).catch(() => null);

    return {
      ok: false,
      published: false,
      queueItemId,
      campaignId,
      dialGroupId,
      accountId,
      assignedExtensionId: assignedExtensionId || null,
      agentUsername,
      externId,
      error: error.message || "RingCX load failed",
      details: error.details || null,
      retryable: Boolean(error.retryable),
    };
  }
}

module.exports = {
  cancelPublishedQueueItemInRingcx,
  publishQueueItemToRingcx,
};
