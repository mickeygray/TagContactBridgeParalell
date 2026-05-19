"use strict";

const express = require("express");
const {
  agentStateRepository,
  userAccountRepository,
} = require("../../../../packages/shared-repositories/src");
const {
  decorateAccountRecord,
  HARDENED_USERS,
  SEED_ADMINS,
} = require("../../../../packages/shared-data/src/accounts");
const {
  syncUsersFromRcExtensions,
  getOrComputeAgentCallStats,
  listCxPlacedCallsToday,
} = require("../../../../packages/shared-services/src");
const { touchCxWorkspacePresence } = require("../../../../packages/shared-services/src");
const { releaseAssignedCxQueueForAgent } = require("../../../../packages/shared-services/src/cxCadenceService");
const {
  deriveFreshLeadGate,
} = require("../../../../packages/shared-services/src/agentAvailabilityService");
const { createRingCentralClient, createRingcxVoiceClient } = require("../../../../packages/shared-integrations/src");
const { findExShellsForEmail } = require("../../../../packages/shared-data/src/exShellDirectory");
const { findLogicsAgentByEmail } = require("../../../../packages/shared-data/src/logicsAgents");
const {
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_ROLES,
  isKnownRole,
  effectivePermissionsFor,
  normalizePermissionList,
} = require("../../../../packages/shared-auth/src");
const cxTokenStorageService = require("../../../../packages/shared-services/src/cxTokenStorageService");
const cxOAuthService = require("../../../../packages/shared-services/src/cxOAuthService");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const SEED_ADMIN_EMAILS = new Set(SEED_ADMINS.map((seed) => seed.email.toLowerCase()));
const HARDENED_USER_RULES = new Map(
  HARDENED_USERS.map((seed) => [seed.email.toLowerCase(), seed]),
);
const HARDENED_USER_EMAILS = new Set(HARDENED_USER_RULES.keys());
const HARDENED_ACCOUNT_EMAILS = new Set([
  ...SEED_ADMIN_EMAILS,
  ...HARDENED_USER_EMAILS,
]);

function decorate(record) {
  if (!record) return null;
  return {
    ...decorateAccountRecord(record),
    isSeed: SEED_ADMIN_EMAILS.has(String(record.email).toLowerCase()),
    isHardened: HARDENED_ACCOUNT_EMAILS.has(String(record.email).toLowerCase()),
  };
}

function isRecentDate(value, maxAgeMs) {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp <= maxAgeMs;
}

function deriveCxLiveState(agentState) {
  if (!agentState) return null;
  const routing = agentState.cxRouting && typeof agentState.cxRouting === "object"
    ? agentState.cxRouting
    : {};
  const appPresence = agentState.appPresence && typeof agentState.appPresence === "object"
    ? agentState.appPresence
    : {};
  const assignmentStats = routing.assignmentStats && typeof routing.assignmentStats === "object"
    ? routing.assignmentStats
    : {};
  const freshLeadGate = deriveFreshLeadGate(agentState, routing);
  const activityState = String(agentState.activityState || agentState.status || "").trim();
  const hasCurrentCall = Boolean(
    agentState.currentCall?.sessionId
      || agentState.currentCall?.telephonySessionId
      || agentState.currentCall?.from
      || agentState.currentCall?.to,
  );
  const workspaceFresh = Boolean(
    freshLeadGate.workspaceActive
      || appPresence.cxWorkspaceActive
      && isRecentDate(appPresence.lastSeenAt || appPresence.updatedAt, 2 * 60 * 1000),
  );
  const routingEnabled = routing.enabled !== false;
  const desiredAvailability = String(
    routing.desiredAvailability || (routingEnabled ? "available" : "unavailable"),
  ).trim().toLowerCase();
  const availableForCx = desiredAvailability === "available";
  const activePlatform = String(agentState.activePlatform || "").trim().toUpperCase();
  const activityKey = activityState.toLowerCase();
  const dialing = hasCurrentCall || ["dialing", "oncall"].includes(activityKey);
  const wrappingUp = ["dispositioning", "wrapup"].includes(activityKey);
  const serving = Boolean(freshLeadGate.allowed && workspaceFresh && routingEnabled && availableForCx);

  return {
    workspaceActive: Boolean(appPresence.cxWorkspaceActive),
    workspaceFresh,
    workspaceLastSeenAt: appPresence.lastSeenAt || null,
    workspaceUserEmail: appPresence.userEmail || null,
    routingEnabled,
    desiredAvailability: routing.desiredAvailability || null,
    serving,
    dialing,
    wrappingUp,
    activityState: agentState.activityState || null,
    activePlatform: agentState.activePlatform || null,
    openAssignments: Number(assignmentStats.openAssignments || 0) || 0,
    totalAssignedToday: Number(assignmentStats.totalAssigned || 0) || 0,
    lastAssignedAt: assignmentStats.lastAssignedAt || null,
    lastAssignedQueueFamily: assignmentStats.lastAssignedQueueFamily || null,
  };
}

function summarizeAgentState(agentState) {
  if (!agentState) return null;
  return {
    status: agentState.status || null,
    activityState: agentState.activityState || null,
    exPresenceStatus: agentState.exPresenceStatus || null,
    exTelephonyStatus: agentState.exTelephonyStatus || null,
    cxQueuePolicy: agentState.cxQueuePolicy || null,
    cxQueuePolicyExplicit: Boolean(agentState.cxQueuePolicyExplicit),
    cxRouting: agentState.cxRouting || null,
    cxLive: deriveCxLiveState(agentState),
    freshLeadGate: deriveFreshLeadGate(agentState, agentState.cxRouting || null),
    currentCall: agentState.currentCall || null,
    lastStatusChange: agentState.lastStatusChange || null,
    lastActivityAt: agentState.lastActivityAt || null,
    lastEventReceived: agentState.lastEventReceived || null,
    dailyStats: agentState.dailyStats || null,
    activePlatform: agentState.activePlatform || null,
    appPresence: agentState.appPresence || null,
  };
}

function attachAgentState(record, agentStateByExtensionId) {
  const decorated = decorate(record);
  if (!decorated) return null;
  const extensionId = String(record.extensionId || "").trim();
  return {
    ...decorated,
    agentState: extensionId
      ? summarizeAgentState(agentStateByExtensionId.get(extensionId) || null)
      : null,
  };
}

// Admin-writable subset of `logicsAuth`. Hashes and the activation/rotation
// timestamps are system-managed — they update as a side-effect of the
// rotate flow, never directly via the admin PUT. Exposed here: the knobs
// an admin needs to grant, revoke, or scope per-agent Logics access.
const LOGICS_AUTH_WRITABLE = new Set([
  "credentialMode",
  "credentialStatus",
  "scopes",
  "permissionsLabel",
  "externalSecretRef",
]);

function sanitizeLogicsAuth(input) {
  if (input == null || typeof input !== "object") return undefined;
  const out = {};
  for (const key of Object.keys(input)) {
    if (LOGICS_AUTH_WRITABLE.has(key)) out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizePatch(body = {}) {
  const patch = {};
  const fields = [
    "name",
    "role",
    "audience",
    "workspace",
    "stationLabel",
    "company",
    "extensionId",
    "extensionNumber",
    "cxAgentId",
    "phone",
    "cxQueuePolicy",
    "exShells",
    "status",
    "metadata",
    "logicsUserId",
    "logicsDisplayName",
    "tagLogicsId",
    "tagSOId",
    "tagEmail",
    "tagLogicsName",
    "tagLogicsRoles",
    "wynnLogicsId",
    "wynnSOId",
    "wynnEmail",
    "wynnLogicsName",
    "wynnLogicsRoles",
  ];
  for (const key of fields) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (body.logicsAuth !== undefined) {
    const safe = sanitizeLogicsAuth(body.logicsAuth);
    if (safe) patch.logicsAuth = safe;
  }
  return patch;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLookupToken(value) {
  return String(value || "").trim().toLowerCase();
}

function compactObject(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function coerceList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["records", "items", "data", "agents", "content"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function bestRcExtensionName(extension = {}) {
  const first = String(extension?.contact?.firstName || "").trim();
  const last = String(extension?.contact?.lastName || "").trim();
  const full = `${first} ${last}`.trim();
  return full || String(extension?.name || "").trim() || null;
}

function deriveCompanyFromEmail(email) {
  const domain = normalizeEmail(email).split("@")[1] || "";
  if (domain === "wynntaxsolutions.com") return "WYNN";
  if (domain === "taxadvocategroup.com") return "TAG";
  return null;
}

function summarizeRcExtension(extension = {}) {
  const email = normalizeEmail(extension?.contact?.email);
  return compactObject({
    extensionId: extension?.id != null ? String(extension.id) : null,
    extensionNumber: extension?.extensionNumber != null ? String(extension.extensionNumber) : null,
    name: bestRcExtensionName(extension),
    email,
    status: extension?.status || null,
    company: String(extension?.contact?.company || "").trim().toUpperCase() || deriveCompanyFromEmail(email),
  });
}

function summarizeUnassignedAgentExtension(agent = {}) {
  return compactObject({
    extensionId: agent?.extensionId != null ? String(agent.extensionId) : null,
    extensionNumber: agent?.extensionNumber != null ? String(agent.extensionNumber) : null,
    name: agent.name || null,
    company: agent.company || null,
    cxAgentId: agent.cxAgentId || null,
    status: agent.status || null,
    exPresenceStatus: agent.exPresenceStatus || null,
    lastStatusChange: agent.lastStatusChange || null,
    lastEventReceived: agent.lastEventReceived || null,
    source: "agent-state-cache",
  });
}

async function listLiveRcExtensionSummaries() {
  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "admin-unassigned-extensions-live" });
  const payload = await rc.listExtensions({ status: null });
  return coerceList(payload)
    .filter((extension) => extension?.type === "User")
    .filter((extension) => String(extension?.status || "").toLowerCase() !== "disabled")
    .map((extension) => ({
      ...summarizeRcExtension(extension),
      source: "ringcentral-ex-live",
    }))
    .filter((extension) => extension.extensionId);
}

function mergeExtensionSummaries(entries = []) {
  const byExtensionId = new Map();
  for (const entry of entries) {
    const extensionId = String(entry?.extensionId || "").trim();
    if (!extensionId) continue;
    const previous = byExtensionId.get(extensionId) || {};
    byExtensionId.set(extensionId, compactObject({
      ...previous,
      ...entry,
      name: entry.name || previous.name || null,
      company: entry.company || previous.company || null,
      cxAgentId: entry.cxAgentId || previous.cxAgentId || null,
      exPresenceStatus: previous.exPresenceStatus || entry.exPresenceStatus || null,
      lastStatusChange: previous.lastStatusChange || entry.lastStatusChange || null,
      lastEventReceived: previous.lastEventReceived || entry.lastEventReceived || null,
      source: Array.from(new Set([
        ...String(previous.source || "").split("+").filter(Boolean),
        entry.source || null,
      ].filter(Boolean))).join("+") || null,
    }));
  }
  return Array.from(byExtensionId.values());
}

function summarizeLocalAgentState(agent = {}) {
  return compactObject({
    extensionId: agent?.extensionId != null ? String(agent.extensionId) : null,
    name: agent?.name || null,
    company: agent?.company || null,
    cxAgentId: agent?.cxAgentId || null,
    status: agent?.status || null,
    exPresenceStatus: agent?.exPresenceStatus || null,
    activityState: agent?.activityState || null,
    lastEventReceived: agent?.lastEventReceived || null,
  });
}

function readRingcxAgentId(agent = {}) {
  return String(
    agent.agentId
      || agent.id
      || agent.agentID
      || agent.agent_id
      || "",
  ).trim();
}

function readRingcxAgentGroupId(agent = {}) {
  return String(
    agent.agentGroupId
      || agent.groupId
      || agent.agentGroupID
      || agent.agent_group_id
      || agent.group?.id
      || "",
  ).trim();
}

function summarizeRingcxAgent(agent = {}) {
  return compactObject({
    agentId: readRingcxAgentId(agent) || null,
    username: normalizeEmail(agent?.username || agent?.email || agent?.login || ""),
    groupId: readRingcxAgentGroupId(agent) || null,
    rcUserId: String(agent?.rcUserId || "").trim() || null,
    firstName: String(agent?.firstName || agent?.first_name || "").trim() || null,
    lastName: String(agent?.lastName || agent?.last_name || "").trim() || null,
    name: String(agent?.name || agent?.fullName || "").trim() || null,
    userManagedByRC: agent?.userManagedByRC === true,
    active: agent?.active ?? agent?.enabled ?? null,
  });
}

async function listRingcxAgentsForAdmin() {
  const client = createRingcxVoiceClient();
  const groupIds = [];
  const defaultGroupId = String(
    client?.config?.defaultAgentGroupId || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID || "",
  ).trim();
  if (defaultGroupId) groupIds.push(defaultGroupId);

  if (typeof client.listAgentGroups === "function") {
    try {
      for (const group of coerceList(await client.listAgentGroups())) {
        const groupId = readRingcxAgentGroupId(group) || String(group?.id || "").trim();
        if (groupId && !groupIds.includes(groupId)) groupIds.push(groupId);
      }
    } catch {
      // The configured default group is enough for the lookup fallback.
    }
  }

  const agents = [];
  for (const groupId of groupIds) {
    try {
      const groupAgents = coerceList(await client.listAgents(groupId));
      for (const agent of groupAgents) {
        agents.push({
          ...agent,
          agentGroupId: readRingcxAgentGroupId(agent) || groupId,
        });
      }
    } catch {
      // Keep scanning other groups; one locked group should not kill lookup.
    }
  }
  return agents;
}

function getSettlementOfficerId(block) {
  return block?.settlementOfficerId || block?.soId || block?.logicsId || null;
}

function buildLogicsSuggestion(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { found: false, suggestion: {} };
  const logicsAgent = findLogicsAgentByEmail(normalizedEmail);
  const exShells = findExShellsForEmail(normalizedEmail);
  if (!logicsAgent && (!Array.isArray(exShells) || exShells.length === 0)) {
    return { found: false, suggestion: {} };
  }

  const tag = logicsAgent?.tag || null;
  const wynn = logicsAgent?.wynn || null;
  const primary =
    tag && normalizeEmail(tag.email) === normalizedEmail
      ? tag
      : wynn && normalizeEmail(wynn.email) === normalizedEmail
        ? wynn
        : tag || wynn || null;

  return {
    found: Boolean(logicsAgent),
    suggestion: compactObject({
      name: logicsAgent?.name || null,
      phone: logicsAgent?.phone || null,
      logicsUserId: primary?.logicsId || null,
      logicsDisplayName: logicsAgent?.name || null,
      tagLogicsId: tag?.logicsId || null,
      tagSOId: getSettlementOfficerId(tag),
      tagEmail: tag?.email || null,
      tagLogicsName: tag ? (tag.displayName || logicsAgent?.name || null) : null,
      tagLogicsRoles: tag?.roles || null,
      wynnLogicsId: wynn?.logicsId || null,
      wynnSOId: getSettlementOfficerId(wynn),
      wynnEmail: wynn?.email || null,
      wynnLogicsName: wynn ? (wynn.displayName || logicsAgent?.name || null) : null,
      wynnLogicsRoles: wynn?.roles || null,
      exShells: Array.isArray(exShells) && exShells.length > 0 ? exShells : null,
    }),
  };
}

function matchRcExtension(extension, input) {
  const summary = summarizeRcExtension(extension);
  const tokens = new Set([
    normalizeLookupToken(input.email),
    normalizeLookupToken(input.username),
    normalizeLookupToken(input.name),
    normalizeLookupToken(input.extensionId),
    normalizeLookupToken(input.extensionNumber),
  ].filter(Boolean));
  if (tokens.has(normalizeLookupToken(summary.email))) return true;
  if (tokens.has(normalizeLookupToken(summary.extensionId))) return true;
  if (tokens.has(normalizeLookupToken(summary.extensionNumber))) return true;
  if (tokens.has(normalizeLookupToken(summary.name))) return true;
  const username = normalizeLookupToken(input.username);
  return Boolean(username && summary.email && summary.email === username);
}

function matchRingcxAgent(agent, input) {
  const summary = summarizeRingcxAgent(agent);
  const username = normalizeLookupToken(summary.username);
  const name = normalizeLookupToken(summary.name || `${summary.firstName || ""} ${summary.lastName || ""}`.trim());
  const tokens = new Set([
    normalizeLookupToken(input.email),
    normalizeLookupToken(input.username),
    normalizeLookupToken(input.cxUsername),
    normalizeLookupToken(input.ringcxUsername),
    normalizeLookupToken(input.name),
  ].filter(Boolean));
  if (tokens.has(username)) return true;
  if (tokens.has(name)) return true;
  if (input.cxAgentId && normalizeLookupToken(summary.agentId) === normalizeLookupToken(input.cxAgentId)) return true;
  if (input.extensionId && normalizeLookupToken(summary.rcUserId) === normalizeLookupToken(input.extensionId)) return true;
  return false;
}

async function resolveIdentityMatches(body = {}) {
  const input = {
    email: normalizeEmail(body.email),
    username: normalizeEmail(body.username || body.ringcxUsername || body.cxUsername),
    cxUsername: normalizeEmail(body.cxUsername || body.ringcxUsername || body.username),
    ringcxUsername: normalizeEmail(body.ringcxUsername || body.cxUsername || body.username),
    name: String(body.name || "").trim(),
    company: String(body.company || "").trim().toUpperCase(),
    extensionId: String(body.extensionId || "").trim(),
    extensionNumber: String(body.extensionNumber || "").trim(),
    cxAgentId: String(body.cxAgentId || "").trim(),
  };

  const lookupTokens = [
    input.email,
    input.username,
    input.name,
    input.extensionId,
    input.extensionNumber,
    input.cxAgentId,
  ].filter(Boolean);
  if (lookupTokens.length === 0) {
    const err = new Error("Provide an email, username, extension, name, or CX agent id to check");
    err.status = 400;
    throw err;
  }

  const checkedAt = new Date();
  const [agentStates, accounts] = await Promise.all([
    agentStateRepository.listAgentStates(input.company ? { company: input.company } : {}),
    userAccountRepository.listUserAccounts({ limit: 1000 }),
  ]);

  const existing = accounts.find((account) => {
    const metadata = account.metadata || {};
    const fields = [
      account.email,
      account.name,
      account.extensionId,
      account.extensionNumber,
      account.cxAgentId,
      metadata.ringcxUsername,
      metadata.ringcxAgentUsername,
      metadata.cxUsername,
      metadata.ringcxAgentId,
    ].map(normalizeLookupToken);
    return lookupTokens.some((token) => fields.includes(normalizeLookupToken(token)));
  }) || null;

  const localEx = agentStates.find((agent) => {
    const fields = [
      agent.extensionId,
      agent.name,
      agent.cxAgentId,
    ].map(normalizeLookupToken);
    return lookupTokens.some((token) => fields.includes(normalizeLookupToken(token)));
  }) || null;

  let exLookup = { ok: false, source: "ringcentral-ex", match: null, error: null };
  try {
    const rc = createRingCentralClient();
    await rc.reinitializePlatform({ force: false, reason: "admin-user-identity-lookup" });
    const payload = await rc.listExtensions({ status: null });
    const liveMatch = coerceList(payload)
      .filter((extension) => String(extension?.status || "").toLowerCase() !== "disabled")
      .find((extension) => matchRcExtension(extension, input));
    exLookup = {
      ok: true,
      source: liveMatch ? "ringcentral-ex-live" : "ringcentral-ex-live",
      match: liveMatch ? summarizeRcExtension(liveMatch) : null,
      error: null,
    };
  } catch (error) {
    exLookup = {
      ok: false,
      source: "ringcentral-ex-live",
      match: null,
      error: error.message,
    };
  }
  if (!exLookup.match && localEx) {
    exLookup = {
      ok: true,
      source: "agent-state-cache",
      match: summarizeLocalAgentState(localEx),
      error: exLookup.error,
    };
  }

  let cxLookup = { ok: false, source: "ringcx-voice", match: null, error: null };
  try {
    const agents = await listRingcxAgentsForAdmin();
    const cxMatch = agents.find((agent) => matchRingcxAgent(agent, {
      ...input,
      extensionId: input.extensionId || exLookup.match?.extensionId,
      cxAgentId: input.cxAgentId || localEx?.cxAgentId || exLookup.match?.cxAgentId,
    }));
    cxLookup = {
      ok: true,
      source: "ringcx-voice",
      match: cxMatch ? summarizeRingcxAgent(cxMatch) : null,
      error: null,
    };
  } catch (error) {
    cxLookup = {
      ok: false,
      source: "ringcx-voice",
      match: null,
      error: error.message,
    };
  }

  const suggestedEmail =
    input.email
    || exLookup.match?.email
    || (input.username.includes("@") && !input.username.startsWith("+") ? input.username : null)
    || existing?.email
    || null;
  const logics = buildLogicsSuggestion(suggestedEmail);
  const ringcxUsername =
    cxLookup.match?.username
    || input.ringcxUsername
    || existing?.metadata?.ringcxUsername
    || existing?.metadata?.ringcxAgentUsername
    || null;
  const metadata = compactObject({
    ...(existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
    ringcxUsername,
    ringcxAgentUsername: ringcxUsername,
    cxUsername: ringcxUsername,
    ringcxAgentId: cxLookup.match?.agentId || existing?.metadata?.ringcxAgentId || null,
    ringcxAgentGroupId: cxLookup.match?.groupId || existing?.metadata?.ringcxAgentGroupId || null,
    ringcxRcUserId: cxLookup.match?.rcUserId || existing?.metadata?.ringcxRcUserId || null,
    identityLastCheckedAt: checkedAt,
    identityCheck: {
      exMatched: Boolean(exLookup.match),
      cxMatched: Boolean(cxLookup.match),
      oauthConfigured: Boolean(cxOAuthService.describeConfig().enabled),
    },
  });

  const suggestion = compactObject({
    ...logics.suggestion,
    email: suggestedEmail,
    name: existing?.name || exLookup.match?.name || logics.suggestion.name || input.name || null,
    company:
      existing?.company
      || input.company
      || exLookup.match?.company
      || deriveCompanyFromEmail(suggestedEmail)
      || null,
    extensionId: existing?.extensionId || exLookup.match?.extensionId || input.extensionId || null,
    extensionNumber: existing?.extensionNumber || exLookup.match?.extensionNumber || input.extensionNumber || null,
    cxAgentId:
      existing?.cxAgentId
      || localEx?.cxAgentId
      || cxLookup.match?.agentId
      || input.cxAgentId
      || null,
    metadata,
  });

  const oauthConfig = cxOAuthService.describeConfig();
  const session = existing ? await cxTokenStorageService.describe(existing.id).catch(() => null) : null;

  return {
    checkedAt,
    input,
    existing: existing
      ? compactObject({
        id: existing.id,
        email: existing.email,
        name: existing.name,
        status: existing.status,
        extensionId: existing.extensionId,
        cxAgentId: existing.cxAgentId,
      })
      : null,
    matches: {
      ex: exLookup,
      cx: cxLookup,
      logics: { found: logics.found },
    },
    suggestion,
    oauth: {
      configured: Boolean(oauthConfig.enabled),
      config: oauthConfig,
      session,
    },
  };
}

async function deactivateAccount(accountId, actorEmail = null, reason = "admin-deactivated") {
  const current = await userAccountRepository.findUserAccountById(accountId);
  if (!current) {
    const err = new Error("Account not found");
    err.status = 404;
    throw err;
  }
  if (HARDENED_ACCOUNT_EMAILS.has(String(current.email || "").toLowerCase())) {
    const err = new Error("Hard-coded accounts cannot be deactivated");
    err.status = 400;
    throw err;
  }

  const now = new Date();
  await userAccountRepository.updateUserAccount(accountId, {
    status: "disabled",
    metadata: {
      ...(current.metadata || {}),
      deactivatedAt: now,
      deactivatedBy: actorEmail || null,
      deactivationReason: reason,
    },
  });

  const sideEffects = {
    cxSessionRevoked: false,
    queueRelease: null,
    presenceCleared: false,
    agentPaused: false,
  };

  try {
    await cxTokenStorageService.revoke(accountId);
    sideEffects.cxSessionRevoked = true;
  } catch (error) {
    sideEffects.cxSessionError = error.message;
  }

  const extensionId = String(current.extensionId || "").trim();
  if (extensionId) {
    try {
      await touchCxWorkspacePresence(extensionId, {
        active: false,
        source: "admin-deactivate",
        userEmail: current.email,
      });
      sideEffects.presenceCleared = true;
    } catch (error) {
      sideEffects.presenceError = error.message;
    }
    try {
      sideEffects.queueRelease = await releaseAssignedCxQueueForAgent({
        extensionId,
        actorEmail: actorEmail || current.email,
        reason: "admin-deactivate",
      });
    } catch (error) {
      sideEffects.queueRelease = { ok: false, error: error.message };
    }
    try {
      await agentStateRepository.updateAgentState(extensionId, {
        status: "offline",
        activityState: "offline",
        lastStatusChange: now,
        lastActivityAt: now,
        "cxRouting.enabled": false,
        "cxRouting.desiredAvailability": "unavailable",
        "cxRouting.reason": "admin-deactivated",
        "cxRouting.syncedAt": now,
        "cxRouting.lastSource": "admin",
        "cxRouting.pauseType": "deactivated",
        "cxRouting.pauseStartedAt": now,
        "cxRouting.pauseReleaseAt": null,
        "upstream.source": "admin-deactivate",
        "upstream.mirroredAt": now,
      });
      sideEffects.agentPaused = true;
    } catch (error) {
      sideEffects.agentPauseError = error.message;
    }
  }

  const record = await userAccountRepository.findUserAccountById(accountId);
  return { account: decorate(record), sideEffects };
}

function createAdminAccountsRouter(auth) {
  const router = express.Router();

  router.get("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const [accounts, agentStates] = await Promise.all([
        userAccountRepository.listUserAccounts({
          status: req.query.status,
          role: req.query.role,
          audience: req.query.audience,
          company: req.query.company,
          search: req.query.search,
          limit: req.query.limit,
        }),
        agentStateRepository.listAgentStates(
          req.query.company ? { company: req.query.company } : {},
        ),
      ]);
      const agentStateByExtensionId = new Map(
        agentStates.map((agent) => [String(agent.extensionId || ""), agent]),
      );
      return res.json({
        ok: true,
        accounts: accounts.map((account) => attachAgentState(account, agentStateByExtensionId)),
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get(
    "/unassigned-extensions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const filters = {};
        if (req.query.company) filters.company = req.query.company;
        const includeLive = String(req.query.live || "true").toLowerCase() !== "false";

        const [agents, accounts, liveLookup] = await Promise.all([
          agentStateRepository.listAgentStates(filters),
          userAccountRepository.listUserAccounts({ limit: 1000 }),
          includeLive
            ? listLiveRcExtensionSummaries()
              .then((extensions) => ({ ok: true, extensions, error: null }))
              .catch((error) => ({ ok: false, extensions: [], error: error.message }))
            : Promise.resolve({ ok: true, extensions: [], error: null }),
        ]);

        const assignedExtensionIds = new Set();
        const assignedExtensionNumbers = new Set();
        for (const account of accounts) {
          if (account.extensionId) assignedExtensionIds.add(String(account.extensionId));
          if (account.extensionId && account.extensionNumber) {
            assignedExtensionNumbers.add(String(account.extensionNumber));
          }
          const additionalIds = Array.isArray(account.metadata?.additionalExtensionIds)
            ? account.metadata.additionalExtensionIds
            : [];
          for (const extensionId of additionalIds) {
            if (extensionId) assignedExtensionIds.add(String(extensionId));
          }
        }

        const companyFilter = String(req.query.company || "").trim().toUpperCase();
        const cachedExtensions = agents.map(summarizeUnassignedAgentExtension);
        const mergedExtensions = mergeExtensionSummaries([
          ...cachedExtensions,
          ...liveLookup.extensions,
        ]);

        const unassigned = mergedExtensions
          .filter((extension) => !assignedExtensionIds.has(String(extension.extensionId)))
          .filter((extension) =>
            !extension.extensionNumber ||
            !assignedExtensionNumbers.has(String(extension.extensionNumber)))
          .filter((extension) =>
            !companyFilter ||
            !extension.company ||
            String(extension.company).toUpperCase() === companyFilter)
          .sort((left, right) =>
            String(left.name || left.extensionNumber || left.extensionId)
              .localeCompare(String(right.name || right.extensionNumber || right.extensionId)));

        return res.json({
          ok: true,
          extensions: unassigned,
          liveLookup,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/identity/resolve",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await resolveIdentityMatches(req.body || {});
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /today-dials
   *
   * Always-fresh per-agent "today's CX activity" rollup. Reads
   * CxDialQueue metadata directly (no CallLog aggregation, no
   * AgentState snapshot cache) and groups by the extensionIds that
   * touched each lead today. Intended for an admin dashboard that
   * needs live numbers across all agents, where the per-agent
   * call-stats endpoint's 5-min snapshot is too coarse.
   *
   * Optional `?domain=TAG|WYNN` to filter; omit to roll up both.
   *
   * Returns:
   *   {
   *     ok: true,
   *     dateKey: "2026-05-18",
   *     domain: "TAG" | null,
   *     items: [
   *       { extensionId, leadsTouchedToday, placedCallsToday,
   *         lastPlacedAt, domains: ["TAG"] },
   *       ...
   *     ]
   *   }
   *
   * MUST be defined BEFORE the `/:id` route — otherwise Express's
   * parametric match will swallow "today-dials" as an id.
   */
  router.get(
    "/today-dials",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await listCxPlacedCallsToday({
          domain: req.query?.domain || null,
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const record = await userAccountRepository.findUserAccountById(req.params.id);
      if (!record) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }
      const agentState = record.extensionId
        ? await agentStateRepository.findAgentStateByExtensionId(record.extensionId)
        : null;
      return res.json({
        ok: true,
        account: {
          ...decorate(record),
          agentState: summarizeAgentState(agentState),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  /**
   * GET /:id/call-stats
   *
   * Returns the lazy-computed per-agent call rollups (today / week /
   * month / lifetime) split by direction (inbound/outbound) and
   * platform (cx/ex). Backed by `AgentState.callStatsSnapshot` with a
   * 5-minute staleness window; pass `?refresh=true` to force re-aggregate.
   *
   * No platform-side write happens here — the underlying CallLog rows
   * are stamped at write time via the writers, not via this endpoint.
   */
  router.get(
    "/:id/call-stats",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) {
          return res.status(404).json({ ok: false, error: "Account not found" });
        }
        const agentState = record.extensionId
          ? await agentStateRepository.findAgentStateByExtensionId(record.extensionId)
          : null;
        const force =
          String(req.query.refresh || "").toLowerCase() === "true";
        const { snapshot, cached } = await getOrComputeAgentCallStats({
          account: record,
          agentState,
          force,
        });
        return res.json({
          ok: true,
          accountId: req.params.id,
          extensionId: record.extensionId || null,
          additionalExtensionIds:
            Array.isArray(record.metadata?.additionalExtensionIds)
              ? record.metadata.additionalExtensionIds
              : [],
          cached,
          snapshot,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      // Accept the same field surface as PUT so the admin can populate
      // tenant-prefixed Logics identities (tag*, wynn*), extensionNumber,
      // and logicsAuth credential state at create time.
      const fields = sanitizePatch(body);
      if (fields.cxQueuePolicy) {
        fields.cxQueuePolicy = {
          ...fields.cxQueuePolicy,
          updatedAt: new Date(),
          updatedBy: req.user?.email || null,
        };
      }
      const record = await userAccountRepository.createUserAccount({
        email: body.email,
        ...fields,
        status: body.status || "invited",
        source: "manual",
        metadata: {
          ...(fields.metadata || {}),
          createdBy: req.user?.email || null,
        },
      });
      return res.status(201).json({ ok: true, account: decorate(record) });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.put("/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const current = await userAccountRepository.findUserAccountById(req.params.id);
      if (!current) {
        return res.status(404).json({ ok: false, error: "Account not found" });
      }

      const patch = sanitizePatch(req.body || {});
      if (patch.cxQueuePolicy) {
        patch.cxQueuePolicy = {
          ...patch.cxQueuePolicy,
          updatedAt: new Date(),
          updatedBy: req.user?.email || null,
        };
      }

      // Seed admins can be edited but cannot have role/audience demoted or
      // email reassigned — keep the hard-coded guarantees predictable.
      if (SEED_ADMIN_EMAILS.has(current.email)) {
        patch.role = "admin";
        patch.audience = "admin";
      } else {
        const hardenedUser = HARDENED_USER_RULES.get(String(current.email || "").toLowerCase());
        if (hardenedUser) {
          patch.role = hardenedUser.role;
          patch.audience = hardenedUser.audience;
          patch.company = hardenedUser.company;
          patch.workspace = hardenedUser.workspace;
        }
      }

      const record = await userAccountRepository.updateUserAccount(req.params.id, patch);
      return res.json({ ok: true, account: decorate(record) });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/:id/disable",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await deactivateAccount(
          req.params.id,
          req.user?.email || null,
          "admin-disabled",
        );
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:id/deactivate",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await deactivateAccount(
          req.params.id,
          req.user?.email || null,
          String(req.body?.reason || "admin-deactivated"),
        );
        return res.json({ ok: true, ...result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/:id/enable",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const current = await userAccountRepository.findUserAccountById(req.params.id);
        if (!current) {
          return res.status(404).json({ ok: false, error: "Account not found" });
        }
        const record = await userAccountRepository.updateUserAccount(req.params.id, {
          status: "active",
          metadata: {
            ...(current.metadata || {}),
            reactivatedAt: new Date(),
            reactivatedBy: req.user?.email || null,
          },
        });
        return res.json({ ok: true, account: decorate(record) });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Consolidate RingCentral extensions → UserAccount, keyed by email.
   * Creates new accounts for RC Users not yet in Parallel (status=invited,
   * role=internal-agent, source=rc-poll), refreshes extensionId/name/cxAgentId
   * on existing accounts without trampling operator-edited fields, and
   * demotes accounts whose RC extension has gone Disabled or disappeared.
   * Seed admins are exempt.
   *
   * Body: { dryRun?: boolean }
   */
  router.post(
    "/sync-from-rc",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const dryRun = Boolean(req.body?.dryRun ?? req.query.dryRun === "true");
        const result = await syncUsersFromRcExtensions({ dryRun });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/accounts/permissions/catalog
   * Returns the full permission catalog + role-default mapping. Used by
   * the SPA admin panel to render permission-grant UI.
   */
  router.get(
    "/permissions/catalog",
    auth.requireAuth,
    auth.requireAdmin,
    (_req, res) => {
      res.json({
        ok: true,
        catalog: PERMISSIONS_CATALOG,
        roleDefaults: ROLE_DEFAULT_PERMISSIONS,
        roles: Array.from(ALL_ROLES),
      });
    },
  );

  /**
   * GET /api/admin/accounts/:id/permissions
   * Returns role + extra grants + effective permissions for one user.
   */
  router.get(
    "/:id/permissions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        return res.json({
          ok: true,
          accountId: String(record._id || record.id),
          email: record.email,
          role: record.role,
          permissions: record.permissions || [],
          permissionsUpdatedAt: record.permissionsUpdatedAt || null,
          permissionsUpdatedBy: record.permissionsUpdatedBy || null,
          effective: effectivePermissionsFor(record),
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * PUT /api/admin/accounts/:id/permissions
   * Body: { permissions: [string, ...], role?: string }
   * Sets the additive permissions list (replaces, doesn't merge). Optional
   * role change. Validates against the catalog and known roles.
   * Hardened seed accounts are protected from role downgrades.
   */
  router.put(
    "/:id/permissions",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });

        const requested = req.body?.permissions;
        const newRole = req.body?.role ? String(req.body.role).trim() : null;

        const update = {
          permissionsUpdatedAt: new Date(),
          permissionsUpdatedBy: req.user?.email || req.user?.id || "internal",
        };

        if (Array.isArray(requested)) {
          update.permissions = normalizePermissionList(requested);
          // Surface unknown keys to the caller so they know the request was filtered
          const unknown = requested
            .map((k) => String(k).trim())
            .filter((k) => k && !update.permissions.includes(k));
          if (unknown.length) update.unknownPermissionsIgnored = unknown;
        }

        if (newRole) {
          if (!isKnownRole(newRole)) {
            return res.status(400).json({ ok: false, error: `unknown-role:${newRole}` });
          }
          // Protect seed admins from accidental role downgrade.
          if (
            SEED_ADMIN_EMAILS.has(String(record.email).toLowerCase())
            && record.role === "admin"
            && newRole !== "admin"
          ) {
            return res.status(403).json({
              ok: false,
              error: "cannot downgrade seed admin role",
            });
          }
          update.role = newRole;
        }

        const persisted = await userAccountRepository.updateUserAccount(
          record._id || record.id,
          update,
        );
        return res.json({
          ok: true,
          account: decorate(persisted),
          effective: effectivePermissionsFor(persisted),
          unknownPermissionsIgnored: update.unknownPermissionsIgnored || [],
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/accounts/:id/cx-session
   * Read-only summary of an agent's CX (RingCX) authentication state.
   * No plaintext tokens — just metadata for admin observability.
   */
  router.get(
    "/:id/cx-session",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        const desc = await cxTokenStorageService.describe(req.params.id);
        return res.json({ ok: true, accountId: req.params.id, email: record.email, session: desc });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * POST /api/admin/accounts/:id/cx-session/revoke
   * Clear an agent's stored CX tokens. Forces them to re-authorize via
   * /api/auth/cx/start on next dial attempt.
   */
  router.post(
    "/:id/cx-session/revoke",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        await cxTokenStorageService.revoke(req.params.id);
        return res.json({ ok: true });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * POST /api/admin/accounts/:id/cx-session/refresh
   * Manually trigger a token refresh for an agent (admin-side debugging).
   */
  router.post(
    "/:id/cx-session/refresh",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const record = await userAccountRepository.findUserAccountById(req.params.id);
        if (!record) return res.status(404).json({ ok: false, error: "Account not found" });
        const result = await cxOAuthService.refreshUserSession({ userId: req.params.id });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * GET /api/admin/cx-oauth/status
   * Check the OAuth configuration is present (no secrets returned).
   */
  router.get(
    "/cx-oauth/status",
    auth.requireAuth,
    auth.requireAdmin,
    (_req, res) => {
      res.json({ ok: true, config: cxOAuthService.describeConfig() });
    },
  );

  return router;
}

module.exports = {
  createAdminAccountsRouter,
};
