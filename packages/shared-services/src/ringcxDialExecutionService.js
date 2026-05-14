"use strict";

const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");
const {
  agentStateRepository,
  cxDialQueueRepository,
  queueItemRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  deriveUcqAgeBucket,
} = require("../../shared-normalizers/src");
const {
  recordWorkflowStage,
} = require("./workflowStateService");
const {
  createCxCallPlacedEvent,
} = require("./cxCadenceService");
const {
  placeCall,
} = require("./dialService");
const {
  buildQueueLeadId,
} = require("./universalQueueService");
const {
  publishQueueItemToRingcx,
} = require("./ringcxLeadServingService");
const {
  getDisposition,
} = require("./dispositionMapService");
const {
  applyCallEndedDailyStats,
  normalizeDailyStats,
} = require("./agentAvailabilityService");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeUsPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length >= 10 ? digits.slice(-10) : null;
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

function readAgentRouteCallerId(dispatchIntent = {}, queueItem = null) {
  const assignment = queueItem?.assignment && typeof queueItem.assignment === "object"
    ? queueItem.assignment
    : {};
  const metadata = queueItem?.metadata && typeof queueItem.metadata === "object"
    ? queueItem.metadata
    : {};
  const tokens = [
    dispatchIntent?.assignedExtensionId,
    dispatchIntent?.dialerExtensionId,
    dispatchIntent?.agent?.assignedExtensionId,
    dispatchIntent?.agent?.extensionId,
    dispatchIntent?.dialerCxAgentId,
    dispatchIntent?.agent?.cxAgentId,
    assignment.extensionId,
    dispatchIntent?.assignedAgentEmail,
    dispatchIntent?.dialerEmail,
    dispatchIntent?.agent?.email,
    assignment.agentEmail,
    assignment.email,
    dispatchIntent?.assignedAgentName,
    dispatchIntent?.dialerName,
    dispatchIntent?.agent?.name,
    assignment.agentName,
    metadata.assignedExtensionId,
    metadata.assignedAgentEmail,
    metadata.assignedAgentName,
    metadata.assignedAgentId,
  ];
  for (const token of tokens) {
    const suffix = envToken(token);
    if (!suffix) continue;
    const callerId = normalizeUsPhone(process.env[`RINGCX_AGENT_ROUTE_${suffix}_CALLER_ID`]);
    if (callerId) return callerId;
  }
  return null;
}

function extractUii(response = null) {
  if (!response || typeof response !== "object") return null;
  const candidates = [response.uii, response.UII, response.callId, response.callID];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return null;
}

function normalizeDialDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function shouldForceRingcxDisposition(options = {}, dispatchIntent = {}) {
  if (options.forceRcxDisposition !== undefined) {
    return parseBooleanFlag(options.forceRcxDisposition, false);
  }
  if (dispatchIntent.forceRcxDisposition !== undefined) {
    return parseBooleanFlag(dispatchIntent.forceRcxDisposition, false);
  }
  return parseBooleanFlag(process.env.RINGCX_FORCE_APP_DISPOSITION, false);
}

function getAutoDispositionWaitMs() {
  const configured = Number(process.env.RINGCX_AUTO_DISPOSITION_WAIT_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return 5_000;
}

function isAutoDispositionAccepted(status) {
  return String(status || "").trim().toLowerCase().startsWith("auto-disposition-accepted");
}

function isAlreadyEndedHangupError(error) {
  if (!error) return false;
  const status = Number(error.status || error.details?.responseStatus || 0);
  if (status === 404 || status === 410) return true;
  const responseBody = error.details?.responseBody;
  const haystack = [
    error.message,
    typeof responseBody === "string" ? responseBody : "",
    responseBody && typeof responseBody === "object" ? JSON.stringify(responseBody) : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /already\s+(ended|complete|completed|disconnected)|no\s+active\s+call|active\s+call\s+not\s+found|call\s+not\s+found|cannot\s+find\s+call/.test(haystack);
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
      lookup.error = serializeError(error, "campaign-disposition-lookup-failed");
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
    logger?.warn?.("ringcx.autoDisposition.agentAvailable.failed", {
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

function coerceActiveCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractActiveCallUii(call = null) {
  return extractUii(call)
    || String(call?.activeCallId || call?.id || "").trim()
    || null;
}

function collectScalarStrings(value, output = [], depth = 0) {
  if (output.length >= 160 || depth > 5 || value === null || value === undefined) {
    return output;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectScalarStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      output.push(String(key));
      collectScalarStrings(child, output, depth + 1);
      if (output.length >= 160) break;
    }
  }
  return output;
}

function activeCallContainsText(call, value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return false;
  return collectScalarStrings(call)
    .some((candidate) => String(candidate || "").toLowerCase().includes(needle));
}

function activeCallContainsPhone(call, phone) {
  const target = normalizeDialDigits(phone);
  if (!target) return false;
  return collectScalarStrings(call)
    .map(normalizeDialDigits)
    .filter(Boolean)
    .some((candidate) => candidate === target);
}

function summarizeActiveCall(call = null) {
  if (!call || typeof call !== "object") return null;
  const summary = {};
  const keys = [
    "uii",
    "UII",
    "callId",
    "callID",
    "activeCallId",
    "id",
    "state",
    "status",
    "callState",
    "ani",
    "dnis",
    "callerId",
    "sourcePhone",
    "destination",
    "destinationPhone",
    "leadPhone",
    "phone",
    "campaignId",
    "dialGroupId",
    "agentId",
    "username",
    "agentEmail",
    "externId",
  ];
  for (const key of keys) {
    const value = call[key];
    if (value !== undefined && value !== null && value !== "") summary[key] = value;
  }
  summary.uii = summary.uii || summary.UII || summary.callId || summary.callID || summary.activeCallId || summary.id || null;
  summary.rawKeys = Object.keys(call).slice(0, 40);
  return summary;
}

function scoreActiveCallMatch(call, {
  phone = null,
  campaignId = null,
  externId = null,
  agentEmail = null,
} = {}) {
  if (!call || typeof call !== "object" || !extractActiveCallUii(call)) {
    return { score: 0, reasons: [] };
  }
  const reasons = [];
  let score = 0;

  if (phone && activeCallContainsPhone(call, phone)) {
    score += 10;
    reasons.push("phone");
  }
  if (externId && activeCallContainsText(call, externId)) {
    score += 7;
    reasons.push("externId");
  }
  if (campaignId && activeCallContainsText(call, campaignId)) {
    score += 4;
    reasons.push("campaignId");
  }
  if (agentEmail && activeCallContainsText(call, agentEmail)) {
    score += 4;
    reasons.push("agentEmail");
  }

  const state = String(call.state || call.callState || call.status || "").toLowerCase();
  if (state && /(outdial|dial|ring|call|connected|preview)/.test(state)) {
    score += 1;
    reasons.push("activeState");
  }

  return { score, reasons };
}

function findMatchingActiveCall(activeCallsPayload, criteria = {}) {
  const scored = coerceActiveCallList(activeCallsPayload)
    .map((call) => ({
      call,
      ...scoreActiveCallMatch(call, criteria),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  const top = scored[0];
  if (!top) return null;
  const next = scored[1];
  const hasStrongIdentifier =
    top.reasons.includes("phone") || top.reasons.includes("externId");
  if (!hasStrongIdentifier && top.score < 8) return null;
  if (next && next.score === top.score && !hasStrongIdentifier) return null;
  return top;
}

async function resolveAgentCxAgentId(queueItem = null, dispatchIntent = {}, extensionId = null) {
  const account = extensionId
    ? await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null)
    : null;
  const accountPreferred = String(
    account?.cxAgentId
      || account?.metadata?.ringcxAgentId
      || "",
  ).trim();
  if (accountPreferred) return accountPreferred;

  const explicit = String(
    dispatchIntent?.dialerCxAgentId
      || dispatchIntent?.agent?.cxAgentId
      || queueItem?.metadata?.lastDialExecutionDialerCxAgentId
      || "",
  ).trim();
  if (explicit) return explicit;
  return null;
}

async function waitForRingcxCampaignCall(client, {
  phone = null,
  campaignId = null,
  externId = null,
  agentEmail = null,
  agentCxAgentId = null,
  timeoutMs = Number(process.env.RINGCX_CAMPAIGN_CALL_CAPTURE_MS) || 12_000,
  intervalMs = Number(process.env.RINGCX_CAMPAIGN_CALL_CAPTURE_INTERVAL_MS) || 1_000,
  logger = null,
} = {}) {
  if (!client || typeof client.listActiveCalls !== "function") {
    return { ok: false, reason: "active-call-list-unavailable" };
  }

  const querySpecs = [];
  if (agentCxAgentId) {
    querySpecs.push({
      product: "AGENT",
      productId: agentCxAgentId,
      scopedToAgent: true,
    });
  }
  querySpecs.push({
    product: "ACCOUNT",
    productId: client.config?.accountId,
    scopedToAgent: false,
  });

  const startedAt = Date.now();
  let lastError = null;
  let lastCallCount = 0;
  let lastSample = null;
  do {
    for (const spec of querySpecs) {
      try {
        const activeCalls = await client.listActiveCalls({
          product: spec.product,
          productId: spec.productId,
        });
        const calls = coerceActiveCallList(activeCalls);
        lastCallCount = calls.length;
        lastSample = calls[0] ? summarizeActiveCall(calls[0]) : null;

        const match = findMatchingActiveCall(activeCalls, {
          phone,
          campaignId,
          externId,
          agentEmail,
        });
        if (match) {
          return {
            ok: true,
            uii: extractActiveCallUii(match.call),
            activeCallSummary: summarizeActiveCall(match.call),
            matchReasons: match.reasons,
            queryScope: spec.product,
          };
        }

        if (spec.scopedToAgent && calls.length === 1) {
          const onlyCall = calls[0];
          const uii = extractActiveCallUii(onlyCall);
          if (uii) {
            return {
              ok: true,
              uii,
              activeCallSummary: summarizeActiveCall(onlyCall),
              matchReasons: ["single-agent-active-call"],
              queryScope: spec.product,
            };
          }
        }
      } catch (error) {
        lastError = error;
        logger?.warn?.("ringcx.campaignCallCapture.listActiveCalls.failed", {
          product: spec.product,
          productId: spec.productId,
          error: error.message,
        });
      }
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    ok: false,
    reason: lastError ? "active-call-list-error" : "active-call-not-found",
    error: lastError ? lastError.message : null,
    callCount: lastCallCount,
    sample: lastSample,
  };
}

function normalizeDispositionKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  const normalized = raw.replace(/[\s-]+/g, "_");
  if (normalized === "callback" || normalized === "call_back") return "callback";
  if (
    normalized === "no_answer"
    || normalized === "did_not_connect"
    || normalized === "didnt_connect"
    || normalized === "no_connect"
  ) {
    return "did_not_connect";
  }
  if (normalized === "postdate" || normalized === "post_date") return "postdate";
  if (normalized === "dnc" || normalized === "do_not_call") return "dnc";
  if (normalized === "sale" || normalized === "deal") return "deal";
  if (normalized === "wrong_number" || normalized === "bad_number") return "wrong_number";
  if (normalized === "left_message" || normalized === "left_voicemail" || normalized === "voicemail") {
    return "voicemail";
  }
  return normalized;
}

function buildRcxDispositionRequest(options = {}, dispatchIntent = {}) {
  const rawDisposition = options.disposition
    || options.dispositionKey
    || dispatchIntent.disposition
    || dispatchIntent.dispositionKey
    || dispatchIntent.normalizedDisposition
    || null;
  const dispositionKey = normalizeDispositionKey(rawDisposition);
  if (!dispositionKey) {
    return {
      dispositionKey: null,
      rcxCode: null,
      payload: {},
    };
  }
  const def = getDisposition(dispositionKey);
  const payload =
    options.payload && typeof options.payload === "object"
      ? options.payload
      : dispatchIntent.payload && typeof dispatchIntent.payload === "object"
        ? dispatchIntent.payload
        : {};
  const callbackAt = payload.callbackAt
    || dispatchIntent.callbackAt
    || dispatchIntent.scheduledFor
    || dispatchIntent.followUpAt
    || null;
  return {
    dispositionKey,
    rcxCode: def?.rcxCode || null,
    payload,
    callbackAt,
  };
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

function formatRingcxCallbackDtsUtc(value) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (part) => String(part).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function normalizeDispositionEnvKey(key) {
  return String(key || "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function splitDispositionList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function addDispositionAttempt(attempts, seen, attempt) {
  const disposition = String(attempt.disposition || "").trim();
  if (!disposition) return;
  const callback = attempt.callback ? "true" : "";
  const callBackDTS = attempt.callBackDTS || "";
  const key = `${disposition}|${callback}|${callBackDTS}`;
  if (seen.has(key)) return;
  seen.add(key);
  attempts.push({
    disposition,
    callback: attempt.callback || undefined,
    callBackDTS: attempt.callBackDTS || undefined,
    source: attempt.source || "candidate",
  });
}

function buildRingcxDispositionAttempts(dispositionRequest = {}) {
  const attempts = [];
  const seen = new Set();
  const dispositionKey = dispositionRequest.dispositionKey || null;
  const primary = dispositionRequest.rcxCode || null;
  const localCallbackDts = dispositionKey === "callback"
    ? formatRingcxCallbackDts(dispositionRequest.callbackAt)
    : undefined;
  const utcCallbackDts = dispositionKey === "callback"
    ? formatRingcxCallbackDtsUtc(dispositionRequest.callbackAt)
    : undefined;
  const append = (disposition, extra = {}) => addDispositionAttempt(attempts, seen, {
    disposition,
    ...extra,
  });

  if (dispositionKey === "callback") {
    append(primary, {
      callback: "true",
      callBackDTS: localCallbackDts,
      source: "primary-local-callback",
    });
    if (utcCallbackDts && utcCallbackDts !== localCallbackDts) {
      append(primary, {
        callback: "true",
        callBackDTS: utcCallbackDts,
        source: "primary-utc-callback",
      });
    }
  } else {
    append(primary, { source: "primary" });
  }

  const envKey = normalizeDispositionEnvKey(dispositionKey);
  for (const configured of [
    ...splitDispositionList(process.env.RINGCX_DISPOSITION_FALLBACKS),
    ...splitDispositionList(envKey ? process.env[`RINGCX_DISPOSITION_${envKey}`] : ""),
  ]) {
    append(configured, {
      callback: dispositionKey === "callback" ? "true" : undefined,
      callBackDTS: dispositionKey === "callback" ? localCallbackDts : undefined,
      source: "env",
    });
  }

  const fallbackByKey = {
    callback: ["CALLBACK", "Callback", "default", "Default", "COMPLETED"],
    postdate: ["POSTDATE", "Postdate", "default", "Default", "COMPLETED"],
    deal: ["SALE", "Sale", "default", "Default", "COMPLETED"],
    dnc: ["DNC", "DoNotCall", "default", "Default", "COMPLETED"],
    wrong_number: ["WRONG_NUMBER", "WrongNumber", "default", "Default", "COMPLETED"],
    did_not_connect: ["NO_ANSWER", "NoAnswer", "default", "Default", "COMPLETED"],
    voicemail: ["LEFT_MESSAGE", "LeftMessage", "default", "Default", "COMPLETED"],
  };
  for (const fallback of fallbackByKey[dispositionKey] || ["COMPLETED"]) {
    const callbackFallback = dispositionKey === "callback"
      && !["default", "Default", "DEFAULT", "COMPLETED"].includes(fallback);
    append(fallback, {
      callback: callbackFallback ? "true" : undefined,
      callBackDTS: callbackFallback ? localCallbackDts : undefined,
      source: "built-in-fallback",
    });
  }

  return attempts;
}

async function applyRingcxDisposition(client, uii, dispositionRequest, context = {}) {
  const attempts = buildRingcxDispositionAttempts(dispositionRequest);
  const notes = context.notes || undefined;
  const phone = context.phone || undefined;
  const recordedAttempts = [];
  let lastFalseAttempt = null;
  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await client.dispositionCall(uii, {
        disposition: attempt.disposition,
        callback: attempt.callback,
        callBackDTS: attempt.callBackDTS,
        notes,
        phone,
      });
      const result = {
        ...attempt,
        response,
        ok: response !== false,
      };
      recordedAttempts.push(result);
      if (response !== false) {
        return {
          ok: true,
          status: "accepted",
          response,
          acceptedAttempt: attempt,
          attempts: recordedAttempts,
        };
      }
      lastFalseAttempt = result;
    } catch (error) {
      const result = {
        ...attempt,
        ok: false,
        error: serializeError(error, "disposition-call-failed"),
      };
      recordedAttempts.push(result);
      lastError = error;
      if ([401, 403].includes(Number(error?.status))) break;
    }
  }

  if (lastError) {
    return {
      ok: false,
      status: "error",
      error: lastError,
      response: null,
      attempts: recordedAttempts,
    };
  }

  const error = new Error("ringcx-disposition-returned-false");
  error.details = {
    disposition: dispositionRequest.rcxCode,
    dispositionKey: dispositionRequest.dispositionKey,
    response: false,
    lastAttempt: lastFalseAttempt,
  };
  return {
    ok: false,
    status: "rejected",
    error,
    response: false,
    attempts: recordedAttempts,
  };
}

async function applyRingcxAutoDisposition(client, uii, context = {}) {
  const resolution = await resolveAutoDispositionCandidates(client, context);
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
      callback: undefined,
      callBackDTS: undefined,
      source: context.source || "auto-disposition",
      phase: context.phase || null,
    };
    try {
      const response = await client.dispositionCall(uii, {
        disposition: candidate.disposition,
        notes: context.notes || undefined,
        phone: context.phone || undefined,
      });
      const result = {
        ...attempt,
        response,
        ok: response !== false,
      };
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
        error: serializeError(error, "auto-disposition-call-failed"),
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

function serializeError(error, fallback = "operation-failed") {
  return {
    message: error?.message || fallback,
    status: error?.status || null,
    retryable: Boolean(error?.retryable),
    details: error?.details || null,
  };
}

async function resolveQueueItem(options = {}) {
  const queueItemId = String(
    options.queueItemId
      || options.dispatchIntent?.queueItemId
      || options.dispatchIntent?.queueTicketId
      || "",
  ).trim();
  if (queueItemId) {
    const item = await cxDialQueueRepository.findQueueItemById(queueItemId);
    return item ? (item.toObject ? item.toObject() : item) : null;
  }

  const domain = normalizeDomain(options.domain || options.dispatchIntent?.domain || "");
  const caseId = Number(
    options.caseId != null
      ? options.caseId
      : options.dispatchIntent?.caseId,
  );
  if (domain && Number.isFinite(caseId)) {
    const actionKey = String(options.dispatchIntent?.actionKey || "").trim();
    const item = await cxDialQueueRepository.findActiveQueueItem(
      domain,
      caseId,
      actionKey ? { actionKey } : {},
    );
    return item ? (item.toObject ? item.toObject() : item) : null;
  }

  return null;
}

async function resolveAgentEmail(queueItem = null, dispatchIntent = {}) {
  const extensionId = String(
    dispatchIntent?.assignedExtensionId
      || dispatchIntent?.dialerExtensionId
      || dispatchIntent?.agent?.assignedExtensionId
      || dispatchIntent?.agent?.extensionId
      || queueItem?.assignment?.extensionId
      || queueItem?.metadata?.assignedExtensionId
      || "",
  ).trim();

  const account = extensionId
    ? await userAccountRepository.findUserAccountByExtensionId(extensionId).catch(() => null)
    : null;

  const candidates = [
    account?.metadata?.ringcxUsername,
    account?.metadata?.ringcxAgentUsername,
    account?.metadata?.ringcxAgentEmail,
    account?.metadata?.cxUsername,
    account?.cxSession?.rcxAgentEmail,
    dispatchIntent?.agent?.ringcxUsername,
    dispatchIntent?.agent?.ringcxAgentUsername,
    queueItem?.metadata?.rcxVisibilityAgentUsername,
    queueItem?.metadata?.assignedAgentUsername,
    queueItem?.metadata?.lastDialIntent?.assignedAgentUsername,
    account?.cxAuth?.rcUserEmail,
    account?.email,
    dispatchIntent?.agent?.email,
    dispatchIntent?.requestedByUserEmail,
    queueItem?.metadata?.assignedAgentEmail,
  ];

  return candidates
    .map((value) => String(value || "").trim().toLowerCase())
    .find(Boolean) || null;
}

function buildCallerId(dispatchIntent = {}, queueItem = null) {
  const candidates = [
    readAgentRouteCallerId(dispatchIntent, queueItem),
    dispatchIntent?.callerId,
    dispatchIntent?.exShell?.primaryPhone,
    queueItem?.metadata?.callerId,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeUsPhone(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function resolveAgentExtensionId(queueItem = null, dispatchIntent = {}) {
  return String(
    dispatchIntent?.assignedExtensionId
      || dispatchIntent?.dialerExtensionId
      || dispatchIntent?.agent?.assignedExtensionId
      || dispatchIntent?.agent?.extensionId
      || queueItem?.assignment?.extensionId
      || queueItem?.metadata?.assignedExtensionId
      || "",
  ).trim() || null;
}

async function assertDispatchDialerMatchesQueue({
  queueItem = null,
  dispatchIntent = {},
  extensionId = null,
} = {}) {
  const effectiveExtensionId = String(extensionId || "").trim();
  if (!effectiveExtensionId) return;

  const queueAssignedExtensionId = String(queueItem?.assignment?.extensionId || "").trim();
  if (queueAssignedExtensionId && queueAssignedExtensionId !== effectiveExtensionId) {
    const error = new Error(
      `cx-dialer-mismatch:queue-assigned-to-${queueAssignedExtensionId}`,
    );
    error.status = 409;
    error.retryable = false;
    throw error;
  }

  const declaredDialerIds = [
    dispatchIntent?.dialerExtensionId,
    dispatchIntent?.assignedExtensionId,
    dispatchIntent?.agent?.extensionId,
    dispatchIntent?.agent?.assignedExtensionId,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const mismatchedDeclaredId = declaredDialerIds.find((value) => value !== effectiveExtensionId);
  if (mismatchedDeclaredId) {
    const error = new Error("cx-dialer-mismatch:dispatch-agent");
    error.status = 403;
    error.retryable = false;
    error.details = {
      expectedExtensionId: effectiveExtensionId,
      declaredExtensionId: mismatchedDeclaredId,
    };
    throw error;
  }

  const actorEmail = String(
    dispatchIntent?.requestedByUserEmail ||
      dispatchIntent?.dialerEmail ||
      dispatchIntent?.agent?.email ||
      "",
  ).trim().toLowerCase();
  if (actorEmail) {
    const account = await userAccountRepository.findUserAccountByEmail(actorEmail).catch(() => null);
    const accountExtensionId = String(account?.extensionId || "").trim();
    if (accountExtensionId && accountExtensionId !== effectiveExtensionId) {
      const error = new Error("cx-dialer-mismatch:actor-account");
      error.status = 403;
      error.retryable = false;
      error.details = {
        actorEmail,
        accountExtensionId,
        effectiveExtensionId,
      };
      throw error;
    }
  }
}

function normalizeQueueFamily(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    normalized === "fresh-day1"
    || normalized === "day0"
    || normalized === "first-day"
    || normalized === "fresh"
  ) {
    return "fresh-day1";
  }
  if (
    normalized === "fresh-day2to10"
    || normalized === "fresh-day2to15"
    || normalized === "day2to10"
    || normalized === "day2to15"
    || normalized === "day2-10"
    || normalized === "day2-15"
    || normalized === "day2_10"
    || normalized === "day2_15"
  ) {
    return "fresh-day2to10";
  }
  if (normalized === "aged") return "aged";
  return "unassigned";
}

function resolveDialExecutionMode(options = {}, dispatchIntent = {}) {
  const raw = String(
    options.executionMode
      || dispatchIntent.executionMode
      || process.env.RINGCX_DIAL_EXECUTION_MODE
      || "ringcx-campaign-queue",
  ).trim().toLowerCase();
  if (["manual", "manual-oneoff", "active-call", "active-calls"].includes(raw)) {
    return "manual";
  }
  if (["campaign", "campaign-queue", "ringcx-campaign-queue", "progressive"].includes(raw)) {
    return "ringcx-campaign-queue";
  }
  return "ringcx-campaign-queue";
}

function resolveUcqAgeBucket(queueItem = null, dispatchIntent = {}) {
  const base = queueItem && typeof queueItem === "object" ? queueItem : {};
  return deriveUcqAgeBucket({
    ...base,
    actionKey: dispatchIntent.actionKey || base?.metadata?.actionKey || null,
    queueFamily: dispatchIntent.queueFamily || base.queueFamily || base?.metadata?.queueFamily || null,
    metadata: {
      ...(base.metadata && typeof base.metadata === "object" ? base.metadata : {}),
      ...(dispatchIntent && typeof dispatchIntent === "object" ? dispatchIntent : {}),
    },
  });
}

function buildUcqQueueItemPayload({
  queueItem = null,
  dispatchIntent = {},
  domain,
  caseId,
  phone,
  agentId,
  requestedAt,
}) {
  const ageBucket = resolveUcqAgeBucket(queueItem, dispatchIntent);
  const partition = ["just_came_in", "second_contact", "third_contact"].includes(ageBucket)
    ? "fresh"
    : "non_fresh";
  const sourceLogicsCaseId = Number.isFinite(Number(caseId)) ? String(Number(caseId)) : null;
  const actionKey = String(dispatchIntent.actionKey || queueItem?.metadata?.actionKey || "").trim() || null;
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;
  return {
    leadId: buildQueueLeadId({
      domain,
      caseId,
      fallbackId: queueItemId || phone,
    }),
    phoneNumber: phone,
    domain,
    partition,
    ageBucket,
    state: partition === "fresh" ? "fresh_assigned" : "in_slice",
    assignedTo: agentId,
    assignedAt: requestedAt,
    expiresAt: partition === "fresh" ? (queueItem?.claimUntil || null) : null,
    sliceId: partition === "fresh" ? null : `cx:${queueItemId || sourceLogicsCaseId || phone}`,
    enteredQueueAt: queueItem?.releaseAt || requestedAt,
    cadenceDueAt: queueItem?.releaseAt || dispatchIntent?.cadenceDueAt || null,
    sourceCadenceTaskId: actionKey,
    sourceLogicsCaseId,
    recycleCount: 0,
  };
}

async function executeCxDispatchIntent(options = {}) {
  const dispatchIntent =
    options.dispatchIntent && typeof options.dispatchIntent === "object"
      ? { ...options.dispatchIntent }
      : {};
  const queueItem = await resolveQueueItem({
    queueItemId: options.queueItemId,
    domain: options.domain,
    caseId: options.caseId,
    dispatchIntent,
  });
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;
  const domain = normalizeDomain(options.domain || dispatchIntent.domain || queueItem?.domain || "") || "TAG";
  const caseId = Number(
    options.caseId != null
      ? options.caseId
      : dispatchIntent.caseId != null
        ? dispatchIntent.caseId
        : queueItem?.caseId,
  );
  const phone = normalizeUsPhone(
    dispatchIntent.phone
      || dispatchIntent.scramble?.phone
      || queueItem?.phone
      || dispatchIntent.leadSnapshot?.phone
      || "",
  );
  if (!phone) {
    return {
      ok: false,
      executed: false,
      skipped: true,
      reason: "missing-phone",
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
    };
  }

  const recentDialStatus = String(queueItem?.metadata?.lastDialExecutionStatus || "").trim().toLowerCase();
  const recentDialAt = queueItem?.metadata?.lastDialExecutionAt
    ? new Date(queueItem.metadata.lastDialExecutionAt)
    : null;
  const recentUii = normalizeExternalId(queueItem?.metadata?.lastDialExecutionUii);
  if (
    recentDialStatus === "accepted"
    && recentUii
    && recentDialAt
    && !Number.isNaN(recentDialAt.getTime())
    && Date.now() - recentDialAt.getTime() < 30_000
  ) {
    return {
      ok: true,
      executed: true,
      reused: true,
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      uii: recentUii,
    };
  }

  const extensionId = resolveAgentExtensionId(queueItem, dispatchIntent);
  if (!extensionId) {
    await recordWorkflowStage({
      domain,
      family: "cx",
      subtype: "dial-request",
      stage: "failed",
      aggregateType: "cx-dial-queue",
      aggregateId: String(queueItemId || caseId || phone),
      caseId: Number.isFinite(caseId) ? caseId : null,
      sourceService: "ringcentral-cx",
      summary: `CX dispatch intent missing agent extension for ${phone}`,
      payload: {
        queueItemId,
        phone,
      },
    }).catch(() => null);
    return {
      ok: false,
      executed: false,
      skipped: true,
      reason: "missing-agent-extension",
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
    };
  }

  const agentEmail = await resolveAgentEmail(queueItem, dispatchIntent);
  const agentCxAgentId = await resolveAgentCxAgentId(queueItem, dispatchIntent, extensionId);
  const callerId = buildCallerId(dispatchIntent, queueItem);
  const requestedAt = new Date();
  const agentState = extensionId
    ? await agentStateRepository.findAgentStateByExtensionId(extensionId).catch(() => null)
    : null;
  const executionMode = resolveDialExecutionMode(options, dispatchIntent);

  if (executionMode === "ringcx-campaign-queue") {
    try {
      if (!queueItemId || !queueItem) {
        const error = new Error("ringcx-campaign-queue-requires-cx-queue-item");
        error.details = {
          queueItemId,
          domain,
          caseId: Number.isFinite(caseId) ? caseId : null,
          phone,
        };
        error.retryable = false;
        throw error;
      }
      await assertDispatchDialerMatchesQueue({
        queueItem,
        dispatchIntent,
        extensionId,
      });

      const publish = await publishQueueItemToRingcx({
        item: queueItem,
        queueItemId,
        force: true,
        allowedStates: ["claimed", "serving"],
        respectPresenceGate: options.respectPresenceGate !== false,
      });

      if (!publish?.ok || publish.published !== true) {
        const error = new Error(
          publish?.reason
            ? `ringcx-campaign-queue-not-published:${publish.reason}`
            : "ringcx-campaign-queue-not-published",
        );
        error.details = publish || null;
        error.retryable = !publish?.skipped;
        throw error;
      }

      let activeCallCapture = {
        ok: false,
        skipped: true,
        reason: "capture-disabled",
      };
      const captureTimeoutMs = Number(process.env.RINGCX_CAMPAIGN_CALL_CAPTURE_MS);
      if (captureTimeoutMs !== 0) {
        try {
          const captureClient = createRingcxVoiceClient();
          activeCallCapture = await waitForRingcxCampaignCall(captureClient, {
            phone,
            campaignId: publish.campaignId || null,
            externId: publish.externId || null,
            agentEmail: agentEmail || publish.agentUsername || null,
            agentCxAgentId,
            timeoutMs: Number.isFinite(captureTimeoutMs) && captureTimeoutMs > 0
              ? captureTimeoutMs
              : undefined,
            logger: options.logger || null,
          });
        } catch (error) {
          activeCallCapture = {
            ok: false,
            reason: "active-call-capture-error",
            error: error.message,
          };
        }
      }
      const capturedUii = normalizeExternalId(activeCallCapture?.uii);

      if (queueItemId) {
        await cxDialQueueRepository.updateQueueItem(queueItemId, {
          "metadata.lastDialExecutionStatus": capturedUii ? "accepted" : "queued",
          "metadata.lastDialExecutionMode": executionMode,
          "metadata.lastDialExecutionAt": requestedAt,
          "metadata.lastDialExecutionAgentEmail": agentEmail,
          "metadata.lastDialExecutionDialerExtensionId": extensionId,
          "metadata.lastDialExecutionDialerCxAgentId": agentCxAgentId,
          "metadata.lastDialExecutionDialerEmail":
            dispatchIntent.dialerEmail || dispatchIntent.requestedByUserEmail || agentEmail || null,
          "metadata.lastDialExecutionPhone": phone,
          "metadata.lastDialExecutionCallerId": callerId,
          "metadata.lastDialExecutionUii": capturedUii,
          "metadata.lastDialExecutionActiveCall": activeCallCapture?.activeCallSummary || null,
          "metadata.lastDialExecutionActiveCallCapture": activeCallCapture || null,
          "metadata.lastDialExecutionCampaignId": publish.campaignId || null,
          "metadata.lastDialExecutionDialGroupId":
            publish.dialGroupId || dispatchIntent.rcxDialGroupId || queueItem.rcxDialGroupId || queueItem.metadata?.rcxDialGroupId || null,
          "metadata.lastDialExecutionAccountId":
            publish.accountId || dispatchIntent.rcxAccountId || queueItem.rcxAccountId || queueItem.metadata?.rcxAccountId || null,
          "metadata.lastDialExecutionExternId": publish.externId || null,
          "metadata.lastDialExecutionRingcxPublish": publish,
          "metadata.lastDialExecutionSource": options.source || "ringcentral-cx",
          "metadata.lastDialExecutionEventId": dispatchIntent.eventId || null,
          "metadata.lastDialIntentStatus": capturedUii ? "accepted" : "queued-in-ringcx",
        }).catch(() => null);
      }

      if (domain) {
        await recordWorkflowStage({
          domain,
          family: "cx",
          subtype: "dial-request",
          stage: "completed",
          aggregateType: "cx-dial-queue",
          aggregateId: String(queueItemId || caseId || phone),
          caseId: Number.isFinite(caseId) ? caseId : null,
          sourceService: "ringcentral-cx",
          summary: `CX lead queued in RingCX campaign ${publish.campaignId || "unknown"} for ${phone}`,
          payload: {
            queueItemId,
            phone,
            agentEmail,
            extensionId,
            callerId,
            executionMode,
            publish,
            activeCallCapture,
            desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
          },
        }).catch(() => null);
      }

      let callPlacedEvent = null;
      if (queueItemId) {
        callPlacedEvent = await createCxCallPlacedEvent({
          sourceService: "ringcentral-cx",
          dedupeKey: `cx-call-placed:${queueItemId}:${capturedUii || requestedAt.toISOString()}`,
          payload: {
            queueItemId,
            domain,
            caseId: Number.isFinite(caseId) ? caseId : null,
            actionKey: dispatchIntent.actionKey || queueItem?.metadata?.actionKey || null,
            placedAt: requestedAt.toISOString(),
            uii: capturedUii,
            agentEmail,
            phone,
            campaignId: publish.campaignId || null,
            dialGroupId: publish.dialGroupId || null,
            externId: publish.externId || null,
            confirmedCall: Boolean(capturedUii),
            holdUntilDisposition: true,
          },
        }).catch((error) => ({
          ok: false,
          error: error.message || "call-placed-event-failed",
        }));
      }

      return {
        ok: true,
        executed: true,
        queued: true,
        mode: executionMode,
        queueItemId,
        caseId: Number.isFinite(caseId) ? caseId : null,
        phone,
        agentEmail,
        callerId,
        uii: capturedUii,
        callSessionId: null,
        campaignId: publish.campaignId || null,
        dialGroupId: publish.dialGroupId || null,
        externId: publish.externId || null,
        callPlacedEventId:
          callPlacedEvent?.event?._id
          ? String(callPlacedEvent.event._id)
          : callPlacedEvent?._id
            ? String(callPlacedEvent._id)
            : null,
        ringcxPublish: publish,
        activeCallCapture,
        agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
        hint: capturedUii
          ? "Lead was loaded into RingCX and the active call handle was captured for app-side disposition."
          : "Lead was loaded into the RingCX campaign queue. RingCX will dial it when the agent is AVAILABLE in the selected dial group.",
      };
    } catch (error) {
      if (queueItemId) {
        await cxDialQueueRepository.updateQueueItem(queueItemId, {
          "metadata.lastDialExecutionStatus": "error",
          "metadata.lastDialExecutionMode": executionMode,
          "metadata.lastDialExecutionAt": requestedAt,
          "metadata.lastDialExecutionAgentEmail": agentEmail,
          "metadata.lastDialExecutionDialerExtensionId": extensionId,
          "metadata.lastDialExecutionDialerCxAgentId": agentCxAgentId,
          "metadata.lastDialExecutionDialerEmail":
            dispatchIntent.dialerEmail || dispatchIntent.requestedByUserEmail || agentEmail || null,
          "metadata.lastDialExecutionPhone": phone,
          "metadata.lastDialExecutionCallerId": callerId,
          "metadata.lastDialExecutionError": {
            message: error.message || "ringcx-campaign-queue-failed",
            status: error.status || null,
            retryable: Boolean(error.retryable),
            details: error.details || null,
            happenedAt: requestedAt.toISOString(),
          },
          "metadata.lastDialIntentStatus": "error",
        }).catch(() => null);
      }

      if (domain) {
        await recordWorkflowStage({
          domain,
          family: "cx",
          subtype: "dial-request",
          stage: "failed",
          aggregateType: "cx-dial-queue",
          aggregateId: String(queueItemId || caseId || phone),
          caseId: Number.isFinite(caseId) ? caseId : null,
          sourceService: "ringcentral-cx",
          summary: `CX campaign queue publish failed for ${phone}`,
          payload: {
            queueItemId,
            phone,
            agentEmail,
            extensionId,
            callerId,
            executionMode,
            error: error.message || "ringcx-campaign-queue-failed",
            details: error.details || null,
            desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
          },
        }).catch(() => null);
      }

      return {
        ok: false,
        executed: false,
        queued: false,
        mode: executionMode,
        queueItemId,
        caseId: Number.isFinite(caseId) ? caseId : null,
        phone,
        agentEmail,
        callerId,
        error: error.message || "ringcx-campaign-queue-failed",
        details: error.details || null,
        retryable: Boolean(error.retryable),
        agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
      };
    }
  }

  try {
    await assertDispatchDialerMatchesQueue({
      queueItem,
      dispatchIntent,
      extensionId,
    });
    const ucqPayload = buildUcqQueueItemPayload({
      queueItem,
      dispatchIntent,
      domain,
      caseId,
      phone,
      agentId: extensionId,
      requestedAt,
    });
    const ucqResult = await queueItemRepository.upsertActiveItemForLead(ucqPayload, {
      forceDialReady: true,
      returnMetadata: true,
    });
    const ucqQueueItem = ucqResult?.item || null;
    const ucqQueueItemId = ucqQueueItem?._id ? String(ucqQueueItem._id) : null;
    if (!ucqQueueItemId) {
      const error = new Error("ucq-queue-item-not-created");
      error.details = { ucqPayload };
      throw error;
    }

    const response = await placeCall(extensionId, ucqQueueItemId, {
      logger: options.logger || null,
      agentEmail,
      callerId,
    });
    if (!response?.ok) {
      const error = new Error(response?.error || "dial-service-place-call-failed");
      error.details = response || null;
      error.retryable = !String(response?.error || "").startsWith("contact-blocked");
      throw error;
    }
    const uii = response.rcxUii || extractUii(response.placementResponse);

    if (queueItemId) {
      await cxDialQueueRepository.updateQueueItem(queueItemId, {
        "metadata.lastDialExecutionStatus": "accepted",
        "metadata.lastDialExecutionAt": requestedAt,
        "metadata.lastDialExecutionUii": uii,
        "metadata.lastDialExecutionCallSessionId": response.callSessionId || null,
        "metadata.lastDialExecutionUcqQueueItemId": ucqQueueItemId,
        "metadata.lastDialExecutionAgentEmail": agentEmail,
        "metadata.lastDialExecutionPhone": phone,
        "metadata.lastDialExecutionCallerId": callerId,
        "metadata.lastDialExecutionResponse": response || null,
        "metadata.lastDialExecutionSource": options.source || "ringcentral-cx",
        "metadata.lastDialExecutionEventId": dispatchIntent.eventId || null,
        "metadata.lastDialIntentStatus": "accepted",
      }).catch(() => null);
    }

    if (domain) {
      await recordWorkflowStage({
        domain,
        family: "cx",
        subtype: "dial-request",
        stage: "completed",
        aggregateType: "cx-dial-queue",
        aggregateId: String(queueItemId || caseId || phone),
        caseId: Number.isFinite(caseId) ? caseId : null,
        sourceService: "ringcentral-cx",
        summary: `CX manual call accepted for ${phone}`,
        payload: {
          queueItemId,
          phone,
          agentEmail,
          callerId,
          uii,
          callSessionId: response.callSessionId || null,
          ucqQueueItemId,
          response,
          desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
        },
      }).catch(() => null);
    }

    let callPlacedEvent = null;
    if (queueItemId) {
      callPlacedEvent = await createCxCallPlacedEvent({
        sourceService: "ringcentral-cx",
        dedupeKey: `cx-call-placed:${queueItemId}:${uii || requestedAt.toISOString()}`,
        payload: {
          queueItemId,
          domain,
          caseId: Number.isFinite(caseId) ? caseId : null,
          actionKey: dispatchIntent.actionKey || queueItem?.metadata?.actionKey || null,
          placedAt: requestedAt.toISOString(),
          uii,
          agentEmail,
          phone,
          ucqQueueItemId,
          callSessionId: response.callSessionId || null,
          confirmedCall: true,
          holdUntilDisposition: true,
        },
      }).catch((error) => ({
        ok: false,
        error: error.message || "call-placed-event-failed",
      }));
    }

    return {
      ok: true,
      executed: true,
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      agentEmail,
      callerId,
      uii,
      callSessionId: response.callSessionId || null,
      ucqQueueItemId,
      response,
      callPlacedEventId:
        callPlacedEvent?.event?._id
        ? String(callPlacedEvent.event._id)
        : callPlacedEvent?._id
          ? String(callPlacedEvent._id)
          : null,
      agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
    };
  } catch (error) {
    if (queueItemId) {
      await cxDialQueueRepository.updateQueueItem(queueItemId, {
        "metadata.lastDialExecutionStatus": "error",
        "metadata.lastDialExecutionAt": requestedAt,
        "metadata.lastDialExecutionAgentEmail": agentEmail,
        "metadata.lastDialExecutionPhone": phone,
        "metadata.lastDialExecutionCallerId": callerId,
        "metadata.lastDialExecutionError": {
          message: error.message || "manual-call-failed",
          status: error.status || null,
          retryable: Boolean(error.retryable),
          details: error.details || null,
          happenedAt: requestedAt.toISOString(),
        },
        "metadata.lastDialIntentStatus": "error",
      }).catch(() => null);
    }

    if (domain) {
      await recordWorkflowStage({
        domain,
        family: "cx",
        subtype: "dial-request",
        stage: "failed",
        aggregateType: "cx-dial-queue",
        aggregateId: String(queueItemId || caseId || phone),
        caseId: Number.isFinite(caseId) ? caseId : null,
        sourceService: "ringcentral-cx",
        summary: `CX manual call failed for ${phone}`,
        payload: {
          queueItemId,
          phone,
          agentEmail,
          callerId,
          error: error.message || "manual-call-failed",
          details: error.details || null,
          desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
        },
      }).catch(() => null);
    }

    return {
      ok: false,
      executed: false,
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      agentEmail,
      callerId,
      error: error.message || "manual-call-failed",
      details: error.details || null,
      retryable: Boolean(error.retryable),
      agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
    };
  }
}

async function executeCxHangupRequest(options = {}) {
  const dispatchIntent =
    options.dispatchIntent && typeof options.dispatchIntent === "object"
      ? options.dispatchIntent
      : {};
  const queueItem = await resolveQueueItem({
    queueItemId: options.queueItemId,
    domain: options.domain,
    caseId: options.caseId,
    dispatchIntent,
  });
  const queueItemId = queueItem?._id ? String(queueItem._id) : null;
  const domain = normalizeDomain(options.domain || dispatchIntent.domain || queueItem?.domain || "");
  const caseId = Number(
    options.caseId != null
      ? options.caseId
      : dispatchIntent.caseId != null
        ? dispatchIntent.caseId
        : queueItem?.caseId,
  );
  const phone = normalizeUsPhone(
    options.phone
      || dispatchIntent.phone
      || queueItem?.metadata?.lastDialExecutionPhone
      || queueItem?.phone
      || "",
  );
  const requestedAt = new Date();
  const extensionId = String(
    options.assignedExtensionId
      || dispatchIntent.assignedExtensionId
      || dispatchIntent.dialerExtensionId
      || queueItem?.assignment?.extensionId
      || queueItem?.metadata?.assignedExtensionId
      || "",
  ).trim() || null;
  const agentState = extensionId
    ? await agentStateRepository.findAgentStateByExtensionId(extensionId).catch(() => null)
    : null;
  const requestedBy =
    String(
      options.requestedByUserEmail
      || dispatchIntent.requestedByUserEmail
      || options.source
      || "ringcentral-cx",
    ).trim() || "ringcentral-cx";
  const agentEmail = await resolveAgentEmail(queueItem, {
    ...dispatchIntent,
    requestedByUserEmail: requestedBy,
  });
  const agentCxAgentId = await resolveAgentCxAgentId(queueItem, dispatchIntent, extensionId);
  const campaignId = normalizeExternalId(
    options.campaignId
      || dispatchIntent.campaignId
      || queueItem?.rcxCampaignId
      || queueItem?.metadata?.rcxCampaignId
      || queueItem?.metadata?.lastDialExecutionCampaignId
      || "",
  );
  const dialGroupId = normalizeExternalId(
    options.dialGroupId
      || dispatchIntent.dialGroupId
      || dispatchIntent.rcxDialGroupId
      || queueItem?.rcxDialGroupId
      || queueItem?.metadata?.rcxDialGroupId
      || queueItem?.metadata?.lastDialExecutionDialGroupId
      || process.env.RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID
      || "",
  );
  const externId = normalizeExternalId(
    options.externId
      || dispatchIntent.externId
      || queueItem?.metadata?.lastDialExecutionExternId
      || queueItem?.metadata?.rcxVisibilityExternId
      || "",
  );
  let uii = normalizeExternalId(
    options.uii
      || dispatchIntent.uii
      || queueItem?.metadata?.lastDialExecutionUii
      || "",
  );
  const dispositionRequest = buildRcxDispositionRequest(options, dispatchIntent);
  const forceRcxDisposition = shouldForceRingcxDisposition(options, dispatchIntent);
  const hasDispositionIntent = Boolean(
    dispositionRequest.dispositionKey
      || options.disposition
      || dispatchIntent.disposition
      || dispatchIntent.dispositionKey,
  );

  let client = null;
  try {
    client = createRingcxVoiceClient();
  } catch (error) {
    if (queueItemId) {
      await cxDialQueueRepository.updateQueueItem(queueItemId, {
        "metadata.lastHangupRequestStatus": "error",
        "metadata.lastHangupRequestAt": requestedAt,
        "metadata.lastHangupRequestUii": uii,
        "metadata.lastHangupRequestPhone": phone,
        "metadata.lastHangupRequestBy": requestedBy,
        "metadata.lastHangupRequestSource": options.source || "ringcentral-cx",
        "metadata.lastHangupRequestError": serializeError(error, "ringcx-client-init-failed"),
      }).catch(() => null);
    }
    return {
      ok: false,
      executed: false,
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      uii,
      error: error.message || "ringcx-client-init-failed",
      details: error.details || null,
      retryable: Boolean(error.retryable),
      agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
    };
  }

  let activeCallCapture = null;
  if (!uii) {
    activeCallCapture = await waitForRingcxCampaignCall(client, {
      phone,
      campaignId,
      externId,
      agentEmail,
      agentCxAgentId,
      timeoutMs: Number(process.env.RINGCX_END_CALL_CAPTURE_MS) || 5_000,
      logger: options.logger || null,
    });
    uii = normalizeExternalId(activeCallCapture?.uii);
    if (queueItemId) {
      await cxDialQueueRepository.updateQueueItem(queueItemId, {
        "metadata.lastHangupActiveCallCapture": activeCallCapture || null,
        "metadata.lastHangupActiveCallCaptureAt": requestedAt,
        "metadata.lastDialExecutionUii": uii || null,
        "metadata.lastDialExecutionActiveCall": activeCallCapture?.activeCallSummary || null,
      }).catch(() => null);
    }
  }

  if (!uii) {
    let autoDispositionRelease = null;
    if (hasDispositionIntent) {
      autoDispositionRelease = await markAgentAvailableAfterAutoDisposition(extensionId, {
        logger: options.logger || null,
        waitMs: 0,
        uii,
      });
    }
    if (queueItemId) {
      await cxDialQueueRepository.updateQueueItem(queueItemId, {
        "metadata.lastHangupRequestStatus": hasDispositionIntent ? "accepted" : "error",
        "metadata.lastHangupRequestAt": requestedAt,
        "metadata.lastHangupRequestUii": null,
        "metadata.lastHangupRequestPhone": phone,
        "metadata.lastHangupRequestBy": requestedBy,
        "metadata.lastHangupRequestSource": options.source || "ringcentral-cx",
        "metadata.lastHangupRequestHangupStatus": "no-active-call",
        "metadata.lastHangupRequestDisposition": dispositionRequest.dispositionKey || null,
        "metadata.lastHangupRequestDispositionStatus": hasDispositionIntent
          ? "skipped-no-active-call-after-disposition"
          : "skipped-missing-uii",
        "metadata.lastHangupRequestAutoDispositionRelease": autoDispositionRelease,
        "metadata.lastHangupActiveCallCapture": activeCallCapture || null,
      }).catch(() => null);
    }
    return {
      ok: hasDispositionIntent,
      executed: false,
      skipped: true,
      reason: hasDispositionIntent ? "no-active-call-after-disposition" : "missing-uii",
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      activeCallCapture,
      hangupStatus: "no-active-call",
      dispositionStatus: hasDispositionIntent
        ? "skipped-no-active-call-after-disposition"
        : "skipped-missing-uii",
      disposition: dispositionRequest.dispositionKey || null,
      autoDispositionRelease,
      agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
    };
  }

  let dispositionResponse = null;
  let dispositionError = null;
  let dispositionAttempts = [];
  let acceptedDispositionAttempt = null;
  let dispositionStatus = dispositionRequest.rcxCode
    ? (forceRcxDisposition ? "pending" : "auto-disposition-pending")
    : (forceRcxDisposition ? "skipped" : "auto-disposition-pending");
  if (forceRcxDisposition && dispositionRequest.dispositionKey && !dispositionRequest.rcxCode) {
    dispositionStatus = "unknown-disposition";
  }

  if (dispositionRequest.rcxCode && forceRcxDisposition) {
    const dispositionResult = await applyRingcxDisposition(client, uii, dispositionRequest, {
      notes: dispositionRequest.payload?.notes || dispatchIntent.notes || undefined,
      phone: phone || undefined,
    });
    dispositionResponse = dispositionResult.response;
    dispositionError = dispositionResult.error || null;
    dispositionStatus = dispositionResult.status || (dispositionResult.ok ? "accepted" : "error");
    dispositionAttempts = dispositionResult.attempts || [];
    acceptedDispositionAttempt = dispositionResult.acceptedAttempt || null;
  } else if (!forceRcxDisposition) {
    const autoDispositionResult = await applyRingcxAutoDisposition(client, uii, {
      source: "auto-disposition-before-hangup",
      phase: "before-hangup",
      notes: dispositionRequest.payload?.notes || dispatchIntent.notes || undefined,
      phone: phone || undefined,
      campaignId,
      dialGroupId,
    });
    dispositionResponse = autoDispositionResult.response || null;
    dispositionError = autoDispositionResult.error || null;
    dispositionStatus = autoDispositionResult.ok
      ? "auto-disposition-accepted-before-hangup"
      : `auto-disposition-${autoDispositionResult.status}-before-hangup`;
    dispositionAttempts = autoDispositionResult.attempts || [];
    acceptedDispositionAttempt = autoDispositionResult.acceptedAttempt || null;
  }

  let response = null;
  let hangupError = null;
  let hangupStatus = "pending";
  try {
    response = await client.hangupCall(uii);
    hangupStatus = "accepted";
  } catch (error) {
    hangupError = error;
    hangupStatus = isAlreadyEndedHangupError(error) ? "already-ended" : "error";
  }

  let autoDispositionRelease = null;
  if (!forceRcxDisposition) {
    if (hangupStatus === "accepted") {
      const waitMs = getAutoDispositionWaitMs();
      if (waitMs > 0) await sleep(waitMs);
      if (!acceptedDispositionAttempt) {
        const autoDispositionResult = await applyRingcxAutoDisposition(client, uii, {
          source: "auto-disposition-after-hangup",
          phase: "after-hangup",
          notes: dispositionRequest.payload?.notes || dispatchIntent.notes || undefined,
          phone: phone || undefined,
          campaignId,
          dialGroupId,
        });
        dispositionAttempts = [
          ...dispositionAttempts,
          ...(autoDispositionResult.attempts || []),
        ];
        if (autoDispositionResult.ok) {
          dispositionResponse = autoDispositionResult.response || null;
          dispositionError = null;
          dispositionStatus = "auto-disposition-accepted-after-hangup";
          acceptedDispositionAttempt = autoDispositionResult.acceptedAttempt || null;
        } else {
          dispositionResponse = dispositionResponse || autoDispositionResult.response || null;
          dispositionError = autoDispositionResult.error || dispositionError;
          dispositionStatus = `auto-disposition-${autoDispositionResult.status}-after-hangup`;
        }
      }
    }
    if (acceptedDispositionAttempt || isAutoDispositionAccepted(dispositionStatus)) {
      autoDispositionRelease = await markAgentAvailableAfterAutoDisposition(extensionId, {
        logger: options.logger || null,
        waitMs: 0,
        uii,
      });
    }
  }

  const dispositionRequired = Boolean(dispositionRequest.dispositionKey) && forceRcxDisposition;
  const autoDispositionAccepted =
    Boolean(acceptedDispositionAttempt) || isAutoDispositionAccepted(dispositionStatus);
  const callEndedAfterDispositionIntent = hasDispositionIntent
    && (hangupStatus === "accepted" || hangupStatus === "already-ended");
  if (!autoDispositionRelease && callEndedAfterDispositionIntent) {
    autoDispositionRelease = await markAgentAvailableAfterAutoDisposition(extensionId, {
      logger: options.logger || null,
      waitMs: 0,
      uii,
    });
    if (!autoDispositionAccepted && dispositionStatus !== "accepted") {
      dispositionStatus = hangupStatus === "already-ended"
        ? "skipped-call-already-ended-after-disposition"
        : "skipped-call-ended-after-disposition";
    }
  }
  const accepted = dispositionRequired
    ? (dispositionStatus === "accepted" || callEndedAfterDispositionIntent)
      && (hangupStatus === "accepted" || hangupStatus === "already-ended")
    : (autoDispositionAccepted || callEndedAfterDispositionIntent)
      && ["accepted", "already-ended", "error"].includes(hangupStatus);
  if (queueItemId) {
    await cxDialQueueRepository.updateQueueItem(queueItemId, {
      "metadata.lastHangupRequestStatus": accepted ? "accepted" : "error",
      "metadata.lastHangupRequestAt": requestedAt,
      "metadata.lastHangupRequestUii": uii,
      "metadata.lastHangupRequestPhone": phone,
      "metadata.lastHangupRequestBy": requestedBy,
      "metadata.lastHangupRequestSource": options.source || "ringcentral-cx",
      "metadata.lastHangupRequestCampaignId": campaignId,
      "metadata.lastHangupRequestDialGroupId": dialGroupId,
      "metadata.lastHangupRequestResponse": response || null,
      "metadata.lastHangupRequestHangupStatus": hangupStatus,
      "metadata.lastHangupRequestDisposition": dispositionRequest.dispositionKey || null,
      "metadata.lastHangupRequestRcxDisposition": dispositionRequest.rcxCode || null,
      "metadata.lastHangupRequestRcxDispositionAccepted": acceptedDispositionAttempt
        ? acceptedDispositionAttempt.disposition
        : null,
      "metadata.lastHangupRequestDispositionStatus": dispositionStatus,
      "metadata.lastHangupRequestDispositionResponse": dispositionResponse || null,
      "metadata.lastHangupRequestDispositionAttempts": dispositionAttempts,
      "metadata.lastHangupRequestForceRcxDisposition": forceRcxDisposition,
      "metadata.lastHangupRequestAutoDispositionRelease": autoDispositionRelease,
      "metadata.lastHangupRequestDispositionError": dispositionError
        ? serializeError(dispositionError, "disposition-call-failed")
        : null,
      "metadata.lastHangupRequestError": hangupError
        ? serializeError(hangupError, "hangup-call-failed")
        : null,
    }).catch(() => null);
  }

  if (domain) {
    await recordWorkflowStage({
      domain,
      family: "cx",
      subtype: "end-call",
      stage: accepted ? "completed" : "error",
      aggregateType: "cx-dial-queue",
      aggregateId: String(queueItemId || caseId || uii),
      caseId: Number.isFinite(caseId) ? caseId : null,
      sourceService: "ringcentral-cx",
      summary: accepted
        ? `CX disposition/end-call accepted for ${phone || uii}`
        : `CX disposition/end-call failed for ${phone || uii}`,
      payload: {
        queueItemId,
        caseId: Number.isFinite(caseId) ? caseId : null,
        phone,
        uii,
        campaignId,
        dialGroupId,
        requestedBy,
        disposition: dispositionRequest.dispositionKey || null,
        rcxDisposition: dispositionRequest.rcxCode || null,
        rcxDispositionAccepted: acceptedDispositionAttempt
          ? acceptedDispositionAttempt.disposition
          : null,
        dispositionStatus,
        dispositionAttempts,
        forceRcxDisposition,
        autoDispositionRelease,
        hangupStatus,
        response,
        dispositionResponse,
        dispositionError: dispositionError ? serializeError(dispositionError, "disposition-call-failed") : null,
        hangupError: hangupError ? serializeError(hangupError, "hangup-call-failed") : null,
        activeCallCapture,
        desiredAvailability: agentState?.cxRouting?.desiredAvailability || null,
      },
    }).catch(() => null);
  }

  if (accepted) {
    return {
      ok: true,
      executed: true,
      queueItemId,
      caseId: Number.isFinite(caseId) ? caseId : null,
      phone,
      uii,
      campaignId,
      dialGroupId,
      response,
      hangupStatus,
      dispositionStatus,
      disposition: dispositionRequest.dispositionKey || null,
      rcxDisposition: dispositionRequest.rcxCode || null,
      rcxDispositionAccepted: acceptedDispositionAttempt
        ? acceptedDispositionAttempt.disposition
        : null,
      dispositionResponse,
      dispositionAttempts,
      forceRcxDisposition,
      autoDispositionRelease,
      dispositionError: dispositionError ? serializeError(dispositionError, "disposition-call-failed") : null,
      hangupError: hangupError ? serializeError(hangupError, "hangup-call-failed") : null,
      activeCallCapture,
      agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
    };
  }

  return {
    ok: false,
    executed: false,
    queueItemId,
    caseId: Number.isFinite(caseId) ? caseId : null,
    phone,
    uii,
    campaignId,
    dialGroupId,
    error: hangupError?.message || dispositionError?.message || "hangup-call-failed",
    details: hangupError?.details || dispositionError?.details || null,
    retryable: Boolean(hangupError?.retryable || dispositionError?.retryable),
    hangupStatus,
    dispositionStatus,
    disposition: dispositionRequest.dispositionKey || null,
    rcxDisposition: dispositionRequest.rcxCode || null,
    rcxDispositionAccepted: acceptedDispositionAttempt
      ? acceptedDispositionAttempt.disposition
      : null,
    dispositionAttempts,
    forceRcxDisposition,
    autoDispositionRelease,
    activeCallCapture,
    agentAvailability: agentState?.cxRouting?.desiredAvailability || null,
  };
}

module.exports = {
  executeCxDispatchIntent,
  executeCxHangupRequest,
};
