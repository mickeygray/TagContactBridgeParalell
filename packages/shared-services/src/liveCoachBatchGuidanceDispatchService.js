"use strict";

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLower(value, maxLength = 500) {
  return cleanText(value, maxLength).toLowerCase();
}

function normalizeGuidanceRows(input = {}) {
  const source = Array.isArray(input)
    ? input
    : Array.isArray(input.guidance)
      ? input.guidance
      : Array.isArray(input.items)
        ? input.items
        : [];
  return source.filter((row) => row && typeof row === "object");
}

function normalizeBatchConversations(activeBatch = {}) {
  const conversations = Array.isArray(activeBatch.conversations) ? activeBatch.conversations : [];
  return conversations.filter((conversation) => conversation?.sessionId);
}

function conversationTarget(conversation = {}) {
  return {
    sessionId: cleanText(conversation.sessionId, 180),
    uii: cleanText(conversation.call?.uii, 180) || null,
    callSessionId: cleanText(conversation.call?.callSessionId, 180) || null,
    queueItemId: cleanText(conversation.call?.queueItemId, 180) || null,
    agentEmail: cleanLower(conversation.agent?.email, 180) || null,
    agentName: cleanText(conversation.agent?.name, 160) || null,
    agentExtension: cleanText(conversation.agent?.extension, 80) || null,
  };
}

function normalizeGuidanceItem(row = {}, index = 0) {
  const mode = cleanLower(row.mode || row.kind || "quiet", 40) || "quiet";
  const read = cleanText(row.read || row.observation || "", 500);
  const steer = cleanText(row.steer || row.guidance || row.nextStep || "", 500);
  const tryLine = cleanText(row.try || row.say || row.line || "", 700);
  const completed = Array.isArray(row.completed)
    ? row.completed.map((item) => cleanText(item, 120)).filter(Boolean)
    : [];
  const next = Array.isArray(row.next)
    ? row.next.map((item) => cleanText(item, 160)).filter(Boolean)
    : [];

  return {
    id: cleanText(row.id || `batch-guidance-${index}`, 180),
    sessionId: cleanText(row.sessionId, 180) || null,
    uii: cleanText(row.uii, 180) || null,
    agentEmail: cleanLower(row.agentEmail || row.agent?.email, 180) || null,
    mode,
    phase: cleanLower(row.phase, 80) || null,
    read,
    steer,
    try: tryLine,
    completed,
    next,
    confidence: cleanLower(row.confidence || "", 40) || null,
    raw: row,
  };
}

function resolveGuidanceTarget(item, conversations) {
  if (item.sessionId) {
    const conversation = conversations.find((row) => row.sessionId === item.sessionId);
    if (!conversation) {
      return { ok: false, reason: "session-not-active" };
    }
    const target = conversationTarget(conversation);
    if (item.uii && target.uii && item.uii !== target.uii) {
      return { ok: false, reason: "uii-mismatch", target };
    }
    if (item.agentEmail && target.agentEmail && item.agentEmail !== target.agentEmail) {
      return { ok: false, reason: "agent-mismatch", target };
    }
    return { ok: true, conversation, target };
  }

  if (!item.uii) {
    return { ok: false, reason: "missing-session-and-uii" };
  }

  const matches = conversations.filter((conversation) => {
    const target = conversationTarget(conversation);
    if (target.uii !== item.uii) return false;
    if (item.agentEmail && target.agentEmail && target.agentEmail !== item.agentEmail) return false;
    return true;
  });
  if (matches.length === 0) return { ok: false, reason: "no-active-uii-match" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous-uii-match" };
  return { ok: true, conversation: matches[0], target: conversationTarget(matches[0]) };
}

function shouldDispatchGuidance(item = {}) {
  return Boolean(
    item.mode === "quiet" ||
      item.read ||
      item.steer ||
      item.try ||
      item.completed.length ||
      item.next.length,
  );
}

function buildGuidancePayload(item = {}, target = {}, input = {}) {
  return {
    schemaVersion: "live-coach.agent-guidance-delta.v1",
    id: item.id,
    generatedAt: cleanText(input.generatedAt || new Date().toISOString(), 80),
    sessionId: target.sessionId,
    uii: target.uii,
    agentEmail: target.agentEmail,
    mode: item.mode,
    phase: item.phase,
    read: item.read,
    steer: item.steer,
    try: item.try,
    completed: item.completed,
    next: item.next,
    confidence: item.confidence,
  };
}

function buildLiveCoachGuidanceDispatchPlan(activeBatch = {}, modelResponse = {}, options = {}) {
  const conversations = normalizeBatchConversations(activeBatch);
  const rows = normalizeGuidanceRows(modelResponse);
  const dispatches = [];
  const rejected = [];
  const generatedAt = cleanText(modelResponse.generatedAt || options.generatedAt || new Date().toISOString(), 80);

  rows.forEach((row, index) => {
    const item = normalizeGuidanceItem(row, index);
    if (!shouldDispatchGuidance(item)) {
      rejected.push({ index, reason: "empty-guidance", item });
      return;
    }

    const resolved = resolveGuidanceTarget(item, conversations);
    if (!resolved.ok) {
      rejected.push({ index, reason: resolved.reason, item, target: resolved.target || null });
      return;
    }

    dispatches.push({
      status: "ready",
      delivery: "placeholder",
      target: resolved.target,
      payload: buildGuidancePayload(item, resolved.target, { generatedAt }),
    });
  });

  return {
    schemaVersion: "live-coach.batch-guidance-dispatch.v1",
    generatedAt,
    activeConversationCount: conversations.length,
    receivedGuidanceCount: rows.length,
    dispatchCount: dispatches.length,
    rejectedCount: rejected.length,
    dispatches,
    rejected,
  };
}

module.exports = {
  buildLiveCoachGuidanceDispatchPlan,
  normalizeGuidanceItem,
  resolveGuidanceTarget,
};
