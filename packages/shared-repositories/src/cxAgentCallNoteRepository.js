"use strict";

const { CxAgentCallNote } = require("../../shared-models/src");

function cleanString(value, maxLength = 1000) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanStringArray(values = [], limit = 30, maxLength = 240) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanString(value, maxLength);
    const key = String(text || "").toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
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

function cleanMixed(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "object") return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeCallNote(note = {}) {
  const noteKey = cleanString(note.noteKey, 260);
  if (!noteKey) throw new Error("cxAgentCallNoteRepository.upsertCallNote requires noteKey");
  const durationSec = cleanNumber(note.durationSec);
  const caseId = cleanNumber(note.caseId);
  return {
    noteKey,
    idemKey: cleanString(note.idemKey, 260),
    uii: cleanString(note.uii, 180),
    coachSessionId: cleanString(note.coachSessionId, 180),
    sessionId: cleanString(note.sessionId, 180),
    queueItemId: cleanString(note.queueItemId, 180),
    rail: cleanString(note.rail, 80),
    source: cleanString(note.source, 100),
    domain: cleanString(note.domain, 40)?.toUpperCase() || null,
    caseId: caseId != null ? caseId : null,
    externId: cleanString(note.externId, 220),
    phoneLast4: cleanString(note.phoneLast4, 12),
    prospectName: cleanString(note.prospectName, 180),
    agentEmail: cleanString(note.agentEmail, 180)?.toLowerCase() || null,
    agentName: cleanString(note.agentName, 180),
    agentExtensionId: cleanString(note.agentExtensionId || note.agentExtension, 80),
    happenedAt: cleanDate(note.happenedAt),
    durationSec: durationSec != null ? durationSec : null,
    outcome: cleanString(note.outcome, 80),
    terminalOutcome: cleanString(note.terminalOutcome || note.outcome, 80),
    summary: cleanString(note.summary, 4000),
    transcriptSummary: cleanString(note.transcriptSummary || note.summary, 4000),
    nextStep: cleanString(note.nextStep, 500),
    transcriptArtifactPath: cleanString(note.transcriptArtifactPath || note.artifactPath, 700),
    contextKeys: cleanStringArray(note.contextKeys, 40, 100),
    facts: cleanMixed(Array.isArray(note.facts) ? note.facts.slice(0, 40) : [], []),
    coachSuggestions: cleanStringArray(note.coachSuggestions, 40, 700),
    metrics: cleanMixed(note.metrics, {}),
    grade: cleanMixed(note.grade, null),
    gradeCandidate: note.gradeCandidate === true,
    gradeStatus: cleanString(note.gradeStatus, 40) || "pending",
    gradeSkippedReason: cleanString(note.gradeSkippedReason, 200),
    gradedAt: cleanDate(note.gradedAt),
    terminalResult: cleanMixed(note.terminalResult, null),
    metadata: cleanMixed(note.metadata, {}),
    lastNoteSource: cleanString(note.lastNoteSource || note.source, 100),
  };
}

async function upsertCallNote(note = {}) {
  const normalized = normalizeCallNote(note);
  const set = { ...normalized };
  delete set.noteKey;
  return CxAgentCallNote.findOneAndUpdate(
    { noteKey: normalized.noteKey },
    {
      $set: set,
      $setOnInsert: {
        noteKey: normalized.noteKey,
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  ).lean();
}

async function listNightlyGradeCandidates({
  from,
  to,
  agentEmail = null,
  minDurationSec = 120,
  limit = 500,
} = {}) {
  const query = {
    gradeCandidate: true,
    gradeStatus: { $in: ["pending", "queued", "failed"] },
  };
  const start = cleanDate(from);
  const end = cleanDate(to);
  if (start || end) {
    query.happenedAt = {};
    if (start) query.happenedAt.$gte = start;
    if (end) query.happenedAt.$lt = end;
  }
  if (agentEmail) query.agentEmail = cleanString(agentEmail, 180)?.toLowerCase();
  if (Number.isFinite(Number(minDurationSec)) && Number(minDurationSec) > 0) {
    query.durationSec = { $gte: Number(minDurationSec) };
  }
  return CxAgentCallNote.find(query)
    .sort({ agentEmail: 1, happenedAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 500, 2000)))
    .lean();
}

async function markGradeStatus(noteKey, status, patch = {}) {
  const key = cleanString(noteKey, 260);
  const cleanStatus = cleanString(status, 40);
  if (!key || !cleanStatus) return null;
  const update = {
    gradeStatus: cleanStatus,
    gradeSkippedReason: cleanString(patch.gradeSkippedReason || patch.reason, 200),
  };
  if (patch.grade) update.grade = cleanMixed(patch.grade, null);
  if (cleanStatus === "graded") update.gradedAt = patch.gradedAt ? cleanDate(patch.gradedAt) : new Date();
  return CxAgentCallNote.findOneAndUpdate({ noteKey: key }, { $set: update }, { new: true }).lean();
}

module.exports = {
  listNightlyGradeCandidates,
  markGradeStatus,
  normalizeCallNote,
  upsertCallNote,
};
