"use strict";

const crypto = require("crypto");
const {
  cxDialQueueRepository,
  cxSlowLaneSessionRepository,
  leadCadenceRepository,
  queueItemRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const {
  LeadCadence,
} = require("../../shared-models/src");
const {
  captureRingcxActiveCallForPublishedLead,
} = require("./ringcxActiveCallCaptureService");
const {
  completeCxQueueItem,
  handleCxCallPlaced,
  handleCxTerminalCallOutcome,
} = require("./cxCadenceService");
const {
  cancelPublishedQueueItemInRingcx,
  publishQueueItemToRingcx,
} = require("./ringcxLeadServingService");
const {
  executeCxHangupRequest,
} = require("./ringcxDialExecutionService");
const {
  CX_SLOW_LANE_PHASES,
  reduceCxSlowLaneState,
} = require("./cxSlowLaneStateMachine");
const { createCxQueueReservationService } = require("./cxQueueReservationService");
const { buildFamilyTargets } = require("./cxReserveModeService");
const { resolveQueueDialability } = require("./cxQueuePolicyService");

// M4: the shared reservation service — the slow lane's source of claimed rows.
// M11 gate 6: inject queueItemRepository so the M5 claim-time cross-pool interlock
// (assertNotActiveInUcq → existsForLead) is LIVE on this rail, not dormant.
const reservationService = createCxQueueReservationService({ cxDialQueueRepository, queueItemRepository });

const ACTIVE_QUEUE_STATES = Object.freeze(["ready", "claimed", "serving", "paused"]);
const DEFAULT_CAPTURE_TIMEOUT_MS = 1200;
const DEFAULT_CAPTURE_INTERVAL_MS = 250;
const DEFAULT_CONFIRM_MISS_LIMIT = 12;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase() || "TAG";
}

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
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

function makeHttpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function clonePlain(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function asPlain(doc = null) {
  if (!doc) return null;
  return typeof doc.toObject === "function" ? doc.toObject() : clonePlain(doc);
}

function safeEventPayload(event = {}) {
  const clone = { ...event };
  delete clone.phone;
  delete clone.diagnostics;
  if (clone.current?.phone) {
    clone.current = sanitizeCurrentForClient(clone.current);
  }
  return clone;
}

function appendEvent(events = [], event = {}, now = new Date()) {
  return [
    ...(Array.isArray(events) ? events : []),
    {
      type: event.type || "unknown",
      at: now.toISOString(),
      ...safeEventPayload(event),
    },
  ].slice(-80);
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
  };
}

function sanitizeCurrentForClient(current = null) {
  if (!current || typeof current !== "object") return current;
  const clone = { ...current };
  const phone = current.phone;
  delete clone.phone;
  clone.phoneLast4 = phoneLast4(phone) || clone.phoneLast4 || null;
  clone.phoneHash = hashPhone(phone) || clone.phoneHash || null;
  if (clone.activeCallSummary) {
    clone.activeCallSummary = sanitizeActiveCallSummary(clone.activeCallSummary);
  }
  return clone;
}

function sanitizeSessionForClient(session = null) {
  const plain = asPlain(session);
  if (!plain) return null;
  return {
    sessionId: plain.sessionId,
    status: plain.status,
    phase: plain.phase,
    agentEmail: plain.agentEmail,
    agentExtensionId: plain.agentExtensionId,
    cxAgentId: plain.cxAgentId,
    domain: plain.domain,
    current: sanitizeCurrentForClient(plain.current),
    lastOutcome: sanitizeCurrentForClient(plain.lastOutcome),
    lastError: plain.lastError || null,
    trace: plain.trace || {},
    events: Array.isArray(plain.events) ? plain.events.slice(-40) : [],
    startedAt: plain.startedAt || null,
    updatedAt: plain.updatedAt || null,
    completedAt: plain.completedAt || null,
    killedAt: plain.killedAt || null,
  };
}

async function resolveAgentContext(input = {}, user = {}) {
  const requesterEmail = normalizeEmail(user.email);
  const targetEmail = normalizeEmail(input.agentEmail || requesterEmail);
  if (!targetEmail) throw makeHttpError("agentEmail is required", 400, "cx-slow-single-agent-required");
  if (targetEmail !== requesterEmail && String(user.role || "").toLowerCase() !== "admin") {
    throw makeHttpError("Cannot control another agent's slow lane", 403, "cx-slow-single-agent-forbidden");
  }
  const account = await userAccountRepository.findUserAccountByEmail(targetEmail).catch(() => null);
  const agentExtensionId = normalizeExternalId(
    input.agentExtensionId ||
      account?.extensionId ||
      user.extensionId ||
      "",
  );
  const cxAgentId = normalizeExternalId(
    input.cxAgentId ||
      account?.cxAgentId ||
      account?.ringcxAgentId ||
      user.cxAgentId ||
      user.ringcxAgentId ||
      "",
  );
  return {
    account,
    agentEmail: targetEmail,
    agentExtensionId,
    cxAgentId,
    displayName: account?.name || user.name || targetEmail,
  };
}

function slowLaneSessionBelongsToAgent(session = {}, agent = {}) {
  if (!session || !agent) return false;
  const sessionEmail = normalizeEmail(session.agentEmail);
  const agentEmail = normalizeEmail(agent.agentEmail);
  const sessionExtensionId = normalizeExternalId(session.agentExtensionId);
  const agentExtensionId = normalizeExternalId(agent.agentExtensionId);
  if (sessionEmail && agentEmail && sessionEmail === agentEmail) return true;
  if (sessionExtensionId && agentExtensionId && sessionExtensionId === agentExtensionId) return true;
  return false;
}

async function findOwnedSlowLaneSession(sessionId, agent) {
  const normalized = String(sessionId || "").trim();
  if (!normalized) return null;
  const session = await cxSlowLaneSessionRepository.findSlowLaneSessionById(normalized);
  if (!session) {
    throw makeHttpError("Slow-single session not found", 404, "cx-slow-single-session-not-found");
  }
  if (!slowLaneSessionBelongsToAgent(session, agent)) {
    throw makeHttpError("Cannot access another agent's slow-single session", 403, "cx-slow-single-session-forbidden");
  }
  return session;
}

function summarizeQueueItem(item = {}) {
  const plain = asPlain(item) || {};
  const metadata = plain.metadata && typeof plain.metadata === "object" ? plain.metadata : {};
  const phone = normalizePhone(plain.phone || metadata.phone || metadata.leadPhone);
  const queueItemId = plain._id ? String(plain._id) : String(plain.queueItemId || "");
  return {
    queueItemId,
    domain: normalizeDomain(plain.domain),
    caseId: Number(plain.caseId || 0) || null,
    name: plain.name || metadata.name || null,
    phone,
    phoneLast4: phoneLast4(phone),
    phoneHash: hashPhone(phone),
    queueFamily: plain.queueFamily || metadata.queueFamily || null,
    queueTier: plain.queueTier || metadata.queueTier || null,
    progressiveStageKey: plain.progressiveStageKey || metadata.progressiveStageKey || null,
    state: plain.state || null,
    assignment: {
      extensionId: plain.assignment?.extensionId || metadata.assignedExtensionId || null,
      agentName: plain.assignment?.agentName || metadata.assignedAgentName || null,
    },
    campaignId:
      plain.rcxCampaignId ||
      metadata.rcxVisibilityCampaignId ||
      metadata.lastRingcxPublishedCampaignId ||
      metadata.lastDialExecutionCampaignId ||
      null,
    dialGroupId:
      plain.rcxDialGroupId ||
      metadata.rcxVisibilityDialGroupId ||
      metadata.lastRingcxPublishedDialGroupId ||
      metadata.lastDialExecutionDialGroupId ||
      null,
    accountId:
      plain.rcxAccountId ||
      metadata.rcxVisibilityAccountId ||
      metadata.lastRingcxPublishedAccountId ||
      null,
    externId:
      metadata.rcxVisibilityExternId ||
      metadata.lastRingcxPublishedExternId ||
      metadata.lastDialExecutionExternId ||
      null,
    metadata: {
      actionKey: metadata.actionKey || null,
      routeCampaignKey: metadata.routeCampaignKey || null,
    },
  };
}

async function applySessionEvent(sessionOrId, event = {}, options = {}) {
  const logger = options.logger || console;
  const now = options.now instanceof Date ? options.now : new Date();
  const session = typeof sessionOrId === "string"
    ? await cxSlowLaneSessionRepository.findSlowLaneSessionById(sessionOrId)
    : asPlain(sessionOrId);
  if (!session) return null;
  const reduced = reduceCxSlowLaneState(session, event, now);
  const events = appendEvent(session.events, event, now);
  const updated = await cxSlowLaneSessionRepository.updateSlowLaneSession(session.sessionId, {
    ...reduced,
    events,
  }, { match: options.match || undefined });
  if (!updated) {
    logger?.warn?.("cx.slow_single.transition_miss", {
      sessionId: session.sessionId,
      event: event.type || "unknown",
      agentEmail: session.agentEmail || null,
      phase: session.phase || null,
      currentQueueItemId: session.current?.queueItemId || null,
      currentUii: session.current?.uii || null,
      reason: "match-failed",
    });
    return null;
  }
  logger?.info?.("cx.slow_single.transition", {
    sessionId: session.sessionId,
    event: event.type || "unknown",
    agentEmail: updated?.agentEmail || session.agentEmail,
    fromPhase: session.phase || null,
    phase: updated?.phase || reduced.phase,
    previousQueueItemId: session.current?.queueItemId || null,
    previousUii: session.current?.uii || null,
    currentQueueItemId: updated?.current?.queueItemId || null,
    currentUii: updated?.current?.uii || null,
    reason: event.reason || null,
  });
  return updated;
}

function currentIdentityMatch(current = {}) {
  const match = {};
  if (current.queueItemId) match["current.queueItemId"] = current.queueItemId;
  if (current.uii) match["current.uii"] = current.uii;
  return match;
}

function captureOptionsForCurrent(current = {}, session = {}, input = {}) {
  return {
    phone: current.phone,
    campaignId: current.campaignId || current.ringcx?.campaignId || null,
    dialGroupId: current.dialGroupId || current.ringcx?.dialGroupId || null,
    externId: current.externId || current.ringcx?.externId || null,
    agentEmail: session.agentEmail,
    agentCxAgentId: session.cxAgentId,
    timeoutMs: parsePositiveInteger(
      input.timeoutMs || process.env.CX_SLOW_SINGLE_CAPTURE_MS,
      DEFAULT_CAPTURE_TIMEOUT_MS,
    ),
    intervalMs: parsePositiveInteger(
      input.intervalMs || process.env.CX_SLOW_SINGLE_CAPTURE_INTERVAL_MS,
      DEFAULT_CAPTURE_INTERVAL_MS,
    ),
    includeDiagnostics: input.includeDiagnostics === true,
  };
}

function confirmMissLimit(input = {}) {
  return Math.max(1, parsePositiveInteger(
    input.missLimit || input.confirmMissLimit || process.env.CX_SLOW_SINGLE_CONFIRM_MISS_LIMIT,
    DEFAULT_CONFIRM_MISS_LIMIT,
  ));
}

function buildSlowLaneCallPayload(current = {}, session = {}, extra = {}) {
  const uii = normalizeExternalId(extra.uii || current.uii || current.activeCallSummary?.uii);
  return {
    queueItemId: current.queueItemId || null,
    domain: current.domain || session.domain || null,
    caseId: current.caseId || null,
    actionKey: current.metadata?.actionKey || null,
    phone: current.phone || null,
    uii,
    callSessionId: uii,
    telephonySessionId: uii,
    extensionId: session.agentExtensionId || current.assignment?.extensionId || null,
    assignedExtensionId: session.agentExtensionId || current.assignment?.extensionId || null,
    agentName: current.assignment?.agentName || null,
    agentEmail: session.agentEmail || null,
    campaignId: current.ringcx?.campaignId || current.campaignId || null,
    dialGroupId: current.ringcx?.dialGroupId || current.dialGroupId || null,
    externId: current.ringcx?.externId || current.externId || null,
    ...extra,
  };
}

async function recordCallPlaced(current = {}, session = {}, capture = {}, options = {}) {
  const logger = options.logger || console;
  if (!current?.queueItemId) return { ok: true, skipped: true, reason: "missing-queue-item" };
  if (current.callPlacedRecordedAt || current.callPlacedResult) {
    return { ok: true, skipped: true, reason: "already-recorded" };
  }
  try {
    return await handleCxCallPlaced(buildSlowLaneCallPayload(current, session, {
      placedAt: new Date().toISOString(),
      uii: capture.uii || current.uii || null,
      confirmedCall: Boolean(capture.uii || current.uii),
      countAsAttempt: true,
      ringcxPublished: true,
      holdUntilDisposition: true,
      sourceService: "cx-slow-single",
      source: "active-call-confirmed",
    }));
  } catch (error) {
    logger?.warn?.("cx.slow_single.call_placed_record_failed", {
      sessionId: session.sessionId || null,
      queueItemId: current.queueItemId || null,
      caseId: current.caseId || null,
      error: error.message || "call-placed-record-failed",
    });
    return { ok: false, error: error.message || "call-placed-record-failed" };
  }
}

function normalizeSlowSingleOutcome(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["answer", "answered", "connected"].includes(normalized)) return "answered";
  if (["voicemail", "left-message", "left-voicemail", "vm"].includes(normalized)) return "voicemail";
  if (["no-answer", "did-not-answer", "did-not-connect", "no-connect"].includes(normalized)) {
    return "did_not_connect";
  }
  return normalized || "did_not_connect";
}

function assertExpectedCurrent(input = {}, current = {}) {
  const expectedQueueItemId = normalizeExternalId(
    input.expectedQueueItemId ||
      input.currentQueueItemId ||
      "",
  );
  const expectedUii = normalizeExternalId(
    input.expectedUii ||
      input.currentUii ||
      "",
  );
  const actualQueueItemId = normalizeExternalId(current.queueItemId);
  const actualUii = normalizeExternalId(current.uii);

  if (expectedQueueItemId && actualQueueItemId && expectedQueueItemId !== actualQueueItemId) {
    throw makeHttpError(
      "Slow-single terminal request is stale for the current queue item",
      409,
      "cx-slow-single-stale-queue-item",
    );
  }
  if (expectedUii && actualUii && expectedUii !== actualUii) {
    throw makeHttpError(
      "Slow-single terminal request is stale for the current call UII",
      409,
      "cx-slow-single-stale-uii",
    );
  }
}

async function markTerminalStarted(session = {}, current = {}, outcome, options = {}) {
  const logger = options.logger || console;
  if (session.phase !== CX_SLOW_LANE_PHASES.ACTIVE || !current.uii) {
    throw makeHttpError(
      "Slow-single terminal request requires an active confirmed call",
      409,
      "cx-slow-single-call-not-active",
    );
  }
  const updated = await applySessionEvent(session, {
    type: "terminal.started",
    outcome,
  }, {
    logger,
    match: {
      phase: CX_SLOW_LANE_PHASES.ACTIVE,
      ...currentIdentityMatch(current),
    },
  });
  if (!updated) {
    throw makeHttpError(
      "Slow-single current call is already changing",
      409,
      "cx-slow-single-terminal-race",
    );
  }
  return updated;
}

async function recordTerminalOutcome(current = {}, session = {}, outcome, options = {}) {
  if (!current?.queueItemId) return { ok: true, skipped: true, reason: "missing-queue-item" };
  if (outcome === "answered") {
    const domain = normalizeDomain(current.domain || session.domain);
    const caseId = Number(current.caseId);
    const lead = domain && Number.isFinite(caseId)
      ? await LeadCadence.findOne({ domain, caseId }).lean().catch(() => null)
      : null;
    const priorAnsweredContacts = Math.max(Number(
      lead?.counterCadence?.cxAnsweredContacts ||
        lead?.payloadSnapshot?.cxAnsweredContacts ||
        0,
    ) || 0, 0);
    const nextAnsweredContacts = priorAnsweredContacts + 1;
    const actionKey = String(current.metadata?.actionKey || "").trim();
    if (domain && Number.isFinite(caseId) && actionKey) {
      await leadCadenceRepository.markScheduledActionStatus(domain, caseId, actionKey, "completed", {
        active: true,
        currentStage: "cx-answered",
      }).catch(() => null);
      await leadCadenceRepository.syncLeadCadenceState(domain, caseId).catch(() => null);
    }
    if (domain && Number.isFinite(caseId)) {
      await LeadCadence.updateOne(
        { domain, caseId },
        {
          $set: {
            "counterCadence.cxAnsweredContacts": nextAnsweredContacts,
            "counterCadence.cxNoAnswerCalls": 0,
            "counterCadence.lastCxAnsweredAt": new Date(),
            "payloadSnapshot.cxAnsweredContacts": nextAnsweredContacts,
            "payloadSnapshot.cxNoAnswerCalls": 0,
            "payloadSnapshot.lastCxAnsweredAt": new Date(),
          },
        },
      ).catch(() => null);
    }
    return completeCxQueueItem({
      queueItemId: current.queueItemId,
      queueOutcome: "answered",
      disposition: "answered",
      actorEmail: options.actorEmail || session.agentEmail || null,
      extraUpdate: {
        metadata: {
          lastAnsweredAt: new Date(),
          lastAnsweredBy: options.actorEmail || session.agentEmail || null,
          answeredContacts: nextAnsweredContacts,
          cxAnsweredContacts: nextAnsweredContacts,
          unansweredCalls: 0,
          noAnswerCalls: 0,
          lastQueueAttemptHeldForDisposition: false,
          wrapUpRequired: false,
          cxSlowSingleCompletedAt: new Date(),
        },
      },
    });
  }

  return handleCxTerminalCallOutcome(buildSlowLaneCallPayload(current, session, {
    outcome,
    disposition: outcome,
    result: outcome === "voicemail" ? "VOICEMAIL" : "NOANSWER",
    outcomeAt: new Date().toISOString(),
    sourceService: "cx-slow-single",
    source: "agent-terminal-button",
    actorEmail: options.actorEmail || session.agentEmail || null,
  }));
}

async function cancelCurrentPublish(current = {}, reason = "cx-slow-single-release", logger = null) {
  if (!current?.queueItemId) return { ok: true, cancelled: false, skipped: true, reason: "missing-queue-item" };
  return cancelPublishedQueueItemInRingcx(current.queueItemId, {
    campaignId: current.ringcx?.campaignId || current.campaignId || null,
    externId: current.ringcx?.externId || current.externId || null,
    reason,
  }).catch((error) => {
    logger?.warn?.("cx.slow_single.cancel_failed", {
      queueItemId: current.queueItemId,
      reason,
      error: error.message,
    });
    return { ok: false, cancelled: false, error: error.message };
  });
}

function isRetryablePublishMiss(result = {}) {
  if (result.retryable === true) return true;
  const text = String(result.error || result.reason || "").toLowerCase();
  return Boolean(text.match(/\b(429|rate|timeout|temporar|network|econnreset|etimedout)\b/));
}

async function releaseNextCandidateAfterPublishMiss(current = {}, result = {}, logger = null) {
  if (!current?.queueItemId) return null;
  const retryable = isRetryablePublishMiss(result);
  const now = new Date();
  const nextState = retryable ? "ready" : "paused";
  const releaseReason = retryable
    ? "cx-slow-single-next-publish-retryable"
    : "cx-slow-single-next-publish-failed";
  const update = {
    state: nextState,
    claimUntil: null,
    assignment: {
      extensionId: null,
      agentName: null,
      assignedAt: null,
      queueFamilySnapshot: null,
    },
    "metadata.cxSlowSinglePhase": nextState === "ready" ? "released-for-retry" : "paused-after-publish-failure",
    "metadata.cxSlowSingleReleasedAt": now,
    "metadata.cxSlowSingleReleaseReason": releaseReason,
    "metadata.cxSlowSinglePublishFailure": {
      reason: result.reason || null,
      error: result.error || null,
      retryable,
      happenedAt: now.toISOString(),
    },
  };
  const released = await cxDialQueueRepository.updateQueueItem(current.queueItemId, update, {
    match: {
      state: { $in: ["claimed", "serving", "paused"] },
    },
  }).catch((error) => {
    logger?.warn?.("cx.slow_single.next_candidate_release_failed", {
      queueItemId: current.queueItemId,
      error: error.message || "release-failed",
    });
    return null;
  });
  logger?.warn?.("cx.slow_single.next_candidate_released_after_publish_miss", {
    queueItemId: current.queueItemId,
    nextState,
    retryable,
    reason: result.reason || null,
    error: result.error || null,
    released: Boolean(released),
  });
  return released;
}

async function selectNextQueueItem(input = {}, agent = {}, session = {}) {
  if (input.queueItemId) {
    const item = await cxDialQueueRepository.findQueueItemById(input.queueItemId);
    if (!item) throw makeHttpError("Queue item not found", 404, "cx-slow-single-queue-not-found");
    return asPlain(item);
  }
  // M4: source the next lead via the shared reservation service (no claimNextCxQueueItem).
  // reserveReadyRows only filters state:'ready' + appointment exclusion; it does NOT apply the
  // dialability policy claimNextCxQueueItem enforced in its retry loop. So we reserve a small
  // family-ordered batch and pick the FIRST dialable row, releasing the rest — a non-dialable
  // top row must not 409 us while a dialable lead waits below (no regression, fail-closed).
  const sessionId = session.sessionId || input.sessionId;
  if (!sessionId) throw makeHttpError("slow-single reservation requires a session", 500, "cx-slow-single-no-session");
  const maxAttempts = parsePositiveInteger(input.maxClaimAttempts, 10);
  const familyTargets = buildFamilyTargets({ policy: agent.account, totalDeficit: maxAttempts, env: process.env });
  const { reserved, missing } = await reservationService.reserveFromFamilyOrder({
    domain: normalizeDomain(input.domain),
    agentExtensionId: agent.agentExtensionId,
    sessionId,
    familyTargets,
    totalLimit: maxAttempts,
    claimMinutes: parsePositiveInteger(input.claimMinutes, 10),
    metadata: { rail: "slow_single" }, // M8b §3 enum: legacy_fast|slow_single|bulk_load
  });
  let picked = null;
  for (const row of reserved) {
    if (picked) {
      await reservationService.releaseReserved([row], "slow-extra-reserved");
      continue;
    }
    const dialability = resolveQueueDialability(row);
    if (dialability && dialability.dialable) {
      picked = row;
      continue;
    }
    await reservationService.releaseReserved([row], `slow-non-dialable:${dialability && dialability.reason ? dialability.reason : "policy-hold"}`);
  }
  if (!picked) {
    const err = makeHttpError("No CX queue item available (no-ready-queue-item)", 409, "no-ready-queue-item");
    err.details = { missing };
    throw err;
  }
  return asPlain(picked);
}

async function publishCurrent(current = {}, input = {}) {
  const item = await cxDialQueueRepository.findQueueItemById(current.queueItemId);
  if (!item) {
    return {
      ok: false,
      published: false,
      error: "queue-item-not-found",
      queueItemId: current.queueItemId,
    };
  }
  return publishQueueItemToRingcx({
    item,
    force: true,
    respectPresenceGate: false,
    allowedStates: ACTIVE_QUEUE_STATES,
    dialPriority: input.dialPriority || "NORMAL",
  });
}

async function executeTerminalDispositionWithRetry(request = {}, options = {}) {
  const logger = options.logger || console;
  const maxAttempts = Math.max(parsePositiveInteger(options.maxAttempts, 2), 1);
  let lastResult = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      lastResult = await executeCxHangupRequest(request);
    } catch (error) {
      lastResult = {
        ok: false,
        error: error.message || "cx-slow-single-hangup-failed",
        retryable: Boolean(error.retryable),
      };
    }
    if (lastResult?.ok) return { ...lastResult, attempts: attempt };
    const retryable = lastResult?.retryable === true;
    if (!retryable || attempt >= maxAttempts) {
      return { ...(lastResult || {}), attempts: attempt };
    }
    logger?.warn?.("cx.slow_single.terminal_retry", {
      attempt,
      maxAttempts,
      queueItemId: request.queueItemId || null,
      uii: request.uii || null,
      error: lastResult.error || lastResult.reason || "terminal-failed",
    });
    await sleep(parsePositiveInteger(options.retryDelayMs, 250));
  }
  return lastResult || { ok: false, error: "cx-slow-single-hangup-failed", attempts: maxAttempts };
}

async function startCxSlowSingleCall(input = {}, options = {}) {
  const logger = options.logger || console;
  const agent = await resolveAgentContext(input, options.user || {});
  const existing = await cxSlowLaneSessionRepository.findActiveSlowLaneSessionForAgent(agent);
  if (existing?.current) {
    if (input.forceReplace !== true) {
      throw makeHttpError(
        "Current slow-single call must be released before sending the next lead",
        409,
        "cx-slow-single-current-call-active",
      );
    }
    await cancelCurrentPublish(existing.current, "replaced-by-new-slow-single-session", logger);
  }
  await cxSlowLaneSessionRepository.killActiveSlowLaneSessionsForAgent({
    agentEmail: agent.agentEmail,
    reason: "replaced-by-new-slow-single-session",
  });
  const session = await cxSlowLaneSessionRepository.createSlowLaneSession({
    sessionId: crypto.randomUUID(),
    status: "running",
    phase: CX_SLOW_LANE_PHASES.IDLE,
    agentEmail: agent.agentEmail,
    agentExtensionId: agent.agentExtensionId,
    cxAgentId: agent.cxAgentId,
    domain: normalizeDomain(input.domain),
    startedAt: new Date(),
  });
  let latest = await applySessionEvent(session, { type: "session.started" }, { logger });

  try {
    latest = await applySessionEvent(latest, { type: "select.started" }, { logger });
    const item = await selectNextQueueItem(input, agent, session);
    const current = summarizeQueueItem(item);
    latest = await applySessionEvent(latest, { type: "publish.started", current }, { logger });
    const publish = await publishCurrent(current, input);
    if (!publish.ok || publish.published === false) {
      await releaseNextCandidateAfterPublishMiss(current, publish, logger);
      latest = await applySessionEvent(latest, {
        type: "failed",
        error: publish.error || publish.reason || "publish-failed",
      }, { logger });
      return sanitizeSessionForClient(latest);
    }
    latest = await applySessionEvent(latest, {
      type: "publish.accepted",
      campaignId: publish.campaignId,
      dialGroupId: publish.dialGroupId,
      accountId: publish.accountId,
      externId: publish.externId,
      loadSummary: publish.loadSummary || null,
    }, { logger });
    await cxDialQueueRepository.updateQueueItem(current.queueItemId, {
      "metadata.cxSlowSingleSessionId": latest.sessionId,
      "metadata.cxSlowSinglePhase": "pending_confirmation",
      "metadata.cxSlowSinglePublishedAt": new Date(),
    }).catch(() => null);

    return sanitizeSessionForClient(latest);
  } catch (error) {
    latest = await applySessionEvent(latest, {
      type: "failed",
      error: error.message || "cx-slow-single-start-failed",
    }, { logger });
    return sanitizeSessionForClient(latest);
  }
}

async function confirmCxSlowSingleCurrent(input = {}, options = {}) {
  const logger = options.logger || console;
  const agent = await resolveAgentContext(input, options.user || {});
  const session = input.sessionId
    ? await findOwnedSlowLaneSession(input.sessionId, agent)
    : await cxSlowLaneSessionRepository.findActiveSlowLaneSessionForAgent(agent);
  if (!session) return null;
  const current = session.current;
  if (!current) return sanitizeSessionForClient(session);
  if (current.uii && session.phase === CX_SLOW_LANE_PHASES.ACTIVE) {
    return sanitizeSessionForClient(session);
  }

  const capture = await captureRingcxActiveCallForPublishedLead(
    captureOptionsForCurrent(current, session, input),
    { logger },
  );
  const missLimit = confirmMissLimit(input);
  if (!capture.ok || !capture.uii) {
    const captureMisses = Math.max(Number(session.trace?.captureMisses || 0) || 0, 0) + 1;
    if (captureMisses >= missLimit) {
      await cancelCurrentPublish(current, "cx-slow-single-confirmation-miss-limit", logger);
      await releaseNextCandidateAfterPublishMiss(current, {
        retryable: true,
        reason: capture.reason || "active-call-confirmation-miss-limit",
      }, logger);
      const failed = await applySessionEvent(session, {
        type: "active.failed",
        reason: capture.reason || "active-call-not-found",
        error: "active-call-confirmation-miss-limit",
        captureMisses,
        missLimit,
      }, {
        logger,
        match: {
          phase: {
            $in: [
              CX_SLOW_LANE_PHASES.SELECTING,
              CX_SLOW_LANE_PHASES.PUBLISHING,
              CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION,
            ],
          },
          ...currentIdentityMatch(current),
        },
      });
      if (failed) return sanitizeSessionForClient(failed);
      const fresh = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
      return sanitizeSessionForClient(fresh || session);
    }

    const updated = await applySessionEvent(session, {
      type: "active.pending",
      reason: capture.reason || "active-call-not-found",
      firstPollMs: capture.firstPollMs ?? null,
      callCount: capture.callCount ?? null,
      captureMisses,
      missLimit,
    }, {
      logger,
      match: {
        phase: {
          $in: [
            CX_SLOW_LANE_PHASES.SELECTING,
            CX_SLOW_LANE_PHASES.PUBLISHING,
            CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION,
          ],
        },
        ...currentIdentityMatch(current),
      },
    });
    if (!updated) {
      const fresh = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
      return sanitizeSessionForClient(fresh || session);
    }
    return sanitizeSessionForClient(updated);
  }

  const callPlacedResult = await recordCallPlaced(current, session, capture, { logger });
  const updated = await applySessionEvent(session, {
    type: "active.confirmed",
    uii: capture.uii,
    activeCallSummary: capture.activeCallSummary || null,
    matchReasons: capture.matchReasons || [],
    firstPollMs: capture.firstPollMs ?? null,
    uiiFoundMs: capture.uiiFoundMs ?? null,
    missLimit,
    callPlacedResult,
  }, {
    logger,
    match: {
      phase: {
        $in: [
          CX_SLOW_LANE_PHASES.SELECTING,
          CX_SLOW_LANE_PHASES.PUBLISHING,
          CX_SLOW_LANE_PHASES.PENDING_CONFIRMATION,
        ],
      },
      ...currentIdentityMatch(current),
    },
  });
  if (!updated) {
    const fresh = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
    return sanitizeSessionForClient(fresh || session);
  }
  await cxDialQueueRepository.updateQueueItem(current.queueItemId, {
    "metadata.cxSlowSinglePhase": "active",
    "metadata.cxSlowSingleActiveAt": new Date(),
    "metadata.lastDialExecutionUii": capture.uii,
  }).catch(() => null);
  return sanitizeSessionForClient(updated);
}

async function submitCxSlowSingleOutcome(input = {}, options = {}) {
  const logger = options.logger || console;
  const agent = await resolveAgentContext(input, options.user || {});
  let session = input.sessionId
    ? await findOwnedSlowLaneSession(input.sessionId, agent)
    : await cxSlowLaneSessionRepository.findActiveSlowLaneSessionForAgent(agent);
  if (!session) return null;
  let current = session.current;
  if (!current) return sanitizeSessionForClient(session);
  assertExpectedCurrent(input, current);

  if (!current.uii) {
    const confirmed = await confirmCxSlowSingleCurrent({
      sessionId: session.sessionId,
      timeoutMs: input.confirmBeforeOutcomeMs || 1500,
    }, options);
    session = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
    current = session?.current || current;
    assertExpectedCurrent(input, current);
    if (!current.uii) return confirmed;
  }

  const outcome = normalizeSlowSingleOutcome(input.outcome || input.disposition);
  session = await markTerminalStarted(session, current, outcome, { logger });

  const hangup = await executeTerminalDispositionWithRetry({
    domain: current.domain,
    caseId: current.caseId,
    queueItemId: current.queueItemId,
    phone: current.phone,
    uii: current.uii,
    assignedExtensionId: session.agentExtensionId || agent.agentExtensionId,
    requestedByUserEmail: options.user?.email || session.agentEmail,
    source: "cx-slow-single",
    disposition: outcome,
    forceRcxDisposition: true,
    logger,
  }, {
    logger,
    maxAttempts: input.terminalMaxAttempts,
    retryDelayMs: input.terminalRetryDelayMs,
  });

  if (!hangup?.ok) {
    const updated = await applySessionEvent(session, {
      type: "terminal.failed",
      error: hangup?.error || hangup?.reason || "hangup-failed",
    }, {
      logger,
      match: {
        phase: CX_SLOW_LANE_PHASES.RELEASING,
        ...currentIdentityMatch(current),
      },
    });
    if (updated) return sanitizeSessionForClient(updated);
    const fresh = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
    return sanitizeSessionForClient(fresh || session);
  }

  const cadence = await recordTerminalOutcome(current, session, outcome, {
    actorEmail: options.user?.email || session.agentEmail,
  }).catch((error) => ({
    ok: false,
    error: error.message || "terminal-outcome-record-failed",
  }));
  if (!cadence?.ok) {
    logger?.warn?.("cx.slow_single.terminal_outcome_record_failed", {
      sessionId: session.sessionId || null,
      queueItemId: current.queueItemId || null,
      caseId: current.caseId || null,
      outcome,
      error: cadence?.error || cadence?.reason || "terminal-outcome-record-failed",
    });
  }

  const updated = await applySessionEvent(session, {
    type: "terminal.accepted",
    outcome,
    hangup,
    cadence,
  }, {
    logger,
    match: {
      phase: CX_SLOW_LANE_PHASES.RELEASING,
      ...currentIdentityMatch(current),
    },
  });
  if (!updated) {
    const fresh = await cxSlowLaneSessionRepository.findSlowLaneSessionById(session.sessionId);
    return sanitizeSessionForClient(fresh || session);
  }
  await cxDialQueueRepository.updateQueueItem(current.queueItemId, {
    "metadata.cxSlowSinglePhase": "released",
    "metadata.cxSlowSingleReleasedAt": new Date(),
    "metadata.cxSlowSingleOutcome": outcome,
  }).catch(() => null);

  return sanitizeSessionForClient(updated);
}

async function getCxSlowSingleSession(input = {}, options = {}) {
  const agent = await resolveAgentContext(input, options.user || {});
  const session = input.sessionId
    ? await findOwnedSlowLaneSession(input.sessionId, agent)
    : await cxSlowLaneSessionRepository.findActiveSlowLaneSessionForAgent(agent);
  return sanitizeSessionForClient(session);
}

async function killCxSlowSingleSession(input = {}, options = {}) {
  const logger = options.logger || console;
  const agent = await resolveAgentContext(input, options.user || {});
  const session = input.sessionId
    ? await findOwnedSlowLaneSession(input.sessionId, agent)
    : await cxSlowLaneSessionRepository.findActiveSlowLaneSessionForAgent(agent);
  if (!session) return null;
  if (session.current) {
    await cancelCurrentPublish(session.current, input.reason || "manual-kill", logger);
  }
  const updated = await applySessionEvent(session, {
    type: "session.killed",
    reason: input.reason || "manual-kill",
  }, { logger });
  return sanitizeSessionForClient(updated);
}

module.exports = {
  confirmCxSlowSingleCurrent,
  getCxSlowSingleSession,
  killCxSlowSingleSession,
  normalizeSlowSingleOutcome,
  sanitizeSessionForClient,
  startCxSlowSingleCall,
  submitCxSlowSingleOutcome,
};
