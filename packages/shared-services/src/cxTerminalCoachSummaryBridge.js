"use strict";

const {
  normalizeRollingSummaryPayload,
  rollingSummaryToText,
} = require("./liveCoachRollingSummaryService");

function cleanText(value, maxLength = 500) {
  return String(value == null ? "" : value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function readRollingSummaryFromSession(session = {}) {
  const latest = session.latest || {};
  const memory = session.memory || {};
  return latest.rollingSummary || memory.rollingSummary || null;
}

function normalizeBridgeSummary(input = {}) {
  const candidate =
    input.rollingSummary ||
    input.codexRollingSummary ||
    input.callMemory ||
    input.coachRollingSummary ||
    null;
  if (!candidate) return null;
  const summary = normalizeRollingSummaryPayload(candidate);
  if (!Array.isArray(summary.summary) || !summary.summary.length) return null;
  return summary;
}

function summaryFactsForPayload(summary = {}) {
  const facts = [];
  for (const text of Array.isArray(summary.factsCaptured) ? summary.factsCaptured : []) {
    if (text) facts.push({ kind: "fact", text });
  }
  for (const text of Array.isArray(summary.taxIssues) ? summary.taxIssues : []) {
    if (text) facts.push({ kind: "tax_issue", text });
  }
  return facts.slice(0, 40);
}

function summaryContextKeys(summary = {}) {
  const keys = [];
  if (Array.isArray(summary.objections) && summary.objections.length) keys.push("objection");
  if (Array.isArray(summary.taxIssues) && summary.taxIssues.length) keys.push("tax_issue");
  if (Array.isArray(summary.openQuestions) && summary.openQuestions.length) keys.push("open_question");
  if (summary.nextBestFocus) keys.push("next_best_focus");
  return keys;
}

function enrichPayloadWithRollingSummary(payload = {}, summaryInput = null) {
  const summary = normalizeBridgeSummary(summaryInput || payload);
  if (!summary) return { payload, summary: null, enriched: false };
  const summaryText = cleanText(summary.summaryText || rollingSummaryToText(summary.summary), 1800);
  const existingFacts = Array.isArray(payload.facts) ? payload.facts : [];
  const existingContextKeys = Array.isArray(payload.contextKeys) ? payload.contextKeys : [];
  const nextPayload = {
    ...payload,
    rollingSummary: summary,
    callSummary: payload.callSummary || payload.summary || summaryText,
    transcriptSummary: payload.transcriptSummary || summaryText,
    summary: payload.summary || payload.callSummary || summaryText,
    nextStep: payload.nextStep || payload.nextAction || summary.nextBestFocus || "",
    facts: [...existingFacts, ...summaryFactsForPayload(summary)].slice(0, 60),
    contextKeys: [...new Set([...existingContextKeys, ...summaryContextKeys(summary)])].slice(0, 40),
    coachSessionId: payload.coachSessionId || summary.sessionId || payload.sessionId || null,
    metadata: {
      ...(payload.metadata || {}),
      rollingSummary: {
        schemaVersion: summary.schemaVersion,
        generatedAt: summary.generatedAt,
        summaryLength: summary.summary.length,
        sourceTranscriptIds: summary.sourceTranscriptIds || [],
        confidence: summary.confidence || null,
      },
    },
  };
  return { payload: nextPayload, summary, enriched: true };
}

async function loadRollingSummaryForTerminalPayload(payload = {}, deps = {}) {
  const embedded = normalizeBridgeSummary(payload);
  if (embedded) return { summary: embedded, source: "payload" };
  const coachSessionId = cleanText(payload.coachSessionId || payload.sessionId, 180);
  if (!coachSessionId || !deps.LiveCoachSession?.findById) {
    return { summary: null, source: "none", reason: coachSessionId ? "live-coach-session-model-unavailable" : "missing-coach-session-id" };
  }
  const doc = await deps.LiveCoachSession.findById(coachSessionId).lean().exec().catch((error) => {
    deps.logger?.warn?.("cx_terminal_summary_bridge.live_coach_lookup_failed", {
      coachSessionId,
      error: error.message,
    });
    return null;
  });
  const fromSession = readRollingSummaryFromSession(doc || {});
  const summary = normalizeBridgeSummary({ rollingSummary: fromSession });
  if (!summary) return { summary: null, source: "livecoach_sessions", reason: "missing-rolling-summary" };
  return { summary, source: "livecoach_sessions" };
}

async function enrichTerminalPacketWithCoachSummary(packet = {}, deps = {}) {
  const payload = packet.payload || {};
  const lookup = await loadRollingSummaryForTerminalPayload(payload, deps);
  if (!lookup.summary) {
    return {
      ...packet,
      coachSummary: { skipped: true, reason: lookup.reason || "missing-rolling-summary", source: lookup.source },
    };
  }
  const enriched = enrichPayloadWithRollingSummary(payload, { rollingSummary: lookup.summary });
  return {
    ...packet,
    payload: enriched.payload,
    coachSummary: {
      skipped: false,
      source: lookup.source,
      summaryLength: lookup.summary.summary.length,
      generatedAt: lookup.summary.generatedAt || null,
    },
  };
}

module.exports = {
  enrichPayloadWithRollingSummary,
  enrichTerminalPacketWithCoachSummary,
  loadRollingSummaryForTerminalPayload,
  readRollingSummaryFromSession,
};
