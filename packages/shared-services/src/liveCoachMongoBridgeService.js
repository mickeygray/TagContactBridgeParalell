"use strict";

const DEFAULT_EVENT_TYPE = "cx.call.placed";
const DEFAULT_SOURCE_SERVICE = "ringcentral-cx";
const DEFAULT_LOOKBACK_MS = 45 * 60 * 1000;
const DEFAULT_LOOKBACK_LIMIT = 120;
const ACTIVE_CALL_STATES = Object.freeze(["placing", "ringing", "connected"]);

function cleanText(value, maxLength = 240) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLower(value, maxLength = 240) {
  return cleanText(value, maxLength).toLowerCase();
}

function canonicalAgentEmail(value) {
  const email = cleanLower(value, 180);
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at).replace(/\+.*/, "");
  const domain = email.slice(at + 1);
  return local && domain ? `${local}@${domain}` : email;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function firstClean(values, maxLength = 240) {
  for (const value of values) {
    const clean = cleanText(value, maxLength);
    if (clean) return clean;
  }
  return "";
}

function toDateMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 9_999_999_999 ? value : Math.round(value * 1000);
  }
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toIso(value, fallbackMs = 0) {
  const ms = toDateMs(value) || fallbackMs;
  return ms ? new Date(ms).toISOString() : null;
}

function isObjectIdLike(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || "").trim());
}

function getPath(input, path) {
  const parts = String(path || "").split(".");
  let cursor = input;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function extractFirstPath(input, paths, maxLength = 240) {
  return firstClean(paths.map((path) => getPath(input, path)), maxLength);
}

function normalizeCoachCallEvent(record = {}, options = {}) {
  const payload = record?.payload && typeof record.payload === "object" ? record.payload : record || {};
  const createdAtMs =
    toDateMs(record?.createdAt) ||
    toDateMs(payload.placedAt) ||
    toDateMs(payload.createdAt) ||
    toDateMs(record?.updatedAt) ||
    Date.now();
  const expiresAtMs = Number(payload.expiresAtMs || 0) || null;
  const eventId = cleanText(record?._id || payload.eventId || payload.id || "", 120);
  const queueItemId = extractFirstPath(
    payload,
    ["queueItemId", "queueTicketId", "id", "queue.id", "dial.queueItemId"],
    160,
  ) || cleanText(record?.aggregateId || "", 160);
  const caseId = extractFirstPath(
    payload,
    ["caseId", "logicsCaseId", "sourceLogicsCaseId", "case.id", "lead.caseId"],
    120,
  ) || (String(record?.aggregateType || "") === "case" ? cleanText(record?.aggregateId || "", 120) : "");
  const extensionId = extractFirstPath(
    payload,
    [
      "extensionId",
      "agentExtensionId",
      "assignedExtensionId",
      "dialerExtensionId",
      "agent.extensionId",
      "assignment.extensionId",
      "activeCallCapture.extensionId",
    ],
    80,
  );
  const agentEmail = canonicalAgentEmail(extractFirstPath(
    payload,
    ["agentEmail", "dialerEmail", "requestedByUserEmail", "agent.email", "user.email", "account.email"],
    180,
  ));
  const agentName = extractFirstPath(
    payload,
    ["agentName", "agent.name", "assignment.agentName", "user.name", "account.name"],
    120,
  );
  const uii = extractFirstPath(
    payload,
    [
      "uii",
      "rcxUii",
      "callUii",
      "telephonySessionId",
      "call.uii",
      "call.rcxUii",
      "activeCallCapture.uii",
      "activeCallCapture.rcxUii",
      "ringcx.uii",
    ],
    160,
  );
  const callSessionId = extractFirstPath(
    payload,
    ["callSessionId", "call.sessionId", "activeCallCapture.callSessionId"],
    160,
  );
  const domain = firstClean([payload.domain, payload.company, payload.sourceDomain], 40).toUpperCase();
  const phone = normalizePhone(extractFirstPath(
    payload,
    ["phone", "phoneNumber", "leadPhone", "contact.phone", "activeCallCapture.phone"],
    80,
  ));

  return {
    id: eventId || `cx-call-${createdAtMs}`,
    source: options.source || "mongo",
    eventType: cleanText(record?.eventType || payload.eventType || DEFAULT_EVENT_TYPE, 80),
    sourceService: cleanText(record?.sourceService || payload.sourceService || DEFAULT_SOURCE_SERVICE, 120),
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    expiresAtMs,
    expired: Boolean(expiresAtMs && expiresAtMs <= Date.now()),
    queueItemId,
    caseId,
    domain,
    extensionId,
    agentEmail,
    agentName,
    phone,
    uii,
    callSessionId,
    campaignId: firstClean([payload.campaignId, payload.route?.campaignId], 80),
    dialGroupId: firstClean([payload.dialGroupId, payload.route?.dialGroupId], 80),
    confirmedCall: payload.confirmedCall,
    ringcxPublished: payload.ringcxPublished,
    synthetic: Boolean(payload.synthetic),
  };
}

function eventMatchesFilters(event, filters = {}) {
  if (!event) return false;
  const extensionId = firstClean([filters.agentExtensionId, filters.extensionId, filters.agentExt], 80);
  const agentEmail = canonicalAgentEmail(firstClean([filters.agentEmail, filters.email], 180));
  const uii = firstClean([filters.uii, filters.rcxUii, filters.callUii], 160);
  const callSessionId = firstClean([filters.callSessionId, filters.sessionId, filters.workflowInstanceId], 160);
  const queueItemId = firstClean([filters.queueItemId, filters.queueTicketId], 160);
  const phone = normalizePhone(firstClean([filters.phone, filters.phoneNumber, filters.leadPhone, filters.contactPhone], 80));
  const eventExtensionId = String(event.extensionId || "");
  const extensionMatched = Boolean(extensionId && eventExtensionId === String(extensionId));

  // RingCX streams often know the UII before our cx.call.placed event has
  // been updated with it. Treat present-but-different IDs as authoritative
  // mismatches, but let a blank event ID fall through to phone/agent/queue
  // matching so the live coach can bind during that capture gap.
  if (uii && event.uii && event.uii !== uii) return false;
  if (callSessionId && event.callSessionId && event.callSessionId !== callSessionId) return false;
  if (queueItemId && event.queueItemId !== queueItemId) return false;
  if (phone && normalizePhone(event.phone || "") !== phone) return false;
  if (extensionId && !extensionMatched) return false;
  if (agentEmail && !extensionMatched && canonicalAgentEmail(event.agentEmail) !== agentEmail) return false;
  return true;
}

function hasAgentFilter(input = {}) {
  return Boolean(firstClean([input.agentExtensionId, input.extensionId, input.agentExt], 80) ||
    firstClean([input.agentEmail, input.email], 180));
}

function stripCallIdentityFilters(input = {}) {
  const copy = { ...input };
  delete copy.uii;
  delete copy.rcxUii;
  delete copy.callUii;
  delete copy.callSessionId;
  delete copy.sessionId;
  delete copy.workflowInstanceId;
  delete copy.queueItemId;
  delete copy.queueTicketId;
  return copy;
}

function summarizeCallSession(session = null) {
  if (!session) return null;
  return {
    id: cleanText(session._id || session.id || "", 160),
    direction: session.direction || null,
    state: session.state || null,
    agentId: cleanText(session.agentId || "", 80),
    agentName: cleanText(session.agentName || "", 120),
    agentEmail: cleanLower(session.agentEmail || "", 180),
    queueItemId: cleanText(session.queueItemId || "", 160),
    domain: cleanText(session.domain || "", 40).toUpperCase(),
    logicsCaseId: cleanText(session.logicsCaseId || "", 120),
    contactName: cleanText(session.contactName || "", 160),
    phoneNumber: normalizePhone(session.phoneNumber || ""),
    rcxUii: cleanText(session.rcxUii || "", 160),
    sessionId: cleanText(session.sessionId || "", 160),
    telephonySessionId: cleanText(session.telephonySessionId || "", 160),
    startedAt: toIso(session.startedAt),
    connectedAt: toIso(session.connectedAt),
    endedAt: toIso(session.endedAt),
    dispositionedAt: toIso(session.dispositionedAt),
    dispositionResult: session.dispositionResult || null,
  };
}

function summarizeCloseWorkflow(row = null) {
  if (!row) return null;
  return {
    id: cleanText(row._id || row.id || "", 160),
    family: row.family || null,
    subtype: row.subtype || null,
    stage: row.stage || null,
    aggregateId: cleanText(row.aggregateId || "", 160),
    happenedAt: toIso(row.happenedAt || row.createdAt),
    createdAt: toIso(row.createdAt),
    status: row.status || null,
    summary: cleanText(row.summary || "", 240),
    uii: cleanText(row.payload?.uii || row.result?.uii || "", 160),
  };
}

function buildCoachSessionId(binding = {}) {
  const metadata = binding.metadata || {};
  const agentKey = cleanText(metadata.agentExtension || metadata.agentEmail || "agent", 80)
    .replace(/[^a-z0-9@._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "agent";
  const callKey = cleanText(metadata.uii || metadata.queueItemId || binding.event?.id || "call", 160)
    .replace(/[^a-z0-9@._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80) || "call";
  return `coach-cx-${agentKey}-${callKey}`;
}

function buildSessionMetadataFromBinding({ event = null, callSession = null } = {}) {
  const session = callSession || {};
  return {
    source: "mongo-cx",
    agentEmail: event?.agentEmail || session.agentEmail || "",
    agentExtension: event?.extensionId || session.agentId || "",
    agentName: event?.agentName || session.agentName || "",
    firmName: "Wynn Tax Solutions",
    uii: event?.uii || session.rcxUii || "",
    queueItemId: event?.queueItemId || session.queueItemId || "",
    caseId: event?.caseId || session.logicsCaseId || "",
    phone: event?.phone || session.phoneNumber || "",
    domain: event?.domain || session.domain || "",
    contactName: session.contactName || "",
    eventId: event?.id || "",
    callSessionId: event?.callSessionId || session.id || "",
  };
}

function createLiveCoachMongoBridge({
  EventRecord,
  CallSession,
  WorkflowRecord,
  now = () => Date.now(),
} = {}) {
  if (!EventRecord) throw new Error("EventRecord model is required");
  if (!CallSession) throw new Error("CallSession model is required");

  async function listRecentCoachCallEvents(input = {}) {
    const limit = Math.max(1, Math.min(500, Number(input.limit || DEFAULT_LOOKBACK_LIMIT) || DEFAULT_LOOKBACK_LIMIT));
    const rawLookbackMs = input.lookbackMs !== undefined && input.lookbackMs !== null
      ? Number(input.lookbackMs)
      : input.lookbackSec !== undefined && input.lookbackSec !== null
        ? Number(input.lookbackSec) * 1000
        : DEFAULT_LOOKBACK_MS;
    const lookbackMs = Math.max(0, Number.isFinite(rawLookbackMs) ? rawLookbackMs : DEFAULT_LOOKBACK_MS);
    const sourceService = cleanText(input.sourceService || DEFAULT_SOURCE_SERVICE, 120);
    const query = { eventType: DEFAULT_EVENT_TYPE };
    if (sourceService && sourceService !== "*") query.sourceService = sourceService;

    // Scan newest-first in pages until we have `limit` MATCHED events or the
    // page falls entirely outside the lookback window. The old shape applied
    // `limit` to the raw scan BEFORE the agent/uii filters ran, so on a busy
    // floor one agent's event could be pushed past the global limit by other
    // agents' events and binding would report not_found even though the event
    // existed. `limit` now caps matched results; the raw scan is bounded by
    // maxScan (LIVE_COACH_CALL_EVENT_MAX_SCAN, default 1000).
    const cutoffMs = lookbackMs ? now() - lookbackMs : 0;
    const scanPageSize = Math.max(limit, 200);
    const maxScan = Math.max(scanPageSize, Number(
      input.maxScan || process.env.LIVE_COACH_CALL_EVENT_MAX_SCAN || 1000,
    ) || 1000);
    const events = [];
    let scanned = 0;
    let lastId = null;
    while (scanned < maxScan && events.length < limit) {
      const pageQuery = lastId ? { ...query, _id: { $lt: lastId } } : query;
      const rows = await EventRecord.find(pageQuery)
        .sort({ _id: -1 })
        .limit(scanPageSize)
        .lean();
      if (!rows.length) break;
      scanned += rows.length;
      let pageEntirelyOlderThanCutoff = true;
      for (const row of rows) {
        const event = normalizeCoachCallEvent(row, { source: "mongo" });
        if (event.createdAtMs < cutoffMs) continue;
        pageEntirelyOlderThanCutoff = false;
        if (events.length < limit && eventMatchesFilters(event, input)) events.push(event);
      }
      if (rows.length < scanPageSize) break;
      if (pageEntirelyOlderThanCutoff) break;
      lastId = rows[rows.length - 1]?._id;
      if (!lastId) break;
    }
    return {
      ok: true,
      query: {
        eventType: DEFAULT_EVENT_TYPE,
        sourceService,
        lookbackMs,
        limit,
        filters: {
          agentExtensionId: firstClean([input.agentExtensionId, input.extensionId, input.agentExt], 80) || null,
          agentEmail: cleanLower(firstClean([input.agentEmail, input.email], 180)) || null,
          uii: firstClean([input.uii, input.rcxUii, input.callUii], 160) || null,
          callSessionId: firstClean([input.callSessionId, input.sessionId, input.workflowInstanceId], 160) || null,
        },
      },
      events,
    };
  }

  async function findLatestCoachCallEvent(input = {}) {
    const result = await listRecentCoachCallEvents(input);
    return result.events[0] || null;
  }

  async function findCallSessionForEvent(event = {}) {
    if (!event) return null;
    if (event.callSessionId && isObjectIdLike(event.callSessionId)) {
      const byId = await CallSession.findById(event.callSessionId).lean();
      if (byId) return summarizeCallSession(byId);
    }
    if (event.uii) {
      const byUii = await CallSession.findOne({ rcxUii: event.uii })
        .sort({ startedAt: -1 })
        .lean();
      if (byUii) return summarizeCallSession(byUii);
    }
    if (event.queueItemId && isObjectIdLike(event.queueItemId)) {
      const byQueue = await CallSession.findOne({ queueItemId: event.queueItemId })
        .sort({ startedAt: -1 })
        .lean();
      if (byQueue) return summarizeCallSession(byQueue);
    }
    if (event.extensionId) {
      const byAgent = await CallSession.findOne({
        agentId: event.extensionId,
        state: { $in: ACTIVE_CALL_STATES },
      })
        .sort({ startedAt: -1 })
        .lean();
      if (byAgent) return summarizeCallSession(byAgent);
    }
    return null;
  }

  async function findDispositionCloseForEvent(event = {}) {
    if (!WorkflowRecord || !event?.queueItemId) return null;
    const close = await WorkflowRecord.findOne({
      family: "cx",
      subtype: "disposition-hangup",
      stage: "completed",
      aggregateType: "dial-request",
      aggregateId: String(event.queueItemId),
    })
      .sort({ _id: -1 })
      .lean();
    if (!close) return null;
    const closeMs = toDateMs(close.happenedAt || close.createdAt);
    if (closeMs && closeMs < event.createdAtMs - 2000) return null;
    return summarizeCloseWorkflow(close);
  }

  async function resolveCoachBinding(input = {}) {
    const requestedUii = firstClean([input.uii, input.rcxUii, input.callUii], 160);
    const requestedCallSessionId = firstClean([input.callSessionId, input.sessionId, input.workflowInstanceId], 160);
    const requestedQueueItemId = firstClean([input.queueItemId, input.queueTicketId], 160);
    const requireCurrentForAgent = input.requireCurrentForAgent !== false;
    const latestForAgent = hasAgentFilter(input) && requireCurrentForAgent
      ? await findLatestCoachCallEvent(stripCallIdentityFilters(input))
      : null;

    if (latestForAgent && requestedUii && latestForAgent.uii && latestForAgent.uii !== requestedUii) {
      return {
        ok: true,
        status: "not_current",
        active: false,
        reason: "requested uii is not the latest call for this agent",
        binding: {
          status: "not_current",
          active: false,
          reason: "agent-current-uii-mismatch",
          event: latestForAgent,
          requested: {
            uii: requestedUii,
            queueItemId: requestedQueueItemId || null,
          },
        },
      };
    }

    if (
      latestForAgent &&
      requestedQueueItemId &&
      latestForAgent.queueItemId &&
      latestForAgent.queueItemId !== requestedQueueItemId
    ) {
      return {
        ok: true,
        status: "not_current",
        active: false,
        reason: "requested queue item is not the latest call for this agent",
        binding: {
          status: "not_current",
          active: false,
          reason: "agent-current-queue-mismatch",
          event: latestForAgent,
          requested: {
            uii: requestedUii || null,
            queueItemId: requestedQueueItemId,
          },
        },
      };
    }

    if (
      latestForAgent &&
      requestedCallSessionId &&
      latestForAgent.callSessionId &&
      latestForAgent.callSessionId !== requestedCallSessionId
    ) {
      return {
        ok: true,
        status: "not_current",
        active: false,
        reason: "requested call session is not the latest call for this agent",
        binding: {
          status: "not_current",
          active: false,
          reason: "agent-current-call-session-mismatch",
          event: latestForAgent,
          requested: {
            uii: requestedUii || null,
            callSessionId: requestedCallSessionId,
            queueItemId: requestedQueueItemId || null,
          },
        },
      };
    }

    const event = latestForAgent || await findLatestCoachCallEvent(input);
    if (!event) {
      return {
        ok: true,
        status: "not_found",
        active: false,
        reason: "no matching cx.call.placed event",
        binding: null,
      };
    }

    const [callSession, close] = await Promise.all([
      findCallSessionForEvent(event),
      findDispositionCloseForEvent(event),
    ]);
    const metadata = buildSessionMetadataFromBinding({ event, callSession });
    if (!metadata.uii && requestedUii) metadata.uii = requestedUii;
    if (!metadata.callSessionId && requestedCallSessionId) metadata.callSessionId = requestedCallSessionId;
    const expired = Boolean(event.expiresAtMs && event.expiresAtMs <= now());
    const closed = Boolean(close);
    const status = closed ? "closed" : expired ? "expired" : "active";
    const binding = {
      status,
      active: status === "active",
      reason: closed
        ? "disposition-hangup"
        : expired
          ? "event-expired"
          : "matched-cx-call-placed",
      event,
      callSession,
      close,
      metadata,
    };
    binding.sessionId = buildCoachSessionId(binding);
    return {
      ok: true,
      status,
      active: binding.active,
      binding,
    };
  }

  return {
    listRecentCoachCallEvents,
    findLatestCoachCallEvent,
    findCallSessionForEvent,
    findDispositionCloseForEvent,
    resolveCoachBinding,
  };
}

module.exports = {
  ACTIVE_CALL_STATES,
  DEFAULT_EVENT_TYPE,
  DEFAULT_LOOKBACK_LIMIT,
  DEFAULT_LOOKBACK_MS,
  DEFAULT_SOURCE_SERVICE,
  buildCoachSessionId,
  buildSessionMetadataFromBinding,
  canonicalAgentEmail,
  createLiveCoachMongoBridge,
  eventMatchesFilters,
  normalizeCoachCallEvent,
  summarizeCallSession,
  summarizeCloseWorkflow,
};
