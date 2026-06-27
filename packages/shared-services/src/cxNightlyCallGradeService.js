"use strict";

const TASK_ID = "liveCoach.callGrader";
const TASK_SCHEMA = "cx.nightly-call-grade-task.v1";
const RESULT_SCHEMA = "cx.nightly-call-grade-result.v1";

function cleanText(value, maxLength = 1000) {
  const text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : "";
}

function cleanLower(value, maxLength = 1000) {
  return cleanText(value, maxLength).toLowerCase();
}

function cleanNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampScore(value, fallback = 0) {
  const number = cleanNumber(value, fallback);
  return Math.max(0, Math.min(100, Math.round(number)));
}

function cleanList(values = [], limit = 10, maxLength = 300) {
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

function cleanFacts(values = []) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      if (typeof value === "string") return { text: cleanText(value, 260) };
      if (!value || typeof value !== "object") return null;
      const text = cleanText(value.text || value.summary || value.value || "", 260);
      const kind = cleanText(value.kind || value.type || value.key || "", 80);
      return text ? { ...(kind ? { kind } : {}), text } : null;
    })
    .filter(Boolean)
    .slice(0, 40);
}

function cleanEmail(value) {
  return cleanLower(value, 180);
}

function cleanDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoOrNull(value) {
  const date = cleanDate(value);
  return date ? date.toISOString() : null;
}

function summarizeRollingText(rollingSummary) {
  if (!rollingSummary || typeof rollingSummary !== "object") return "";
  const parts = [
    cleanText(rollingSummary.summaryText, 2400),
    ...(Array.isArray(rollingSummary.summary)
      ? rollingSummary.summary.map((row) => cleanText(row?.text, 400))
      : []),
  ].filter(Boolean);
  return parts.join(" ");
}

function readRollingSummary(note = {}) {
  const summary = note.metadata?.rollingSummary || note.rollingSummary || null;
  if (!summary || typeof summary !== "object") return null;
  return {
    summaryText: cleanText(summary.summaryText, 3000),
    summary: Array.isArray(summary.summary)
      ? summary.summary
        .map((entry) => ({
          sequence: cleanNumber(entry?.sequence, 0),
          kind: cleanText(entry?.kind || "call_progress", 80),
          text: cleanText(entry?.text, 500),
          sourceTranscriptIds: cleanList(entry?.sourceTranscriptIds, 12, 160),
        }))
        .filter((entry) => entry.text)
        .slice(0, 80)
      : [],
    factsCaptured: cleanList(summary.factsCaptured, 20, 260),
    openQuestions: cleanList(summary.openQuestions, 20, 260),
    objections: cleanList(summary.objections, 20, 260),
    taxIssues: cleanList(summary.taxIssues, 20, 260),
    nextBestFocus: cleanText(summary.nextBestFocus, 400),
    confidence: cleanText(summary.confidence, 80),
  };
}

function hasEnoughGradeEvidence(note = {}, options = {}) {
  if (note.gradeCandidate !== true) return false;
  const minDurationSec = cleanNumber(options.minDurationSec, 0);
  const minSummaryChars = cleanNumber(options.minSummaryChars, 80);
  const durationSec = cleanNumber(note.durationSec, 0);
  const summaryText = cleanText(note.transcriptSummary || note.summary, 10000);
  const factCount = Array.isArray(note.facts) ? note.facts.length : 0;
  const rolling = readRollingSummary(note);
  const rollingChars = cleanText(rolling?.summaryText || "", 10000).length +
    (rolling?.summary || []).reduce((sum, row) => sum + row.text.length, 0);
  return (
    durationSec >= minDurationSec &&
    (
      summaryText.length >= minSummaryChars ||
      rollingChars >= minSummaryChars ||
      factCount > 0 ||
      cleanText(note.transcriptArtifactPath, 700)
    )
  );
}

function buildCallGradeTaskPacket(note = {}, options = {}) {
  const noteKey = cleanText(note.noteKey, 260);
  if (!noteKey) throw new Error("buildCallGradeTaskPacket requires note.noteKey");
  const generatedAt = cleanText(options.generatedAt || new Date().toISOString(), 80);
  const rollingSummary = readRollingSummary(note);
  return {
    schemaVersion: TASK_SCHEMA,
    taskId: TASK_ID,
    idempotencyKey: `call-grade:${noteKey}`,
    generatedAt,
    noteKey,
    call: {
      domain: cleanText(note.domain, 40).toUpperCase() || null,
      caseId: cleanNumber(note.caseId),
      queueItemId: cleanText(note.queueItemId, 180) || null,
      uii: cleanText(note.uii, 180) || null,
      coachSessionId: cleanText(note.coachSessionId || note.sessionId, 180) || null,
      prospectName: cleanText(note.prospectName, 180) || null,
      agentEmail: cleanLower(note.agentEmail, 180) || null,
      agentName: cleanText(note.agentName, 180) || null,
      agentExtensionId: cleanText(note.agentExtensionId, 80) || null,
      happenedAt: note.happenedAt || null,
      durationSec: cleanNumber(note.durationSec, 0),
      outcome: cleanText(note.outcome || note.terminalOutcome, 80) || null,
      source: cleanText(note.source, 120) || null,
    },
    evidence: {
      summary: cleanText(note.summary, 4000),
      transcriptSummary: cleanText(note.transcriptSummary || note.summary, 4000),
      rollingSummary,
      nextStep: cleanText(note.nextStep, 500),
      contextKeys: cleanList(note.contextKeys, 40, 100),
      facts: cleanFacts(note.facts),
      coachSuggestions: cleanList(note.coachSuggestions, 40, 700),
      metrics: note.metrics && typeof note.metrics === "object" ? note.metrics : {},
      transcriptArtifactPath: cleanText(note.transcriptArtifactPath, 700) || null,
    },
    instructions: {
      outputSchema: RESULT_SCHEMA,
      noSideEffects: true,
      doNotEmail: true,
      doNotWriteLogics: true,
      gradeOnlyWhatEvidenceSupports: true,
    },
  };
}

function buildCallGradePrompt(packet = {}) {
  return {
    system: [
      "You are grading a tax sales call from a durable after-hours call note.",
      "Use only the evidence in the JSON packet. Do not invent tax facts, dollar amounts, notices, or outcomes.",
      "Return JSON only. Do not send email, write Logics, or mutate anything.",
      "If evidence is thin, grade what is observable and say the limitation plainly.",
    ].join("\n"),
    prompt: [
      "Grade this call note.",
      "",
      "Return this JSON shape:",
      JSON.stringify({
        schemaVersion: RESULT_SCHEMA,
        overallScore: 0,
        verdict: "",
        callPhaseReached: "",
        outcome: "",
        scores: {
          rapport: 0,
          discovery: 0,
          control: 0,
          taxComprehension: 0,
          salesPivot: 0,
          compliance: 0,
          close: 0,
        },
        whatWorked: [],
        missedOpportunities: [],
        coachingNotes: [],
        nextCallFocus: [],
        riskFlags: [],
        factsCaptured: [],
        summaryForAgent: "",
      }, null, 2),
      "",
      "Call grade packet:",
      JSON.stringify(packet, null, 2),
    ].join("\n"),
  };
}

function buildCallGradeAiTaskPayload(packet = {}) {
  const evidence = packet.evidence && typeof packet.evidence === "object" ? packet.evidence : {};
  const call = packet.call && typeof packet.call === "object" ? packet.call : {};
  const rollingText = summarizeRollingText(evidence.rollingSummary);
  const sparseSummary = cleanText(
    evidence.transcriptSummary ||
      evidence.summary ||
      rollingText ||
      evidence.nextStep ||
      "",
    3200,
  );
  return {
    input: JSON.stringify({
      metadata: {
        schemaVersion: packet.schemaVersion || TASK_SCHEMA,
        noteKey: packet.noteKey || null,
        idempotencyKey: packet.idempotencyKey || null,
        generatedAt: packet.generatedAt || null,
        agentEmail: call.agentEmail || null,
        agentName: call.agentName || null,
        prospectName: call.prospectName || null,
        domain: call.domain || null,
        caseId: call.caseId || null,
        queueItemId: call.queueItemId || null,
        uii: call.uii || null,
      },
      outcome: call.outcome || null,
      durationSec: cleanNumber(call.durationSec, 0),
      sparseSummary,
      transcriptRows: [],
      selectedContexts: [],
      contextKeys: Array.isArray(evidence.contextKeys) ? evidence.contextKeys : [],
      facts: (Array.isArray(evidence.facts) ? evidence.facts : [])
        .map((fact) => cleanText(fact?.text || fact?.value || fact, 220))
        .filter(Boolean),
      coachSuggestions: Array.isArray(evidence.coachSuggestions) ? evidence.coachSuggestions : [],
      priorCallSummary: rollingText,
      counters: evidence.metrics && typeof evidence.metrics === "object" ? evidence.metrics : {},
    }),
  };
}

function normalizeCallGradeResult(result = {}) {
  const value = result?.grade && typeof result.grade === "object" ? result.grade : result;
  if (!value || typeof value !== "object") {
    throw new Error("call grade result must be an object");
  }
  const scores = value.scores && typeof value.scores === "object" ? value.scores : {};
  const grade = {
    schemaVersion: RESULT_SCHEMA,
    overallScore: clampScore(value.overallScore ?? value.score, 0),
    verdict: cleanText(value.verdict || value.summary, 700),
    callPhaseReached: cleanText(value.callPhaseReached || value.phase, 120),
    outcome: cleanText(value.outcome, 120),
    scores: {
      rapport: clampScore(scores.rapport ?? scores.empathy, 0),
      discovery: clampScore(scores.discovery, 0),
      control: clampScore(scores.control ?? scores.callControl, 0),
      taxComprehension: clampScore(scores.taxComprehension ?? scores.taxUnderstanding, 0),
      salesPivot: clampScore(scores.salesPivot ?? scores.offerBuilding, 0),
      compliance: clampScore(scores.compliance, 0),
      close: clampScore(scores.close ?? scores.nextStep, 0),
    },
    whatWorked: cleanList(value.whatWorked || value.strengths, 8, 260),
    missedOpportunities: cleanList(value.missedOpportunities || value.opportunities, 8, 280),
    coachingNotes: cleanList(value.coachingNotes || value.notes, 10, 320),
    nextCallFocus: cleanList(value.nextCallFocus || value.nextSteps, 6, 260),
    riskFlags: cleanList(value.riskFlags || value.complianceFlags, 6, 220),
    factsCaptured: cleanList(value.factsCaptured || value.keyFacts, 10, 240),
    summaryForAgent: cleanText(value.summaryForAgent || value.agentSummary, 1000),
  };
  if (!grade.verdict && !grade.summaryForAgent) {
    grade.verdict = "Score-only grade returned; review evidence manually.";
  }
  return grade;
}

async function applyCallGradeResult(noteKey, result, repository) {
  if (!repository || typeof repository.markGradeStatus !== "function") {
    throw new Error("applyCallGradeResult requires repository.markGradeStatus");
  }
  const key = cleanText(noteKey, 260);
  if (!key) throw new Error("applyCallGradeResult requires noteKey");
  const grade = normalizeCallGradeResult(result);
  return repository.markGradeStatus(key, "graded", {
    grade,
    gradedAt: new Date(),
    gradeSkippedReason: null,
  });
}

async function markCallGradeFailure(noteKey, error, repository) {
  if (!repository || typeof repository.markGradeStatus !== "function") {
    throw new Error("markCallGradeFailure requires repository.markGradeStatus");
  }
  const key = cleanText(noteKey, 260);
  if (!key) throw new Error("markCallGradeFailure requires noteKey");
  return repository.markGradeStatus(key, "failed", {
    reason: cleanText(error?.message || error || "call-grade-failed", 200),
  });
}

function buildNightlyCallGradeReport(notes = [], options = {}) {
  const rows = (Array.isArray(notes) ? notes : []).map((note) => {
    const packet = note?.noteKey ? buildCallGradeTaskPacket(note, options) : null;
    return {
      noteKey: note?.noteKey || null,
      eligible: Boolean(packet && hasEnoughGradeEvidence(note, options)),
      idempotencyKey: packet?.idempotencyKey || null,
      agentEmail: packet?.call.agentEmail || null,
      durationSec: packet?.call.durationSec || 0,
      evidenceChars: packet
        ? JSON.stringify(packet.evidence).length
        : 0,
    };
  });
  return {
    schemaVersion: "cx.nightly-call-grade-report.v1",
    generatedAt: cleanText(options.generatedAt || new Date().toISOString(), 80),
    count: rows.length,
    eligibleCount: rows.filter((row) => row.eligible).length,
    rows,
  };
}

function groupNotesByAgent(notes = []) {
  const groups = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const agentEmail = cleanEmail(note?.agentEmail) || "unknown-agent";
    if (!groups.has(agentEmail)) groups.set(agentEmail, []);
    groups.get(agentEmail).push(note);
  }
  return [...groups.entries()].map(([agentEmail, rows]) => ({ agentEmail, rows }));
}

function rowLabel(row = {}) {
  const note = row.note || {};
  const name = cleanText(note.prospectName || "Unknown prospect", 120);
  const duration = cleanNumber(note.durationSec, 0);
  const outcome = cleanText(note.outcome || note.terminalOutcome || "unknown", 80);
  const score = row.grade ? cleanNumber(row.grade.overallScore, 0) : null;
  const scoreText = score == null ? "" : ` | score ${score}`;
  return `${name} | ${duration}s | ${outcome} | ${row.status}${scoreText}`;
}

function buildNightlyCallGradeEmail({ agentEmail, rows = [], generatedAt, from, to } = {}) {
  const cleanAgent = cleanEmail(agentEmail) || "unknown-agent";
  const graded = rows.filter((row) => row.status === "graded");
  const failed = rows.filter((row) => row.status === "failed");
  const skipped = rows.filter((row) => row.status === "skipped");
  const subject = `[CX Grades] ${cleanAgent} - ${graded.length} graded`;
  const lines = [
    `CX nightly call grades for ${cleanAgent}`,
    `Generated: ${cleanText(generatedAt || new Date().toISOString(), 80)}`,
    `Window: ${isoOrNull(from) || "not set"} to ${isoOrNull(to) || "not set"}`,
    "",
    `Graded: ${graded.length}`,
    `Failed: ${failed.length}`,
    `Skipped: ${skipped.length}`,
    "",
    "Calls",
    "-----",
    ...rows.map((row) => `- ${rowLabel(row)}`),
  ];
  if (failed.length) {
    lines.push("", "Failures", "--------");
    for (const row of failed) {
      lines.push(`- ${cleanText(row.note?.noteKey, 180)}: ${cleanText(row.error || "failed", 220)}`);
    }
  }
  return { agentEmail: cleanAgent, subject, text: lines.join("\n"), rows };
}

async function runNightlyCallGrading(options = {}, deps = {}) {
  const repository = deps.repository;
  if (!repository || typeof repository.listNightlyGradeCandidates !== "function") {
    throw new Error("runNightlyCallGrading requires repository.listNightlyGradeCandidates");
  }
  if (!repository || typeof repository.markGradeStatus !== "function") {
    throw new Error("runNightlyCallGrading requires repository.markGradeStatus");
  }
  const dryRun = Boolean(options.dryRun);
  const runAiTask = deps.runAiTask;
  if (!dryRun && typeof runAiTask !== "function") {
    throw new Error("runNightlyCallGrading requires deps.runAiTask unless dryRun=true");
  }
  const logger = deps.logger || null;
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const generatedAt = cleanText(options.generatedAt || now().toISOString(), 80);
  const minDurationSec = Math.max(0, cleanNumber(options.minDurationSec, 120));
  const minSummaryChars = Math.max(0, cleanNumber(options.minSummaryChars, 80));
  const limit = Math.max(1, Math.min(cleanNumber(options.limit, 500), 2000));
  const from = options.from || null;
  const to = options.to || null;
  const taskTimeoutMs = Math.max(1000, cleanNumber(options.timeoutMs, 60000));
  const candidates = await repository.listNightlyGradeCandidates({
    from,
    to,
    agentEmail: options.agentEmail || null,
    minDurationSec,
    limit,
  });

  const agentGroups = groupNotesByAgent(candidates);
  const result = {
    ok: true,
    schemaVersion: "cx.nightly-call-grade-run.v1",
    generatedAt,
    from: isoOrNull(from),
    to: isoOrNull(to),
    candidateCount: candidates.length,
    agentCount: agentGroups.length,
    gradedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    emailCount: 0,
    emailFailedCount: 0,
    agents: [],
  };

  for (const group of agentGroups) {
    const agentResult = {
      agentEmail: group.agentEmail,
      candidateCount: group.rows.length,
      gradedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      email: null,
      rows: [],
    };

    for (const note of group.rows) {
      const noteKey = cleanText(note?.noteKey, 260);
      const row = {
        noteKey,
        note,
        status: "pending",
        grade: null,
        error: null,
      };
      try {
        if (!hasEnoughGradeEvidence(note, { minDurationSec, minSummaryChars })) {
          row.status = "skipped";
          row.error = "insufficient-grade-evidence";
          await repository.markGradeStatus(noteKey, "skipped", { reason: row.error });
          agentResult.skippedCount += 1;
          result.skippedCount += 1;
          agentResult.rows.push(row);
          continue;
        }

        const packet = buildCallGradeTaskPacket(note, { generatedAt });
        if (dryRun) {
          row.status = "dry-run";
          agentResult.rows.push(row);
          continue;
        }

        await repository.markGradeStatus(noteKey, "queued", { reason: null });
        const aiResult = await runAiTask(TASK_ID, buildCallGradeAiTaskPayload(packet), {
          timeoutMs: taskTimeoutMs,
          label: options.label || "nightly.call_grade",
          qualityMode: options.qualityMode || undefined,
          preferProvider: options.preferProvider || undefined,
          preferModel: options.preferModel || undefined,
          safeFallback: null,
        });
        if (!aiResult || aiResult.ok !== true) {
          const reason = cleanText(aiResult?.error || aiResult?.code || "call-grade-task-failed", 220);
          await markCallGradeFailure(noteKey, reason, repository);
          row.status = "failed";
          row.error = reason;
          agentResult.failedCount += 1;
          result.failedCount += 1;
          agentResult.rows.push(row);
          continue;
        }

        const grade = normalizeCallGradeResult(aiResult.result || aiResult.grade || aiResult);
        await applyCallGradeResult(noteKey, grade, repository);
        row.status = "graded";
        row.grade = grade;
        agentResult.gradedCount += 1;
        result.gradedCount += 1;
        agentResult.rows.push(row);
      } catch (error) {
        const message = cleanText(error?.message || error || "call-grade-error", 220);
        row.status = "failed";
        row.error = message;
        try {
          if (noteKey) await markCallGradeFailure(noteKey, message, repository);
        } catch (markError) {
          logger?.warn?.("cx.nightly_call_grade.mark_failure_failed", {
            noteKey,
            error: markError.message,
          });
        }
        agentResult.failedCount += 1;
        result.failedCount += 1;
        agentResult.rows.push(row);
      }
    }

    if (options.sendEmail && typeof deps.sendGradeEmail === "function" && agentResult.rows.length > 0) {
      const email = buildNightlyCallGradeEmail({
        agentEmail: group.agentEmail,
        rows: agentResult.rows,
        generatedAt,
        from,
        to,
      });
      try {
        agentResult.email = await deps.sendGradeEmail(email);
        result.emailCount += 1;
      } catch (error) {
        agentResult.email = { ok: false, error: cleanText(error?.message || error, 220) };
        result.emailFailedCount += 1;
        logger?.warn?.("cx.nightly_call_grade.email_failed", {
          agentEmail: group.agentEmail,
          error: agentResult.email.error,
        });
        if (options.failOnEmailError) throw error;
      }
    }

    result.agents.push(agentResult);
  }

  return result;
}

module.exports = {
  RESULT_SCHEMA,
  TASK_ID,
  TASK_SCHEMA,
  applyCallGradeResult,
  buildCallGradeAiTaskPayload,
  buildNightlyCallGradeEmail,
  buildCallGradePrompt,
  buildCallGradeTaskPacket,
  buildNightlyCallGradeReport,
  groupNotesByAgent,
  hasEnoughGradeEvidence,
  markCallGradeFailure,
  normalizeCallGradeResult,
  runNightlyCallGrading,
};
