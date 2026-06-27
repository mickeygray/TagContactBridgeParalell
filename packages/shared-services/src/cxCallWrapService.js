"use strict";

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || null;
}

function cleanMultilineText(value, maxLength = 1800) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => cleanText(line, 500))
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength) || null;
}

function cleanUpper(value, maxLength = 40) {
  const clean = cleanText(value, maxLength);
  return clean ? clean.toUpperCase() : null;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toPlainRecord(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : safeObject(value);
}

function sanitizeMetadataValue(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return value.trim().slice(0, 2000);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= 4) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizeMetadataValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      const cleanKey = String(key || "").trim().slice(0, 80);
      if (!cleanKey) continue;
      out[cleanKey] = sanitizeMetadataValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

function normalizeActor(input = {}) {
  const actor = safeObject(input.actor || input.user || {});
  const actorEmail = cleanText(
    actor.actorEmail || actor.email || input.actorEmail || input.agentEmail || "",
    180,
  );
  const actorName = cleanText(
    actor.actorName || actor.name || input.actorName || input.agentName || actorEmail || "",
    180,
  );
  return {
    actorEmail,
    actorName,
  };
}

function hasCommunicationThreadKey(caseProfile, threadKey) {
  const key = cleanText(threadKey, 220);
  if (!key || !caseProfile) return false;
  const plain = toPlainRecord(caseProfile);
  return (Array.isArray(plain.communications) ? plain.communications : [])
    .some((entry) => cleanText(entry?.threadKey, 220) === key);
}

function buildCxCallWrapThreadKey(input = {}) {
  const explicit = cleanText(input.threadKey, 220);
  if (explicit) return explicit;

  const uii = cleanText(input.uii || input.telephonySessionId || input.callSessionId, 180);
  if (uii) return `cx-call:${uii}`;

  const coachSessionId = cleanText(input.coachSessionId || input.sessionId, 180);
  if (coachSessionId) return `live-coach:${coachSessionId}`;

  const interviewSnapshotWorkflowId = cleanText(input.interviewSnapshotWorkflowId, 180);
  if (interviewSnapshotWorkflowId) return `cx-interview:${interviewSnapshotWorkflowId}`;

  const queueItemId = cleanText(input.queueItemId || input.queueTicketId, 180);
  if (queueItemId) {
    const stamp = cleanText(input.outcomeAt || input.happenedAt || input.at || "", 80) || "summary";
    return `cx-call:${queueItemId}:${stamp}`;
  }

  return null;
}

function summarizeInterviewSnapshot(snapshot = {}) {
  const value = safeObject(snapshot);
  const lines = [];
  for (const [key, raw] of Object.entries(value).slice(0, 10)) {
    const label = cleanText(key, 60);
    if (!label) continue;
    let text = "";
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      text = cleanText(raw, 160) || "";
    } else if (Array.isArray(raw)) {
      text = raw.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 4).join(", ");
    } else if (raw && typeof raw === "object") {
      text = Object.keys(raw).slice(0, 6).join(", ");
    }
    if (text) lines.push(`${label}: ${text}`);
    if (lines.length >= 6) break;
  }
  return lines;
}

function normalizeCxCallWrapPacket(input = {}) {
  const domain = cleanUpper(input.domain || input.queueDomain || input.company);
  const caseId = positiveNumber(input.caseId ?? input.CaseID);
  const actor = normalizeActor(input);
  const happenedAt = parseDateOrNull(input.happenedAt || input.outcomeAt || input.updatedAt || input.at) || new Date();
  const durationSec = positiveNumber(input.durationSec ?? input.durationSeconds);
  const interviewSnapshot = sanitizeMetadataValue(input.interviewSnapshot || input.snapshot || null);
  const grade = sanitizeMetadataValue(input.grade || input.callGrade || null);
  const facts = sanitizeMetadataValue(Array.isArray(input.facts) ? input.facts.slice(0, 20) : []);
  const contextKeys = Array.isArray(input.contextKeys)
    ? input.contextKeys.map((key) => cleanText(key, 80)).filter(Boolean).slice(0, 20)
    : [];

  return {
    domain,
    caseId,
    actor,
    threadKey: buildCxCallWrapThreadKey(input),
    source: cleanText(input.source || "cx-call-wrap", 80),
    provider: cleanText(input.provider || input.source || "cx-call-wrap", 80),
    subject: cleanText(input.subject || "CX call summary", 120) || "CX call summary",
    status: cleanText(input.terminalOutcome || input.outcome || input.status || "completed", 80) || "completed",
    terminalOutcome: cleanText(input.terminalOutcome || input.outcome || input.status || "", 80),
    phone: cleanText(input.phone || input.prospectPhone || input.contactPhone || "", 80),
    prospectName: cleanText(input.prospectName || input.contactName || "", 160),
    summary: cleanMultilineText(
      input.summary || input.callSummary || input.activityNote || input.note || input.comment || "",
      1800,
    ),
    nextStep: cleanText(input.nextStep || input.nextAction || "", 300),
    interviewNote: cleanMultilineText(input.interviewNote || input.interviewSummary || "", 900),
    callStrategy: cleanMultilineText(input.callStrategy || "", 1400),
    happenedAt,
    durationSec,
    uii: cleanText(input.uii || input.telephonySessionId || input.callSessionId || "", 180),
    queueItemId: cleanText(input.queueItemId || input.queueTicketId || "", 180),
    coachSessionId: cleanText(input.coachSessionId || input.sessionId || "", 180),
    interviewSnapshotWorkflowId: cleanText(input.interviewSnapshotWorkflowId || input.workflowId || "", 180),
    transcriptArtifactPath: cleanText(input.transcriptArtifactPath || "", 500),
    contextKeys,
    facts,
    grade,
    metrics: sanitizeMetadataValue(input.metrics || null),
    rollingSummary: sanitizeMetadataValue(input.rollingSummary || input.codexRollingSummary || null),
    interviewSnapshot,
    metadata: sanitizeMetadataValue(input.metadata || null),
  };
}

function buildCxCallWrapBody(packet = {}, options = {}) {
  const lines = [];
  if (packet.summary) lines.push(packet.summary);
  if (packet.interviewNote && packet.interviewNote !== packet.summary) lines.push(`Interview: ${packet.interviewNote}`);

  const snapshotLines = summarizeInterviewSnapshot(packet.interviewSnapshot);
  if (snapshotLines.length && options.includeInterviewSnapshotInBody !== false) {
    lines.push("Interview details:");
    lines.push(...snapshotLines.map((line) => `- ${line}`));
  }

  if (packet.nextStep) lines.push(`Next step: ${packet.nextStep}`);
  if (packet.terminalOutcome) lines.push(`Outcome: ${packet.terminalOutcome}`);
  if (!lines.length && options.allowSparse !== false) {
    lines.push("CX call completed. Summary details pending.");
  }
  return lines.join("\n").trim();
}

function buildCxCallWrapMetadata(packet = {}) {
  return {
    sessionId: packet.coachSessionId || null,
    uii: packet.uii || null,
    queueItemId: packet.queueItemId || null,
    durationSec: packet.durationSec || null,
    durationSeconds: packet.durationSec || null,
    transcriptArtifactPath: packet.transcriptArtifactPath || null,
    contextKeys: packet.contextKeys || [],
    facts: packet.facts || [],
    grade: packet.grade || null,
    rollingSummary: packet.rollingSummary || null,
    metrics: packet.metrics || null,
    interviewSnapshotWorkflowId: packet.interviewSnapshotWorkflowId || null,
    hasInterviewSnapshot: Boolean(packet.interviewSnapshot),
    interviewSnapshot: packet.interviewSnapshot || null,
    callStrategy: packet.callStrategy || null,
    sourceMetadata: packet.metadata || null,
  };
}

async function writeCxCallWrapSummary(input = {}, deps = {}, options = {}) {
  const packet = normalizeCxCallWrapPacket(input);
  const body = buildCxCallWrapBody(packet, options);
  const repo = deps.caseProfileRepository || {};
  const writeLogicsActivity = deps.writeLogicsActivity;

  if (!packet.domain || !packet.caseId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-domain-or-case",
      packet,
      communication: { skipped: true, reason: "missing-domain-or-case" },
      logicsActivity: { skipped: true, reason: "missing-domain-or-case" },
    };
  }

  if (!body) {
    return {
      ok: false,
      skipped: true,
      reason: "missing-call-wrap-body",
      packet,
      communication: { skipped: true, reason: "missing-call-wrap-body" },
      logicsActivity: { skipped: true, reason: "missing-call-wrap-body" },
    };
  }

  if (packet.threadKey && typeof repo.findCaseProfile === "function") {
    const existing = await repo.findCaseProfile(packet.domain, packet.caseId).catch(() => null);
    if (hasCommunicationThreadKey(existing, packet.threadKey)) {
      return {
        ok: true,
        skipped: true,
        reason: "duplicate-thread-key",
        packet,
        communication: { skipped: true, reason: "duplicate-thread-key", threadKey: packet.threadKey },
        logicsActivity: { skipped: true, reason: "duplicate-thread-key", threadKey: packet.threadKey },
      };
    }
  }

  let communication = { skipped: true, reason: "case-profile-disabled" };
  if (options.writeCaseProfileCommunication !== false) {
    if (typeof repo.appendCommunicationEntry !== "function") {
      communication = { skipped: true, reason: "case-profile-repository-unavailable" };
    } else {
      try {
        const profile = await repo.appendCommunicationEntry(packet.domain, packet.caseId, "call", {
          direction: "outbound",
          status: packet.status,
          provider: packet.provider,
          threadKey: packet.threadKey || null,
          phone: packet.phone,
          subject: packet.subject,
          body,
          actorEmail: packet.actor.actorEmail,
          actorName: packet.actor.actorName,
          happenedAt: packet.happenedAt,
          source: packet.source,
          metadata: buildCxCallWrapMetadata(packet),
        });
        communication = {
          skipped: false,
          caseProfileId: profile?._id ? String(profile._id) : null,
          threadKey: packet.threadKey || null,
        };
      } catch (error) {
        deps.logger?.warn?.("cx_call_wrap.case_profile_failed", {
          domain: packet.domain,
          caseId: packet.caseId,
          threadKey: packet.threadKey,
          error: error.message,
        });
        return {
          ok: false,
          skipped: false,
          reason: "case-profile-write-failed",
          packet,
          communication: { skipped: false, ok: false, error: error.message },
          logicsActivity: { skipped: true, reason: "case-profile-write-failed" },
        };
      }
    }
  }

  let logicsActivity = { skipped: true, reason: "disabled" };
  if (options.writeLogicsActivity !== false) {
    if (typeof writeLogicsActivity !== "function") {
      logicsActivity = { skipped: true, reason: "logics-writer-unavailable" };
    } else {
      try {
        logicsActivity = await writeLogicsActivity(packet.domain, packet.actor, {
          caseId: packet.caseId,
          subject: packet.subject,
          activityType: options.logicsActivityType || input.activityType || "General",
          note: body,
          source: packet.source,
          metadata: buildCxCallWrapMetadata(packet),
        });
      } catch (error) {
        deps.logger?.warn?.("cx_call_wrap.logics_failed", {
          domain: packet.domain,
          caseId: packet.caseId,
          threadKey: packet.threadKey,
          error: error.message,
        });
        logicsActivity = { ok: false, error: error.message, details: error.details || null };
      }
    }
  }

  return {
    ok: true,
    skipped: false,
    packet,
    body,
    communication,
    logicsActivity,
  };
}

module.exports = {
  buildCxCallWrapBody,
  buildCxCallWrapMetadata,
  buildCxCallWrapThreadKey,
  hasCommunicationThreadKey,
  normalizeCxCallWrapPacket,
  writeCxCallWrapSummary,
};
