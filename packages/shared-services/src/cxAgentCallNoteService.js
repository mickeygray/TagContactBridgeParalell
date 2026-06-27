"use strict";

function cleanText(value, maxLength = 1000) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function cleanUpper(value, maxLength = 40) {
  return cleanText(value, maxLength).toUpperCase();
}

function cleanDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanList(values = [], limit = 30, maxLength = 240) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === "string"
      ? cleanText(value, maxLength)
      : cleanText(value?.text || value?.summary || value?.value || JSON.stringify(value || ""), maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function safeMetadata(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return cleanText(value, 2000);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= 4) return null;
  if (Array.isArray(value)) return value.slice(0, 80).map((item) => safeMetadata(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      const cleanKey = cleanText(key, 80);
      if (cleanKey) out[cleanKey] = safeMetadata(item, depth + 1);
    }
    return out;
  }
  return null;
}

function noteKeyFrom(input = {}) {
  const uii = cleanText(input.uii, 180);
  if (uii) return `uii:${uii}`;
  const coachSessionId = cleanText(input.coachSessionId || input.sessionId, 180);
  if (coachSessionId) return `coach:${coachSessionId}`;
  const idemKey = cleanText(input.idemKey, 260);
  if (idemKey) return `terminal:${idemKey}`;
  const queueItemId = cleanText(input.queueItemId, 180);
  const happenedAt = cleanText(input.happenedAt || input.at || "", 80);
  if (queueItemId && happenedAt) return `queue:${queueItemId}:${happenedAt}`;
  return "";
}

function hasGradeEvidence(note = {}) {
  const durationSec = Number(note.durationSec || note.metrics?.durationSec || 0);
  const summaryChars = cleanText(note.summary || note.transcriptSummary || "", 10_000).length;
  const prospectChars = Number(note.metrics?.prospectCharCount || 0);
  const transcriptCount = Number(note.metrics?.transcriptCount || 0);
  const factCount = Array.isArray(note.facts) ? note.facts.length : 0;
  const hasTranscriptArtifact = Boolean(cleanText(note.transcriptArtifactPath || "", 700));
  return (
    durationSec >= 120 &&
    (
      summaryChars >= 80 ||
      prospectChars >= 250 ||
      transcriptCount >= 2 ||
      factCount > 0 ||
      hasTranscriptArtifact
    )
  );
}

function buildAgentCallNoteFromTerminal({ row = {}, payload = {}, terminalResult = null } = {}) {
  const source = cleanText(payload.source || row.source || "cx-terminal-outbox-drain", 100);
  const note = {
    noteKey: noteKeyFrom({
      uii: payload.uii || row.uii,
      coachSessionId: payload.coachSessionId || row.coachSessionId,
      sessionId: payload.sessionId || row.sessionId,
      idemKey: payload.idemKey || row.idemKey,
      queueItemId: payload.queueItemId || row.queueItemId,
      happenedAt: payload.at || payload.outcomeAt || row.drainedAt || row.updatedAt || row.createdAt,
    }),
    idemKey: payload.idemKey || row.idemKey || null,
    uii: payload.uii || row.uii || null,
    coachSessionId: payload.coachSessionId || row.coachSessionId || null,
    sessionId: payload.sessionId || row.sessionId || null,
    queueItemId: payload.queueItemId || row.queueItemId || null,
    rail: payload.rail || row.rail || null,
    source,
    domain: cleanUpper(payload.domain || row.domain || "", 40) || null,
    caseId: cleanNumber(payload.caseId ?? row.caseId),
    externId: payload.externId || row.externId || null,
    phoneLast4: payload.phoneLast4 || row.phoneLast4 || null,
    prospectName: payload.prospectName || payload.contactName || null,
    agentEmail: cleanText(payload.agentEmail || row.agentEmail || "", 180).toLowerCase() || null,
    agentName: payload.agentName || row.agentName || null,
    agentExtensionId: payload.agentExtensionId || payload.agentExtension || null,
    happenedAt: cleanDate(payload.at || payload.outcomeAt || row.drainedAt || row.updatedAt || row.createdAt) || new Date(),
    durationSec: cleanNumber(payload.durationSec ?? payload.durationSeconds ?? row.durationSec),
    outcome: payload.outcome || payload.terminalOutcome || row.outcome || null,
    terminalOutcome: payload.terminalOutcome || payload.outcome || row.outcome || null,
    summary: payload.callSummary || payload.summary || payload.activityNote || payload.note || null,
    transcriptSummary: payload.transcriptSummary || payload.callSummary || payload.summary || null,
    nextStep: payload.nextStep || payload.nextAction || null,
    transcriptArtifactPath: payload.transcriptArtifactPath || null,
    contextKeys: cleanList(payload.contextKeys, 40, 100),
    facts: Array.isArray(payload.facts) ? payload.facts.slice(0, 40) : [],
    coachSuggestions: cleanList(payload.coachSuggestions, 40, 700),
    metrics: payload.metrics || {},
    // Terminal drain writes source material only. Nightly grading is the single
    // writer for grade output, so stale inline payload grades cannot hitchhike
    // through replayed terminal rows.
    grade: null,
    terminalResult,
    metadata: {
      terminalStatus: terminalResult?.status || terminalResult?.outcome || null,
      terminalSource: source,
      hasCallSummary: Boolean(payload.callSummary || payload.summary),
      hasTranscriptArtifact: Boolean(payload.transcriptArtifactPath),
      rollingSummary: safeMetadata(payload.rollingSummary || payload.codexRollingSummary || null),
    },
    lastNoteSource: source,
  };
  note.gradeCandidate = hasGradeEvidence(note);
  note.gradeSkippedReason = note.gradeCandidate ? null : "insufficient-call-note-evidence";
  return note;
}

function buildAgentCallNoteFromCloseout(closeout = {}) {
  const metadata = closeout.metadata || {};
  const metrics = closeout.metrics || {};
  const sparse = closeout.sparse || {};
  const note = {
    noteKey: noteKeyFrom({
      uii: metadata.uii,
      coachSessionId: closeout.sessionId,
      queueItemId: metadata.queueItemId,
      happenedAt: closeout.createdAt,
    }),
    idemKey: metadata.uii ? `${metadata.queueItemId || closeout.sessionId || "coach"}:${metadata.uii}` : null,
    uii: metadata.uii || null,
    coachSessionId: closeout.sessionId || null,
    sessionId: closeout.sessionId || null,
    queueItemId: metadata.queueItemId || null,
    rail: "live_coach",
    source: "live-coach-closeout",
    domain: cleanUpper(metadata.domain || "", 40) || null,
    caseId: cleanNumber(metadata.caseId),
    phoneLast4: cleanText(metadata.phone || "", 80).replace(/\D/g, "").slice(-4) || null,
    prospectName: metadata.contactName || null,
    agentEmail: cleanText(metadata.agentEmail || "", 180).toLowerCase() || null,
    agentName: metadata.agentName || null,
    agentExtensionId: metadata.agentExtension || null,
    happenedAt: cleanDate(closeout.createdAt) || new Date(),
    durationSec: cleanNumber(sparse.durationSec ?? metrics.durationSec),
    outcome: sparse.outcome || null,
    terminalOutcome: sparse.outcome || null,
    summary: closeout.callSummary || sparse.text || "",
    transcriptSummary: closeout.callSummary || sparse.text || "",
    nextStep: sparse.nextStep || "",
    transcriptArtifactPath: closeout.artifactPath || "",
    contextKeys: cleanList(closeout.contextKeys, 40, 100),
    facts: Array.isArray(closeout.facts) ? closeout.facts.slice(0, 40) : [],
    coachSuggestions: cleanList(closeout.agentFeedback?.recentProspectSnippets, 12, 300),
    metrics,
    // Closeout notes are source material for nightly grading. Do not persist
    // inline/legacy grades here; nightly is the single writer for grade output.
    grade: null,
    metadata: {
      closeoutId: closeout.id || null,
      closeoutReason: closeout.reason || null,
      skipReason: closeout.skipReason || null,
      artifactPath: closeout.artifactPath || null,
      rollingSummary: safeMetadata(closeout.rollingSummary || null),
    },
    lastNoteSource: "live-coach-closeout",
  };
  note.gradeCandidate = hasGradeEvidence(note);
  note.gradeSkippedReason = note.gradeCandidate ? null : "insufficient-call-note-evidence";
  return note;
}

async function writeAgentCallNoteFromTerminal(input = {}, deps = {}) {
  if (!deps.agentCallNoteRepository?.upsertCallNote) {
    return { skipped: true, reason: "agent-call-note-repository-unavailable" };
  }
  const note = buildAgentCallNoteFromTerminal(input);
  if (!note.noteKey) return { skipped: true, reason: "missing-note-key" };
  const saved = await deps.agentCallNoteRepository.upsertCallNote(note);
  return { skipped: false, noteKey: note.noteKey, gradeCandidate: note.gradeCandidate, saved };
}

async function writeAgentCallNoteFromCloseout(closeout = {}, deps = {}) {
  if (!deps.agentCallNoteRepository?.upsertCallNote) {
    return { skipped: true, reason: "agent-call-note-repository-unavailable" };
  }
  const note = buildAgentCallNoteFromCloseout(closeout);
  if (!note.noteKey) return { skipped: true, reason: "missing-note-key" };
  const saved = await deps.agentCallNoteRepository.upsertCallNote(note);
  return { skipped: false, noteKey: note.noteKey, gradeCandidate: note.gradeCandidate, saved };
}

module.exports = {
  buildAgentCallNoteFromCloseout,
  buildAgentCallNoteFromTerminal,
  hasGradeEvidence,
  noteKeyFrom,
  writeAgentCallNoteFromCloseout,
  writeAgentCallNoteFromTerminal,
};
