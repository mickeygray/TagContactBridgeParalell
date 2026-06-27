"use strict";

// Service entry for the bulk_load rail — the thin boundary the routes call.
//
// It does three jobs and nothing else: resolve the agent context (admin guard),
// apply the runtime gate (only an agent resolved to bulk_load may proceed), and
// delegate to the tested orchestrator with the REAL adapters wired in. The
// orchestrator (cxBulkLoadRuntimeService) stays pure-injectable; this file owns the
// concrete wiring (RingCX client, repo, cadence finalizer). Mirrors the slow lane's
// resolveAgentContext + cadence approach so the two rails finalize consistently.

const crypto = require("crypto");

const { createRingcxVoiceClient } = require("../../shared-integrations/src");
const {
  cxBulkLoadSessionRepository,
  cxDialQueueRepository,
  cxTerminalOutboxRepository,
  agentStateRepository,
  queueItemRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const { createCxAppointment } = require("./cxAppointmentService");

const leadSource = require("./cxBulkLoadLeadSourceService");
const publisher = require("./cxBulkLoadRingcxPublisher");
const watcher = require("./cxBulkLoadActiveCallWatcher");
const { createCxBulkLoadOutcomeAdapter, makeOutcomeIdemKey } = require("./cxBulkLoadOutcomeAdapter");
const { createCxBulkLoadRuntimeService } = require("./cxBulkLoadRuntimeService");
const { reduceCxBulkLoadState } = require("./cxBulkLoadStateMachine");
const { createCxQueueReservationService } = require("./cxQueueReservationService");
const { buildFamilyTargets } = require("./cxReserveModeService");
const { resolveCxDialRuntimeMode, isCxBulkLoadRuntime } = require("./cxDialRuntimeModeService");
const { resolveCaseContactEligibility } = require("./contactEligibilityService");
const { handleCxTerminalCallOutcome } = require("./cxCadenceService");
const { executeCxHangupRequest } = require("./ringcxDialExecutionService");
const {
  executeCxAppointmentWorkbenchActions,
  executeCxLogicsUpdateCase,
  requestCxAssignCaseToMe,
} = require("./cxWorkspaceService");

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v != null && v !== "" ? String(v) : fallback;
}

function readBooleanEnv(name, fallback = false) {
  const value = readEnv(name, "");
  if (!value) return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return fallback;
}

function readDurationEnvMs(name, fallback) {
  const value = Number(readEnv(name, ""));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isDispositionTraceEnabled() {
  return /^(1|true|yes|on)$/i.test(readEnv("CX_BULK_LOAD_DISPOSITION_TRACE"));
}

function createDispositionTrace(scope) {
  if (!isDispositionTraceEnabled()) return () => {};
  const startedAt = Date.now();
  return (label, extra) => {
    console.log(
      `[DISPTRACE] ${scope}:${label} +${Date.now() - startedAt}ms`,
      extra !== undefined ? extra : "",
    );
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
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

function resolveBulkAgentRingcxRoute(agent = {}, input = {}) {
  const account = agent.account || {};
  const tokens = [
    input.agentExtensionId,
    input.extensionId,
    agent.agentExtensionId,
    input.cxAgentId,
    input.ringcxAgentId,
    agent.cxAgentId,
    input.agentEmail,
    agent.agentEmail,
    account.email,
    account.name,
  ];
  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const dialGroupId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_DIAL_GROUP_ID`));
    const campaignId = normalizeExternalId(readEnv(`RINGCX_AGENT_ROUTE_${suffix}_CAMPAIGN_ID`));
    if (dialGroupId || campaignId) {
      return { dialGroupId, campaignId, matchedToken: String(token) };
    }
  }
  return { dialGroupId: null, campaignId: null, matchedToken: null };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

const progressivePauseTokens = new Map();

function progressivePauseKey(agentId, agentGroupId) {
  return `${normalizeExternalId(agentGroupId) || "group?"}:${normalizeExternalId(agentId) || "agent?"}`;
}

function resolveProgressivePauseStateIds() {
  return {
    pauseStateId: firstNonEmpty(
      process.env.CX_BULK_LOAD_PROGRESSIVE_PAUSE_STATE_ID,
      process.env.RINGCX_VOICE_AUX_WORKING_STATE_ID,
      process.env.RINGCX_VOICE_AUX_ON_BREAK_STATE_ID,
      process.env.RINGCX_VOICE_AUX_AWAY_STATE_ID,
    ),
    availableStateId: firstNonEmpty(
      process.env.CX_BULK_LOAD_PROGRESSIVE_AVAILABLE_STATE_ID,
      process.env.RINGCX_VOICE_AUX_AVAILABLE_STATE_ID,
    ),
  };
}

async function restoreProgressivePause({ client, key, agentId, agentGroupId, availableStateId, token, pauseMs }) {
  await sleep(pauseMs);
  if (progressivePauseTokens.get(key) !== token) return { ok: true, skipped: true, reason: "superseded" };
  await client.setAgentState(agentId, availableStateId, agentGroupId);
  if (progressivePauseTokens.get(key) === token) progressivePauseTokens.delete(key);
  return { ok: true, restored: true };
}

async function pauseRingcxProgressiveDialing(client, session = {}, options = {}) {
  if (!readBooleanEnv("CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED", true)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!client || typeof client.setAgentState !== "function") {
    return { ok: false, skipped: true, reason: "set-agent-state-unavailable" };
  }
  const agentId = normalizeExternalId(session.cxAgentId || options.agentId);
  const agentGroupId = normalizeExternalId(
    session.ringcx?.agentGroupId ||
      options.agentGroupId ||
      process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
  );
  if (!agentId || !agentGroupId) {
    return { ok: false, skipped: true, reason: !agentId ? "missing-agent-id" : "missing-agent-group-id" };
  }

  const pauseMs = readDurationEnvMs("CX_BULK_LOAD_PROGRESSIVE_PAUSE_MS", 3000);
  if (pauseMs <= 0) return { ok: true, skipped: true, reason: "zero-duration" };

  const { pauseStateId, availableStateId } = resolveProgressivePauseStateIds();
  if (!pauseStateId || !availableStateId) {
    return {
      ok: false,
      skipped: true,
      reason: !pauseStateId ? "missing-pause-state-id" : "missing-available-state-id",
    };
  }

  const key = progressivePauseKey(agentId, agentGroupId);
  const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  progressivePauseTokens.set(key, token);
  await client.setAgentState(agentId, pauseStateId, agentGroupId);
  console.info("[cx-bulk-load] progressive_pause.set", {
    agentId,
    agentGroupId,
    pauseMs,
    holdUntilResume: options.holdUntilResume === true,
    reason: options.reason || null,
  });

  if (options.holdUntilResume === true) {
    return {
      ok: true,
      paused: true,
      restoreScheduled: false,
      holdUntilResume: true,
      pauseMs,
      reason: options.reason || null,
    };
  }

  const restore = restoreProgressivePause({
    client,
    key,
    agentId,
    agentGroupId,
    availableStateId,
    token,
    pauseMs,
  });
  if (options.waitForRestore === true) {
    const restored = await restore;
    return {
      ok: restored.ok !== false,
      paused: true,
      restored: restored.restored === true,
      pauseMs,
      reason: options.reason || null,
    };
  }
  restore.catch((error) => {
    console.warn("[cx-bulk-load] progressive_pause.restore_failed", {
      agentId,
      agentGroupId,
      reason: options.reason || null,
      error: error && error.message ? error.message : String(error),
    });
  });
  restore.then((result) => {
    if (result?.restored) {
      console.info("[cx-bulk-load] progressive_pause.restored", {
        agentId,
        agentGroupId,
        reason: options.reason || null,
      });
    }
  });
  return {
    ok: true,
    paused: true,
    restoreScheduled: true,
    pauseMs,
    reason: options.reason || null,
  };
}

async function resumeRingcxProgressiveDialing(client, session = {}, options = {}) {
  if (!readBooleanEnv("CX_BULK_LOAD_PROGRESSIVE_PAUSE_ENABLED", true)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!client || typeof client.setAgentState !== "function") {
    return { ok: false, skipped: true, reason: "set-agent-state-unavailable" };
  }
  const agentId = normalizeExternalId(session.cxAgentId || options.agentId);
  const agentGroupId = normalizeExternalId(
    session.ringcx?.agentGroupId ||
      options.agentGroupId ||
      process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID,
  );
  if (!agentId || !agentGroupId) {
    return { ok: false, skipped: true, reason: !agentId ? "missing-agent-id" : "missing-agent-group-id" };
  }
  const { availableStateId } = resolveProgressivePauseStateIds();
  if (!availableStateId) {
    return { ok: false, skipped: true, reason: "missing-available-state-id" };
  }
  const key = progressivePauseKey(agentId, agentGroupId);
  progressivePauseTokens.delete(key);
  await client.setAgentState(agentId, availableStateId, agentGroupId);
  console.info("[cx-bulk-load] progressive_pause.resumed", {
    agentId,
    agentGroupId,
    reason: options.reason || null,
  });
  return { ok: true, resumed: true, reason: options.reason || null };
}

function activeCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function confirmRingcxUiiReleased(client, uii, options = {}) {
  const normalizedUii = normalizeExternalId(uii);
  if (!client || typeof client.listActiveCalls !== "function" || !normalizedUii) {
    return { ok: false, reason: "missing-active-call-verifier" };
  }
  const accountId = normalizeExternalId(options.accountId);
  const waits = Array.isArray(options.waits) && options.waits.length ? options.waits : [250, 600, 900];
  let lastActiveCall = null;
  let lastError = null;
  for (let index = 0; index < waits.length; index += 1) {
    const waitMs = Math.max(Number(waits[index]) || 0, 0);
    if (waitMs > 0) await sleep(waitMs);
    try {
      const payload = await client.listActiveCalls({
        product: "ACCOUNT",
        productId: accountId || undefined,
        maxRows: 100,
      });
      const match = activeCallList(payload)
        .find((call) => normalizeExternalId(call?.uii) === normalizedUii);
      if (!match) {
        return { ok: true, status: "released", attempts: index + 1 };
      }
      lastActiveCall = {
        uii: normalizeExternalId(match.uii),
        externalId: normalizeExternalId(match.externalId || match.externId),
        callState: match.callState || match.state || match.status || null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError && !lastActiveCall) {
    return {
      ok: false,
      reason: "active-call-release-verification-failed",
      error: lastError.message || String(lastError),
    };
  }
  return {
    ok: false,
    reason: "active-call-still-active-after-disposition",
    activeCall: lastActiveCall,
  };
}

async function resolveBulkManualDialContext(session = {}) {
  const account = session.agentExtensionId
    ? await userAccountRepository.findUserAccountByExtensionId(session.agentExtensionId).catch(() => null)
    : session.agentEmail
      ? await userAccountRepository.findUserAccountByEmail(session.agentEmail).catch(() => null)
      : null;
  const domain = normalizeDomain(session.domain);
  const username = firstNonEmpty(
    account?.metadata?.ringcxUsername,
    account?.metadata?.ringcxAgentUsername,
    account?.metadata?.ringcxAgentEmail,
    account?.metadata?.cxUsername,
    account?.cxSession?.rcxAgentEmail,
    account?.cxAuth?.rcUserEmail,
    account?.email,
    session.agentEmail,
    process.env.RINGCX_VOICE_AGENT_EMAIL,
  );
  const callerId = firstNonEmpty(
    account?.metadata?.ringcxCallerId,
    account?.metadata?.cxCallerId,
    account?.phone,
    domain === "WYNN" ? process.env.WYNN_PROSPECT_CONTACT_PHONE : process.env.TAG_CLIENT_CONTACT_PHONE,
    domain === "WYNN" ? process.env.WYNN_RINGOUT_CALLER : process.env.TAG_RINGOUT_CALLER,
  );
  return {
    username,
    callerId,
    usernameSource: username ? "account-or-env" : null,
    callerIdSource: callerId ? "account-or-env" : null,
  };
}

// Map a bulk call outcome to the REAL RingCX disposition name (the ones actually
// configured on the campaigns). Dispositioning the active call is what ends it
// and advances the dialer — so the name must be one RingCX recognizes.
function bulkOutcomeDisposition(outcome) {
  switch (String(outcome || "").trim().toLowerCase()) {
    case "voicemail":
      return "VM DROP";
    case "dnc":
      // RingCX only needs the fast close disposition here. The app outcome
      // remains `dnc` for terminal/outbox/Logics handling.
      return "Auto Dispo";
    case "answered":
    case "did-not-answer":
    case "did_not_connect":
    default:
      return "Auto Dispo";
  }
}

function buildCampaignLeadCriteria(session = {}, candidate = {}) {
  const campaignId = normalizeExternalId(
    session.ringcx?.campaignId
    || candidate.campaignId
    || candidate.ringcx?.campaignId
    || "",
  );
  const externId = normalizeExternalId(
    candidate.externId
    || candidate.ringcx?.externId
    || "",
  );
  if (!campaignId || !externId) return null;
  return {
    campaignId,
    campaignIds: [campaignId],
    externIds: [externId],
  };
}

function buildBulkAgentReservationParamMap(session = {}) {
  const agentId = normalizeExternalId(session.cxAgentId || "");
  if (!agentId) return null;
  const agentEmail = normalizeExternalId(session.agentEmail || "");
  const extensionId = normalizeExternalId(session.agentExtensionId || "");
  const agentGroupId = normalizeExternalId(session.ringcx?.agentGroupId || "");
  return {
    RESERVATION_AGENT_ID: agentId,
    CALLBACK_DTS: new Date(Date.now() + 1000).toISOString(),
    AGENT_ID: agentId,
    AGENT_USERNAME: agentEmail,
    AGENT_EMAIL: agentEmail,
    USERNAME: agentEmail,
    RC_USER_ID: extensionId,
    EXTENSION_ID: extensionId,
    AGENT_GROUP_ID: agentGroupId,
  };
}

async function runLeadAction(client, action, criteria, leadActionParams = { paramMap: {} }) {
  const startedAt = Date.now();
  try {
    const response = await client.leadAction(action, {
      campaignLeadSearchCriteria: criteria,
      leadActionParams,
    });
    const responseObject = response && typeof response === "object" ? response : null;
    const successFlag = responseObject && Object.prototype.hasOwnProperty.call(responseObject, "success")
      ? responseObject.success !== false
      : response !== false;
    const ok = successFlag && !responseObject?.errorMessage;
    return {
      action,
      ok,
      elapsedMs: Date.now() - startedAt,
      response: response === true ? true : responseObject ? {
        success: responseObject.success ?? null,
        leadUpdateCount: responseObject.leadUpdateCount ?? null,
        dialerRefreshed: responseObject.dialerRefreshed ?? null,
        leadActionType: responseObject.leadActionType ?? null,
        errorMessage: responseObject.errorMessage || null,
      } : undefined,
      error: ok ? null : responseObject?.errorMessage || null,
    };
  } catch (error) {
    return {
      action,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error && error.message ? error.message : String(error),
      status: error && error.status ? error.status : null,
    };
  }
}

async function requestNativeRingcxGetLeads(client, { session = {}, candidate = {} } = {}) {
  const startedAt = Date.now();
  if (!client || typeof client.leadAction !== "function") {
    return { ok: false, source: "ringcx-native-lead-action", reason: "lead-action-unavailable" };
  }
  const criteria = buildCampaignLeadCriteria(session, candidate);
  if (!criteria) {
    return { ok: false, source: "ringcx-native-lead-action", reason: "missing-campaign-or-extern-id" };
  }

  const ready = await runLeadAction(client, "READY_LEADS", criteria);
  if (!ready.ok) {
    console.info("[cx-bulk-load] native_get_leads", {
      ok: false,
      reason: "ready-leads-failed",
      sessionId: session.sessionId || null,
      candidateId: candidate.queueItemId || candidate._id || null,
      campaignId: criteria.campaignId,
      externId: criteria.externIds?.[0] || null,
      elapsedMs: Date.now() - startedAt,
      actions: [ready],
    });
    return {
      ok: false,
      source: "ringcx-native-lead-action",
      reason: "ready-leads-failed",
      error: ready.error || null,
      elapsedMs: ready.elapsedMs,
      actions: [ready],
    };
  }

  const reservationParamMap = buildBulkAgentReservationParamMap(session);
  if (reservationParamMap) {
    const reservation = await runLeadAction(client, "AGENT_RESERVATION", criteria, {
      paramMap: reservationParamMap,
    });
    console.info("[cx-bulk-load] native_get_leads", {
      ok: reservation.ok,
      reason: reservation.ok ? null : "agent-reservation-failed",
      sessionId: session.sessionId || null,
      candidateId: candidate.queueItemId || candidate._id || null,
      campaignId: criteria.campaignId,
      externId: criteria.externIds?.[0] || null,
      elapsedMs: Date.now() - startedAt,
      actions: [ready, reservation],
    });
    return {
      ok: reservation.ok,
      source: "ringcx-native-lead-action",
      reason: reservation.ok ? null : "agent-reservation-failed",
      error: reservation.error || null,
      elapsedMs: ready.elapsedMs + reservation.elapsedMs,
      actions: [ready, reservation],
    };
  }

  const refresh = await runLeadAction(client, "DIALER_REFRESH", criteria);
  console.info("[cx-bulk-load] native_get_leads", {
    ok: refresh.ok,
    reason: refresh.ok ? null : "dialer-refresh-failed",
    sessionId: session.sessionId || null,
    candidateId: candidate.queueItemId || candidate._id || null,
    campaignId: criteria.campaignId,
    externId: criteria.externIds?.[0] || null,
    elapsedMs: Date.now() - startedAt,
    actions: [ready, refresh],
  });
  return {
    ok: refresh.ok,
    source: "ringcx-native-lead-action",
    reason: refresh.ok ? null : "dialer-refresh-failed",
    error: refresh.error || null,
    elapsedMs: ready.elapsedMs + refresh.elapsedMs,
    actions: [ready, refresh],
  };
}

function isBulkLoginOffhook(summary = {}) {
  if (!summary || typeof summary !== "object") return false;
  if (summary.offHook === false) return false;
  if (summary.ghostLogin === true) return false;
  if (summary.loggedIn === false) return false;
  return (
    summary.offHook === true
    || Boolean(summary.sessionId)
    || Boolean(summary.iqServerId)
    || /connected|off\s*-?\s*hook/i.test(`${summary.status || ""} ${summary.auxState || ""} ${summary.loginType || ""}`)
  );
}

function makeHttpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function readErrorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function readErrorStatus(error) {
  return error?.status || error?.statusCode || error?.response?.status || null;
}

async function safeBulkAppointmentStep(executor, fallback = {}, map = (value) => ({ result: value })) {
  try {
    const mapped = map(await executor()) || {};
    const step = {
      ...fallback,
      ...mapped,
    };
    if (step.ok == null && step.skipped !== true) step.ok = true;
    return step;
  } catch (error) {
    return {
      ...fallback,
      ok: false,
      skipped: false,
      error: readErrorMessage(error),
      status: readErrorStatus(error),
    };
  }
}

function bulkSessionBelongsToAgent(session = {}, agent = {}) {
  if (!session || !agent) return false;
  const sessionEmail = normalizeEmail(session.agentEmail);
  const agentEmail = normalizeEmail(agent.agentEmail);
  const sessionExtensionId = normalizeExternalId(session.agentExtensionId);
  const agentExtensionId = normalizeExternalId(agent.agentExtensionId);
  if (sessionEmail && agentEmail && sessionEmail === agentEmail) return true;
  if (sessionExtensionId && agentExtensionId && sessionExtensionId === agentExtensionId) return true;
  return false;
}

async function findOwnedBulkLoadSession(sessionId, agent) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  const session = await cxBulkLoadSessionRepository.findBulkLoadSessionById(normalized);
  if (!session) {
    throw makeHttpError("Bulk-load session not found", 404, "cx-bulk-load-session-not-found");
  }
  if (!bulkSessionBelongsToAgent(session, agent)) {
    throw makeHttpError("Cannot access another agent's bulk-load session", 403, "cx-bulk-load-session-forbidden");
  }
  return session;
}

async function resolveAgentContext(input = {}, user = {}) {
  const requesterEmail = normalizeEmail(user.email);
  const targetEmail = normalizeEmail(input.agentEmail || requesterEmail);
  if (!targetEmail) throw makeHttpError("agentEmail is required", 400, "cx-bulk-load-agent-required");
  if (targetEmail !== requesterEmail && String(user.role || "").toLowerCase() !== "admin") {
    throw makeHttpError("Cannot control another agent's bulk-load rail", 403, "cx-bulk-load-agent-forbidden");
  }
  const account = await userAccountRepository.findUserAccountByEmail(targetEmail).catch(() => null);
  return {
    agentEmail: targetEmail,
    account, // M4: surfaced so the start can resolve policy-driven familyTargets
    agentExtensionId: normalizeExternalId(input.agentExtensionId || (account && account.extensionId) || user.extensionId || ""),
    cxAgentId: normalizeExternalId(
      input.cxAgentId ||
        (account && (account.cxAgentId || account.ringcxAgentId)) ||
        user.cxAgentId ||
        user.ringcxAgentId ||
        "",
    ),
    ringcxAgentGroupId: normalizeExternalId(
      input.agentGroupId
        || input.ringcxAgentGroupId
        || (account && account.metadata && (account.metadata.ringcxAgentGroupId || account.metadata.cxAgentGroupId))
        || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
        || "",
    ),
  };
}

// The runtime gate: only an agent the resolver places on bulk_load may proceed.
// Default-off — when CX_DIAL_RUNTIME_BULK_LOAD_ENABLED is false the resolver never
// returns bulk_load, so every request 403s.
function assertBulkRuntime(agent) {
  const resolution = resolveCxDialRuntimeMode({ userEmail: agent.agentEmail, extensionId: agent.agentExtensionId });
  if (!isCxBulkLoadRuntime(resolution)) {
    throw makeHttpError(
      `bulk_load runtime not active for ${agent.agentEmail} (${resolution.reason})`,
      403,
      "cx-bulk-load-runtime-inactive",
    );
  }
  return resolution;
}

let _service = null;
function getService() {
  if (_service) return _service;
  const client = createRingcxVoiceClient();
  // M11 gate 2: dispatch one cadence event into the existing finalizer.
  const dispatchCadenceEvent = async (event) =>
    handleCxTerminalCallOutcome({
      queueItemId: event.queueItemId,
      domain: event.domain,
      caseId: event.caseId,
      uii: event.uii,
      externId: event.externId,
      outcome: event.outcome,
      disposition: event.outcome,
      source: event.source || "cx-bulk-load",
      sourceService: "cx-bulk-load",
      actorEmail: event.agentEmail,
      outcomeAt: event.at || new Date().toISOString(),
    });
  const outcomeAdapter = createCxBulkLoadOutcomeAdapter({
    recordCadenceEvent: async (event) => {
      // M11 gate 2: DURABLE terminal recording. The live click path only writes the
      // insert-once outbox row; the control-plane drain replays it into cadence/Logics.
      // That keeps slow business cleanup (especially DNC stop/sync work) out of the
      // call-advance response while preserving crash-safe counting.
      const idemKey = event.idemKey || makeOutcomeIdemKey({
        sessionId: event.sessionId,
        queueItemId: event.queueItemId,
        uii: event.uii,
        eventType: "terminal",
      });
      const inserted = await cxTerminalOutboxRepository
        .insertOnce({
          idemKey,
          sessionId: event.sessionId || null,
          rail: "bulk_load",
          domain: event.domain || null,
          queueItemId: event.queueItemId || null,
          uii: event.uii || null,
          caseId: event.caseId != null ? Number(event.caseId) : null,
          agentEmail: event.agentEmail || null,
          agentName: event.agentName || null,
          externId: event.externId || null,
          phone: event.phone || null,
          phoneLast4: event.phoneLast4 || null,
          durationSec: event.durationSec != null ? Number(event.durationSec) : null,
          coachSessionId: event.coachSessionId || null,
          outcome: event.outcome || null,
          source: event.source || null,
          payload: event,
        })
        .catch(async (err) => {
          // If the outbox itself is unavailable, fail open to the old direct dispatch so
          // terminal events are not silently lost. This is an outage path, not normal flow.
          await dispatchCadenceEvent(event);
          return { idemKey, fallbackDispatched: true, error: err };
        });
      if (inserted === null) {
        return { written: false, idemKey, reason: "duplicate" };
      }
      return {
        written: true,
        idemKey,
        deferred: inserted?.fallbackDispatched !== true,
        fallbackDispatched: inserted?.fallbackDispatched === true,
      };
    },
  });
  const queueStateAdapter = {
    // M11 gate 7: cross-pool publish interlock — is this case already active on a DIFFERENT
    // queue row? Mirrors the slow/legacy publisher's findActiveClaimForCase guard.
    async findActiveSibling({ domain = null, caseId = null, excludeId = null } = {}) {
      return cxDialQueueRepository.findActiveClaimForCase(domain, caseId, excludeId);
    },
    async markCandidatePublished({ session = {}, candidate = {}, externId = null, campaignId = null } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      if (!queueItemId) return null;
      const now = new Date();
      // M11 gate 5: ownership-guarded CAS. The row MUST already be `claimed` by THIS session's
      // reservation — re-assert {state:'claimed', reservationSessionId} so a publish stamp can
      // never land on a row another session reserved or that already advanced. `bulkLoadSessionId`
      // stays as debug metadata only; `reservationSessionId` is the real ownership lock.
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["claimed"],
        {
          state: "claimed",
          claimUntil: null,
          lastClaimedAt: now,
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadPublishedAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.lastRingcxPublishedAt": now,
          "metadata.lastRingcxPublishedCampaignId": campaignId || session.ringcx?.campaignId || null,
          "metadata.lastRingcxPublishedDialGroupId": session.ringcx?.dialGroupId || null,
          "metadata.lastRingcxPublishedExternId": externId || candidate.externId || null,
          "metadata.lastDialExecutionUii": null,
          "metadata.lastQueueAttemptUii": null,
          "metadata.servingAt": null,
          "metadata.lastRingcxActiveCall": null,
          "metadata.lastRingcxMatchReasons": [],
          "metadata.lastDialIntentStatus": "bulk-loaded",
          "metadata.lastQueueAttemptHeldForDisposition": false,
          "metadata.wrapUpRequired": false,
          "metadata.lastReleasedAt": null,
          "metadata.lastReleaseReason": null,
          "metadata.lastReleasedExtensionId": null,
          "metadata.lastReleasedAgentName": null,
          "metadata.lastReleasedBy": null,
        },
        { match: { "metadata.reservationSessionId": session.sessionId } },
      );
    },
    async markCandidateServing({ session = {}, candidate = {}, uii = null, activeCallSummary = null, matchReasons = [] } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      if (!queueItemId) return null;
      const now = new Date();
      // M11 gate 5: ownership-guarded serving stamp. Only a row THIS session still holds
      // (claimed/serving + matching reservationSessionId) may be moved to `serving`. A miss
      // (null return) is the signal the runtime uses to NOT promote the lead to `current`.
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["claimed", "serving"],
        {
          state: "serving",
          claimUntil: null,
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadActiveAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.servingAt": now,
          "metadata.lastDialExecutionUii": uii || null,
          "metadata.lastQueueAttemptUii": uii || null,
          "metadata.lastDialExecutionSource": "cx-bulk-load",
          "metadata.lastDialIntentStatus": "active",
          "metadata.lastQueueAttemptHeldForDisposition": true,
          "metadata.wrapUpRequired": true,
          "metadata.wrapUpReason": "bulk-load-active-call",
          "metadata.lastRingcxActiveCall": activeCallSummary || null,
          "metadata.lastRingcxMatchReasons": Array.isArray(matchReasons) ? matchReasons : [],
        },
        { match: { "metadata.reservationSessionId": session.sessionId } },
      );
    },
    async markAdoptedCandidateServing({ session = {}, candidate = {}, uii = null, activeCallSummary = null, matchReasons = [] } = {}) {
      const queueItemId = normalizeExternalId(candidate.queueItemId || candidate.id || candidate._id);
      const externId = normalizeExternalId(candidate.externId || candidate.ringcx?.externId);
      if (!queueItemId || !externId) return null;
      const now = new Date();
      return cxDialQueueRepository.transitionQueueItemState(
        queueItemId,
        ["queued", "ready", "claimed", "serving"],
        {
          state: "serving",
          claimUntil: null,
          lastClaimedAt: now,
          "assignment.extensionId": session.agentExtensionId || null,
          "assignment.agentName": session.agentEmail || null,
          "assignment.assignedAt": now,
          "assignment.queueFamilySnapshot": candidate.queueFamily || null,
          "metadata.reservationSessionId": session.sessionId || null,
          "metadata.bulkLoadSessionId": session.sessionId || null,
          "metadata.bulkLoadActiveAt": now,
          "metadata.bulkLoadRuntime": "bulk_load",
          "metadata.servingAt": now,
          "metadata.lastDialExecutionUii": uii || null,
          "metadata.lastQueueAttemptUii": uii || null,
          "metadata.lastDialExecutionSource": "cx-bulk-load-adopted-active",
          "metadata.lastDialIntentStatus": "active",
          "metadata.lastQueueAttemptHeldForDisposition": true,
          "metadata.wrapUpRequired": true,
          "metadata.wrapUpReason": "bulk-load-active-call",
          "metadata.lastRingcxActiveCall": activeCallSummary || null,
          "metadata.lastRingcxMatchReasons": Array.isArray(matchReasons) ? matchReasons : [],
        },
        {
          match: {
            domain: normalizeDomain(session.domain || candidate.domain),
            $or: [
              { "metadata.rcxVisibilityExternId": externId },
              { "metadata.lastRingcxPublishedExternId": externId },
              { "metadata.lastDialExecutionRingcxPublish.externId": externId },
            ],
          },
        },
      );
    },
  };
  const agentLifecycleAdapter = {
    async pauseProgressiveDialing({ session = {}, reason = null, waitForRestore = false } = {}) {
      return pauseRingcxProgressiveDialing(client, session, {
        reason: reason || "bulk-progressive-pause",
        waitForRestore,
      }).catch((error) => ({
        ok: false,
        skipped: true,
        reason: "progressive-pause-failed",
        error: error && error.message ? error.message : String(error),
      }));
    },
    async clearTerminalHold({ session = {}, outcome = null } = {}) {
      const extensionId = normalizeExternalId(session.agentExtensionId);
      if (!extensionId) return null;
      const existing = await agentStateRepository.findAgentStateByExtensionId(extensionId).catch(() => null);
      if (String(existing?.cxRouting?.reason || "").trim().toLowerCase() !== "long-call-hold") {
        return null;
      }
      const now = new Date();
      return agentStateRepository.updateAgentState(
        extensionId,
        {
          status: "available",
          activityState: "idle",
          activePlatform: "none",
          currentCall: {},
          "cxRouting.desiredAvailability": "available",
          "cxRouting.reason": "bulk-terminal-cleared",
          "cxRouting.syncedAt": now,
          "cxRouting.lastSource": "cx-bulk-load-terminal",
          "cxRouting.manualUnavailableAt": null,
          "cxRouting.pauseType": null,
          "cxRouting.pauseStartedAt": null,
          "cxRouting.pauseReleaseAt": null,
          lastCallOutcome: outcome || "bulk-terminal",
          lastActivityAt: now,
          lastStatusChange: now,
          "upstream.source": "cx-bulk-load-terminal",
          "upstream.mirroredAt": now,
        },
      );
    },
  };

  _service = createCxBulkLoadRuntimeService({
    repo: cxBulkLoadSessionRepository,
    leadSource,
    publisher,
    watcher,
    // Bulk mode owns a closed buffer. The account watcher may observe every
    // active RingCX call, but it must only promote calls already present in this
    // session's acceptedBuffer/current. Adopting arbitrary matching queue rows
    // lets unrelated campaign activity steal the session and hide the terminal
    // buttons for the agent.
    resolveExternalCandidates: null,
    outcomeAdapter,
    terminalExecutor: async ({ session = {}, candidate = {}, outcome = null, notes = null } = {}) => {
      // SIMPLEST PATH: no hangup. Dispositioning the active call is what ends it
      // and advances the dialer in RingCX. One call → RingCX disposition, then the
      // runtime writes the terminal outcome to Mongo. (hangupCall was accepted but
      // never dropped a ringing call — verified via [DISPTRACE].)
      const uii = normalizeExternalId(candidate.uii);
      const disposition = bulkOutcomeDisposition(outcome);
      const _step = createDispositionTrace("bulkDispose");
      _step("ENTER", { uii, outcome, disposition });
      if (!uii) {
        _step("NO uii on candidate → cannot disposition");
        return { ok: false, executed: false, reason: "missing-uii", disposition };
      }
      try {
        const response = await client.dispositionCall(uii, {
          disposition,
          callback: false,
          notes: notes || undefined,
        });
        const ok = response !== false;
        _step("dispositionCall DONE", { ok, response: ok ? "accepted" : response });
        if (!ok) {
          return {
            ok: false,
            executed: true,
            disposition,
            uii,
            dispositionStatus: "rejected",
            response,
          };
        }
        if (agentLifecycleAdapter && typeof agentLifecycleAdapter.pauseProgressiveDialing === "function") {
          agentLifecycleAdapter
            .pauseProgressiveDialing({
              session,
              reason: "bulk-disposition-accepted",
              waitForRestore: false,
            })
            .then((pause) => {
              _step("post-disposition progressive pause", pause);
            })
            .catch((error) => {
              _step("post-disposition progressive pause failed", {
                message: error && error.message ? error.message : String(error),
              });
            });
        }
        const release = await confirmRingcxUiiReleased(client, uii, {
          accountId: session.ringcx?.accountId || candidate.accountId || candidate.ringcx?.accountId,
        });
        _step("release verification DONE", release);
        if (!release.ok) {
          return {
            ok: false,
            executed: true,
            disposition,
            uii,
            dispositionStatus: "accepted-but-still-active",
            reason: release.reason || "active-call-release-unconfirmed",
            activeCall: release.activeCall || null,
            error: release.error || null,
            response,
          };
        }
        return {
          ok: true,
          executed: true,
          disposition,
          uii,
          dispositionStatus: "accepted",
          releaseStatus: release.status,
          releaseAttempts: release.attempts,
          response,
        };
      } catch (error) {
        _step("dispositionCall ERROR", {
          status: error && error.status,
          message: error && error.message ? error.message : String(error),
        });
        return {
          ok: false,
          executed: false,
          disposition,
          uii,
          error: error && error.message ? error.message : String(error),
        };
      }
    },
    queueStateAdapter,
    agentLifecycleAdapter,
    manualDialer: {
      async startNext({ session = {}, candidate = {}, ringDuration = null } = {}) {
        const destination = firstNonEmpty(candidate.phone);
        if (!destination) return { ok: false, reason: "missing-destination" };
        const context = await resolveBulkManualDialContext(session);
        if (!context.username) return { ok: false, reason: "missing-ringcx-username" };
        if (!context.callerId) return { ok: false, reason: "missing-caller-id" };
        const startedAt = Date.now();
        try {
          const response = await client.placeManualCall({
            username: context.username,
            destination,
            callerId: context.callerId,
            ringDuration: Number(ringDuration) > 0 ? Number(ringDuration) : 5,
          });
          return {
            ok: response !== false,
            elapsedMs: Date.now() - startedAt,
            response: response === true ? true : undefined,
            usernameSource: context.usernameSource,
            callerIdSource: context.callerIdSource,
          };
        } catch (error) {
          return {
            ok: false,
            elapsedMs: Date.now() - startedAt,
            reason: "place-manual-call-failed",
            error: error && error.message ? error.message : String(error),
          };
        }
      },
    },
    leadStarter: {
      async getLeads({ session = {}, candidate = {} } = {}) {
        return requestNativeRingcxGetLeads(client, { session, candidate });
      },
    },
    offhookGate: {
      async isAgentOffhook(session = {}, gateOptions = {}) {
        const agentId = normalizeExternalId(session.cxAgentId);
        const agentGroupId = normalizeExternalId(
          session.ringcx?.agentGroupId
          || process.env.RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID
          || "",
        );
        if (!agentId || !agentGroupId) {
          return {
            ok: false,
            reason: !agentId ? "missing-agent-id" : "missing-agent-group-id",
          };
        }
        const ringcxClient = gateOptions.client || client;
        if (!ringcxClient || typeof ringcxClient.getAgentLogin !== "function") {
          return { ok: false, reason: "agent-login-unavailable" };
        }
        try {
          const { summarizeRingcxLoginPayload } = require("./dialService");
          const login = await ringcxClient.getAgentLogin(agentId, agentGroupId);
          const summary = summarizeRingcxLoginPayload(login);
          return {
            ok: isBulkLoginOffhook(summary),
            reason: isBulkLoginOffhook(summary) ? "agent-offhook" : "agent-not-offhook",
            summary,
          };
        } catch (error) {
          return {
            ok: false,
            reason: `agent-login-read-failed:${error.message || error}`,
          };
        }
      },
    },
    client,
    listReadyQueueItems: async ({ domain, limit, agentExtensionId, includeUnassignedVisible } = {}) => {
      const visibleExtensionId = normalizeExternalId(agentExtensionId);
      if (!visibleExtensionId) return [];
      return cxDialQueueRepository.listQueueItems({
        domain: domain || undefined,
        states: ["ready"],
        visibleExtensionId,
        includeUnassignedVisible: includeUnassignedVisible === true,
        sort: {
          "assignment.assignedAt": 1,
          createdAt: 1,
          _id: 1,
        },
        limit,
      });
    },
    reduce: reduceCxBulkLoadState,
    // M4: the shared reservation service — the bulk rail's ONLY source of claimed rows.
    // M11 gate 6: inject queueItemRepository so the M5 claim-time cross-pool interlock
    // (assertNotActiveInUcq → existsForLead) is LIVE on this rail, not dormant — a caseId
    // already active in the legacy UCQ pool is dropped+released at reserve time.
    reservationService: createCxQueueReservationService({ cxDialQueueRepository, queueItemRepository }),
    contactEligibilityAdapter: {
      async resolve({ domain, caseId } = {}) {
        const eligibility = await resolveCaseContactEligibility(domain, caseId, {
          enforceStop: true,
          requireFreshLogicsStatus: readBooleanEnv("CX_BULK_LOAD_REQUIRE_FRESH_LOGICS_STATUS", false),
          currentStage: "contact-blocked",
          sourceService: "cx-bulk-load",
        });
        return {
          ok: eligibility.ok,
          reason: eligibility.reason || null,
          detail: eligibility.detail || null,
          enforced: Boolean(eligibility.enforcement),
        };
      },
    },
    newSessionId: () => `cxbl-${crypto.randomUUID()}`,
  });
  return _service;
}

// Resolve the session id for an operation: explicit, else the agent's active one.
async function resolveSessionId(input, agent) {
  if (input.sessionId) {
    const session = await findOwnedBulkLoadSession(input.sessionId, agent);
    return session.sessionId;
  }
  const active = await cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
  return active ? active.sessionId : null;
}

// ── public entry functions (what the routes call) ───────────────────────

async function startCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const agentRoute = resolveBulkAgentRingcxRoute(agent, input);
  // M4/M7: resolve the per-family reservation targets ONCE from the agent's account policy.
  // (A missing/disabled account yields all-zero targets — fail-closed: the rail reserves nothing
  // rather than over-serving.)
  const targetSize = Number(input.targetSize) > 0 ? Number(input.targetSize) : 35; // M11 gate 8: canonical 35
  const familyTargets = buildFamilyTargets({ policy: agent.account, totalDeficit: targetSize, env: process.env });
  return getService().startCxBulkLoadSession({
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
    cxAgentId: agent.cxAgentId,
    domain: normalizeDomain(input.domain),
    targetSize: input.targetSize,
    refillThreshold: input.refillThreshold,
    familyTargets,
    claimMinutes: input.claimMinutes,
    ringcx: {
      accountId: input.accountId || readEnv("RINGCX_VOICE_ACCOUNT_ID"),
      campaignId: input.campaignId || input.rcxCampaignId || agentRoute.campaignId || readEnv("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID"),
      dialGroupId: input.dialGroupId || input.rcxDialGroupId || agentRoute.dialGroupId || readEnv("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID"),
      agentGroupId: input.agentGroupId || agent.ringcxAgentGroupId || readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID"),
      dialPriority: input.dialPriority || "NORMAL",
      agentRoute,
    },
  });
}

async function getCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  const sessionId = input.sessionId
    ? (await findOwnedBulkLoadSession(input.sessionId, agent)).sessionId
    : null;
  return getService().getCxBulkLoadSession({
    sessionId,
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
  });
}

async function watchCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().watchCxBulkLoadSession({ sessionId });
}

async function watchCxBulkLoadAccountActiveCalls(input = {}) {
  return getService().watchAccountActiveCalls({
    domain: input.domain,
    accountId: input.accountId,
    sessionId: input.sessionId,
    agentEmail: input.agentEmail,
    agentExtensionId: input.agentExtensionId,
    now: input.now,
  });
}

async function submitCxBulkLoadDisposition(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().submitCxBulkLoadDisposition({
    sessionId,
    disposition: input.disposition || input.outcome,
    callback: input.callback,
    callBackDTS: input.callBackDTS,
    notes: input.notes,
    hangup: input.hangup,
  });
}

async function submitCxBulkLoadAppointmentWrap(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;
  if (String(session.status || "") !== "running") {
    throw makeHttpError("Bulk-load session is not running", 409, "cx-bulk-load-session-not-running");
  }
  const current = session.current && typeof session.current === "object" ? session.current : {};
  const resolvedCaseId = Number(
    input.caseId ??
      input.CaseID ??
      current.caseId,
  );
  if (!Number.isFinite(resolvedCaseId) || resolvedCaseId <= 0) {
    throw makeHttpError("Bulk-load appointment requires a valid caseId", 400, "cx-bulk-load-appointment-case-required");
  }

  const domain = normalizeDomain(input.domain || current.domain || session.domain || agent.account?.company);
  const result = {
    ok: true,
    session,
    appointment: {
      ok: false,
      skipped: true,
      reason: "not-attempted",
    },
    workbench: {
      skipped: true,
      reason: "not-attempted",
    },
    assign: {
      skipped: true,
      reason: "not-requested",
    },
    postdate: {
      skipped: true,
      reason: "not-requested",
    },
    terminal: {
      skipped: true,
      reason: "not-attempted",
    },
    resume: {
      skipped: true,
      reason: "not-attempted",
    },
  };

  const appointmentStep = await safeBulkAppointmentStep(
    () => createCxAppointment(domain, options.user || {}, {
      caseId: resolvedCaseId,
      appointmentDate: input.appointmentDate,
      appointmentTime: input.appointmentTime,
      appointmentTimezone: input.appointmentTimezone,
      note: input.note,
      phone: input.phone || current.phone || null,
      searchPhone: input.searchPhone || current.phone || current.searchPhone || null,
      prospectName: input.prospectName || current.name || null,
      sourceName: input.sourceName || current.sourceName || current.intakeSource || null,
      queueItemId: input.queueItemId || current.queueItemId || current.queueTicketId || null,
      queueTicketId: input.queueTicketId || input.queueItemId || current.queueTicketId || current.queueItemId || null,
      queueActionKey: input.queueActionKey || current.queueActionKey || null,
      assignedExtensionId: input.assignedExtensionId || null,
    }),
    {
      ok: false,
      skipped: false,
      reason: "appointment-create-failed",
    },
    (appointmentResult) => ({
      ok: appointmentResult?.ok !== false,
      skipped: false,
      reason: appointmentResult?.reason || null,
      error: appointmentResult?.error || null,
      status: appointmentResult?.status || null,
      result: appointmentResult,
    }),
  );
  result.appointment = appointmentStep;
  if (appointmentStep.ok !== true) {
    result.ok = false;
    return result;
  }

  const appointmentResult = appointmentStep.result;
  result.workbench = await safeBulkAppointmentStep(
    () => executeCxAppointmentWorkbenchActions(domain, options.user || {}, appointmentResult),
    {
      ok: false,
      reason: "workbench-failed",
    },
    (workbenchResult) => ({
      ok: workbenchResult?.ok !== false,
      skipped: workbenchResult?.skipped === true,
      reason: workbenchResult?.reason || null,
      task: workbenchResult?.task || null,
      activity: workbenchResult?.activity || null,
      error: workbenchResult?.error || null,
      details: workbenchResult?.details || null,
    }),
  );

  if (input.assignToMe === true) {
    result.assign = await safeBulkAppointmentStep(
      () => requestCxAssignCaseToMe(domain, options.user || {}, {
        caseId: resolvedCaseId,
        note: input.note,
      }),
      {
        ok: false,
        skipped: false,
        reason: "assign-failed",
      },
      (assignResult) => ({
        ok: assignResult?.ok !== false,
        skipped: false,
        reason: assignResult?.reason || null,
        error: assignResult?.error || null,
        status: assignResult?.status || null,
        result: assignResult,
      }),
    );
  } else {
    result.assign = { skipped: true, reason: "not-requested" };
  }

  if (input.postdate === true) {
    result.postdate = await safeBulkAppointmentStep(
      () => executeCxLogicsUpdateCase(domain, options.user || {}, {
        caseId: resolvedCaseId,
        CaseID: resolvedCaseId,
        status: "post-date",
        skipQueueFinalize: true,
        notes: input.note,
      }),
      {
        ok: false,
        skipped: false,
        reason: "postdate-failed",
      },
      (postdateResult) => ({
        ok: postdateResult?.ok !== false,
        skipped: postdateResult?.skipped === true,
        reason: postdateResult?.reason || null,
        error: postdateResult?.error || null,
        status: postdateResult?.status || null,
        result: postdateResult,
      }),
    );
  } else {
    result.postdate = { skipped: true, reason: "not-requested" };
  }

  result.terminal = await safeBulkAppointmentStep(
    () => submitCxBulkLoadDisposition({
      sessionId: session.sessionId,
      disposition: "answered",
      notes: input.note,
    }, options),
    {
      ok: false,
      skipped: false,
      dispositionOk: false,
      reason: "terminal-disposition-failed",
    },
    (terminal) => ({
      ok: terminal?.dispositionOk === true,
      dispositionOk: terminal?.dispositionOk === true,
      skipped: terminal == null,
      reason: terminal == null
        ? "terminal-missing"
        : terminal?.terminal?.reason || terminal?.reason || null,
      error: terminal?.terminal?.error || terminal?.error || null,
      status: terminal?.terminal?.status || terminal?.status || null,
      result: terminal || null,
    }),
  );
  const terminal = result.terminal.result;
  result.session = terminal || session;

  if (result.terminal.dispositionOk !== true) {
    result.ok = false;
    result.resume = {
      skipped: true,
      reason: result.terminal.reason || result.terminal.error || "terminal-rejected",
    };
    return result;
  }

  result.resume = await safeBulkAppointmentStep(
    () => resumeCxBulkLoadProgressiveDialing({
      sessionId: session.sessionId,
      reason: "bulk-appointment-wrap-complete",
    }, options),
    {
      ok: false,
      reason: "progressive-resume-failed",
    },
    (resume) => ({
      ok: resume?.ok === true,
      resumed: resume?.resumed === true,
      restored: resume?.restored === true,
      skipped: resume == null,
      error: resume?.error || null,
      reason: resume?.reason || null,
      status: resume?.status || null,
    }),
  );
  if (!result.resume.ok) result.ok = false;
  return result;
}

async function submitCxBulkLoadReviewOutcome(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = input.sessionId
    ? await findOwnedBulkLoadSession(input.sessionId, agent)
    : await cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
  if (!session) return null;
  const outcome = String(input.outcome || "").trim();
  if (!["dnc"].includes(outcome)) {
    throw makeHttpError("Unsupported bulk-load review outcome", 400, "cx-bulk-load-review-outcome-unsupported");
  }
  const queueItemId = normalizeExternalId(input.queueItemId);
  const uii = normalizeExternalId(input.uii);
  if (!queueItemId || !uii) {
    throw makeHttpError("Bulk-load review requires queueItemId and uii", 400, "cx-bulk-load-review-identity-required");
  }
  const updated = await cxTerminalOutboxRepository.updatePendingOutcomeByIdentity({
    sessionId: session.sessionId,
    queueItemId,
    uii,
    outcome,
    source: "agent-auto-review",
  });
  return {
    ok: Boolean(updated),
    updated: Boolean(updated),
    reason: updated ? null : "terminal-outbox-already-drained-or-missing",
    sessionId: session.sessionId,
    queueItemId,
    uii,
    outcome,
  };
}

async function startCxBulkLoadNextManualCall(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().startCxBulkLoadNextManualCall({
    sessionId,
    ringDuration: input.ringDuration,
  });
}

async function startCxBulkLoadGetLeads(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().startCxBulkLoadGetLeads({ sessionId });
}

async function resolveOwnedBulkSession(input = {}, agent = {}) {
  if (input.sessionId) return findOwnedBulkLoadSession(input.sessionId, agent);
  return cxBulkLoadSessionRepository.findActiveBulkLoadSessionForAgent(agent);
}

async function pauseCxBulkLoadProgressiveDialing(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;
  return pauseRingcxProgressiveDialing(createRingcxVoiceClient(), session, {
    reason: input.reason || "bulk-progressive-pause",
    holdUntilResume: input.holdUntilResume === true,
    waitForRestore: input.waitForRestore === true,
  });
}

async function resumeCxBulkLoadProgressiveDialing(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const session = await resolveOwnedBulkSession(input, agent);
  if (!session) return null;
  return resumeRingcxProgressiveDialing(createRingcxVoiceClient(), session, {
    reason: input.reason || "bulk-progressive-resume",
  });
}

async function skipCxBulkLoadCurrent(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().skipCxBulkLoadCurrent({ sessionId });
}

async function killCxBulkLoadSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  // Same gate as every other mutating path: only a bulk_load agent may touch a
  // bulk session. (Cleaning up a stuck session after a global rollback is an
  // ops/reaper concern, not this agent route.)
  assertBulkRuntime(agent);
  const sessionId = await resolveSessionId(input, agent);
  if (!sessionId) return null;
  return getService().killCxBulkLoadSession({ sessionId, reason: input.reason || "manual" });
}

module.exports = {
  startCxBulkLoadSession,
  getCxBulkLoadSession,
  watchCxBulkLoadSession,
  watchCxBulkLoadAccountActiveCalls,
  submitCxBulkLoadDisposition,
  startCxBulkLoadNextManualCall,
  startCxBulkLoadGetLeads,
  pauseCxBulkLoadProgressiveDialing,
  resumeCxBulkLoadProgressiveDialing,
  skipCxBulkLoadCurrent,
  submitCxBulkLoadReviewOutcome,
  submitCxBulkLoadAppointmentWrap,
  killCxBulkLoadSession,
  _test: {
    bulkOutcomeDisposition,
    confirmRingcxUiiReleased,
    pauseRingcxProgressiveDialing,
    resumeRingcxProgressiveDialing,
  },
};
