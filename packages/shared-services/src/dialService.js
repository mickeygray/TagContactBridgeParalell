"use strict";

const {
  callSessionRepository,
  queueItemRepository,
  agentSliceRepository,
  agentStateRepository,
  leadActivityRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");
const {
  getDisposition,
  validateDisposition,
  computeNextTouchAt,
} = require("./dispositionMapService");
const {
  setActivityState,
  bumpLastActivityAt,
  applyCallEndedDailyStats,
  normalizeDailyStats,
} = require("./agentAvailabilityService");
const { maybeCompleteSlice } = require("./agentSliceService");
const {
  resolveCaseContactEligibility,
} = require("./contactEligibilityService");

// dialService — places outbound calls, terminates and dispositions
// existing calls. The bridge between SPA actions and RingCX/RC APIs.
//
// Two primary entry points:
//
//   placeCall(agentId, queueItemId, options)
//     1. Atomic claim QueueItem (in_slice|fresh_assigned → dialing)
//     2. Acquire lead lock (queue_active → in_call)
//     3. AgentState.activityState = "dialing"
//     4. RingCX placeManualCall API call (with timeout)
//     5. CallSession created with state: "placing"
//     6. Returns { sessionId, queueItem, logicsUrl } to SPA
//
//   terminateAndDispose(callSessionId, dispositionKey, payload)
//     1. Validate disposition
//     2. RingCX hangupCall (terminates if still active)
//     3. RingCX campaign auto-disposition clears the agent after timeout
//     4. CallSession.state = "dispositioned"
//     5. QueueItem.state = "completed" or "recycled"
//     6. Slice.completedCount++ (and maybe markCompleted)
//     7. Release lead lock
//     8. AgentState.activityState = "dispositioning" → "idle"
//     9. Trigger fresh-lead drain (hand off pending fresh items if any)
//
// All steps are designed to be idempotent and recover-on-error.
// Failures during placeCall trigger a full rollback. terminateAndDispose
// is idempotent: calling it twice with the same args is a no-op.

const RCX_API_TIMEOUT_MS = Number(process.env.RCX_API_TIMEOUT_MS) || 15_000;
const RCX_PLACING_TTL_MS = Number(process.env.RCX_PLACING_TTL_MS) || 2 * 60 * 1000;
const RCX_RINGING_TTL_MS = Number(process.env.RCX_RINGING_TTL_MS) || 5 * 60 * 1000;
const DEFAULT_MANUAL_CALL_RING_DURATION_SECONDS = 20;
const DEFAULT_RCX_ACTIVE_CALL_VERIFY_MS = 25_000;
const DEFAULT_RCX_ACTIVE_CALL_VERIFY_INTERVAL_MS = 1_000;

// Activity states from which an agent can initiate a new dial.
const DIAL_ELIGIBLE_ACTIVITY_STATES = new Set(["idle", "dispositioning", "wrapup"]);

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldForceRingcxDisposition(payload = {}) {
  if (payload.forceRcxDisposition !== undefined) {
    return parseBooleanFlag(payload.forceRcxDisposition, false);
  }
  return parseBooleanFlag(process.env.RINGCX_FORCE_APP_DISPOSITION, false);
}

function shouldUseUserBearerForManualCall() {
  return parseBooleanFlag(process.env.RINGCX_MANUAL_CALL_USE_USER_BEARER, true);
}

function shouldSendManualCallerId() {
  return parseBooleanFlag(process.env.RINGCX_MANUAL_CALL_SEND_CALLER_ID, true);
}

function getManualCallRingDurationSeconds() {
  const configured = Number(
    process.env.RINGCX_MANUAL_CALL_RING_DURATION_SECONDS
      || process.env.RINGCX_MANUAL_CALL_RING_DURATION,
  );
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_MANUAL_CALL_RING_DURATION_SECONDS;
}

function getManualCallApiTimeoutMs() {
  return Math.max(RCX_API_TIMEOUT_MS, (getManualCallRingDurationSeconds() * 1000) + 5_000);
}

function getActiveCallVerifyMs() {
  const configured = Number(process.env.RCX_ACTIVE_CALL_VERIFY_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_RCX_ACTIVE_CALL_VERIFY_MS;
}

function getActiveCallVerifyIntervalMs() {
  const configured = Number(process.env.RCX_ACTIVE_CALL_VERIFY_INTERVAL_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_RCX_ACTIVE_CALL_VERIFY_INTERVAL_MS;
}

function getAutoDispositionWaitMs() {
  const configured = Number(process.env.RINGCX_AUTO_DISPOSITION_WAIT_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 5_000;
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function splitAutoDispositionList(value) {
  return String(value || "")
    .split(/[,\n|]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function addAutoDispositionCandidate(candidates, seen, disposition, extra = {}) {
  const normalized = disposition === "" ? "" : String(disposition || "").trim();
  if (normalized !== "" && !normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    disposition: normalized,
    source: extra.source || "candidate",
    dispositionId: extra.dispositionId || null,
    isDefault: Boolean(extra.isDefault),
    isDisabled: Boolean(extra.isDisabled),
    timeout: Number.isFinite(Number(extra.timeout)) ? Number(extra.timeout) : null,
  });
}

function readConfiguredAutoDispositions() {
  if (!Object.prototype.hasOwnProperty.call(process.env, "RINGCX_AUTO_DISPOSITION_VALUE")) {
    return [];
  }
  const raw = process.env.RINGCX_AUTO_DISPOSITION_VALUE;
  if (raw === "") return [""];
  return splitAutoDispositionList(raw);
}

function normalizeCampaignDispositionRows(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.records)) return value.records;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function sortCampaignDispositionRows(rows = []) {
  return [...rows].sort((a, b) => {
    const aEnabled = a?.isDisabled === true ? 0 : 1;
    const bEnabled = b?.isDisabled === true ? 0 : 1;
    if (aEnabled !== bEnabled) return bEnabled - aEnabled;
    const aDefault = a?.isDefault === true ? 1 : 0;
    const bDefault = b?.isDefault === true ? 1 : 0;
    if (aDefault !== bDefault) return bDefault - aDefault;
    const aTimeout = Number.isFinite(Number(a?.timeout)) ? Number(a.timeout) : Number.MAX_SAFE_INTEGER;
    const bTimeout = Number.isFinite(Number(b?.timeout)) ? Number(b.timeout) : Number.MAX_SAFE_INTEGER;
    if (aTimeout !== bTimeout) return aTimeout - bTimeout;
    const aRank = Number.isFinite(Number(a?.rank)) ? Number(a.rank) : Number.MAX_SAFE_INTEGER;
    const bRank = Number.isFinite(Number(b?.rank)) ? Number(b.rank) : Number.MAX_SAFE_INTEGER;
    return aRank - bRank;
  });
}

async function resolveAutoDispositionCandidates(client, context = {}) {
  const candidates = [];
  const seen = new Set();
  const campaignId = normalizeExternalId(
    context.campaignId
      || client?.config?.defaultCampaignId
      || process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID
      || process.env.RINGCX_VOICE_NEW_CAMPAIGN_ID
      || "",
  );
  const dialGroupId = normalizeExternalId(
    context.dialGroupId
      || client?.config?.defaultDialGroupId
      || process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID
      || "",
  );
  const lookup = {
    campaignId,
    dialGroupId,
    attempted: false,
    count: 0,
    error: null,
  };

  for (const configured of readConfiguredAutoDispositions()) {
    addAutoDispositionCandidate(candidates, seen, configured, { source: "env" });
  }

  if (campaignId && typeof client?.listCampaignDispositions === "function") {
    lookup.attempted = true;
    try {
      const rows = normalizeCampaignDispositionRows(
        await client.listCampaignDispositions(campaignId, dialGroupId || undefined),
      );
      lookup.count = rows.length;
      for (const row of sortCampaignDispositionRows(rows)) {
        addAutoDispositionCandidate(candidates, seen, row?.disposition, {
          source: row?.isDefault ? "campaign-default" : "campaign",
          dispositionId: row?.dispositionId,
          isDefault: row?.isDefault,
          isDisabled: row?.isDisabled,
          timeout: row?.timeout,
        });
      }
    } catch (error) {
      lookup.error = safeSerializeError(error);
    }
  }

  addAutoDispositionCandidate(candidates, seen, "Test", { source: "built-in-fallback" });
  addAutoDispositionCandidate(candidates, seen, "Default", { source: "built-in-fallback" });
  addAutoDispositionCandidate(candidates, seen, "", { source: "blank-fallback" });

  return {
    candidates,
    lookup,
  };
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

async function markAgentAvailableAfterAutoDisposition(extensionId, { logger = null, waitMs = null, uii = null } = {}) {
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!normalizedExtensionId) {
    return { skipped: true, reason: "missing-extension-id" };
  }
  const effectiveWaitMs = waitMs === null ? getAutoDispositionWaitMs() : Number(waitMs);
  if (Number.isFinite(effectiveWaitMs) && effectiveWaitMs > 0) await sleep(effectiveWaitMs);
  try {
    const now = new Date();
    const existing = await agentStateRepository
      .findAgentStateByExtensionId(normalizedExtensionId)
      .catch(() => null);
    const existingCall = existing?.currentCall && typeof existing.currentCall === "object"
      ? existing.currentCall
      : {};
    const existingCallChannel = String(existingCall.channel || "").trim().toLowerCase();
    const existingIdentity = callIdentity(existingCall);
    const requestedIdentity = normalizeExternalId(uii);
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
    if (existingCallChannel && existingCallChannel !== "cx" && String(existing?.activePlatform || "").trim().toUpperCase() !== "CX") {
      return {
        skipped: true,
        reason: "active-non-cx-call",
        extensionId: normalizedExtensionId,
        existingCallChannel,
      };
    }
    const beforeStats = normalizeDailyStats(existing?.dailyStats, now);
    const dailyStats = applyCallEndedDailyStats(existing || {}, beforeStats, {
      missed: false,
      date: now,
    });
    const updated = await agentStateRepository.updateAgentState(normalizedExtensionId, {
      activityState: "idle",
      status: "available",
      activePlatform: "none",
      currentCall: {},
      dailyStats,
      lastCallOutcome: "ringcx-auto-disposition",
      lastCallEndedAt: now,
      lastActivityAt: now,
      "cxRouting.enabled": true,
      "cxRouting.desiredAvailability": "available",
      "cxRouting.reason": "ringcx-auto-disposition",
      "cxRouting.syncedAt": now,
      "cxRouting.lastSource": "ringcx-auto-disposition",
      "upstream.source": "ringcx-auto-disposition",
      "upstream.mirroredAt": now,
    });
    return {
      ok: Boolean(updated),
      waitedMs: Number.isFinite(effectiveWaitMs) ? effectiveWaitMs : 0,
      extensionId: normalizedExtensionId,
      activityState: updated?.activityState || null,
      status: updated?.status || null,
      callEndCounted: Number(dailyStats.goodCalls || 0) > Number(beforeStats.goodCalls || 0)
        || Number(dailyStats.badCalls || 0) > Number(beforeStats.badCalls || 0),
    };
  } catch (error) {
    logger?.warn?.("dial.dispose.autoDisposition.agentAvailable.failed", {
      extensionId: normalizedExtensionId,
      error: error.message,
    });
    return {
      ok: false,
      waitedMs: Number.isFinite(effectiveWaitMs) ? effectiveWaitMs : 0,
      extensionId: normalizedExtensionId,
      error: error.message,
    };
  }
}

async function applyRingcxAutoDisposition(client, uii, { payload = {}, phase = null } = {}) {
  const resolution = await resolveAutoDispositionCandidates(client, payload);
  const attempts = [];
  let lastResponse = null;
  let lastError = null;

  for (const candidate of resolution.candidates) {
    const attempt = {
      disposition: candidate.disposition,
      dispositionId: candidate.dispositionId || null,
      dispositionSource: candidate.source || "candidate",
      campaignId: resolution.lookup.campaignId || null,
      dialGroupId: resolution.lookup.dialGroupId || null,
      phase,
      source: phase ? `auto-disposition-${phase}` : "auto-disposition",
    };
    try {
      const response = await withTimeout(
        () => client.dispositionCall(uii, {
          disposition: candidate.disposition,
          notes: payload.notes || undefined,
          phone: payload.phone || undefined,
        }),
        RCX_API_TIMEOUT_MS,
        "autoDispositionCall",
      );
      const result = { ...attempt, response, ok: response !== false };
      attempts.push(result);
      lastResponse = response;
      if (response !== false) {
        return {
          ok: true,
          status: "accepted",
          response,
          acceptedAttempt: result,
          attempts,
          resolution,
          error: null,
        };
      }
    } catch (error) {
      lastError = error;
      attempts.push({
        ...attempt,
        ok: false,
        error: {
          message: error.message,
          status: error.status || null,
          details: error.details || null,
        },
      });
      if ([401, 403].includes(Number(error?.status))) break;
    }
  }

  return {
    ok: false,
    status: lastError ? "error" : "rejected",
    response: lastResponse,
    acceptedAttempt: null,
    attempts,
    resolution,
    error: lastError,
  };
}

// ── Helper: derive caller ID + agent email from AgentState + env ──

function normalizeShellCompany(value) {
  return String(value || "").trim().toUpperCase();
}

function pickAgentExShell(account = null, domain = "TAG") {
  const shells = Array.isArray(account?.exShells) ? account.exShells : [];
  if (shells.length === 0) return null;
  const normalizedDomain = normalizeShellCompany(domain || account?.company || "TAG");
  return (
    shells.find((shell) => normalizeShellCompany(shell.company) === normalizedDomain)
    || shells.find((shell) => normalizeShellCompany(shell.company) === normalizeShellCompany(account?.company))
    || shells[0]
  );
}

function normalizeAgentIdentifier(value) {
  return String(value || "").trim().toLowerCase() || null;
}

function pickFirstAgentIdentifier(values = []) {
  for (const value of values) {
    const normalized = normalizeAgentIdentifier(value);
    if (normalized) return normalized;
  }
  return null;
}

async function resolveAgentDialContext(agent) {
  const account = agent?.extensionId
    ? await userAccountRepository.findUserAccountByExtensionId(agent.extensionId).catch(() => null)
    : null;
  // Email used by RingCX placeManualCall API to identify the agent's
  // phone session. RingCX's manual-call endpoint wants the RingCX
  // username when the user-managed seat has a generated login such as
  // acalloway+50810001_9322@..., not merely the office email.
  const agentEmail = pickFirstAgentIdentifier([
    account?.metadata?.ringcxUsername,
    account?.metadata?.ringcxAgentUsername,
    account?.metadata?.ringcxAgentEmail,
    account?.metadata?.cxUsername,
    account?.cxSession?.rcxAgentEmail,
    account?.cxAuth?.rcUserEmail,
    account?.email,
    agent?.agentEmail,
    agent?.email,
    process.env.RINGCX_VOICE_AGENT_EMAIL,
  ]);
  // Caller ID used for outbound. Prefer the user's EX shell number; this
  // is the "one company, one person" behavior we want for CX testing.
  const domain = String(agent?.company || "TAG").toUpperCase();
  const exShell = pickAgentExShell(account, domain);
  const callerId = domain === "WYNN"
    ? (exShell?.primaryPhone || account?.phone || process.env.WYNN_PROSPECT_CONTACT_PHONE || process.env.WYNN_RINGOUT_CALLER || null)
    : (exShell?.primaryPhone || account?.phone || process.env.TAG_CLIENT_CONTACT_PHONE || process.env.TAG_RINGOUT_CALLER || null);
  const agentLoginDest = exShell?.primaryPhone || null;
  return { agentEmail, callerId, agentLoginDest, account, exShell };
}

function sanitizeUsPhone(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  // Reject anything that's neither US 10-digit nor 1+10 — preserves
  // existing E.164 only if it's well-formed (was already +1NNN..)
  if (trimmed.startsWith("+1") && digits.length === 11) return `+${digits}`;
  return null;
}

function buildLogicsCaseUrl(domain, logicsCaseId) {
  if (!logicsCaseId) return null;
  const upper = String(domain || "TAG").toUpperCase();
  if (upper === "TAG") return `https://taxag.irslogics.com/Default.aspx?caseid=${logicsCaseId}`;
  if (upper === "WYNN") return `https://wynntax.irslogics.com/Default.aspx?caseid=${logicsCaseId}`;
  return null;
}

function extractRcxUii(response) {
  if (!response) return null;
  // RingCX placeManualCall response shapes vary; try common keys.
  return response?.uii
    || response?.callId
    || response?.callID
    || response?.UII
    || response?.data?.uii
    || response?.data?.callId
    || response?.data?.callID
    || null;
}

function normalizeDialDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function formatRingcxCallbackDts(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (part) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function coerceActiveCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  return [];
}

function extractActiveCallUii(call) {
  return call?.uii
    || call?.UII
    || call?.callId
    || call?.callID
    || call?.activeCallId
    || call?.id
    || null;
}

function findMatchingActiveCall(activeCallsPayload, { destination, callerId } = {}) {
  const destinationDigits = normalizeDialDigits(destination);
  const callerDigits = normalizeDialDigits(callerId);
  const calls = coerceActiveCallList(activeCallsPayload);
  return calls.find((call) => {
    const callDestination = normalizeDialDigits(
      call?.dnis
      || call?.destination
      || call?.destinationPhone
      || call?.leadPhone
      || call?.phone,
    );
    const callCaller = normalizeDialDigits(call?.ani || call?.callerId || call?.sourcePhone);
    const destinationMatches = destinationDigits && callDestination === destinationDigits;
    const callerMatches = !callerDigits || !callCaller || callCaller === callerDigits;
    return destinationMatches && callerMatches;
  }) || null;
}

async function waitForRingcxActiveCall(client, {
  destination,
  callerId,
  timeoutMs = getActiveCallVerifyMs(),
  intervalMs = getActiveCallVerifyIntervalMs(),
  logger = null,
} = {}) {
  if (!client || typeof client.listActiveCalls !== "function") {
    return { ok: false, reason: "active-call-list-unavailable" };
  }
  const startedAt = Date.now();
  let lastError = null;
  do {
    try {
      const activeCalls = await client.listActiveCalls();
      const match = findMatchingActiveCall(activeCalls, { destination, callerId });
      if (match) {
        return {
          ok: true,
          activeCall: match,
          rcxUii: extractActiveCallUii(match),
        };
      }
    } catch (error) {
      lastError = error;
      logger?.warn?.("dial.placeCall.activeCallVerify.failed", {
        error: error.message,
      });
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() - startedAt < timeoutMs);
  return {
    ok: false,
    reason: lastError ? "active-call-list-error" : "active-call-not-found",
    error: lastError ? lastError.message : null,
  };
}

// Sanitize an arbitrary error/response value so Mongo can serialize it.
// Strips cycles, functions, and non-JSON values; truncates long strings.
function safeSerializeError(error) {
  if (!error) return null;
  const seen = new WeakSet();
  const sanitize = (val, depth = 0) => {
    if (val === null || val === undefined) return null;
    if (depth > 4) return "[depth-limit]";
    const t = typeof val;
    if (t === "string") return val.length > 2000 ? val.slice(0, 2000) + "…[truncated]" : val;
    if (t === "number" || t === "boolean") return val;
    if (t === "function" || t === "symbol") return undefined;
    if (Array.isArray(val)) {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
      return val.slice(0, 20).map((v) => sanitize(v, depth + 1));
    }
    if (t === "object") {
      if (seen.has(val)) return "[circular]";
      seen.add(val);
      const out = {};
      for (const key of Object.keys(val).slice(0, 30)) {
        try {
          out[key] = sanitize(val[key], depth + 1);
        } catch { out[key] = "[unreadable]"; }
      }
      return out;
    }
    return undefined;
  };
  return {
    message: typeof error.message === "string" ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
    name: error.name || null,
    code: error.code || null,
    response: sanitize(error.response, 0),
    stack: typeof error.stack === "string" ? error.stack.slice(0, 2000) : null,
  };
}

// Wrap an async fn with a timeout. Throws AbortError-like message on timeout.
async function withTimeout(promiseFactory, timeoutMs, opName) {
  let timeoutHandle;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`${opName} timed out after ${timeoutMs}ms`);
      err.code = "TIMEOUT";
      reject(err);
    }, timeoutMs);
    if (typeof timeoutHandle.unref === "function") timeoutHandle.unref();
  });
  try {
    return await Promise.race([promiseFactory(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── placeCall ──────────────────────────────────────────────────────

function getActiveCallStaleCutoff(state, asOf = new Date()) {
  const normalized = String(state || "").trim().toLowerCase();
  if (normalized === "placing") return new Date(asOf.getTime() - RCX_PLACING_TTL_MS);
  if (normalized === "ringing") return new Date(asOf.getTime() - RCX_RINGING_TTL_MS);
  return null;
}

function isStaleActiveCallSession(session, asOf = new Date()) {
  if (!session) return false;
  const state = String(session.state || "").trim().toLowerCase();
  const cutoff = getActiveCallStaleCutoff(state, asOf);
  if (!cutoff) return false;
  const basis = state === "ringing"
    ? session.ringingAt || session.startedAt
    : session.startedAt;
  if (!basis) return false;
  const basisDate = new Date(basis);
  if (Number.isNaN(basisDate.getTime())) return false;
  return basisDate <= cutoff;
}

async function clearStaleActiveCallSession(session, agentId, logger = null) {
  if (!isStaleActiveCallSession(session)) return false;
  const state = String(session.state || "active").trim().toLowerCase();
  await callSessionRepository.markFailed(session._id, {
    failureReason: `${state || "active"}-stale-preflight-timeout`,
  });
  if (session.queueItemId) {
    await safeRelease(rollbackPlaceCall, agentId, session.leadId, session.queueItemId);
  }
  logger?.warn?.("dial.placeCall.staleActiveSessionCleared", {
    agentId,
    callSessionId: session._id,
    queueItemId: session.queueItemId || null,
    state,
    startedAt: session.startedAt || null,
    ringingAt: session.ringingAt || null,
  });
  return true;
}

async function placeCall(agentId, queueItemId, {
  logger = null,
  agentEmail: agentEmailOverride = null,
  callerId: callerIdOverride = null,
} = {}) {
  // 1. Look up agent + queue item
  const agent = await agentStateRepository.findAgentStateByExtensionId(agentId);
  if (!agent) {
    return { ok: false, error: "agent-not-found", agentId };
  }
  const queueItem = await queueItemRepository.findById(queueItemId);
  if (!queueItem) {
    return { ok: false, error: "queue-item-not-found", queueItemId };
  }
  if (!["in_slice", "fresh_assigned"].includes(queueItem.state)) {
    return {
      ok: false,
      error: `queue-item-bad-state:${queueItem.state}`,
      queueItemId,
    };
  }
  if (queueItem.assignedTo && String(queueItem.assignedTo) !== String(agentId)) {
    return {
      ok: false,
      error: "queue-item-assigned-to-other-agent",
      assignedTo: queueItem.assignedTo,
    };
  }

  // 2. Pre-flight: agent must be eligible (not on another call, not unavail)
  const activityState = agent.activityState || "idle";
  if (!DIAL_ELIGIBLE_ACTIVITY_STATES.has(activityState)) {
    return {
      ok: false,
      error: `agent-not-eligible:${activityState}`,
    };
  }

  // 2b. Belt-and-suspenders: agent must not have an active CallSession.
  // activityState should already reflect this, but if there's a stale
  // session from a crashed prior process, the CallSession is canonical.
  let existingActiveCall = await callSessionRepository.findActiveByAgent(agentId);
  if (existingActiveCall) {
    const cleared = await clearStaleActiveCallSession(existingActiveCall, agentId, logger);
    if (cleared) {
      existingActiveCall = await callSessionRepository.findActiveByAgent(agentId);
    }
  }
  if (existingActiveCall) {
    return {
      ok: false,
      error: "agent-has-active-call",
      activeCallSessionId: existingActiveCall._id,
      hint: "dispose or fail the existing session first",
    };
  }

  const queueDomain = String(queueItem.domain || agent.company || "TAG").trim().toUpperCase();
  const logicsCaseId = Number(queueItem.sourceLogicsCaseId);
  if (queueDomain && Number.isFinite(logicsCaseId) && logicsCaseId > 0) {
    let eligibility = null;
    try {
      eligibility = await resolveCaseContactEligibility(queueDomain, logicsCaseId, {
        enforceStop: true,
        currentStage: "contact-blocked",
        sourceService: "dial-service",
      });
    } catch (error) {
      logger?.warn?.("dial.placeCall.contactEligibility.failed", {
        agentId,
        queueItemId,
        domain: queueDomain,
        logicsCaseId,
        error: error.message,
      });
      return {
        ok: false,
        error: "contact-eligibility-check-failed",
        detail: error.message || null,
      };
    }
    if (!eligibility?.ok) {
      return {
        ok: false,
        error: "contact-blocked",
        reason: eligibility?.reason || null,
        detail: eligibility?.detail || null,
        queueItemId,
        logicsCaseId,
      };
    }
  }

  // 3. Acquire lead lock (queue_active → in_call)
  // If the lead doesn't yet have a queue lock (e.g. fresh-assigned race),
  // try acquiring directly into in_call.
  const leadId = queueItem.leadId;
  let lockResult = await leadActivityRepository.transitionLock(leadId, "queue_active", "in_call", {
    ownerAgentId: agentId,
    queueItemId,
  });
  if (!lockResult) {
    // No prior queue lock — try fresh acquire
    const acquired = await leadActivityRepository.acquireLock(leadId, "in_call", {
      ownerAgentId: agentId,
      queueItemId,
    });
    if (!acquired.acquired) {
      return {
        ok: false,
        error: "lead-locked-by-other",
        existing: acquired.existing,
      };
    }
    lockResult = acquired.doc;
  }

  // 4. Atomically mark QueueItem dialing
  const dialingItem = await queueItemRepository.markDialing(queueItemId);
  if (!dialingItem) {
    // Race: someone else already moved the item past in_slice. Release lead lock.
    await safeRelease(leadActivityRepository.releaseLock, leadId, { ownerAgentId: agentId });
    return {
      ok: false,
      error: "queue-item-state-race",
    };
  }

  // 5. Update agent activity (best-effort; failure here doesn't strand
  //    the dial because activityState is informational).
  try {
    await setActivityState(agentId, "dialing", { source: "dial-service" });
  } catch (error) {
    logger?.warn?.("dial.placeCall.activityState.failed", { agentId, error: error.message });
  }

  // 6. Resolve dial context + place RingCX call
  const dialContext = await resolveAgentDialContext(agent);
  const agentEmail = String(agentEmailOverride || dialContext.agentEmail || "").trim() || null;
  const resolvedCallerId = sanitizeUsPhone(callerIdOverride) || dialContext.callerId;
  const callerId = shouldSendManualCallerId() ? resolvedCallerId : null;
  if (!agentEmail) {
    await rollbackPlaceCall(agentId, leadId, queueItemId);
    return {
      ok: false,
      error: "missing-agent-email",
      hint: "set RINGCX_VOICE_AGENT_EMAIL or AgentState.agentEmail",
    };
  }
  const destination = sanitizeUsPhone(queueItem.phoneNumber);
  if (!destination) {
    await rollbackPlaceCall(agentId, leadId, queueItemId);
    return {
      ok: false,
      error: "invalid-destination-number",
      phoneNumber: queueItem.phoneNumber,
    };
  }

  // 7. Create CallSession in "placing" BEFORE the API call so we have
  // a record even if the API hangs / fails.
  let callSession;
  try {
    callSession = await callSessionRepository.createSession({
      direction: "outbound",
      agentId,
      agentName: agent.name,
      agentEmail,
      leadId,
      queueItemId,
      domain: queueItem.domain || agent.company || "TAG",
      logicsCaseId: queueItem.sourceLogicsCaseId || null,
      phoneNumber: destination,
      callerId,
      placedVia: "ringcx-soft",
      state: "placing",
    });
  } catch (error) {
    await rollbackPlaceCall(agentId, leadId, queueItemId);
    logger?.warn?.("dial.placeCall.sessionCreate.failed", {
      agentId, queueItemId, error: error.message,
    });
    return {
      ok: false,
      error: `session-create-failed: ${error.message}`,
    };
  }

  // 8. The RingCX API call itself — wrapped in timeout.
  //
  // When the per-user OAuth flow has stored a bearer for this agent
  // (cxSession.bearerEnc populated), we use THAT bearer instead of
  // admin JWT-bearer. This is the path that may bypass the
  // "agent.not.logged.in" gate since the bearer represents an
  // authenticated agent identity rather than an admin acting on
  // behalf of an agent.
  let placementResponse = null;
  let userBearer = null;
  let client = null;
  try {
    // eslint-disable-next-line global-require
    const cxStore = require("./cxTokenStorageService");
    if (shouldUseUserBearerForManualCall() && cxStore.isConfigured()) {
      // Map extensionId → UserAccount to fetch the stored bearer
      // (AgentState ≠ UserAccount; we look up by extensionId on the
      // user-account side to find the right agent's stored token).
      const userAccount = await userAccountRepository.findUserAccountByExtensionId(agentId);
      if (userAccount) {
        const userAccountId = String(userAccount._id || userAccount.id);
        let session = await cxStore.getRcxSession(userAccountId);
        const bearerExpiresInMs = session?.bearerExpiresAt
          ? new Date(session.bearerExpiresAt).getTime() - Date.now()
          : 0;
        if ((!session?.bearer || bearerExpiresInMs <= 30_000) && userAccount?.cxAuth?.refreshTokenEnc) {
          try {
            // eslint-disable-next-line global-require
            const cxOAuth = require("./cxOAuthService");
            const refreshed = await cxOAuth.refreshUserSession({ userId: userAccountId });
            if (refreshed?.ok) {
              session = await cxStore.getRcxSession(userAccountId);
            } else {
              logger?.warn?.("dial.userBearer.refreshFailed", {
                agentId,
                userAccountId,
                error: refreshed?.error || "unknown",
              });
            }
          } catch (refreshError) {
            logger?.warn?.("dial.userBearer.refreshException", {
              agentId,
              userAccountId,
              error: refreshError.message,
            });
          }
        }
        if (session?.bearer && session.bearerExpiresAt
            && new Date(session.bearerExpiresAt).getTime() - Date.now() > 30_000) {
          userBearer = {
            accessToken: session.bearer,
            tokenType: "Bearer",
            expiresAt: new Date(session.bearerExpiresAt).getTime(),
          };
        }
      }
    }
  } catch (cxStoreErr) {
    logger?.warn?.("dial.userBearer.lookupFailed", { error: cxStoreErr.message });
  }

  try {
    try {
      client = userBearer
        ? createRingcxVoiceClient({ userBearer })
        : createRingcxVoiceClient();
    } catch (clientError) {
      throw new Error(`ringcx-client-init-failed: ${clientError.message}`);
    }
    logger?.info?.("dial.placeCall.bearerSelection", {
      agentId,
      userBearerActive: Boolean(userBearer),
      bearerExpiresAt: userBearer?.expiresAt ? new Date(userBearer.expiresAt).toISOString() : null,
    });
    placementResponse = await withTimeout(
      () => client.placeManualCall({
        agentEmail,
        destination,
        callerId,
        ringDuration: getManualCallRingDurationSeconds(),
      }),
      getManualCallApiTimeoutMs(),
      "placeManualCall",
    );
  } catch (error) {
    // Roll back: mark CallSession failed, release lock, recycle queue item back to in_slice.
    // safeSerializeError captures the error.details (with responseBody) so the
    // RingCX side error is visible in CallSession.placementError for debugging.
    const safeError = safeSerializeError(error);
    if (error?.details) {
      safeError.details = safeSerializeError({ response: error.details })?.response || null;
    }
    await safeRelease(callSessionRepository.markFailed, callSession._id, {
      failureReason: safeError.message,
      placementError: safeError,
    });
    await rollbackPlaceCall(agentId, leadId, queueItemId);
    logger?.warn?.("dial.placeCall.failed", {
      agentId, queueItemId, error: error.message,
    });
    return {
      ok: false,
      error: `placement-failed: ${error.message}`,
      callSessionId: callSession._id,
    };
  }

  // 9. Capture rcxUii (RingCX call ID) from the response if present.
  let rcxUii = extractRcxUii(placementResponse);
  if (rcxUii) {
    await safeRelease(callSessionRepository.attachRcIds, callSession._id, { rcxUii });
  } else {
    const activeCallVerification = await waitForRingcxActiveCall(client, {
      destination,
      callerId,
      logger,
    });
    rcxUii = activeCallVerification.rcxUii || null;
    if (rcxUii) {
      await safeRelease(callSessionRepository.attachRcIds, callSession._id, { rcxUii });
    } else if (!activeCallVerification.ok) {
      const safeError = {
        message: "RingCX accepted manual call but no active call appeared",
        name: "RingcxPlacementVerificationError",
        code: "ringcx-placement-unverified",
        response: safeSerializeError({ response: placementResponse }),
        details: activeCallVerification,
      };
      await safeRelease(callSessionRepository.markFailed, callSession._id, {
        failureReason: "placement-unverified:no-active-ringcx-call",
        placementError: safeError,
      });
      await rollbackPlaceCall(agentId, leadId, queueItemId);
      logger?.warn?.("dial.placeCall.unverified", {
        agentId,
        queueItemId,
        callSessionId: callSession._id,
        verification: activeCallVerification,
      });
      return {
        ok: false,
        error: "placement-unverified:no-active-ringcx-call",
        callSessionId: callSession._id,
        hint: "RingCX returned success but did not create an active call. Confirm the agent is logged into the RingCX Agent dashboard, available, and has a selected phone route.",
      };
    }
    // No uii in response — we placed the call but can't terminate via
    // RingCX API. Log so we know to investigate; presence webhooks will
    // still drive state.
    logger?.warn?.("dial.placeCall.noRcxUii", {
      callSessionId: callSession._id, response: safeSerializeError({ response: placementResponse }),
    });
  }

  await safeRelease(bumpLastActivityAt, agentId);
  logger?.info?.("dial.placeCall.placed", {
    agentId, queueItemId, callSessionId: callSession._id, rcxUii,
  });

  return {
    ok: true,
    callSessionId: callSession._id,
    rcxUii,
    queueItem: dialingItem,
    logicsUrl: buildLogicsCaseUrl(queueItem.domain, queueItem.sourceLogicsCaseId),
    leadId,
    placementResponse: placementResponse ? { uii: rcxUii } : null,
  };
}

// safeRelease: run an async fn, swallow any error. For best-effort cleanup paths.
async function safeRelease(fn, ...args) {
  try { return await fn(...args); } catch { return null; }
}

async function rollbackPlaceCall(agentId, leadId, queueItemId) {
  // Best-effort rollback. We don't bubble errors here — the caller
  // already has its primary error to report.
  try {
    // Move queue item back to in_slice (or fresh_assigned if fresh)
    const item = await queueItemRepository.findById(queueItemId);
    if (item && item.state === "dialing") {
      const restoreState = item.partition === "fresh" ? "fresh_assigned" : "in_slice";
      const { QueueItem } = require("../../shared-models/src");
      await QueueItem.updateOne(
        { _id: queueItemId, state: "dialing" }, // CAS: only if still dialing
        { $set: { state: restoreState } },
      );
    }
  } catch (_) { /* swallow */ }
  try {
    if (leadId) await leadActivityRepository.releaseLock(leadId, { ownerAgentId: agentId });
  } catch (_) { /* swallow */ }
  try {
    await setActivityState(agentId, "idle", { source: "dial-rollback" });
  } catch (_) { /* swallow */ }
}

// ── terminateAndDispose ────────────────────────────────────────────

async function terminateAndDispose(callSessionId, dispositionKey, {
  payload = {},
  agentId = null,
  logger = null,
} = {}) {
  const session = await callSessionRepository.findById(callSessionId);
  if (!session) {
    return { ok: false, error: "call-session-not-found" };
  }
  // Idempotent — already done OR already failed (terminal states)
  if (session.state === "dispositioned") {
    return {
      ok: true,
      idempotent: true,
      reason: "already-dispositioned",
      callSession: session,
    };
  }
  if (session.state === "failed") {
    return {
      ok: false,
      error: "session-already-failed",
      reason: session.failureReason || null,
    };
  }

  // Validate disposition key + payload
  const def = getDisposition(dispositionKey);
  if (!def) {
    return { ok: false, error: `unknown-disposition:${dispositionKey}` };
  }
  const validation = validateDisposition(dispositionKey, payload);
  if (!validation.ok) {
    return { ok: false, error: "invalid-payload", errors: validation.errors };
  }

  const requestedAgentId = agentId ? String(agentId).trim() : null;
  const sessionAgentId = session.agentId ? String(session.agentId).trim() : null;
  if (requestedAgentId && sessionAgentId && requestedAgentId !== sessionAgentId) {
    return {
      ok: false,
      error: "call-session-assigned-to-other-agent",
      assignedTo: sessionAgentId,
    };
  }
  const effectiveAgentId = requestedAgentId || sessionAgentId;

  // ── Capture sliceId BEFORE state changes (recycle clears it) ────
  let queueItemSliceId = null;
  let queueItemBeforeUpdate = null;
  if (session.queueItemId) {
    queueItemBeforeUpdate = await queueItemRepository.findById(session.queueItemId);
    queueItemSliceId = queueItemBeforeUpdate?.sliceId || null;
  }
  const autoDispositionPayload = {
    ...payload,
    campaignId: payload.campaignId
      || queueItemBeforeUpdate?.metadata?.lastDialExecutionCampaignId
      || queueItemBeforeUpdate?.metadata?.rcxVisibilityCampaignId
      || queueItemBeforeUpdate?.rcxCampaignId
      || queueItemBeforeUpdate?.metadata?.rcxCampaignId
      || process.env.RINGCX_VOICE_DEFAULT_CAMPAIGN_ID
      || process.env.RINGCX_VOICE_NEW_CAMPAIGN_ID
      || null,
    dialGroupId: payload.dialGroupId
      || payload.rcxDialGroupId
      || queueItemBeforeUpdate?.metadata?.lastDialExecutionDialGroupId
      || queueItemBeforeUpdate?.metadata?.rcxVisibilityDialGroupId
      || queueItemBeforeUpdate?.rcxDialGroupId
      || queueItemBeforeUpdate?.metadata?.rcxDialGroupId
      || process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID
      || null,
  };

  // ── 1. Tag the call in RingCX (best-effort, with timeout) ──────
  let rcxDispositionResponse = null;
  let rcxHangupResponse = null;
  let rcxDispositionStatus = "skipped";
  let rcxAutoDispositionRelease = null;
  let rcxAutoDispositionAttempts = [];
  const forceRcxDisposition = shouldForceRingcxDisposition(payload);
  if (session.rcxUii) {
    let client = null;
    try { client = createRingcxVoiceClient(); }
    catch (e) {
      logger?.warn?.("dial.dispose.rcxClientInit.failed", { error: e.message });
    }
    if (client) {
      if (forceRcxDisposition) {
        rcxDispositionStatus = "pending";
        try {
          rcxDispositionResponse = await withTimeout(
            () => client.dispositionCall(session.rcxUii, {
              disposition: def.rcxCode,
              callback: dispositionKey === "callback" ? "true" : undefined,
              callBackDTS: dispositionKey === "callback"
                ? formatRingcxCallbackDts(payload.callbackAt)
                : undefined,
              notes: payload.notes || undefined,
              phone: payload.phone || undefined,
            }),
            RCX_API_TIMEOUT_MS,
            "dispositionCall",
          );
          rcxDispositionStatus = "accepted";
        } catch (error) {
          rcxDispositionStatus = "error";
          await safeRelease(callSessionRepository.recordRcxApiError, callSessionId, {
            op: "dispositionCall",
            message: error.message,
          });
          logger?.warn?.("dial.dispose.rcxDispositionCall.failed", {
            callSessionId, rcxUii: session.rcxUii, error: error.message,
          });
        }
      } else {
        const autoDisposition = await applyRingcxAutoDisposition(client, session.rcxUii, {
          payload: autoDispositionPayload,
          phase: "before-hangup",
        });
        rcxDispositionResponse = autoDisposition.response || null;
        rcxDispositionStatus = autoDisposition.ok
          ? "auto-disposition-accepted-before-hangup"
          : `auto-disposition-${autoDisposition.status}-before-hangup`;
        rcxAutoDispositionAttempts = autoDisposition.attempts || [];
        if (autoDisposition.error) {
          await safeRelease(callSessionRepository.recordRcxApiError, callSessionId, {
            op: "autoDispositionCall",
            message: autoDisposition.error.message,
          });
          logger?.warn?.("dial.dispose.rcxAutoDisposition.failed", {
            callSessionId,
            rcxUii: session.rcxUii,
            phase: "before-hangup",
            error: autoDisposition.error.message,
          });
        }
      }
      // Hangup separately to ensure call is terminated. Some RingCX
      // configurations close on disposition automatically; this is the
      // belt-and-suspenders.
      try {
        rcxHangupResponse = await withTimeout(
          () => client.hangupCall(session.rcxUii),
          RCX_API_TIMEOUT_MS,
          "hangupCall",
        );
      } catch (error) {
        // Likely already ended; non-fatal
        await safeRelease(callSessionRepository.recordRcxApiError, callSessionId, {
          op: "hangupCall",
          message: error.message,
        });
      }
      if (!forceRcxDisposition && rcxHangupResponse) {
        const waitMs = getAutoDispositionWaitMs();
        if (waitMs > 0) await sleep(waitMs);
        if (!String(rcxDispositionStatus || "").startsWith("auto-disposition-accepted")) {
          const autoDisposition = await applyRingcxAutoDisposition(client, session.rcxUii, {
            payload: autoDispositionPayload,
            phase: "after-hangup",
          });
          rcxAutoDispositionAttempts = [
            ...rcxAutoDispositionAttempts,
            ...(autoDisposition.attempts || []),
          ];
          if (autoDisposition.ok) {
            rcxDispositionResponse = autoDisposition.response || null;
            rcxDispositionStatus = "auto-disposition-accepted-after-hangup";
          } else {
            rcxDispositionStatus = `auto-disposition-${autoDisposition.status}-after-hangup`;
            if (autoDisposition.error) {
              await safeRelease(callSessionRepository.recordRcxApiError, callSessionId, {
                op: "autoDispositionCall",
                message: autoDisposition.error.message,
              });
              logger?.warn?.("dial.dispose.rcxAutoDisposition.failed", {
                callSessionId,
                rcxUii: session.rcxUii,
                phase: "after-hangup",
                error: autoDisposition.error.message,
              });
            }
          }
        }
        rcxAutoDispositionRelease = await markAgentAvailableAfterAutoDisposition(effectiveAgentId, {
          logger,
          waitMs: 0,
          uii: session.rcxUii,
        });
      }
    }
  }

  // ── 2. Mark CallSession ended + dispositioned ──────────────────
  await callSessionRepository.markEnded(callSessionId);
  const dispositioned = await callSessionRepository.markDispositioned(callSessionId, {
    dispositionResult: dispositionKey,
    rcxDispositionCode: def.rcxCode,
    dispositionPayload: payload,
    dispositionedBy: effectiveAgentId,
  });

  // ── 3. Update QueueItem state ──────────────────────────────────
  let queueItemUpdate = null;
  if (session.queueItemId) {
    if (def.queueItemState === "completed") {
      queueItemUpdate = await queueItemRepository.markCompleted(session.queueItemId, {
        dispositionResult: dispositionKey,
      });
    } else {
      queueItemUpdate = await queueItemRepository.recycle(session.queueItemId, {
        reason: dispositionKey,
      });
    }
  }

  // ── 4. Slice bookkeeping (use the captured sliceId) ────────────
  let sliceCompleted = null;
  if (queueItemSliceId) {
    await safeRelease(agentSliceRepository.incrementCompleted, queueItemSliceId);
    sliceCompleted = await safeRelease(maybeCompleteSlice, queueItemSliceId);
  }

  // ── 5. Release lead lock ───────────────────────────────────────
  if (session.leadId) {
    await safeRelease(leadActivityRepository.releaseLock, session.leadId, {
      ownerAgentId: effectiveAgentId,
    });
  }

  // ── 6. Agent activity transition: dispositioning → idle ────────
  try {
    await setActivityState(effectiveAgentId, "dispositioning", { source: "dispose" });
    await setActivityState(effectiveAgentId, "idle", { source: "dispose-complete" });
  } catch (e) {
    logger?.warn?.("dial.dispose.activityState.failed", { error: e.message });
  }

  // ── 7. Trigger fresh-lead drain on agent-becomes-eligible. ─────
  // Lazy-required to avoid load-time circular deps.
  try {
    // eslint-disable-next-line global-require
    const { onAgentBecomesEligible } = require("./freshLeadAssignmentService");
    await onAgentBecomesEligible(effectiveAgentId);
  } catch (e) {
    logger?.warn?.("dial.dispose.eligibilityHook.failed", { error: e.message });
  }

  // ── 8. Cadence reschedule (stub: cadence engine consumes nextTouchAt
  //      via a future hook). Returned in response for downstream consumers.
  const nextTouchAt = computeNextTouchAt(def.rescheduleRule, payload);

  logger?.info?.("dial.dispose.completed", {
    callSessionId,
    dispositionKey,
    queueItemState: queueItemUpdate?.state,
    sliceCompleted: sliceCompleted?.completed || false,
    nextTouchAt,
  });

  return {
    ok: true,
    callSession: dispositioned,
    queueItem: queueItemUpdate,
    sliceCompleted: sliceCompleted?.completed || false,
    nextTouchAt,
    rcxResponses: {
      disposition: rcxDispositionResponse ? "ok" : rcxDispositionStatus,
      hangup: rcxHangupResponse ? "ok" : null,
      forceRcxDisposition,
      autoDispositionAttempts: rcxAutoDispositionAttempts,
      autoDispositionRelease: rcxAutoDispositionRelease,
    },
  };
}

// ── Reconcile call-ended events from presence webhooks ─────────────
//
// Called from ringcentralExService.processPresenceEnvelope when a call
// transitions to NoCall. If we have an active CallSession matching the
// session id (or the most recent active for the agent), mark it ended.
// The agent must still disposition via the SPA — this just closes the
// active-call portion.

async function reconcileCallEnded({ agentId, sessionRcId, telephonySessionId, logger = null } = {}) {
  if (!agentId) return { ok: false, reason: "no-agent" };

  // Try to match by session id first (most precise)
  let target = null;
  if (sessionRcId) {
    const { CallSession } = require("../../shared-models/src");
    target = await CallSession.findOne({
      sessionId: sessionRcId,
      state: { $in: ["placing", "ringing", "connected"] },
    }).lean();
  }
  // Fall back to the most recent active session for this agent. Only
  // attach the sessionId/telephonySessionId if the active session
  // doesn't already have a different sessionId (avoid mis-attribution).
  if (!target) {
    const active = await callSessionRepository.findActiveByAgent(agentId);
    if (!active) return { ok: true, reason: "no-active-session" };
    if (sessionRcId && active.sessionId && active.sessionId !== sessionRcId) {
      // Active session has a different sessionId — leave alone, this
      // ended event is for some other (probably already-cleaned) session.
      return { ok: true, reason: "session-mismatch", activeId: active._id };
    }
    target = active;
  }

  // Attach session ids if we got them now (only if missing)
  const idsPatch = {};
  if (sessionRcId && !target.sessionId) idsPatch.sessionRcId = sessionRcId;
  if (telephonySessionId && !target.telephonySessionId) idsPatch.telephonySessionId = telephonySessionId;
  if (Object.keys(idsPatch).length) {
    await callSessionRepository.attachRcIds(target._id, idsPatch);
  }

  await callSessionRepository.markEnded(target._id);
  logger?.info?.("dial.reconcile.ended", {
    callSessionId: target._id,
    agentId, sessionRcId,
  });
  return { ok: true, callSessionId: target._id, marked: "ended" };
}

// ── Reconcile call-connected events from presence webhooks ─────────

async function reconcileCallConnected({ agentId, sessionRcId, telephonySessionId, logger = null } = {}) {
  if (!agentId) return { ok: false, reason: "no-agent" };

  // Match by session id if known (precise); else most recent active
  let target = null;
  if (sessionRcId) {
    const { CallSession } = require("../../shared-models/src");
    target = await CallSession.findOne({
      sessionId: sessionRcId,
      state: { $in: ["placing", "ringing"] },
    }).lean();
  }
  if (!target) {
    const active = await callSessionRepository.findActiveByAgent(agentId);
    if (!active) return { ok: true, reason: "no-active-session" };
    if (sessionRcId && active.sessionId && active.sessionId !== sessionRcId) {
      return { ok: true, reason: "session-mismatch", activeId: active._id };
    }
    target = active;
  }

  // Attach session ids if missing
  const idsPatch = {};
  if (sessionRcId && !target.sessionId) idsPatch.sessionRcId = sessionRcId;
  if (telephonySessionId && !target.telephonySessionId) idsPatch.telephonySessionId = telephonySessionId;
  if (Object.keys(idsPatch).length) {
    await callSessionRepository.attachRcIds(target._id, idsPatch);
  }

  await callSessionRepository.markConnected(target._id, idsPatch);
  await safeRelease(setActivityState, agentId, "onCall", { source: "presence-connected" });
  logger?.info?.("dial.reconcile.connected", {
    callSessionId: target._id, agentId, sessionRcId,
  });
  return { ok: true, callSessionId: target._id, marked: "connected" };
}

// ── Inbound call materialization ───────────────────────────────────
//
// Called when an EX phone rings AND we don't already have an active
// CallSession for THIS direction (inbound). If an outbound is in flight,
// we DO materialize an inbound — but log a warning. Real-world: shouldn't
// happen because RC won't ring an extension that's already mid-call.

async function materializeInboundCall({
  agentId, fromNumber, sessionRcId, telephonySessionId, logger = null,
} = {}) {
  if (!agentId || !fromNumber) return { ok: false, reason: "missing-args" };

  const agent = await agentStateRepository.findAgentStateByExtensionId(agentId);
  if (!agent) return { ok: false, reason: "agent-not-found" };

  // If there's already an inbound session for this sessionId, idempotent.
  if (sessionRcId) {
    const { CallSession } = require("../../shared-models/src");
    const existing = await CallSession.findOne({
      sessionId: sessionRcId,
      direction: "inbound",
    }).lean();
    if (existing) {
      return { ok: true, idempotent: true, callSessionId: existing._id };
    }
  }

  // If there's an active OUTBOUND session for the agent, log a warning
  // but proceed — multiple sessions are possible in unusual scenarios
  // and we'd rather track them than drop them.
  const activeOutbound = await callSessionRepository.findActiveByAgent(agentId);
  if (activeOutbound && activeOutbound.direction === "outbound") {
    logger?.warn?.("dial.inbound.unexpectedActiveOutbound", {
      agentId, activeId: activeOutbound._id, fromNumber,
    });
  }

  // TODO (next PR): lookup leadId by fromNumber via caseProfile/lookup ladder
  const leadId = null;

  const session = await callSessionRepository.createSession({
    direction: "inbound",
    agentId,
    agentName: agent.name,
    agentEmail: agent.agentEmail || agent.email || null,
    leadId,
    queueItemId: null,
    domain: agent.company || "TAG",
    phoneNumber: fromNumber,
    placedVia: "rc-ex-ringout",
    state: "ringing",
    sessionId: sessionRcId,
    telephonySessionId,
  });
  logger?.info?.("dial.inbound.materialized", {
    callSessionId: session._id, agentId, fromNumber,
  });
  return { ok: true, callSessionId: session._id };
}

// ── Stale-state sweeper ───────────────────────────────────────────
//
// Recovers from process crashes and other lost-state scenarios:
//
//   1. CallSessions stuck in "placing" for > 2 min → mark failed
//   2. CallSessions stuck in "ringing" for > 5 min → mark failed
//   3. QueueItems stuck in "dialing" with no active CallSession →
//      restore to in_slice or fresh_assigned
//   4. AgentStates stuck in "dialing" for > 5 min with no active
//      session → reset to idle
//
// Called from the 60s tick worker. Best-effort; surfaces counts for
// observability.

async function sweepStaleStates({ asOf = new Date(), logger = null } = {}) {
  const result = { failedSessions: 0, restoredQueueItems: 0, resetAgents: 0, errors: [] };

  try {
    const { CallSession, QueueItem, AgentState } = require("../../shared-models/src");

    // 1+2. Stale placing/ringing CallSessions
    const stalePlacing = await CallSession.find({
      state: "placing",
      startedAt: { $lte: new Date(asOf.getTime() - RCX_PLACING_TTL_MS) },
    }).limit(50).lean();
    for (const s of stalePlacing) {
      await callSessionRepository.markFailed(s._id, {
        failureReason: "placing-stale-timeout",
      });
      // Roll back queue item + lead lock + activity
      if (s.queueItemId) {
        await safeRelease(rollbackPlaceCall, s.agentId, s.leadId, s.queueItemId);
      }
      result.failedSessions += 1;
    }
    const staleRinging = await CallSession.find({
      state: "ringing",
      $or: [
        { ringingAt: { $lte: new Date(asOf.getTime() - RCX_RINGING_TTL_MS) } },
        { ringingAt: null, startedAt: { $lte: new Date(asOf.getTime() - RCX_RINGING_TTL_MS) } },
      ],
    }).limit(50).lean();
    for (const s of staleRinging) {
      await callSessionRepository.markFailed(s._id, {
        failureReason: "ringing-stale-timeout",
      });
      if (s.queueItemId) {
        await safeRelease(rollbackPlaceCall, s.agentId, s.leadId, s.queueItemId);
      }
      result.failedSessions += 1;
    }

    // 3. QueueItems stuck in "dialing" with no active CallSession
    const dialingItems = await QueueItem.find({
      state: "dialing",
      assignedAt: { $lte: new Date(asOf.getTime() - RCX_PLACING_TTL_MS) },
    }).limit(50).lean();
    for (const item of dialingItems) {
      const active = await callSessionRepository.findActiveByQueueItem(item._id);
      if (active) continue; // legitimate, leave alone
      const restoreState = item.partition === "fresh" ? "fresh_assigned" : "in_slice";
      await QueueItem.updateOne(
        { _id: item._id, state: "dialing" },
        { $set: { state: restoreState } },
      );
      if (item.leadId) {
        await safeRelease(leadActivityRepository.releaseLock, item.leadId, {
          ownerAgentId: item.assignedTo,
        });
      }
      result.restoredQueueItems += 1;
    }

    // 4. AgentStates stuck in "dialing" with no active session
    const dialingAgents = await AgentState.find({
      activityState: "dialing",
      lastActivityAt: { $lte: new Date(asOf.getTime() - RCX_RINGING_TTL_MS) },
    }).lean();
    for (const a of dialingAgents) {
      const active = await callSessionRepository.findActiveByAgent(a.extensionId);
      if (active) continue;
      await safeRelease(setActivityState, a.extensionId, "idle", { source: "stale-sweeper" });
      result.resetAgents += 1;
    }

    // 5. Expired LeadActivity locks — generic cleanup
    const lockCleanup = await safeRelease(leadActivityRepository.cleanupExpired, { asOf });
    if (lockCleanup) result.expiredLocksReaped = lockCleanup.reapedCount;

  } catch (error) {
    result.errors.push(error.message);
    logger?.warn?.("dial.sweepStaleStates.failed", { error: error.message });
  }

  if (result.failedSessions || result.restoredQueueItems || result.resetAgents) {
    logger?.info?.("dial.sweepStaleStates.swept", result);
  }
  return result;
}

module.exports = {
  placeCall,
  terminateAndDispose,
  reconcileCallEnded,
  reconcileCallConnected,
  materializeInboundCall,
  sweepStaleStates,
  // exposed for tests / debug:
  resolveAgentDialContext,
  sanitizeUsPhone,
  buildLogicsCaseUrl,
  extractRcxUii,
  safeSerializeError,
  withTimeout,
  DIAL_ELIGIBLE_ACTIVITY_STATES,
};
