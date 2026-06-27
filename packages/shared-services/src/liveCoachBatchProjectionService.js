"use strict";

const crypto = require("node:crypto");

const DEFAULT_GRPC_SOURCES = Object.freeze([
  "grpc",
  "grpc-mongo",
  "grpc-live-bridge",
  "mongo-cx",
  "control-plane-cx",
]);
const TERMINAL_STATUSES = Object.freeze(["stopped", "stale", "voicemail_rejected", "released", "pruned"]);

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLower(value, maxLength = 500) {
  return cleanText(value, maxLength).toLowerCase();
}

function toPositiveInt(value, fallback, min = 1, max = 500) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function toDateMs(value) {
  if (!value) return 0;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function normalizePhoneLast4(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

function cleanArray(values, limit, mapper) {
  const rows = Array.isArray(values) ? values : [];
  return rows
    .slice(-limit)
    .filter(Boolean) // drop null/undefined ELEMENTS before mapping — the row mappers deref immediately
    .map(mapper)
    .filter(Boolean);
}

function normalizeSourceFilter(value) {
  const sourceRows = Array.isArray(value) ? value : String(value || "").split(",");
  const sources = sourceRows
    .map((source) => cleanLower(source, 80))
    .filter(Boolean);
  return sources.length ? new Set(sources) : new Set(DEFAULT_GRPC_SOURCES);
}

function isTerminalSession(session = {}) {
  return TERMINAL_STATUSES.includes(cleanLower(session.status, 60));
}

function sessionUpdatedMs(session = {}) {
  return (
    toDateMs(session.lastEventAt) ||
    toDateMs(session.updatedAt) ||
    toDateMs(session.createdAt)
  );
}

function sessionHasSignal(session = {}) {
  const latest = session.latest || {};
  const memory = session.memory || {};
  return Boolean(
    latest.provisionalTranscript?.text ||
      latest.transcript?.text ||
      latest.context ||
      latest.dialog ||
      latest.streamStatus ||
      (Array.isArray(memory.transcripts) && memory.transcripts.length) ||
      (Array.isArray(memory.provisionalTranscripts) && memory.provisionalTranscripts.length)
  );
}

function shouldIncludeSession(session = {}, options = {}) {
  if (!session || isTerminalSession(session)) return false;
  const sourceFilter = normalizeSourceFilter(options.sources);
  const source = cleanLower(session.metadata?.source || "", 80);
  if (sourceFilter.size && source && !sourceFilter.has(source)) return false;
  if (sourceFilter.size && !source) return false;

  const maxIdleMs = Math.max(30_000, Number(options.maxIdleMs || 10 * 60 * 1000));
  const updatedMs = sessionUpdatedMs(session);
  if (updatedMs && Date.now() - updatedMs > maxIdleMs) return false;

  if (options.requireSignal && !sessionHasSignal(session)) return false;
  return true;
}

function transcriptRow(row, input = {}) {
  if (!row) return null; // latest.transcript / latest.provisionalTranscript are null on a fresh session
  const text = cleanText(row.text || row.transcript || "", input.maxTextChars || 1200);
  if (!text) return null;
  return {
    id: cleanText(row.id || row.itemId || row.at || text.slice(0, 40), 140),
    at: row.at || row.createdAt || null,
    role: cleanLower(row.role || "prospect", 40) || "prospect",
    channel: cleanLower(row.channel || "", 30) || null,
    text,
    source: cleanText(row.source || row.model || "", 80) || null,
    model: cleanText(row.model || "", 80) || null,
    wordCount: Number(row.wordCount || 0) || text.split(/\s+/).filter(Boolean).length,
    provisional: Boolean(input.provisional || row.provisional),
  };
}

function contextRow(row = {}) {
  const selectedKeys = [
    ...(Array.isArray(row.selectedKeys) ? row.selectedKeys : []),
    ...(Array.isArray(row.matches) ? row.matches.map((match) => match?.key || match?.label) : []),
    ...(Array.isArray(row.miniJudgement?.selectedKeys) ? row.miniJudgement.selectedKeys : []),
  ]
    .map((key) => cleanText(key, 80))
    .filter(Boolean);
  return {
    id: cleanText(row.id || row.sourceTranscriptId || row.at || "", 140) || null,
    at: row.at || null,
    text: cleanText(row.phraseText || row.text || "", 420),
    selectedKeys: [...new Set(selectedKeys)].slice(0, 12),
    shouldCompose: row.shouldCompose == null ? null : Boolean(row.shouldCompose),
    actionReason: cleanText(row.actionReason || row.reason || "", 180) || null,
    meaning: cleanText(
      row.miniJudgement?.transcriptMeaning ||
        row.memoryBrief?.whatHappened ||
        row.contextBrief ||
        "",
      360,
    ) || null,
  };
}

function guidanceRow(row = {}) {
  const text = cleanText(row.say || row.text || row.try || row.steer || "", 600);
  if (!text) return null;
  return {
    id: cleanText(row.id || row.dialogId || row.at || text.slice(0, 40), 140),
    at: row.at || null,
    status: cleanLower(row.status || "", 40) || null,
    read: cleanText(row.read || "", 300) || null,
    steer: cleanText(row.steer || "", 300) || null,
    try: cleanText(row.try || row.say || "", 500) || null,
    say: cleanText(row.say || "", 500) || null,
    source: cleanText(row.source || row.model || "", 80) || null,
    skillKeys: Array.isArray(row.skillKeys)
      ? row.skillKeys.map((key) => cleanText(key, 80)).filter(Boolean).slice(0, 8)
      : [],
  };
}

function askRow(row = {}) {
  const question = cleanText(row.question || row.prompt || row.input || "", 360);
  const answer = cleanText(row.answer || row.output || "", 700);
  if (!question && !answer) return null;
  return {
    id: cleanText(row.id || row.at || question.slice(0, 40), 140),
    at: row.at || row.createdAt || null,
    status: cleanLower(row.status || "", 40) || null,
    question,
    answer,
  };
}

function factRows(factLedger = {}, limit = 20) {
  const facts = [];
  if (Array.isArray(factLedger.facts)) {
    for (const fact of factLedger.facts) {
      const text = cleanText(fact?.text || fact?.value || fact, 240);
      if (text) facts.push({ key: cleanText(fact?.key || fact?.type || "", 80) || null, text });
      if (facts.length >= limit) return facts;
    }
  }
  for (const [key, value] of Object.entries(factLedger || {})) {
    if (facts.length >= limit) break;
    if (key === "facts") continue;
    const text = cleanText(value?.text || value?.value || value, 240);
    if (text) facts.push({ key: cleanText(key, 80), text });
  }
  return facts;
}

function rollingSummaryFromSession(session = {}) {
  const latest = session.latest || {};
  const memory = session.memory || {};
  const summary = latest.rollingSummary || memory.rollingSummary || null;
  return summary && typeof summary === "object" ? summary : null;
}

function buildConversationProjection(session = {}, options = {}) {
  const memory = session.memory || {};
  const latest = session.latest || {};
  const metadata = session.metadata || {};
  const maxTranscriptRows = toPositiveInt(options.maxTranscriptRows, 40, 1, 240);
  const maxProvisionalRows = toPositiveInt(options.maxProvisionalRows, 8, 0, 40);
  const maxContextRows = toPositiveInt(options.maxContextRows, 12, 0, 80);
  const maxGuidanceRows = toPositiveInt(options.maxGuidanceRows, 8, 0, 80);
  const maxAskRows = toPositiveInt(options.maxAskRows, 5, 0, 30);
  const rollingSummary = rollingSummaryFromSession(session);
  const transcript = cleanArray(memory.transcripts, maxTranscriptRows, (row) => transcriptRow(row, options));
  const provisional = cleanArray(
    memory.provisionalTranscripts,
    maxProvisionalRows,
    (row) => transcriptRow(row, { ...options, provisional: true, maxTextChars: Math.min(options.maxTextChars || 600, 600) }),
  );
  const latestProvisional = transcriptRow(latest.provisionalTranscript, {
    ...options,
    provisional: true,
    maxTextChars: Math.min(options.maxTextChars || 600, 600),
  });
  if (latestProvisional && !provisional.some((row) => row.id === latestProvisional.id)) {
    provisional.push(latestProvisional);
  }

  return {
    sessionId: cleanText(session.id || session.sessionId || "", 160),
    status: cleanLower(session.status || "", 60) || null,
    source: cleanLower(metadata.source || "", 80) || null,
    updatedAt: session.updatedAt || null,
    lastEventAt: session.lastEventAt || null,
    agent: {
      email: cleanLower(metadata.agentEmail || "", 180) || null,
      name: cleanText(metadata.agentName || "", 120) || null,
      extension: cleanText(metadata.agentExtension || "", 80) || null,
    },
    call: {
      domain: cleanText(metadata.domain || "", 40).toUpperCase() || null,
      caseId: cleanText(metadata.caseId || "", 120) || null,
      queueItemId: cleanText(metadata.queueItemId || "", 160) || null,
      uii: cleanText(metadata.uii || session.binding?.metadata?.uii || "", 160) || null,
      callSessionId: cleanText(metadata.callSessionId || session.binding?.metadata?.callSessionId || "", 160) || null,
      streamId: cleanText(metadata.streamId || "", 160) || null,
      contactName: cleanText(metadata.contactName || "", 160) || null,
      phoneLast4: normalizePhoneLast4(metadata.phone || metadata.contactPhone),
    },
    counters: session.counters || {},
    latest: {
      transcript: transcriptRow(latest.transcript, options),
      provisionalTranscript: latestProvisional,
      context: latest.context ? contextRow(latest.context) : null,
      guidance: latest.dialog ? guidanceRow(latest.dialog) : null,
      streamStatus: latest.streamStatus
        ? {
          status: cleanText(latest.streamStatus.status || latest.streamStatus.state || "", 80) || null,
          at: latest.streamStatus.at || null,
          bindingStatus: cleanText(latest.streamStatus.bindingStatus || "", 80) || null,
        }
        : null,
    },
    arrays: {
      transcript,
      provisionalTranscript: provisional,
      context: cleanArray(memory.contexts, maxContextRows, contextRow),
      guidance: cleanArray(memory.coachingSuggestions, maxGuidanceRows, guidanceRow),
      asks: cleanArray(memory.asks, maxAskRows, askRow),
      facts: factRows(session.factLedger || {}, toPositiveInt(options.maxFacts, 20, 0, 80)),
    },
    callStrategy: cleanText(session.callStrategy || metadata.callStrategy || "", 1800) || null,
    rollingSummary,
    callSummary: cleanText(rollingSummary?.summaryText || session.callSummary || "", 1200) || null,
  };
}

function buildActiveLiveCoachBatch(sessions = [], options = {}) {
  const maxSessions = toPositiveInt(options.maxSessions, 12, 1, 50);
  const rows = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => shouldIncludeSession(session, options))
    .sort((left, right) => sessionUpdatedMs(right) - sessionUpdatedMs(left))
    .slice(0, maxSessions)
    .map((session) => buildConversationProjection(session, options))
    .filter((conversation) => conversation.sessionId);

  return {
    schemaVersion: "live-coach.active-conversation-batch.v1",
    generatedAt: new Date().toISOString(),
    activeConversationCount: rows.length,
    limits: {
      maxSessions,
      maxTranscriptRows: toPositiveInt(options.maxTranscriptRows, 40, 1, 240),
      maxProvisionalRows: toPositiveInt(options.maxProvisionalRows, 8, 0, 40),
      maxContextRows: toPositiveInt(options.maxContextRows, 12, 0, 80),
      maxGuidanceRows: toPositiveInt(options.maxGuidanceRows, 8, 0, 80),
      maxAskRows: toPositiveInt(options.maxAskRows, 5, 0, 30),
    },
    conversations: rows,
  };
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 24);
}

function lastRows(rows, count = 2) {
  return (Array.isArray(rows) ? rows : []).slice(-count).map((row) => ({
    id: row.id || null,
    at: row.at || null,
    role: row.role || null,
    text: row.text || null,
    selectedKeys: row.selectedKeys || undefined,
    status: row.status || undefined,
  }));
}

function normalizeCursor(cursor) {
  if (!cursor) return { conversations: {} };
  if (typeof cursor === "string") {
    try {
      return normalizeCursor(JSON.parse(cursor));
    } catch (_error) {
      return { conversations: {} };
    }
  }
  const conversations = cursor.conversations && typeof cursor.conversations === "object"
    ? cursor.conversations
    : {};
  return { ...cursor, conversations };
}

function buildConversationCursorEntry(conversation = {}) {
  const arrays = conversation.arrays || {};
  const signatureInput = {
    sessionId: conversation.sessionId || null,
    status: conversation.status || null,
    call: {
      uii: conversation.call?.uii || null,
      callSessionId: conversation.call?.callSessionId || null,
      queueItemId: conversation.call?.queueItemId || null,
    },
    counts: {
      transcript: arrays.transcript?.length || 0,
      provisionalTranscript: arrays.provisionalTranscript?.length || 0,
      context: arrays.context?.length || 0,
      asks: arrays.asks?.length || 0,
      facts: arrays.facts?.length || 0,
    },
    last: {
      transcript: lastRows(arrays.transcript, 2),
      provisionalTranscript: lastRows(arrays.provisionalTranscript, 2),
      context: lastRows(arrays.context, 2),
      asks: lastRows(arrays.asks, 1),
      facts: lastRows(arrays.facts, 2),
    },
  };
  return {
    signature: stableHash(signatureInput),
    uii: conversation.call?.uii || null,
    queueItemId: conversation.call?.queueItemId || null,
    callSessionId: conversation.call?.callSessionId || null,
    updatedAt: conversation.updatedAt || null,
    lastEventAt: conversation.lastEventAt || null,
    counts: signatureInput.counts,
  };
}

function buildActiveLiveCoachChangeSet(sessions = [], input = {}) {
  const previousCursor = normalizeCursor(input.cursor || input.previousCursor);
  const batch = buildActiveLiveCoachBatch(sessions, input);
  const conversations = {};
  const activeSessionIds = [];
  const changedConversations = [];

  for (const conversation of batch.conversations) {
    const entry = buildConversationCursorEntry(conversation);
    const previous = previousCursor.conversations[conversation.sessionId] || null;
    conversations[conversation.sessionId] = entry;
    activeSessionIds.push(conversation.sessionId);

    if (!previous || previous.signature !== entry.signature) {
      changedConversations.push({
        ...conversation,
        change: {
          reason: previous ? "conversation-updated" : "new-active-conversation",
          signature: entry.signature,
          previousSignature: previous?.signature || null,
          counts: entry.counts,
        },
      });
    }
  }

  const endedConversations = Object.keys(previousCursor.conversations)
    .filter((sessionId) => !conversations[sessionId])
    .map((sessionId) => ({
      sessionId,
      previous: previousCursor.conversations[sessionId],
    }));

  return {
    schemaVersion: "live-coach.active-conversation-changes.v1",
    generatedAt: batch.generatedAt,
    hasChanges: changedConversations.length > 0,
    activeConversationCount: batch.activeConversationCount,
    changedConversationCount: changedConversations.length,
    unchangedConversationCount: Math.max(0, batch.activeConversationCount - changedConversations.length),
    endedConversationCount: endedConversations.length,
    limits: batch.limits,
    changedConversations,
    endedConversations,
    cursor: {
      schemaVersion: "live-coach.active-conversation-cursor.v1",
      generatedAt: batch.generatedAt,
      activeSessionIds,
      conversations,
    },
  };
}

module.exports = {
  DEFAULT_GRPC_SOURCES,
  TERMINAL_STATUSES,
  buildActiveLiveCoachChangeSet,
  buildActiveLiveCoachBatch,
  buildConversationProjection,
  shouldIncludeSession,
};
