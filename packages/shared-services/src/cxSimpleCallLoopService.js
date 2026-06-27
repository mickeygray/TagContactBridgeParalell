"use strict";

const crypto = require("crypto");
const {
  CxSimpleLoopSession,
} = require("../../shared-models/src");
const {
  cxDialQueueRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  cancelPublishedQueueItemInRingcx,
  publishQueueItemToRingcx,
} = require("./ringcxLeadServingService");
const {
  executeCxHangupRequest,
} = require("./ringcxDialExecutionService");
const {
  handleCxCallPlaced,
  handleCxTerminalCallOutcome,
} = require("./cxCadenceService");
const {
  activeCallContainsText,
  captureRingcxActiveCallForPublishedLead,
  coerceActiveCallList,
  extractActiveCallUii,
  summarizeActiveCall,
} = require("./ringcxActiveCallCaptureService");
const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");

const ACTIVE_QUEUE_STATES = Object.freeze(["ready", "claimed", "serving", "paused"]);
const MAX_EVENT_HISTORY = 80;
const DEFAULT_CAPTURE_TIMEOUT_MS = 8000;
const DEFAULT_CAPTURE_INTERVAL_MS = 250;
const DEFAULT_SIMPLE_LOOP_REFILL_THRESHOLD = 5;
const DEFAULT_ACTIVE_CALL_SNAPSHOT_TTL_MS = 900;
let bulkActiveCallsSnapshot = null;
let bulkActiveCallsSnapshotPromise = null;

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "bulk-mirror" ? "bulk-mirror" : "single";
}

function normalizeSimpleLoopDisposition(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["answer", "answered", "connected"].includes(normalized)) return "answered";
  if (["voicemail", "left-message", "left-voicemail"].includes(normalized)) return "voicemail";
  if (["no-answer", "did-not-answer", "did-not-connect", "no-connect"].includes(normalized)) {
    return "did_not_connect";
  }
  return normalized || "did_not_connect";
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function phoneLast4(value) {
  const phone = normalizePhone(value);
  return phone ? phone.slice(-4) : null;
}

function hashPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return null;
  return crypto.createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

function buildExternId(item = {}) {
  const domain = normalizeDomain(item.domain || "TAG");
  const caseId = Number(item.caseId || 0) || 0;
  const queueItemId = item._id ? String(item._id) : "";
  if (queueItemId) return `parallel:${domain}:${caseId}:${queueItemId}`;
  return `parallel:${domain}:${caseId}`;
}

function simpleLoopEnabled() {
  return parseBooleanFlag(process.env.CX_SIMPLE_LOOP_ENABLED, false);
}

function allowedEmails() {
  return new Set(
    String(process.env.CX_SIMPLE_LOOP_ALLOWED_EMAILS || "")
      .split(",")
      .map(normalizeEmail)
      .filter(Boolean),
  );
}

function maxQueueSize(inputLimit = null) {
  const configured = parsePositiveInteger(process.env.CX_SIMPLE_LOOP_MAX_QUEUE, 5);
  const requested = parsePositiveInteger(inputLimit, configured);
  return Math.min(Math.max(requested, 1), 50);
}

function simpleLoopRefillThreshold(inputLimit = null) {
  const target = maxQueueSize(inputLimit);
  return Math.min(
    Math.max(
      parsePositiveInteger(process.env.CX_SIMPLE_LOOP_REFILL_THRESHOLD, DEFAULT_SIMPLE_LOOP_REFILL_THRESHOLD),
      1,
    ),
    target,
  );
}

function parseQueueItemId(candidate = null) {
  return String(candidate?.queueItemId || "").trim();
}

function collectQueueItemIds(...groups) {
  const seen = new Set();
  for (const group of groups) {
    const items = Array.isArray(group) ? group : [group];
    for (const item of items) {
      const queueItemId = parseQueueItemId(item);
      if (queueItemId) seen.add(queueItemId);
    }
  }
  return seen;
}

function dedupeQueueItems(existing = [], additions = []) {
  const seen = collectQueueItemIds(existing);
  const merged = [];
  for (const candidate of Array.isArray(additions) ? additions : []) {
    const queueItemId = parseQueueItemId(candidate);
    if (!queueItemId || seen.has(queueItemId)) continue;
    seen.add(queueItemId);
    merged.push(candidate);
  }
  return merged;
}

function queueState(candidate = null) {
  return String(candidate?.status || candidate?.ringcx?.status || "pending").toLowerCase();
}

function isPendingForPublish(candidate = null) {
  return queueState(candidate) === "pending";
}

function isMirrored(candidate = null) {
  return queueState(candidate) === "mirrored" || queueState(candidate) === "published";
}

function isBulkBufferCandidate(candidate = null) {
  return ["pending", "mirrored", "published"].includes(queueState(candidate));
}

function scoreBulkActiveCandidate(call = null, candidate = null) {
  if (!call || !candidate) return 0;
  let score = 0;
  const externId = String(candidate.externId || candidate.ringcx?.externId || "").trim();
  const queueItemId = String(candidate.queueItemId || "").trim();
  const caseId = candidate.caseId != null ? String(candidate.caseId) : "";
  // M4: phone-only matching REMOVED. externId (100) / queueItemId (60) are the only ways to reach
  // the >=45 match floor; caseId (+5) only reinforces an existing id match. A recycled phone number
  // must never bind an active call to the wrong lead.
  if (externId && activeCallContainsText(call, externId)) score += 100;
  if (queueItemId && activeCallContainsText(call, queueItemId)) score += 60;
  if (caseId && score > 0 && activeCallContainsText(call, caseId)) score += 5;
  return score;
}

function findBulkCandidateForActiveCall(call = null, candidates = []) {
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      candidate,
      score: scoreBulkActiveCandidate(call, candidate),
    }))
    .filter((entry) => entry.score >= 45)
    .sort((left, right) => right.score - left.score);
  const top = scored[0];
  if (!top) return null;
  const next = scored[1];
  if (next && next.score === top.score) return null;
  return top;
}

async function listBulkActiveCallsForSession(session = {}, logger = null) {
  const now = Date.now();
  const snapshotTtlMs = parsePositiveInteger(
    process.env.CX_SIMPLE_LOOP_ACTIVE_CALL_SNAPSHOT_TTL_MS,
    DEFAULT_ACTIVE_CALL_SNAPSHOT_TTL_MS,
  );
  if (
    bulkActiveCallsSnapshot &&
    now - Number(bulkActiveCallsSnapshot.atMs || 0) <= snapshotTtlMs
  ) {
    return {
      ok: true,
      calls: bulkActiveCallsSnapshot.calls || [],
      queryScope: "ACCOUNT_CACHE",
      cached: true,
    };
  }
  if (bulkActiveCallsSnapshotPromise) {
    try {
      const result = await bulkActiveCallsSnapshotPromise;
      return {
        ...result,
        shared: true,
      };
    } catch (error) {
      logger?.warn?.("cx.simple_loop.bulk_active_list_failed", {
        queryScope: "ACCOUNT_SHARED",
        shared: true,
        error: error.message,
      });
      return {
        ok: false,
        calls: [],
        queryScope: null,
        shared: true,
        error: error.message,
      };
    }
  }

  bulkActiveCallsSnapshotPromise = (async () => {
    const client = createRingcxVoiceClient();
    const payload = await client.listActiveCalls({
      product: "ACCOUNT",
      productId: client.config?.accountId,
    });
    const calls = coerceActiveCallList(payload);
    bulkActiveCallsSnapshot = {
      atMs: Date.now(),
      calls,
    };
    return { ok: true, calls, queryScope: "ACCOUNT", cached: false };
  })();

  try {
    return await bulkActiveCallsSnapshotPromise;
  } catch (error) {
    logger?.warn?.("cx.simple_loop.bulk_active_list_failed", {
      queryScope: "ACCOUNT",
      error: error.message,
    });
    return {
      ok: false,
      calls: [],
      queryScope: null,
      error: error.message,
    };
  } finally {
    bulkActiveCallsSnapshotPromise = null;
  }
}

function buildSimpleLoopCallPayload(candidate = {}, session = {}, extra = {}) {
  const uii = String(extra.uii || candidate.uii || "").trim() || null;
  return {
    queueItemId: candidate.queueItemId || null,
    domain: candidate.domain || null,
    caseId: candidate.caseId || null,
    actionKey: candidate.metadata?.actionKey || null,
    phone: candidate.phone || null,
    uii,
    callSessionId: uii,
    telephonySessionId: uii,
    extensionId: session.agentExtensionId || candidate.assignment?.extensionId || null,
    assignedExtensionId: session.agentExtensionId || candidate.assignment?.extensionId || null,
    agentName: candidate.assignment?.agentName || null,
    agentEmail: session.agentEmail || null,
    campaignId: candidate.ringcx?.campaignId || candidate.campaignId || null,
    dialGroupId: candidate.ringcx?.dialGroupId || candidate.dialGroupId || null,
    externId: candidate.ringcx?.externId || candidate.externId || null,
    ...extra,
  };
}

async function recordSimpleLoopCallPlaced(candidate = {}, session = {}, input = {}, options = {}) {
  const logger = options.logger || console;
  if (!candidate?.queueItemId) return { ok: true, skipped: true, reason: "missing-queue-item" };
  try {
    const payload = buildSimpleLoopCallPayload(candidate, session, {
      placedAt: new Date().toISOString(),
      uii: input.uii || candidate.uii || null,
      confirmedCall: Boolean(input.uii || candidate.uii),
      countAsAttempt: true,
      ringcxPublished: true,
      holdUntilDisposition: true,
      sourceService: "cx-simple-loop",
      source: "bulk-active-call-match",
    });
    return await handleCxCallPlaced(payload);
  } catch (error) {
    logger?.warn?.("cx.simple_loop.call_placed_record_failed", {
      sessionId: session.sessionId || null,
      queueItemId: candidate.queueItemId || null,
      caseId: candidate.caseId || null,
      error: error.message || "call-placed-record-failed",
    });
    return { ok: false, error: error.message || "call-placed-record-failed" };
  }
}

async function recordSimpleLoopAutoAdvanceTerminal(candidate = {}, session = {}, options = {}) {
  const logger = options.logger || console;
  if (!candidate?.queueItemId) return { ok: true, skipped: true, reason: "missing-queue-item" };
  try {
    const payload = buildSimpleLoopCallPayload(candidate, session, {
      outcome: "did_not_connect",
      disposition: "did_not_connect",
      result: "NOANSWER",
      outcomeAt: new Date().toISOString(),
      sourceService: "cx-simple-loop",
      source: "ringcx-active-call-changed",
    });
    return await handleCxTerminalCallOutcome(payload);
  } catch (error) {
    logger?.warn?.("cx.simple_loop.auto_advance_terminal_failed", {
      sessionId: session.sessionId || null,
      queueItemId: candidate.queueItemId || null,
      caseId: candidate.caseId || null,
      uii: candidate.uii || null,
      error: error.message || "auto-advance-terminal-failed",
    });
    return { ok: false, error: error.message || "auto-advance-terminal-failed" };
  }
}

function bulkBufferCount(session = {}) {
  return (Array.isArray(session.queue) ? session.queue : [])
    .filter(isBulkBufferCandidate)
    .length;
}

function sessionKnownQueueItems(session = {}) {
  return [
    ...(Array.isArray(session.queue) ? session.queue : []),
    ...(session.current ? [session.current] : []),
    ...(Array.isArray(session.completed) ? session.completed : []),
  ];
}

function makeHttpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function assertSimpleLoopAccess(input = {}, user = {}) {
  if (!simpleLoopEnabled()) {
    throw makeHttpError("CX simple loop is disabled", 403, "cx-simple-loop-disabled");
  }
  const targetEmail = normalizeEmail(input.agentEmail || user.email);
  const requesterEmail = normalizeEmail(user.email);
  const allowed = allowedEmails();
  const requesterAllowed = allowed.has(requesterEmail);
  const targetAllowed = allowed.has(targetEmail);
  if (!requesterAllowed && !targetAllowed && user.role !== "admin") {
    throw makeHttpError("CX simple loop is not enabled for this user", 403, "cx-simple-loop-not-allowed");
  }
  if (!targetEmail) {
    throw makeHttpError("agentEmail is required", 400, "cx-simple-loop-agent-required");
  }
  return targetEmail;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function asPlainSession(doc = null) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : clonePlain(doc);
}

function safeEventPayload(event = {}) {
  const clone = { ...event };
  delete clone.phone;
  delete clone.leadPhone;
  delete clone.diagnostics;
  if (clone.activeCallSummary) {
    clone.activeCallSummary = sanitizeActiveCallSummary(clone.activeCallSummary);
  }
  if (clone.candidate && typeof clone.candidate === "object") {
    clone.candidate = sanitizeCandidateForClient(clone.candidate);
  }
  return clone;
}

function appendEvent(state, event = {}, now = new Date()) {
  const events = Array.isArray(state.events) ? state.events.slice(-MAX_EVENT_HISTORY + 1) : [];
  events.push({
    type: event.type || "unknown",
    at: now.toISOString(),
    ...safeEventPayload(event),
  });
  state.events = events;
}

function queueItemLookupId(candidate) {
  return String(candidate?.queueItemId || "").trim();
}

function hasCompletedCandidate(state, queueItemId) {
  const target = String(queueItemId || "").trim();
  if (!target) return true;
  return Array.isArray(state.completed)
    ? state.completed.some((completed) => queueItemLookupId(completed) === target)
    : false;
}

function appendCompletedCandidate(state, candidate, patch = {}) {
  if (!candidate || typeof candidate !== "object") return false;
  const queueItemId = queueItemLookupId(candidate);
  if (!queueItemId || hasCompletedCandidate(state, queueItemId)) return false;
  state.completed.push({
    ...clonePlain(candidate),
    ...patch,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  });
  return true;
}

function makeStats(previous = {}) {
  return {
    started: Number(previous.started || 0),
    published: Number(previous.published || 0),
    publishFailed: Number(previous.publishFailed || 0),
    captureFound: Number(previous.captureFound || 0),
    captureMissed: Number(previous.captureMissed || 0),
    completed: Number(previous.completed || 0),
    skipped: Number(previous.skipped || 0),
    killed: Number(previous.killed || 0),
    captureMissWindow: Array.isArray(previous.captureMissWindow) ? previous.captureMissWindow.slice(-10) : [],
    ...previous,
  };
}

function incrementStat(stats, key, amount = 1) {
  stats[key] = Number(stats[key] || 0) + amount;
}

function updateQueueCandidate(queue = [], queueItemId, patch = {}) {
  return queue.map((candidate) => (
    String(candidate.queueItemId || "") === String(queueItemId || "")
      ? { ...candidate, ...patch, updatedAt: patch.updatedAt || new Date().toISOString() }
      : candidate
  ));
}

function removeQueueCandidate(queue = [], queueItemId) {
  return queue.filter((candidate) => String(candidate.queueItemId || "") !== String(queueItemId || ""));
}

function reduceCxSimpleLoopSession(previous = {}, event = {}, nowInput = new Date()) {
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  const nowIso = now.toISOString();
  const state = {
    ...clonePlain(previous || {}),
    queue: Array.isArray(previous.queue) ? clonePlain(previous.queue) : [],
    current: previous.current ? clonePlain(previous.current) : null,
    completed: Array.isArray(previous.completed) ? clonePlain(previous.completed) : [],
    events: Array.isArray(previous.events) ? clonePlain(previous.events) : [],
    stats: makeStats(previous.stats || {}),
    updatedAt: now,
  };

  switch (event.type) {
    case "session.started": {
      state.status = "running";
      state.startedAt = state.startedAt || now;
      incrementStat(state.stats, "started");
      break;
    }
    case "session.killed": {
      state.status = "killed";
      state.killedAt = now;
      state.current = null;
      incrementStat(state.stats, "killed");
      break;
    }
    case "session.paused": {
      state.status = "paused";
      state.pausedAt = now;
      state.lastError = event.reason || null;
      break;
    }
    case "advance.started": {
      if (!event.candidate) break;
      state.current = {
        ...clonePlain(event.candidate),
        phase: "publishing",
        startedAt: nowIso,
        updatedAt: nowIso,
      };
      state.queue = removeQueueCandidate(state.queue, event.candidate.queueItemId);
      break;
    }
    case "publish.accepted": {
      if (state.current) {
        state.current = {
          ...state.current,
          phase: "confirming",
          ringcx: {
            ...(state.current.ringcx || {}),
            status: "published",
            campaignId: event.campaignId || state.current.campaignId || null,
            dialGroupId: event.dialGroupId || state.current.dialGroupId || null,
            accountId: event.accountId || null,
            externId: event.externId || state.current.externId || null,
            publishedAt: nowIso,
            loadSummary: event.loadSummary || null,
          },
          updatedAt: nowIso,
        };
      }
      state.queue = updateQueueCandidate(state.queue, event.queueItemId, {
        ringcx: {
          status: "published",
          campaignId: event.campaignId || null,
          dialGroupId: event.dialGroupId || null,
          externId: event.externId || null,
          publishedAt: nowIso,
        },
      });
      incrementStat(state.stats, "published");
      break;
    }
    case "publish.failed": {
      appendCompletedCandidate(state, state.current || event.candidate || {}, {
        phase: "failed",
        outcome: "publish-failed",
        error: event.error || null,
        failedAt: nowIso,
      });
      state.current = null;
      state.lastError = event.error || "publish-failed";
      incrementStat(state.stats, "publishFailed");
      break;
    }
    case "capture.found": {
      if (state.current) {
        state.current = {
          ...state.current,
          phase: "active",
          uii: event.uii || state.current.uii || null,
          activeEvidenceAt: nowIso,
          activeCallSummary: event.activeCallSummary || null,
          matchReasons: event.matchReasons || [],
          firstPollMs: event.firstPollMs ?? null,
          uiiFoundMs: event.uiiFoundMs ?? null,
          activeAt: nowIso,
          updatedAt: nowIso,
        };
      }
      incrementStat(state.stats, "captureFound");
      break;
    }
    case "capture.missed": {
      const candidate = state.current || event.candidate || null;
      const eventQueueItemId = String(event.queueItemId || candidate?.queueItemId || "").trim();
      const alreadyCompleted = eventQueueItemId ? hasCompletedCandidate(state, eventQueueItemId) : false;
      const added = candidate
        ? appendCompletedCandidate(state, candidate, {
          phase: "failed",
          outcome: "capture-missed",
          reason: event.reason || "active-call-not-found",
          error: event.error || null,
          captureDiagnostics: event.diagnostics || null,
          failedAt: nowIso,
        })
        : false;
      state.current = null;
      state.lastError = event.reason || "capture-missed";
      if ((candidate && added) || (!candidate && !alreadyCompleted)) {
        state.stats.captureMissWindow = [
          ...(Array.isArray(state.stats.captureMissWindow) ? state.stats.captureMissWindow : []),
          nowIso,
        ].slice(-10);
        incrementStat(state.stats, "captureMissed");
      }
      state.lastError = event.reason || "capture-missed";
      break;
    }
    case "bulk.watch.empty": {
      state.stats.bulkWatchEmpty = Number(state.stats.bulkWatchEmpty || 0) + 1;
      state.stats.bulkBufferCount = bulkBufferCount(state);
      state.lastError = null;
      break;
    }
    case "terminal.submitted": {
      if (state.current) {
        const added = appendCompletedCandidate(state, state.current, {
          ...state.current,
          phase: "released",
          outcome: event.outcome || "unknown",
          dispositionResult: event.dispositionResult || null,
          completedAt: nowIso,
          updatedAt: nowIso,
        });
        if (added) {
          incrementStat(state.stats, "completed");
        }
      }
      state.current = null;
      if (!state.current) {
        state.lastError = null;
      }
      break;
    }
    case "current.skipped": {
      if (state.current) {
        const added = appendCompletedCandidate(state, state.current, {
          ...state.current,
          phase: "skipped",
          outcome: event.reason || "skipped",
          completedAt: nowIso,
          updatedAt: nowIso,
        });
        if (added) {
          incrementStat(state.stats, "skipped");
        }
      }
      state.current = null;
      break;
    }
    case "bulk.publish.accepted": {
      state.queue = updateQueueCandidate(state.queue, event.queueItemId, {
        status: "mirrored",
        ringcx: {
          status: "published",
          campaignId: event.campaignId || null,
          dialGroupId: event.dialGroupId || null,
          accountId: event.accountId || null,
          externId: event.externId || null,
          publishedAt: nowIso,
          loadSummary: event.loadSummary || null,
        },
      });
      incrementStat(state.stats, "published");
      state.stats.bulkBufferCount = bulkBufferCount(state);
      break;
    }
    case "bulk.publish.failed": {
      state.queue = updateQueueCandidate(state.queue, event.queueItemId, {
        status: "failed",
        ringcx: {
          status: "error",
          error: event.error || "publish-failed",
          failedAt: nowIso,
        },
      });
      state.lastError = event.error || "bulk-publish-failed";
      incrementStat(state.stats, "publishFailed");
      state.stats.bulkBufferCount = bulkBufferCount(state);
      break;
    }
    case "bulk.capture.found": {
      if (!event.candidate) break;
      const currentQueueItemId = queueItemLookupId(state.current);
      const nextQueueItemId = queueItemLookupId(event.candidate);
      const currentUii = String(state.current?.uii || "").trim();
      const nextUii = String(event.uii || "").trim();
      if (
        state.current &&
        currentQueueItemId &&
        currentQueueItemId !== nextQueueItemId &&
        (!currentUii || !nextUii || currentUii !== nextUii)
      ) {
        const added = appendCompletedCandidate(state, state.current, {
          ...state.current,
          phase: "released",
          outcome: "cx-auto-advanced",
          reason: "ringcx-active-call-changed",
          completedAt: nowIso,
          updatedAt: nowIso,
        });
        if (added) {
          incrementStat(state.stats, "completed");
          incrementStat(state.stats, "cxAutoAdvanced");
        }
      }
      state.current = {
        ...clonePlain(event.candidate),
        phase: "active",
        uii: event.uii || null,
        activeCallSummary: event.activeCallSummary || null,
        matchReasons: event.matchReasons || [],
        firstPollMs: event.firstPollMs ?? null,
        uiiFoundMs: event.uiiFoundMs ?? null,
        activeEvidenceAt: nowIso,
        activeAt: nowIso,
        updatedAt: nowIso,
      };
      state.queue = removeQueueCandidate(state.queue, event.candidate.queueItemId);
      incrementStat(state.stats, "captureFound");
      state.stats.bulkBufferCount = bulkBufferCount(state);
      break;
    }
    default:
      break;
  }

  appendEvent(state, event, now);
  return state;
}

function assignReducedSession(doc, reduced) {
  const fields = [
    "status",
    "mode",
    "agentEmail",
    "agentExtensionId",
    "cxAgentId",
    "queue",
    "current",
    "completed",
    "events",
    "stats",
    "lastError",
    "startedAt",
    "killedAt",
    "pausedAt",
  ];
  for (const field of fields) {
    if (reduced[field] !== undefined) doc[field] = reduced[field];
  }
  return doc;
}

async function applySessionEvent(doc, event, options = {}) {
  const now = options.now || new Date();
  const reduced = reduceCxSimpleLoopSession(asPlainSession(doc), event, now);
  assignReducedSession(doc, reduced);
  await doc.save();
  options.logger?.info?.("cx.simple_loop.transition", {
    sessionId: doc.sessionId,
    event: event.type || "unknown",
    agentEmail: doc.agentEmail,
    currentQueueItemId: doc.current?.queueItemId || null,
    currentUii: doc.current?.uii || null,
    status: doc.status,
    queueCount: Array.isArray(doc.queue) ? doc.queue.length : 0,
    bufferCount: bulkBufferCount(doc),
  });
  return doc;
}

function summarizeCandidate(item = {}) {
  const plain = typeof item.toObject === "function" ? item.toObject() : item;
  const metadata = plain.metadata && typeof plain.metadata === "object" ? plain.metadata : {};
  const phone = normalizePhone(plain.phone || metadata.phone || metadata.leadPhone);
  const queueItemId = plain._id ? String(plain._id) : String(plain.queueItemId || "");
  const campaignId = String(
    plain.rcxCampaignId
      || metadata.rcxVisibilityCampaignId
      || metadata.lastRingcxPublishedCampaignId
      || metadata.lastDialExecutionCampaignId
      || "",
  ).trim() || null;
  const dialGroupId = String(
    plain.rcxDialGroupId
      || metadata.rcxVisibilityDialGroupId
      || metadata.lastRingcxPublishedDialGroupId
      || metadata.lastDialExecutionDialGroupId
      || "",
  ).trim() || null;
  const externId = String(
    metadata.rcxVisibilityExternId
      || metadata.lastRingcxPublishedExternId
      || metadata.lastDialExecutionExternId
      || buildExternId(plain)
      || "",
  ).trim() || null;

  return {
    queueItemId,
    domain: normalizeDomain(plain.domain),
    caseId: Number(plain.caseId || 0) || null,
    name: plain.name || metadata.name || null,
    phone,
    phoneLast4: phoneLast4(phone),
    phoneHash: hashPhone(phone),
    queueFamily: plain.queueFamily || null,
    queueTier: plain.queueTier || null,
    progressiveStageKey: plain.progressiveStageKey || null,
    state: plain.state || null,
    assignment: {
      extensionId: plain.assignment?.extensionId || null,
      agentName: plain.assignment?.agentName || null,
    },
    campaignId,
    dialGroupId,
    accountId: plain.rcxAccountId || metadata.rcxVisibilityAccountId || null,
    externId,
    status: "pending",
    metadata: {
      actionKey: metadata.actionKey || null,
      routeCampaignKey: metadata.routeCampaignKey || null,
      lastRingcxPublishedAt: metadata.lastRingcxPublishedAt || null,
      rcxVisibilityStatus: metadata.rcxVisibilityStatus || null,
    },
  };
}

function sanitizeCandidateForClient(candidate = null) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const clone = { ...candidate };
  const candidatePhone = candidate.phone;
  delete clone.phone;
  clone.phoneLast4 = phoneLast4(candidatePhone) || clone.phoneLast4 || null;
  clone.phoneHash = hashPhone(candidatePhone) || clone.phoneHash || null;
  if (clone.activeCallSummary) {
    clone.activeCallSummary = sanitizeActiveCallSummary(clone.activeCallSummary);
  }
  if (clone.captureDiagnostics) {
    clone.captureDiagnostics = {
      count: Array.isArray(clone.captureDiagnostics) ? clone.captureDiagnostics.length : 0,
    };
  }
  return clone;
}

function sanitizeActiveCallSummary(summary = null) {
  if (!summary || typeof summary !== "object") return summary;
  return {
    uii: summary.uii || summary.UII || summary.callId || summary.callID || summary.activeCallId || summary.id || null,
    state: summary.state || summary.status || summary.callState || null,
    campaignId: summary.campaignId || null,
    dialGroupId: summary.dialGroupId || null,
    agentId: summary.agentId || null,
    username: summary.username || null,
    agentEmail: summary.agentEmail || null,
    externId: summary.externId || summary.externalId || null,
    rawKeys: Array.isArray(summary.rawKeys) ? summary.rawKeys.slice(0, 80) : [],
  };
}

function sanitizeSessionForClient(session = null) {
  const plain = asPlainSession(session);
  if (!plain) return null;
  return {
    sessionId: plain.sessionId,
    status: plain.status,
    mode: plain.mode,
    agentEmail: plain.agentEmail,
    agentExtensionId: plain.agentExtensionId,
    cxAgentId: plain.cxAgentId,
    queue: Array.isArray(plain.queue) ? plain.queue.map(sanitizeCandidateForClient) : [],
    current: sanitizeCandidateForClient(plain.current),
    completed: Array.isArray(plain.completed)
      ? plain.completed.slice(-20).map(sanitizeCandidateForClient)
      : [],
    events: Array.isArray(plain.events) ? plain.events.slice(-40) : [],
    stats: plain.stats || {},
    lastError: plain.lastError || null,
    startedAt: plain.startedAt || null,
    updatedAt: plain.updatedAt || null,
  };
}

async function resolveAgentAccount(agentEmail) {
  const account = await userAccountRepository.findUserAccountByEmail(agentEmail);
  if (!account) {
    throw makeHttpError(`No user account found for ${agentEmail}`, 404, "cx-simple-loop-agent-not-found");
  }
  return account;
}

async function loadSimpleLoopQueue(input = {}, account = {}) {
  const limit = maxQueueSize(input.limit);
  let docs = [];
  const excludeIds = Array.isArray(input.excludeQueueItemIds)
    ? input.excludeQueueItemIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  if (Array.isArray(input.queueItemIds) && input.queueItemIds.length > 0) {
    const loaded = await Promise.all(
      input.queueItemIds.slice(0, limit).map((id) => cxDialQueueRepository.findQueueItemById(id)),
    );
    const excluded = new Set(excludeIds);
    docs = loaded
      .filter(Boolean)
      .map((doc) => (typeof doc.toObject === "function" ? doc.toObject() : doc))
      .filter((doc) => !excluded.has(String(doc._id || doc.queueItemId || "")));
  } else {
    docs = await cxDialQueueRepository.listQueueItems({
      states: Array.isArray(input.states) && input.states.length > 0 ? input.states : ACTIVE_QUEUE_STATES,
      visibleExtensionId: input.agentExtensionId || account.extensionId,
      includeUnassignedVisible: input.includeUnassignedVisible === true,
      excludeIds,
      limit,
    });
  }

  let candidates = docs.map(summarizeCandidate).filter((candidate) => candidate.queueItemId && candidate.phone);
  if (input.reverse === true) candidates = candidates.reverse();
  return candidates.slice(0, limit);
}

function getBulkQueueTargetSize(session = {}, input = {}) {
  const fromSession = parsePositiveInteger(session.stats?.queueTarget, null);
  const fromInput = parsePositiveInteger(input.limit, null);
  return fromInput || fromSession || maxQueueSize();
}

function shouldReplenishBulkQueue(session = {}, input = {}) {
  const published = Number(session.stats?.published || 0);
  if (!Number.isFinite(published) || published <= 0) return false;
  const queue = bulkBufferCount(session);
  const targetSize = getBulkQueueTargetSize(session, input);
  const threshold = simpleLoopRefillThreshold(targetSize);
  return queue <= threshold;
}

async function replenishBulkQueue(session, input = {}, options = {}) {
  const logger = options.logger || console;
  if (!shouldReplenishBulkQueue(session, input)) return false;
  const target = getBulkQueueTargetSize(session, input);
  if (!target) return false;
  const available = bulkBufferCount(session);
  const needed = Math.max(target - available, 0);
  if (needed <= 0) return false;

  const account = { extensionId: session.agentExtensionId };
  const knownQueueItemIds = Array.from(collectQueueItemIds(sessionKnownQueueItems(session)));
  const fresh = await loadSimpleLoopQueue(
    {
      states: ACTIVE_QUEUE_STATES,
      visibleExtensionId: session.agentExtensionId || null,
      includeUnassignedVisible: input.includeUnassignedVisible === true,
      excludeQueueItemIds: knownQueueItemIds,
      reverse: input.reverse === true,
      limit: needed,
    },
    account,
  );

  const additions = dedupeQueueItems(sessionKnownQueueItems(session), fresh);
  if (additions.length === 0) {
    return false;
  }

  session.queue = [
    ...(Array.isArray(session.queue) ? session.queue : []),
    ...additions,
  ];
  session.stats = {
    ...(session.stats || {}),
    bulkBufferCount: bulkBufferCount(session),
  };
  logger.info?.("cx.simple_loop.replenish_bulk_queue", {
    sessionId: session.sessionId,
    added: additions.length,
    queueCount: session.queue.length,
    bufferCount: bulkBufferCount(session),
    needed,
    target,
  });
  return true;
}

async function getMutableSession(sessionId, agentEmail = null) {
  const query = sessionId
    ? { sessionId: String(sessionId) }
    : {
      agentEmail: normalizeEmail(agentEmail),
      status: { $in: ["running", "paused"] },
    };
  const doc = await CxSimpleLoopSession.findOne(query).sort({ updatedAt: -1 });
  if (!doc) throw makeHttpError("CX simple loop session not found", 404, "cx-simple-loop-session-not-found");
  return doc;
}

async function startCxSimpleLoopSession(input = {}, options = {}) {
  const logger = options.logger || console;
  const agentEmail = assertSimpleLoopAccess(input, options.user || {});
  const account = await resolveAgentAccount(agentEmail);
  if (input.replaceExisting !== false) {
    await killSimpleLoopSessionsForAgent({
      agentEmail,
      reason: "replaced-by-new-simple-loop-session",
      logger,
      skipSessionId: null,
    });
  }

  const targetQueueSize = maxQueueSize(input.limit);
  const queue = await loadSimpleLoopQueue({
    ...input,
    limit: targetQueueSize,
  }, account);

  const session = await CxSimpleLoopSession.create({
    sessionId: `cx-simple-${Date.now()}-${crypto.randomUUID()}`,
    status: "running",
    mode: normalizeMode(input.mode || process.env.CX_SIMPLE_LOOP_MODE || "single"),
    agentEmail,
    agentExtensionId: input.agentExtensionId || account.extensionId || null,
    cxAgentId: input.cxAgentId || account.cxAgentId || account.metadata?.ringcxAgentId || null,
    queue,
    current: null,
    completed: [],
    events: [],
    stats: {
      queueLoaded: queue.length,
      queueTarget: targetQueueSize,
      bulkBufferCount: queue.length,
      captureMissWindow: [],
    },
    startedAt: new Date(),
  });
  await applySessionEvent(session, { type: "session.started", queueCount: queue.length }, { logger });
  logger.info?.("cx.simple_loop.started", {
    sessionId: session.sessionId,
    agentEmail,
    agentExtensionId: session.agentExtensionId,
    mode: session.mode,
    targetQueueSize,
    queueCount: queue.length,
  });

  if (input.autoAdvance === true) {
    return advanceCxSimpleLoopSession({ sessionId: session.sessionId }, options);
  }
  return sanitizeSessionForClient(session);
}

async function publishCandidate(candidate, options = {}) {
  const item = await cxDialQueueRepository.findQueueItemById(candidate.queueItemId);
  if (!item) {
    return {
      ok: false,
      published: false,
      error: "queue-item-not-found",
      queueItemId: candidate.queueItemId,
    };
  }
  return publishQueueItemToRingcx({
    item,
    force: true,
    respectPresenceGate: false,
    allowedStates: ACTIVE_QUEUE_STATES,
    dialPriority: options.dialPriority || "IMMEDIATE",
  });
}

async function cancelCandidatePublish(candidate = {}, reason = "cx-simple-loop-release", logger = null) {
  if (!candidate?.queueItemId) return { ok: true, cancelled: false, skipped: true, reason: "missing-queue-item" };
  return cancelPublishedQueueItemInRingcx(candidate.queueItemId, {
    campaignId: candidate.ringcx?.campaignId || candidate.campaignId || null,
    externId: candidate.ringcx?.externId || candidate.externId || null,
    reason,
  }).catch((error) => {
    logger?.warn?.("cx.simple_loop.cancel_failed", {
      queueItemId: candidate.queueItemId,
      reason,
      error: error.message,
    });
    return {
      ok: false,
      cancelled: false,
      error: error.message,
    };
  });
}

function captureOptionsForCandidate(candidate = {}, session = {}, input = {}) {
  return {
    phone: candidate.phone,
    campaignId: candidate.campaignId || candidate.ringcx?.campaignId || null,
    dialGroupId: candidate.dialGroupId || candidate.ringcx?.dialGroupId || null,
    externId: candidate.externId || candidate.ringcx?.externId || null,
    agentEmail: session.agentEmail,
    agentCxAgentId: session.cxAgentId,
    timeoutMs: input.timeoutMs || parsePositiveInteger(process.env.CX_SIMPLE_LOOP_CAPTURE_MS, DEFAULT_CAPTURE_TIMEOUT_MS),
    intervalMs: input.intervalMs || parsePositiveInteger(process.env.CX_SIMPLE_LOOP_CAPTURE_INTERVAL_MS, DEFAULT_CAPTURE_INTERVAL_MS),
    includeDiagnostics: input.includeDiagnostics === true,
  };
}

function shouldPauseAfterCaptureMiss(session = {}) {
  const stats = session.stats && typeof session.stats === "object" ? session.stats : {};
  const windowMs = parsePositiveInteger(process.env.CX_SIMPLE_LOOP_MISS_WINDOW_MS, 5 * 60 * 1000);
  const limit = parsePositiveInteger(process.env.CX_SIMPLE_LOOP_MISS_LIMIT, 3);
  const cutoff = Date.now() - windowMs;
  const recent = (Array.isArray(stats.captureMissWindow) ? stats.captureMissWindow : [])
    .map((value) => new Date(value).getTime())
    .filter((time) => Number.isFinite(time) && time >= cutoff);
  return recent.length >= limit;
}

function shouldCancelCandidate(candidate = null) {
  return Boolean(candidate?.queueItemId) && queueState(candidate) !== "completed";
}

function dedupeByQueueItemId(items = []) {
  const seen = new Set();
  const output = [];
  for (const candidate of Array.isArray(items) ? items : []) {
    const queueItemId = queueItemLookupId(candidate);
    if (!queueItemId || seen.has(queueItemId)) continue;
    seen.add(queueItemId);
    output.push(candidate);
  }
  return output;
}

async function cancelCandidatesForSession(session = {}, options = {}) {
  const logger = options.logger || null;
  const reason = options.reason || "cx-simple-loop-killed";
  const candidates = dedupeByQueueItemId([
    ...(Array.isArray(session.queue) ? session.queue : []),
    ...(session.current ? [session.current] : []),
  ]).filter(shouldCancelCandidate);

  for (const candidate of candidates) {
    await cancelCandidatePublish(candidate, reason, logger)
      .catch((error) => {
        logger?.warn?.("cx.simple_loop.cancel_failed", {
          sessionId: session.sessionId || session._id || null,
          queueItemId: candidate.queueItemId,
          reason,
          error: error.message,
        });
      });
  }
}

async function killSimpleLoopSessionsForAgent({
  agentEmail,
  reason,
  logger,
  skipSessionId = null,
} = {}) {
  if (!agentEmail) return;
  const sessions = await CxSimpleLoopSession.find({
    agentEmail,
    status: { $in: ["running", "paused"] },
    ...(skipSessionId ? { sessionId: { $ne: String(skipSessionId) } } : {}),
  }).sort({ updatedAt: -1 });
  for (const session of sessions) {
    await cancelCandidatesForSession(session, { logger, reason });
    await applySessionEvent(session, { type: "session.killed", reason }, { logger });
  }
}

async function advanceSingleSession(session, input = {}, options = {}) {
  const logger = options.logger || console;
  if (session.current && input.force !== true) {
    return sanitizeSessionForClient(session);
  }
  const candidate = (Array.isArray(session.queue) ? session.queue : [])
    .find((entry) => ["pending", "failed"].includes(String(entry.status || "pending")) || !entry.status);
  if (!candidate) {
    session.status = "completed";
    await session.save();
    return sanitizeSessionForClient(session);
  }

  await applySessionEvent(session, { type: "advance.started", candidate }, { logger });
  const publish = await publishCandidate(candidate, input);
  if (!publish.ok || publish.published === false) {
    await applySessionEvent(session, {
      type: "publish.failed",
      queueItemId: candidate.queueItemId,
      error: publish.error || publish.reason || "publish-failed",
    }, { logger });
    return sanitizeSessionForClient(session);
  }

  await applySessionEvent(session, {
    type: "publish.accepted",
    queueItemId: candidate.queueItemId,
    campaignId: publish.campaignId,
    dialGroupId: publish.dialGroupId,
    accountId: publish.accountId,
    externId: publish.externId,
    loadSummary: publish.loadSummary || null,
  }, { logger });

  const current = session.current || candidate;
  const capture = await captureRingcxActiveCallForPublishedLead(
    captureOptionsForCandidate(current, session, input),
    { logger },
  );
  if (!capture.ok || !capture.activeCallSummary) {
    const cancelResult = await cancelCandidatePublish(
      current,
      "cx-simple-loop-capture-missed",
      logger,
    );
    await applySessionEvent(session, {
      type: "capture.missed",
      queueItemId: candidate.queueItemId,
      reason: capture.reason || "active-call-not-found",
      error: capture.error || null,
      cancelResult,
      diagnostics: capture.diagnostics || null,
    }, { logger });
    if (shouldPauseAfterCaptureMiss(session)) {
      await applySessionEvent(session, {
        type: "session.paused",
        reason: "capture-miss-breaker",
      }, { logger });
    }
    return sanitizeSessionForClient(session);
  }

  await applySessionEvent(session, {
    type: "capture.found",
    queueItemId: candidate.queueItemId,
    uii: capture.uii,
    activeCallSummary: capture.activeCallSummary || null,
    matchReasons: capture.matchReasons || [],
    firstPollMs: capture.firstPollMs ?? null,
    uiiFoundMs: capture.uiiFoundMs ?? null,
  }, { logger });
  return sanitizeSessionForClient(session);
}

async function mirrorBulkQueue(session, input = {}, options = {}) {
  const logger = options.logger || console;
  const queue = Array.isArray(session.queue) ? session.queue : [];
  const pending = queue.filter((candidate) => isPendingForPublish(candidate));
  for (const candidate of pending) {
    const publish = await publishCandidate(candidate, input);
    if (publish.ok && publish.published !== false) {
      await applySessionEvent(session, {
        type: "bulk.publish.accepted",
        queueItemId: candidate.queueItemId,
        campaignId: publish.campaignId,
        dialGroupId: publish.dialGroupId,
        accountId: publish.accountId,
        externId: publish.externId,
        loadSummary: publish.loadSummary || null,
      }, { logger });
    } else {
      await applySessionEvent(session, {
        type: "bulk.publish.failed",
        queueItemId: candidate.queueItemId,
        error: publish.error || publish.reason || "publish-failed",
      }, { logger });
    }
  }
  return session;
}

async function captureBulkCurrent(session, input = {}, options = {}) {
  const logger = options.logger || console;
  if (session.current && input.force !== true) return sanitizeSessionForClient(session);
  const mirrored = (Array.isArray(session.queue) ? session.queue : [])
    .filter((candidate) => isMirrored(candidate));
  if (mirrored.length === 0) {
    return sanitizeSessionForClient(session);
  }
  const startedAt = Date.now();
  const active = await listBulkActiveCallsForSession(session, logger);
  if (active.calls.length > 0) {
    for (const call of active.calls) {
      const match = findBulkCandidateForActiveCall(call, mirrored);
      if (!match) continue;
      const uii = extractActiveCallUii(call);
      const priorCurrent = session.current ? clonePlain(session.current) : null;
      if (priorCurrent && queueItemLookupId(priorCurrent) !== queueItemLookupId(match.candidate)) {
        await recordSimpleLoopAutoAdvanceTerminal(priorCurrent, session, { logger });
      }
      const callPlacedResult = await recordSimpleLoopCallPlaced(match.candidate, session, {
        uii,
      }, { logger });
      await applySessionEvent(session, {
        type: "bulk.capture.found",
        candidate: match.candidate,
        uii,
        activeCallSummary: summarizeActiveCall(call),
        matchReasons: [
          match.score >= 100 ? "externId" : "activeCall",
          active.queryScope,
        ].filter(Boolean),
        callPlacedResult,
        firstPollMs: 0,
        uiiFoundMs: Date.now() - startedAt,
      }, { logger });
      return sanitizeSessionForClient(session);
    }
  }
  for (const candidate of mirrored) {
    const capture = await captureRingcxActiveCallForPublishedLead(
      captureOptionsForCandidate(candidate, session, {
        ...input,
        timeoutMs: input.timeoutMs || parsePositiveInteger(process.env.CX_SIMPLE_LOOP_BULK_CAPTURE_MS, 250),
      }),
      { logger },
    );
    if (capture.ok && capture.activeCallSummary) {
      const priorCurrent = session.current ? clonePlain(session.current) : null;
      if (priorCurrent && queueItemLookupId(priorCurrent) !== queueItemLookupId(candidate)) {
        await recordSimpleLoopAutoAdvanceTerminal(priorCurrent, session, { logger });
      }
      const callPlacedResult = await recordSimpleLoopCallPlaced(candidate, session, {
        uii: capture.uii,
      }, { logger });
      await applySessionEvent(session, {
        type: "bulk.capture.found",
        candidate,
        uii: capture.uii,
        activeCallSummary: capture.activeCallSummary || null,
        matchReasons: capture.matchReasons || [],
        callPlacedResult,
      }, { logger });
      return sanitizeSessionForClient(session);
    }
  }
  await applySessionEvent(session, {
    type: "bulk.watch.empty",
    reason: "active-call-not-found",
    mirroredCount: mirrored.length,
  }, { logger });
  return sanitizeSessionForClient(session);
}

async function advanceCxSimpleLoopSession(input = {}, options = {}) {
  assertSimpleLoopAccess(input, options.user || {});
  const targetEmail = normalizeEmail(input.agentEmail || options.user?.email);
  const session = await getMutableSession(input.sessionId, targetEmail);
  if (session.status !== "running") return sanitizeSessionForClient(session);

  if (session.mode === "bulk-mirror") {
    await replenishBulkQueue(session, input, options);
    await mirrorBulkQueue(session, input, options);
    return captureBulkCurrent(session, input, options);
  }
  return advanceSingleSession(session, input, options);
}

async function submitCxSimpleLoopDisposition(input = {}, options = {}) {
  const logger = options.logger || console;
  assertSimpleLoopAccess(input, options.user || {});
  const targetEmail = normalizeEmail(input.agentEmail || options.user?.email);
  const session = await getMutableSession(input.sessionId, targetEmail);
  const current = session.current;
  if (!current) return sanitizeSessionForClient(session);
  const disposition = normalizeSimpleLoopDisposition(input.disposition || input.outcome);

  let dispositionResult = null;
  try {
    dispositionResult = await executeCxHangupRequest({
      domain: current.domain,
      caseId: current.caseId,
      queueItemId: current.queueItemId,
      phone: current.phone,
      uii: current.uii,
      assignedExtensionId: session.agentExtensionId,
      requestedByUserEmail: options.user?.email || session.agentEmail,
      source: "cx-simple-loop",
      disposition,
      forceRcxDisposition: true,
    });
  } catch (error) {
    dispositionResult = {
      ok: false,
      error: error.message || "cx-simple-loop-disposition-failed",
    };
  }

  await applySessionEvent(session, {
    type: "terminal.submitted",
    outcome: disposition,
    dispositionResult,
  }, { logger });

  if (input.autoAdvance === true && session.status === "running") {
    return advanceCxSimpleLoopSession({ sessionId: session.sessionId }, options);
  }
  return sanitizeSessionForClient(session);
}

async function skipCxSimpleLoopCurrent(input = {}, options = {}) {
  const logger = options.logger || console;
  assertSimpleLoopAccess(input, options.user || {});
  const targetEmail = normalizeEmail(input.agentEmail || options.user?.email);
  const session = await getMutableSession(input.sessionId, targetEmail);
  if (!session.current) return sanitizeSessionForClient(session);
  await applySessionEvent(session, {
    type: "current.skipped",
    reason: input.reason || "manual-skip",
  }, { logger });
  if (input.autoAdvance === true && session.status === "running") {
    return advanceCxSimpleLoopSession({ sessionId: session.sessionId }, options);
  }
  return sanitizeSessionForClient(session);
}

async function killCxSimpleLoopSession(input = {}, options = {}) {
  const logger = options.logger || console;
  assertSimpleLoopAccess(input, options.user || {});
  const targetEmail = normalizeEmail(input.agentEmail || options.user?.email);
  const session = await getMutableSession(input.sessionId, targetEmail);
  if (input.cancelPublished !== false) {
    await cancelCandidatesForSession(session, {
      logger,
      reason: input.reason || "cx-simple-loop-killed",
    });
  }
  await applySessionEvent(session, {
    type: "session.killed",
    reason: input.reason || "manual-kill",
  }, { logger });
  return sanitizeSessionForClient(session);
}

async function getCxSimpleLoopSession(input = {}, options = {}) {
  assertSimpleLoopAccess(input, options.user || {});
  const agentEmail = normalizeEmail(input.agentEmail || options.user?.email);
  if (input.sessionId) {
    const session = await CxSimpleLoopSession.findOne({ sessionId: String(input.sessionId) }).lean();
    return sanitizeSessionForClient(session);
  }
  const session = await CxSimpleLoopSession.findOne({
    agentEmail,
    status: { $in: ["running", "paused"] },
  }).sort({ updatedAt: -1 }).lean();
  return sanitizeSessionForClient(session);
}

module.exports = {
  ACTIVE_QUEUE_STATES,
  advanceCxSimpleLoopSession,
  getCxSimpleLoopSession,
  killCxSimpleLoopSession,
  normalizeSimpleLoopDisposition,
  reduceCxSimpleLoopSession,
  sanitizeCandidateForClient,
  sanitizeSessionForClient,
  skipCxSimpleLoopCurrent,
  startCxSimpleLoopSession,
  submitCxSimpleLoopDisposition,
};
