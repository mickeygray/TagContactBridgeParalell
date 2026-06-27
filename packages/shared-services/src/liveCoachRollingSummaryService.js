"use strict";

const crypto = require("node:crypto");

const ROLLING_SUMMARY_TASK_ID = "liveCoach.rollingSemanticSummary";
const ROLLING_SUMMARY_BATCH_SCHEMA = "live-coach.rolling-summary-batch.v1";
const ROLLING_SUMMARY_RESULT_SCHEMA = "live-coach.rolling-summary-result.v1";
const ROLLING_SUMMARY_APPLY_SCHEMA = "live-coach.rolling-summary-apply-plan.v1";
const ROLLING_SUMMARY_PAYLOAD_SCHEMA = "live-coach.rolling-summary.v1";
const SUMMARY_KINDS = new Set([
  "fact",
  "objection",
  "tax_issue",
  "open_question",
  "next_step",
  "call_progress",
  "uncertainty",
]);

function cleanText(value, maxLength = 500) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanLower(value, maxLength = 500) {
  return cleanText(value, maxLength).toLowerCase();
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function toPositiveInt(value, fallback, min = 1, max = 500) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeStringArray(values, maxItems = 12, maxText = 220) {
  const source = Array.isArray(values) ? values : [];
  const out = [];
  for (const row of source) {
    const text = cleanText(row?.text || row?.value || row?.summary || row, maxText);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeTargetFromConversation(conversation = {}) {
  return {
    sessionId: cleanText(conversation.sessionId, 180),
    uii: cleanText(conversation.call?.uii, 180) || null,
    callSessionId: cleanText(conversation.call?.callSessionId, 180) || null,
    queueItemId: cleanText(conversation.call?.queueItemId, 180) || null,
    agentEmail: cleanLower(conversation.agent?.email, 180) || null,
    agentExtensionId: cleanText(conversation.agent?.extension, 80) || null,
  };
}

function normalizeSummaryEntry(row = {}, index = 0) {
  const text = cleanText(row.text || row.summary || row.value || "", 500);
  if (!text) return null;
  const sourceTranscriptIds = Array.isArray(row.sourceTranscriptIds)
    ? row.sourceTranscriptIds.map((id) => cleanText(id, 160)).filter(Boolean).slice(0, 12)
    : [];
  const kind = cleanLower(row.kind || row.type || "call_progress", 40);
  return {
    sequence: Number.isFinite(Number(row.sequence)) ? Math.max(1, Math.floor(Number(row.sequence))) : index + 1,
    at: cleanText(row.at || row.createdAt || new Date().toISOString(), 80),
    kind: SUMMARY_KINDS.has(kind) ? kind : "call_progress",
    text,
    sourceTranscriptIds,
  };
}

function normalizeSummaryEntries(values) {
  return (Array.isArray(values) ? values : [])
    .map(normalizeSummaryEntry)
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence);
}

function normalizeRollingSummaryMemory(input = {}) {
  if (!input || typeof input !== "object") {
    const text = cleanText(input, 900);
    return {
      summary: text ? [normalizeSummaryEntry({ sequence: 1, kind: "call_progress", text })] : [],
      factsCaptured: [],
      openQuestions: [],
      objections: [],
      taxIssues: [],
    };
  }
  const summary = normalizeSummaryEntries(input.summary);
  const fallbackText = cleanText(input.summaryText || input.callSummary || input.text || "", 900);
  return {
    summary: summary.length
      ? summary
      : fallbackText
        ? [normalizeSummaryEntry({ sequence: 1, kind: "call_progress", text: fallbackText })]
        : [],
    factsCaptured: normalizeStringArray(input.factsCaptured || input.facts || []),
    openQuestions: normalizeStringArray(input.openQuestions || []),
    objections: normalizeStringArray(input.objections || []),
    taxIssues: normalizeStringArray(input.taxIssues || input.taxFacts || []),
  };
}

function rollingSummaryToText(summary = []) {
  return normalizeSummaryEntries(summary)
    .map((row) => row.text)
    .filter(Boolean)
    .join(" ");
}

function normalizeRollingSummaryPayload(payload = {}) {
  const normalizedMemory = normalizeRollingSummaryMemory(payload);
  const summaryText = cleanText(payload.summaryText || rollingSummaryToText(normalizedMemory.summary), 1600);
  return {
    schemaVersion: ROLLING_SUMMARY_PAYLOAD_SCHEMA,
    generatedAt: cleanText(payload.generatedAt || new Date().toISOString(), 80),
    sessionId: cleanText(payload.sessionId, 180) || null,
    uii: cleanText(payload.uii, 180) || null,
    callSessionId: cleanText(payload.callSessionId, 180) || null,
    queueItemId: cleanText(payload.queueItemId, 180) || null,
    agentEmail: cleanLower(payload.agentEmail, 180) || null,
    agentExtensionId: cleanText(payload.agentExtensionId, 80) || null,
    summary: normalizedMemory.summary,
    summaryText,
    factsCaptured: normalizedMemory.factsCaptured,
    openQuestions: normalizedMemory.openQuestions,
    objections: normalizedMemory.objections,
    taxIssues: normalizedMemory.taxIssues,
    nextBestFocus: cleanText(payload.nextBestFocus, 300) || "",
    confidence: cleanLower(payload.confidence, 40) || "",
    sourceTranscriptIds: Array.isArray(payload.sourceTranscriptIds)
      ? payload.sourceTranscriptIds.map((id) => cleanText(id, 160)).filter(Boolean).slice(0, 80)
      : [],
    suspectedMishearings: Array.isArray(payload.suspectedMishearings) ? payload.suspectedMishearings.slice(0, 20) : [],
    summaryCursor: payload.summaryCursor || null,
  };
}

function applyRollingSummaryToSession(session = {}, payload = {}, options = {}) {
  if (!session || typeof session !== "object") return null;
  const normalized = normalizeRollingSummaryPayload(payload);
  if (!normalized.sessionId) normalized.sessionId = cleanText(session.id || session.sessionId, 180) || null;
  if (!normalized.sessionId) return null;
  if (!Array.isArray(normalized.summary) || !normalized.summary.length) return null;

  const target = options.mutate ? session : { ...session };
  target.latest = { ...(target.latest || {}) };
  target.memory = { ...(target.memory || {}) };
  target.latest.rollingSummary = normalized;
  target.memory.rollingSummary = normalized;
  // callSummary is the rolling-DIGEST scribe's field. Closeout/drain (the default
  // caller) owns it and SHOULD write it; the LIVE cockpit summary tick passes
  // writeCallSummary:false so it never races/poisons the digest mid-call.
  if (options.writeCallSummary !== false) {
    target.callSummary = normalized.summaryText || target.callSummary || "";
  }

  const history = Array.isArray(target.memory.rollingSummaryHistory)
    ? [...target.memory.rollingSummaryHistory]
    : [];
  history.push({
    at: normalized.generatedAt,
    sessionId: normalized.sessionId,
    uii: normalized.uii,
    summaryLength: normalized.summary.length,
    sourceTranscriptIds: normalized.sourceTranscriptIds,
  });
  const limit = toPositiveInt(options.historyLimit, 12, 1, 50);
  if (history.length > limit) history.splice(0, history.length - limit);
  target.memory.rollingSummaryHistory = history;

  if (options.mutate) return session;
  return target;
}

function getPreviousRollingSummary(conversation = {}) {
  const candidates = [
    conversation.rollingSummary,
    conversation.call?.rollingSummary,
    conversation.latest?.rollingSummary,
    conversation.memory?.rollingSummary,
    conversation.callSummary ? { summaryText: conversation.callSummary } : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeRollingSummaryMemory(candidate);
    if (normalized.summary.length || normalized.factsCaptured.length || normalized.openQuestions.length) {
      return normalized;
    }
  }
  return normalizeRollingSummaryMemory({});
}

function cursorForConversation(cursor = {}, sessionId = "") {
  const conversations = cursor?.conversations && typeof cursor.conversations === "object"
    ? cursor.conversations
    : {};
  return conversations[sessionId] || {};
}

function normalizeTranscriptRow(row = {}, index = 0, priorLine = "") {
  const text = cleanText(row.deterministicText || row.text || row.transcript || "", 1400);
  if (!text) return null;
  const role = cleanLower(row.role || "prospect", 40);
  if (role !== "agent" && role !== "prospect") return null;
  if (row.provisional) return null;
  return {
    transcriptId: cleanText(row.id || row.itemId || row.transcriptId || row.at || `row-${index}`, 160),
    role,
    redactedRawText: text,
    deterministicText: text,
    priorLine: cleanText(priorLine, 500) || null,
    at: cleanText(row.at || row.createdAt || "", 80) || null,
  };
}

function selectTranscriptRows(conversation = {}, cursorEntry = {}, options = {}) {
  const maxRows = toPositiveInt(options.maxRowsPerCall, 24, 1, 120);
  const rows = Array.isArray(conversation.arrays?.transcript) ? conversation.arrays.transcript : [];
  const lastTranscriptId = cleanText(cursorEntry.lastTranscriptId, 160);
  const lastTranscriptAt = cleanText(cursorEntry.lastTranscriptAt, 80);
  let startIndex = 0;
  if (lastTranscriptId) {
    const found = rows.findIndex((row) => cleanText(row.id || row.itemId || row.transcriptId, 160) === lastTranscriptId);
    if (found >= 0) startIndex = found + 1;
  } else if (lastTranscriptAt) {
    const found = rows.findIndex((row) => cleanText(row.at || row.createdAt, 80) === lastTranscriptAt);
    if (found >= 0) startIndex = found + 1;
  }

  return rows
    .slice(startIndex)
    .map((row, offset) => normalizeTranscriptRow(
      row,
      startIndex + offset,
      rows[startIndex + offset - 1]?.text || "",
    ))
    .filter(Boolean)
    .slice(-maxRows);
}

function normalizeBatchConversations(input = {}) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.conversations)) return input.conversations;
  if (Array.isArray(input.changedConversations)) return input.changedConversations;
  return [];
}

function buildRollingSummaryBatchRequest(activeBatch = {}, options = {}) {
  const generatedAt = cleanText(options.generatedAt || new Date().toISOString(), 80);
  const maxCalls = toPositiveInt(options.maxCalls, 7, 1, 20);
  const cursor = options.cursor || activeBatch.summaryCursor || {};
  const calls = [];

  for (const conversation of normalizeBatchConversations(activeBatch)) {
    if (calls.length >= maxCalls) break;
    const target = normalizeTargetFromConversation(conversation);
    if (!target.sessionId || !target.uii || !target.agentExtensionId || !target.agentEmail) continue;
    const summaryCursor = cursorForConversation(cursor, target.sessionId);
    const rows = selectTranscriptRows(conversation, summaryCursor, options);
    if (!rows.length && !options.includeEmptyCalls) continue;
    calls.push({
      sessionId: target.sessionId,
      uii: target.uii,
      callSessionId: target.callSessionId,
      queueItemId: target.queueItemId,
      agentExtensionId: target.agentExtensionId,
      agentEmail: target.agentEmail,
      summaryCursor,
      previousRollingSummary: getPreviousRollingSummary(conversation),
      rows,
    });
  }

  return {
    schemaVersion: ROLLING_SUMMARY_BATCH_SCHEMA,
    taskId: ROLLING_SUMMARY_TASK_ID,
    generatedAt,
    cadenceMs: Math.max(1000, Number(options.cadenceMs || 120000) || 120000),
    batchId: cleanText(options.batchId, 120) || `rolling-summary-${stableHash({ generatedAt, calls })}`,
    maxCalls,
    calls,
  };
}

function buildRollingSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "batchId", "generatedAt", "summaries"],
    properties: {
      schemaVersion: { type: "string" },
      batchId: { type: "string" },
      generatedAt: { type: "string" },
      summaries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
          required: ["sessionId", "uii", "agentExtensionId", "agentEmail", "summary"],
          properties: {
            sessionId: { type: "string" },
            uii: { type: "string" },
            callSessionId: { type: "string" },
            queueItemId: { type: "string" },
            agentEmail: { type: "string" },
            agentExtensionId: { type: "string" },
            summary: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["sequence", "kind", "text", "sourceTranscriptIds"],
                properties: {
                  sequence: { type: "number" },
                  at: { type: "string" },
                  kind: { type: "string" },
                  text: { type: "string" },
                  sourceTranscriptIds: { type: "array", items: { type: "string" } },
                },
              },
            },
            summaryText: { type: "string" },
            factsCaptured: { type: "array", items: { type: "string" } },
            openQuestions: { type: "array", items: { type: "string" } },
            objections: { type: "array", items: { type: "string" } },
            taxIssues: { type: "array", items: { type: "string" } },
            nextBestFocus: { type: "string" },
            confidence: { type: "string" },
            sourceTranscriptIds: { type: "array", items: { type: "string" } },
            suspectedMishearings: { type: "array" },
          },
        },
      },
    },
  };
}

function buildRollingSummaryPrompt(batchRequest = {}, options = {}) {
  const system = [
    "You maintain rolling semantic memory for live tax sales calls.",
    "You run beside STT. Do not write coach advice. Do not replace the transcript.",
    "Read final transcript rows only and update call memory in strict JSON.",
    "Every returned row must be keyed by sessionId, uii, agentExtensionId, and agentEmail.",
    "Treat previousRollingSummary.summary as append-only memory.",
    "Do not rewrite, remove, or renumber existing summary entries.",
    "Append only new summary entries supported by the supplied transcript rows.",
    "Every new summary entry must include sequence, kind, text, at, and sourceTranscriptIds.",
    "If a call has no new useful information, return the keyed row with the same summary array.",
    "If identity is ambiguous, omit the call rather than guessing.",
    "Return JSON only.",
  ].join("\n");

  const prompt = [
    "Update rolling summaries for this batch.",
    "",
    "Allowed summary kinds:",
    [...SUMMARY_KINDS].join(", "),
    "",
    "Batch request JSON:",
    JSON.stringify(batchRequest, null, 2),
  ].join("\n");

  return {
    taskId: ROLLING_SUMMARY_TASK_ID,
    system: cleanText(options.systemPrefix || "", 4000)
      ? `${cleanText(options.systemPrefix, 4000)}\n${system}`
      : system,
    prompt,
    schema: buildRollingSummarySchema(),
    batchId: batchRequest.batchId || null,
    callCount: Array.isArray(batchRequest.calls) ? batchRequest.calls.length : 0,
  };
}

function stripFences(text) {
  return String(text || "")
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function coerceModelResponse(response) {
  if (response && typeof response === "object") {
    if (response.json && typeof response.json === "object") return response.json;
    if (Array.isArray(response.summaries) || Array.isArray(response.items)) return response;
    if (typeof response.text === "string") return coerceModelResponse(response.text);
    if (typeof response.content === "string") return coerceModelResponse(response.content);
    return response;
  }
  if (typeof response === "string") {
    try {
      return JSON.parse(stripFences(response));
    } catch (_error) {
      return { summaries: [] };
    }
  }
  return { summaries: [] };
}

function normalizeSummaryResultRow(row = {}, index = 0) {
  return {
    sessionId: cleanText(row.sessionId, 180) || null,
    uii: cleanText(row.uii, 180) || null,
    callSessionId: cleanText(row.callSessionId, 180) || null,
    queueItemId: cleanText(row.queueItemId, 180) || null,
    agentEmail: cleanLower(row.agentEmail || row.agent?.email, 180) || null,
    agentExtensionId: cleanText(row.agentExtensionId || row.agentExtension || row.extensionId, 80) || null,
    summary: normalizeSummaryEntries(row.summary),
    summaryText: cleanText(row.summaryText, 1400) || "",
    factsCaptured: normalizeStringArray(row.factsCaptured || row.facts),
    openQuestions: normalizeStringArray(row.openQuestions),
    objections: normalizeStringArray(row.objections),
    taxIssues: normalizeStringArray(row.taxIssues || row.taxFacts),
    nextBestFocus: cleanText(row.nextBestFocus, 300) || "",
    confidence: cleanLower(row.confidence, 40) || "",
    sourceTranscriptIds: Array.isArray(row.sourceTranscriptIds)
      ? row.sourceTranscriptIds.map((id) => cleanText(id, 160)).filter(Boolean).slice(0, 40)
      : [],
    suspectedMishearings: Array.isArray(row.suspectedMishearings) ? row.suspectedMishearings.slice(0, 20) : [],
    raw: row,
    index,
  };
}

function parseRollingSummaryResult(response, options = {}) {
  const coerced = coerceModelResponse(response);
  const summaries = Array.isArray(coerced)
    ? coerced
    : Array.isArray(coerced.summaries)
      ? coerced.summaries
      : Array.isArray(coerced.items)
        ? coerced.items
        : [];
  return {
    schemaVersion: ROLLING_SUMMARY_RESULT_SCHEMA,
    batchId: cleanText(coerced.batchId || options.batchId, 120) || null,
    generatedAt: cleanText(coerced.generatedAt || options.generatedAt || new Date().toISOString(), 80),
    summaries: summaries.map(normalizeSummaryResultRow),
  };
}

function resolveSummaryTarget(row = {}, conversations = []) {
  if (!row.sessionId) return { ok: false, reason: "missing-session" };
  const conversation = conversations.find((item) => item?.sessionId === row.sessionId);
  if (!conversation) return { ok: false, reason: "session-not-active" };
  const target = normalizeTargetFromConversation(conversation);
  if (row.uii && target.uii && row.uii !== target.uii) return { ok: false, reason: "uii-mismatch", target };
  if (row.agentEmail && target.agentEmail && row.agentEmail !== target.agentEmail) {
    return { ok: false, reason: "agent-mismatch", target };
  }
  if (row.agentExtensionId && target.agentExtensionId && row.agentExtensionId !== target.agentExtensionId) {
    return { ok: false, reason: "agent-extension-mismatch", target };
  }
  return { ok: true, conversation, target };
}

function sameSummaryEntry(left = {}, right = {}) {
  if (
    left.sequence &&
    right.sequence &&
    Number(left.sequence) === Number(right.sequence) &&
    cleanText(left.text, 500) === cleanText(right.text, 500)
  ) {
    return true;
  }
  const leftIds = (left.sourceTranscriptIds || []).join("|");
  const rightIds = (right.sourceTranscriptIds || []).join("|");
  return Boolean(left.text && right.text && left.text === right.text && leftIds && leftIds === rightIds);
}

function mergeAppendOnlySummary(previousEntries = [], returnedEntries = []) {
  const previous = normalizeSummaryEntries(previousEntries);
  const next = [...previous];
  const maxSequence = previous.reduce((max, row) => Math.max(max, Number(row.sequence) || 0), 0);
  for (const row of normalizeSummaryEntries(returnedEntries)) {
    if (previous.some((existing) => sameSummaryEntry(existing, row))) continue;
    if (row.sequence <= maxSequence) {
      row.sequence = next.length + 1;
    }
    next.push({ ...row, sequence: next.length + 1 });
  }
  return next;
}

function buildRollingSummaryPayload(row = {}, target = {}, conversation = {}, options = {}) {
  const previous = getPreviousRollingSummary(conversation);
  const summary = mergeAppendOnlySummary(previous.summary, row.summary);
  const summaryText = cleanText(row.summaryText || rollingSummaryToText(summary), 1600);
  const sourceTranscriptIds = [
    ...summary.flatMap((entry) => entry.sourceTranscriptIds || []),
    ...(row.sourceTranscriptIds || []),
  ]
    .map((id) => cleanText(id, 160))
    .filter(Boolean);
  return {
    schemaVersion: ROLLING_SUMMARY_PAYLOAD_SCHEMA,
    generatedAt: cleanText(options.generatedAt || row.generatedAt || new Date().toISOString(), 80),
    sessionId: target.sessionId,
    uii: target.uii,
    callSessionId: target.callSessionId,
    queueItemId: target.queueItemId,
    agentEmail: target.agentEmail,
    agentExtensionId: target.agentExtensionId,
    summary,
    summaryText,
    factsCaptured: row.factsCaptured.length ? row.factsCaptured : previous.factsCaptured,
    openQuestions: row.openQuestions.length ? row.openQuestions : previous.openQuestions,
    objections: row.objections.length ? row.objections : previous.objections,
    taxIssues: row.taxIssues.length ? row.taxIssues : previous.taxIssues,
    nextBestFocus: row.nextBestFocus || "",
    confidence: row.confidence || "",
    sourceTranscriptIds: [...new Set(sourceTranscriptIds)].slice(0, 80),
    suspectedMishearings: row.suspectedMishearings || [],
    summaryCursor: options.summaryCursor || null,
  };
}

function buildSummaryCursorFromRequestCall(call = {}) {
  const rows = Array.isArray(call.rows) ? call.rows : [];
  const last = rows[rows.length - 1] || null;
  return {
    uii: cleanText(call.uii, 180) || null,
    callSessionId: cleanText(call.callSessionId, 180) || null,
    queueItemId: cleanText(call.queueItemId, 180) || null,
    agentEmail: cleanLower(call.agentEmail, 180) || null,
    agentExtensionId: cleanText(call.agentExtensionId, 80) || null,
    lastTranscriptId: cleanText(last?.transcriptId, 160) || null,
    lastTranscriptAt: cleanText(last?.at, 80) || null,
    processedRowCount: rows.length,
    updatedAt: new Date().toISOString(),
  };
}

function buildRollingSummaryApplyPlan(activeBatch = {}, parsedResult = {}, options = {}) {
  const conversations = normalizeBatchConversations(activeBatch);
  const rows = Array.isArray(parsedResult.summaries) ? parsedResult.summaries : [];
  const requestCalls = Array.isArray(options.batchRequest?.calls) ? options.batchRequest.calls : [];
  const applies = [];
  const rejected = [];
  const generatedAt = cleanText(parsedResult.generatedAt || options.generatedAt || new Date().toISOString(), 80);

  rows.forEach((rawRow, index) => {
    const row = rawRow.raw ? rawRow : normalizeSummaryResultRow(rawRow, index);
    const resolved = resolveSummaryTarget(row, conversations);
    if (!resolved.ok) {
      rejected.push({ index, reason: resolved.reason, item: row, target: resolved.target || null });
      return;
    }
    const requestCall = requestCalls.find((call) => cleanText(call.sessionId, 180) === resolved.target.sessionId) || null;
    const payload = buildRollingSummaryPayload(row, resolved.target, resolved.conversation, {
      generatedAt,
      summaryCursor: requestCall ? buildSummaryCursorFromRequestCall(requestCall) : null,
    });
    if (!payload.summary.length) {
      rejected.push({ index, reason: "empty-summary", item: row, target: resolved.target });
      return;
    }
    applies.push({
      status: "ready",
      target: resolved.target,
      payload,
    });
  });

  return {
    schemaVersion: ROLLING_SUMMARY_APPLY_SCHEMA,
    batchId: cleanText(parsedResult.batchId || options.batchId, 120) || null,
    generatedAt,
    activeConversationCount: conversations.length,
    receivedSummaryCount: rows.length,
    applyCount: applies.length,
    rejectedCount: rejected.length,
    applies,
    rejected,
  };
}

function buildRollingSummaryCursorFromApplyPlan(applyPlan = {}, options = {}) {
  // Seed from the PRIOR cursor so sessions NOT re-summarized this tick keep their advance.
  // A wholesale replace would drop every session the model omitted / the plan rejected / that
  // went quiet -> next tick it re-sends its WHOLE transcript window, forever (the exact waste
  // the cadence exists to prevent). Merge: only sessions touched this tick overwrite their entry.
  const previousConversations = options.previousCursor && typeof options.previousCursor === "object"
    ? options.previousCursor.conversations
    : null;
  const conversations = previousConversations && typeof previousConversations === "object"
    ? { ...previousConversations }
    : {};
  // When the caller knows which sessions were ACTUALLY written (the bus skips terminal sessions),
  // only those advance; the rest keep their seeded prior entry so unwritten rows aren't lost.
  const onlySessionIds = Array.isArray(options.onlySessionIds)
    ? new Set(options.onlySessionIds.map((id) => String(id)))
    : null;
  for (const apply of Array.isArray(applyPlan.applies) ? applyPlan.applies : []) {
    const target = apply.target || {};
    if (!target.sessionId) continue;
    if (onlySessionIds && !onlySessionIds.has(String(target.sessionId))) continue;
    const payload = apply.payload || {};
    const cursor = payload.summaryCursor || {};
    conversations[target.sessionId] = {
      uii: target.uii || null,
      callSessionId: target.callSessionId || null,
      queueItemId: target.queueItemId || null,
      agentEmail: target.agentEmail || null,
      agentExtensionId: target.agentExtensionId || null,
      lastTranscriptId: cursor.lastTranscriptId || null,
      lastTranscriptAt: cursor.lastTranscriptAt || null,
      processedRowCount: cursor.processedRowCount || 0,
      summaryLength: Array.isArray(payload.summary) ? payload.summary.length : 0,
      updatedAt: applyPlan.generatedAt || new Date().toISOString(),
    };
  }
  return {
    schemaVersion: "live-coach.rolling-summary-cursor.v1",
    generatedAt: applyPlan.generatedAt || new Date().toISOString(),
    conversations,
  };
}

module.exports = {
  ROLLING_SUMMARY_TASK_ID,
  ROLLING_SUMMARY_BATCH_SCHEMA,
  ROLLING_SUMMARY_RESULT_SCHEMA,
  ROLLING_SUMMARY_APPLY_SCHEMA,
  ROLLING_SUMMARY_PAYLOAD_SCHEMA,
  applyRollingSummaryToSession,
  buildRollingSummaryApplyPlan,
  buildRollingSummaryBatchRequest,
  buildRollingSummaryCursorFromApplyPlan,
  buildRollingSummaryPrompt,
  buildRollingSummarySchema,
  mergeAppendOnlySummary,
  normalizeRollingSummaryPayload,
  normalizeRollingSummaryMemory,
  parseRollingSummaryResult,
  rollingSummaryToText,
};
