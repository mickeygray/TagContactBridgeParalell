"use strict";

const crypto = require("crypto");
const { env, getInternalFromEmail } = require("../../shared-config/src");
const { createAnthropicClient } = require("../../shared-integrations/src/anthropicClient");
const {
  trainerSessionAuditRepository: defaultRepository,
  trainingCourseRepository: defaultCourseRepository,
} = require("../../shared-repositories/src");
const { ANALYST_DOCTRINE } = require("./coachTwoStationPrompts");
const defaultMailer = require("./mailerService");

const SESSION_GRADE_TOOL = Object.freeze({
  name: "submit_trainer_session_grade",
  description: "Grade the trainee's performance in one sales training session.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "verdict", "summary", "strengths", "gaps", "nextPractice", "stuckPoint"],
    properties: {
      score: { type: "integer", minimum: 0, maximum: 100 },
      verdict: { type: "string", enum: ["excellent", "solid", "developing", "needs_review", "insufficient_evidence"] },
      summary: { type: "string", maxLength: 700 },
      strengths: { type: "array", maxItems: 4, items: { type: "string", maxLength: 240 } },
      gaps: { type: "array", maxItems: 4, items: { type: "string", maxLength: 240 } },
      nextPractice: { type: "string", maxLength: 500 },
      stuckPoint: { type: "string", maxLength: 400 },
    },
  },
});

function parseList(value) {
  return [...new Set(String(value || "")
    .split(/[;,\n]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean))];
}

function truthy(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(String(value || "").trim().toLowerCase());
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function getTrainerSessionAuditConfig(overrides = {}) {
  const retentionDays = boundedNumber(
    overrides.retentionDays ?? env("SALES_TRAINER_SESSION_AUDIT_RETENTION_DAYS", 90),
    90,
    7,
    365,
  );
  return {
    enabled: overrides.enabled ?? truthy(env("SALES_TRAINER_SESSION_AUDIT_ENABLED", "false")),
    monitoredLearners: overrides.monitoredLearners ?? parseList(env("SALES_TRAINER_SESSION_AUDIT_LEARNERS", "")),
    recipients: overrides.recipients ?? parseList(env("SALES_TRAINER_SESSION_REPORT_RECIPIENTS", "")),
    idleMs: boundedNumber(
      overrides.idleMs ?? Number(env("SALES_TRAINER_SESSION_IDLE_MINUTES", 15)) * 60_000,
      15 * 60_000,
      60_000,
      2 * 60 * 60_000,
    ),
    intervalMs: boundedNumber(
      overrides.intervalMs ?? env("SALES_TRAINER_SESSION_REPORT_INTERVAL_MS", 60_000),
      60_000,
      10_000,
      10 * 60_000,
    ),
    retentionDays,
    maxReportAttempts: boundedNumber(overrides.maxReportAttempts, 3, 1, 10),
    slowTurnMs: boundedNumber(overrides.slowTurnMs, 15_000, 2_000, 120_000),
    reportModel: String(overrides.reportModel || env("SALES_TRAINER_SESSION_REPORT_MODEL", "") || "").trim() || null,
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanText(value, maxLength = 1200) {
  return String(value || "")
    .replace(/<UI_(?:HEALTH|PAYLOAD|SCORECARD)>[\s\S]*?<\/UI_(?:HEALTH|PAYLOAD|SCORECARD)>/gi, " ")
    .replace(/<PROSPECT_STATE>[\s\S]*?<\/PROSPECT_STATE>/gi, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function wordCount(value) {
  const text = cleanText(value, 20_000);
  return text ? text.split(/\s+/).length : 0;
}

function gradeLetter(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  if (value >= 93) return "A";
  if (value >= 90) return "A-";
  if (value >= 87) return "B+";
  if (value >= 83) return "B";
  if (value >= 80) return "B-";
  if (value >= 77) return "C+";
  if (value >= 73) return "C";
  if (value >= 70) return "C-";
  if (value >= 60) return "D";
  return "F";
}

function safeEventId(prefix, supplied = null) {
  const value = cleanText(supplied, 120).replace(/[^a-zA-Z0-9_.:-]/g, "-");
  if (value) return `${prefix}:${value}`;
  return `${prefix}:${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
}

function sessionKey(kind, sourceId) {
  return `${kind === "trainer_section" ? "attempt" : "free"}:${String(sourceId || "").trim()}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function publicErrorCode(error) {
  const code = cleanText(error?.code || error?.stage || "TRAINER_SESSION_REPORT_FAILED", 80)
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_");
  return code || "TRAINER_SESSION_REPORT_FAILED";
}

function transcriptText(session) {
  return (session.turns || [])
    .map((turn) => {
      const lines = [];
      if (turn.learnerText) lines.push(`Trainee: ${cleanText(turn.learnerText, 700)}`);
      if (turn.prospectText) lines.push(`Prospect: ${cleanText(turn.prospectText, 700)}`);
      if (turn.outcome) lines.push(`Result: ${cleanText(turn.outcome, 240)}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 24_000);
}

function softwareAssessment(session) {
  const metrics = session.metrics || {};
  const deductions = [
    ["errors", 14],
    ["conflicts", 10],
    ["sttFailures", 15],
    ["ttsFailures", 7],
    ["noSpeech", 3],
    ["slowTurns", 4],
  ];
  let score = 100;
  const issues = [];
  for (const [key, weight] of deductions) {
    const count = Math.max(0, Number(metrics[key]) || 0);
    if (count > 0) {
      score -= Math.min(40, count * weight);
      issues.push(`${key}: ${count}`);
    }
  }
  if (session.endReason === "abandoned_idle") {
    score -= 5;
    issues.push("session ended after inactivity");
  }
  const turns = Math.max(0, Number(metrics.turns) || 0);
  const averageTurnMs = turns > 0
    ? Math.round((Number(metrics.totalTurnLatencyMs) || 0) / turns)
    : 0;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    grade: gradeLetter(clamped),
    verdict: clamped >= 90 ? "healthy" : clamped >= 75 ? "usable_with_friction" : "needs_attention",
    summary: issues.length > 0
      ? `The session completed with ${issues.length} observed friction signal${issues.length === 1 ? "" : "s"}.`
      : "No material Trainer friction was observed in this session.",
    issues,
    averageTurnMs,
    maxTurnMs: Math.max(0, Number(metrics.maxTurnLatencyMs) || 0),
    stuckSignals:
      Math.max(0, Number(metrics.failedAnswers) || 0) +
      Math.max(0, Number(metrics.retries) || 0) +
      Math.max(0, Number(metrics.noSpeech) || 0) +
      Math.max(0, Number(metrics.conflicts) || 0),
  };
}

function fallbackTraineeAssessment(session) {
  const metrics = session.metrics || {};
  const turns = Math.max(0, Number(metrics.turns) || 0);
  if (turns === 0 && Number(metrics.answers || 0) === 0) {
    return {
      score: 0,
      grade: "N/A",
      verdict: "insufficient_evidence",
      summary: "The session ended before there was enough trainee evidence to grade.",
      strengths: [],
      gaps: ["No substantive response was captured."],
      nextPractice: "Start the exercise again and complete at least one exchange.",
      stuckPoint: session.endReason === "abandoned_idle" ? "The exercise was left before a substantive exchange." : "Not enough evidence.",
      model: null,
    };
  }
  let score = 75;
  score -= Math.min(35, (Number(metrics.failedAnswers) || 0) * 12);
  score -= Math.min(20, (Number(metrics.retries) || 0) * 5);
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: clamped,
    grade: gradeLetter(clamped),
    verdict: clamped >= 85 ? "solid" : clamped >= 60 ? "developing" : "needs_review",
    summary: "Automated fallback score based on completed turns, answer outcomes, and retries; narrative grading was unavailable.",
    strengths: turns > 0 ? [`Completed ${turns} substantive exchange${turns === 1 ? "" : "s"}.`] : [],
    gaps: Number(metrics.failedAnswers || 0) > 0 ? ["One or more knowledge checks did not pass."] : [],
    nextPractice: "Review the session transcript and repeat the weakest move.",
    stuckPoint: Number(metrics.retries || 0) > 0 ? "The trainee restarted at least one exercise." : "No clear stuck point detected.",
    model: null,
  };
}

async function gradeTraineeSession(session, options = {}) {
  const transcript = transcriptText(session);
  if (!transcript) return fallbackTraineeAssessment(session);
  const client = options.anthropicClient || createAnthropicClient();
  const model = options.model || env("SALES_TRAINER_COACH_MODEL", "claude-sonnet-5");
  const raw = await client.createMessage({
    system:
      "You are grading one trainee's tax-resolution sales practice session. Grade only the trainee's skill and judgment, not software latency, audio failures, API errors, or UI friction. Use the house doctrine below. Treat model-generated coaching and prospect dialogue as context, not as trainee performance. Be direct and specific. Output strictly through submit_trainer_session_grade.\n\n" +
      ANALYST_DOCTRINE,
    messages: [{
      role: "user",
      content: [
        `Session type: ${cleanText(session.kind, 80)}`,
        `Exercise: ${cleanText(session.title || session.itemId || "Training session", 200)}`,
        `End reason: ${cleanText(session.endReason || "completed", 80)}`,
        `Observed answer failures: ${Number(session.metrics?.failedAnswers) || 0}`,
        `Observed retries: ${Number(session.metrics?.retries) || 0}`,
        "TRANSCRIPT AND GRADED OUTCOMES:",
        transcript,
      ].join("\n\n"),
    }],
    model,
    maxTokens: 900,
    temperature: 0.2,
    tools: [SESSION_GRADE_TOOL],
    toolChoice: { type: "tool", name: SESSION_GRADE_TOOL.name },
    timeoutMs: 30_000,
  });
  const block = (Array.isArray(raw?.content) ? raw.content : []).find(
    (item) => item?.type === "tool_use" && item?.name === SESSION_GRADE_TOOL.name,
  );
  if (!block?.input) throw new Error("TRAINER_SESSION_GRADE_EMPTY");
  const grade = block.input;
  const score = Math.max(0, Math.min(100, Math.round(Number(grade.score) || 0)));
  return {
    score,
    grade: gradeLetter(score),
    verdict: cleanText(grade.verdict, 40) || "developing",
    summary: cleanText(grade.summary, 700),
    strengths: (Array.isArray(grade.strengths) ? grade.strengths : []).slice(0, 4).map((item) => cleanText(item, 240)).filter(Boolean),
    gaps: (Array.isArray(grade.gaps) ? grade.gaps : []).slice(0, 4).map((item) => cleanText(item, 240)).filter(Boolean),
    nextPractice: cleanText(grade.nextPractice, 500),
    stuckPoint: cleanText(grade.stuckPoint, 400),
    model: cleanText(raw?.model || model, 100),
  };
}

function renderReport(session, trainee, software) {
  const startedAt = new Date(session.startedAt);
  const endedAt = new Date(session.endedAt || session.lastActivityAt || session.startedAt);
  const elapsedMs = Math.max(0, endedAt.getTime() - startedAt.getTime());
  const turns = session.turns || [];
  const transcriptLines = turns.flatMap((turn, index) => {
    const rows = [];
    if (turn.learnerText) rows.push(`${index + 1}. Trainee: ${cleanText(turn.learnerText, 700)}`);
    if (turn.prospectText) rows.push(`${index + 1}. Prospect: ${cleanText(turn.prospectText, 700)}`);
    if (turn.outcome) rows.push(`${index + 1}. Result: ${cleanText(turn.outcome, 240)}`);
    return rows;
  });
  const title = cleanText(session.title || (session.kind === "trainer_section" ? "Trainer section" : "Free conversation"), 160);
  const subject = `Trainer session report: ${title} — trainee ${trainee.grade}, software ${software.grade}`;
  const details = [
    `Session: ${title}`,
    `Trainee: ${session.learnerEmailNormalized}`,
    `Started: ${startedAt.toISOString()}`,
    `Ended: ${endedAt.toISOString()}`,
    `Active span: ${formatDuration(elapsedMs)}`,
    `End reason: ${session.endReason || "completed"}`,
    `Turns: ${Number(session.metrics?.turns) || 0}`,
    `Learner words: ${Number(session.metrics?.learnerWords) || 0}`,
    "",
    `TRAINEE — ${trainee.grade} (${trainee.score}/100, ${trainee.verdict})`,
    trainee.summary,
    `Strengths: ${trainee.strengths.join("; ") || "None established"}`,
    `Gaps: ${trainee.gaps.join("; ") || "None established"}`,
    `Where he got stuck: ${trainee.stuckPoint || "No clear stuck point"}`,
    `Next practice: ${trainee.nextPractice || "Repeat the weakest section"}`,
    "",
    `SOFTWARE — ${software.grade} (${software.score}/100, ${software.verdict})`,
    software.summary,
    `Issues: ${software.issues.join("; ") || "None"}`,
    `Average turn: ${formatDuration(software.averageTurnMs)}`,
    `Slowest turn: ${formatDuration(software.maxTurnMs)}`,
    `Stuck signals: ${software.stuckSignals}`,
    "",
    "SESSION TRANSCRIPT",
    ...(transcriptLines.length > 0 ? transcriptLines : ["No substantive transcript captured."]),
  ];
  const section = (heading, body) =>
    `<section style="margin:18px 0;padding:16px;border:1px solid #ddd;border-radius:8px"><h2 style="margin:0 0 10px">${escapeHtml(heading)}</h2>${body}</section>`;
  const list = (items) => items.length > 0
    ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "<p>None established.</p>";
  const transcriptHtml = turns.length > 0
    ? turns.map((turn, index) => {
        const rows = [];
        if (turn.learnerText) rows.push(`<p><strong>${index + 1}. Trainee:</strong> ${escapeHtml(cleanText(turn.learnerText, 700))}</p>`);
        if (turn.prospectText) rows.push(`<p><strong>${index + 1}. Prospect:</strong> ${escapeHtml(cleanText(turn.prospectText, 700))}</p>`);
        if (turn.outcome) rows.push(`<p><strong>Result:</strong> ${escapeHtml(cleanText(turn.outcome, 240))}</p>`);
        return rows.join("");
      }).join("")
    : "<p>No substantive transcript captured.</p>";
  const html = [
    "<div style=\"font-family:Arial,sans-serif;line-height:1.45;color:#172033;max-width:800px\">",
    `<h1>Trainer session report</h1><p><strong>${escapeHtml(title)}</strong><br>${escapeHtml(session.learnerEmailNormalized)}<br>${escapeHtml(startedAt.toISOString())} – ${escapeHtml(endedAt.toISOString())} (${escapeHtml(formatDuration(elapsedMs))})</p>`,
    section(`Trainee — ${trainee.grade} (${trainee.score}/100)`, `<p>${escapeHtml(trainee.summary)}</p><h3>Strengths</h3>${list(trainee.strengths)}<h3>Gaps</h3>${list(trainee.gaps)}<p><strong>Where he got stuck:</strong> ${escapeHtml(trainee.stuckPoint || "No clear stuck point")}</p><p><strong>Next practice:</strong> ${escapeHtml(trainee.nextPractice || "Repeat the weakest section")}</p>`),
    section(`Software — ${software.grade} (${software.score}/100)`, `<p>${escapeHtml(software.summary)}</p><p><strong>Issues:</strong> ${escapeHtml(software.issues.join("; ") || "None")}</p><p><strong>Average / slowest turn:</strong> ${escapeHtml(formatDuration(software.averageTurnMs))} / ${escapeHtml(formatDuration(software.maxTurnMs))}</p><p><strong>Stuck signals:</strong> ${software.stuckSignals}</p>`),
    section("Session transcript", transcriptHtml),
    "</div>",
  ].join("");
  return { subject, text: details.join("\n"), html, elapsedMs };
}

function createTrainerSessionAuditService(options = {}) {
  const config = getTrainerSessionAuditConfig(options.config || {});
  const repository = options.repository || defaultRepository;
  const courseRepository = options.courseRepository || defaultCourseRepository;
  const mailer = options.mailer || defaultMailer;
  const clock = options.clock || (() => new Date());
  const monitored = new Set(config.monitoredLearners.map(normalizeEmail));
  let timer = null;
  let running = false;

  function isMonitored(user) {
    if (!config.enabled) return false;
    const email = normalizeEmail(user?.email || user?.learnerEmailNormalized);
    return Boolean(email && monitored.has(email));
  }

  function expiresAt(now) {
    return new Date(now.getTime() + config.retentionDays * 24 * 60 * 60_000);
  }

  async function openFreeConversation({ user, result }) {
    if (!isMonitored(user) || !result?.sessionId) return null;
    const now = clock();
    const key = sessionKey("free_conversation", result.sessionId);
    const session = await repository.findOrCreateSession({
      sessionKey: key,
      create: {
        sessionKey: key,
        sourceId: String(result.sessionId),
        learnerEmailNormalized: normalizeEmail(user.email),
        companySnapshot: cleanText(user.company || "TAG", 20).toUpperCase(),
        kind: "free_conversation",
        title: "Free conversation",
        status: "active",
        startedAt: now,
        lastActivityAt: now,
        expiresAt: expiresAt(now),
      },
    });
    const opening = cleanText(result.openingLine, 1200);
    if (opening) {
      await repository.appendEntry({
        sessionKey: key,
        eventId: "opening",
        entry: {
          eventId: "opening",
          sequence: 0,
          kind: "conversation",
          learnerText: null,
          prospectText: opening,
          outcome: result.openingAudioError ? "opening audio failed" : "opening delivered",
          latencyMs: null,
          occurredAt: now,
        },
        increments: {
          prospectWords: wordCount(opening),
          ttsFailures: result.openingAudioError ? 1 : 0,
          errors: result.openingAudioError ? 1 : 0,
        },
        occurredAt: now,
      });
    }
    return session;
  }

  async function recordFreeConversationTurn({ user, sessionId: sourceId, turnNumber, eventId = null, result }) {
    if (!isMonitored(user) || !sourceId) return null;
    const key = sessionKey("free_conversation", sourceId);
    const now = clock();
    const learnerText = cleanText(result?.transcript?.text, 3000);
    const prospectText = cleanText(result?.response?.text, 3000);
    const latencyMs = Math.max(0, Number(result?.elapsedMs) || 0);
    if (!learnerText) {
      return repository.recordMetricEvent({
        sessionKey: key,
        eventId: safeEventId("no-speech"),
        increments: { noSpeech: 1 },
        errorCode: "TRAINER_NO_SPEECH",
        occurredAt: now,
      });
    }
    const entryId = safeEventId("turn", eventId || turnNumber);
    const recorded = await repository.appendEntry({
      sessionKey: key,
      eventId: entryId,
      entry: {
        eventId: entryId,
        sequence: Math.max(1, Number(turnNumber) || 1),
        kind: "conversation",
        learnerText,
        prospectText: prospectText || null,
        outcome: result?.audioError ? "prospect audio failed" : "turn completed",
        latencyMs,
        occurredAt: now,
      },
      increments: {
        turns: 1,
        learnerWords: wordCount(learnerText),
        prospectWords: wordCount(prospectText),
        totalTurnLatencyMs: latencyMs,
        slowTurns: latencyMs >= config.slowTurnMs ? 1 : 0,
        sttFailures: result?.sttError ? 1 : 0,
        ttsFailures: result?.audioError ? 1 : 0,
        errors: result?.sttError || result?.audioError ? 1 : 0,
      },
      maxTurnLatencyMs: latencyMs,
      occurredAt: now,
    });
    if (/<UI_SCORECARD>/i.test(String(result?.response?.text || ""))) {
      await repository.finish({ sessionKey: key, endedAt: now, endReason: "scorecard_completed" });
    }
    return recorded;
  }

  async function recordFreeConversationError({ user, sourceId, stage, status }) {
    if (!isMonitored(user) || !sourceId) return null;
    const key = sessionKey("free_conversation", sourceId);
    const code = status === 409
      ? "TRAINER_SESSION_CONFLICT"
      : `TRAINER_${cleanText(stage || "REQUEST", 40).toUpperCase().replace(/[^A-Z0-9]/g, "_")}_FAILED`;
    return repository.recordMetricEvent({
      sessionKey: key,
      eventId: safeEventId("error"),
      increments: { errors: 1, conflicts: status === 409 ? 1 : 0, sttFailures: stage === "stt" ? 1 : 0 },
      errorCode: code,
      occurredAt: clock(),
    });
  }

  async function ensureCourseSession({ user, attemptId }) {
    if (!isMonitored(user) || !attemptId) return null;
    const attempt = await courseRepository.findAttemptById(String(attemptId));
    if (!attempt || normalizeEmail(attempt.learnerEmailNormalized) !== normalizeEmail(user.email)) return null;
    const now = clock();
    const key = sessionKey("trainer_section", attempt.attemptId);
    return repository.findOrCreateSession({
      sessionKey: key,
      create: {
        sessionKey: key,
        sourceId: String(attempt.attemptId),
        learnerEmailNormalized: normalizeEmail(user.email),
        companySnapshot: cleanText(attempt.companySnapshot || user.company || "TAG", 20).toUpperCase(),
        kind: "trainer_section",
        title: cleanText(attempt.contentSnapshot?.title || attempt.itemId || "Trainer section", 180),
        courseId: cleanText(attempt.courseId, 120),
        itemId: cleanText(attempt.itemId, 160),
        itemType: cleanText(attempt.itemType, 80),
        status: "active",
        startedAt: attempt.createdAt || now,
        lastActivityAt: now,
        expiresAt: expiresAt(now),
      },
    });
  }

  function attemptIdFrom({ path = "", result = null }) {
    const direct = result?.attempt?.attemptId || result?.attemptId;
    if (direct) return String(direct);
    const match = String(path).match(/\/attempts\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function observeCourseResult({ user, path, body = {}, result }) {
    if (!isMonitored(user)) return null;
    const attemptId = attemptIdFrom({ path, result });
    if (!attemptId) return null;
    await ensureCourseSession({ user, attemptId });
    const key = sessionKey("trainer_section", attemptId);
    const now = clock();
    const eventId = safeEventId("course", body.eventId || body.requestId || `${path}:${result?.version ?? "ok"}`);
    if (/\/answers$/.test(path)) {
      const passed = result?.grade?.passed === true;
      return repository.appendEntry({
        sessionKey: key,
        eventId,
        entry: {
          eventId,
          sequence: Number(result?.version) || 0,
          kind: "answer",
          learnerText: cleanText(body.answer, 3000),
          prospectText: null,
          outcome: `score ${Number(result?.grade?.score) || 0}; ${passed ? "passed" : "not passed"}`,
          latencyMs: null,
          occurredAt: now,
        },
        increments: {
          answers: 1,
          failedAnswers: passed ? 0 : 1,
          learnerWords: wordCount(body.answer),
        },
        occurredAt: now,
      });
    }
    if (/\/turns$/.test(path)) {
      return repository.appendEntry({
        sessionKey: key,
        eventId,
        entry: {
          eventId,
          sequence: Number(result?.state?.nextTurn || result?.attempt?.version || 0),
          kind: "conversation",
          learnerText: cleanText(body.text, 3000),
          prospectText: cleanText(result?.prospectReply?.text || result?.prospectReply, 3000) || null,
          outcome: cleanText(result?.terminal?.status || result?.state?.status || "turn completed", 120),
          latencyMs: null,
          occurredAt: now,
        },
        increments: {
          turns: 1,
          learnerWords: wordCount(body.text),
          prospectWords: wordCount(result?.prospectReply?.text || result?.prospectReply),
        },
        occurredAt: now,
      });
    }
    if (/\/module-answer$/.test(path)) {
      const passed = result?.passed === true || result?.verdict === "nailed" || Number(result?.score) >= 70;
      return repository.appendEntry({
        sessionKey: key,
        eventId,
        entry: {
          eventId,
          sequence: Number(result?.version) || 0,
          kind: "answer",
          learnerText: cleanText(body.answer, 3000),
          prospectText: null,
          outcome: `score ${Number(result?.score) || 0}; ${passed ? "passed" : "not passed"}`,
          latencyMs: null,
          occurredAt: now,
        },
        increments: { answers: 1, failedAnswers: passed ? 0 : 1, learnerWords: wordCount(body.answer) },
        occurredAt: now,
      });
    }
    if (/\/retry$/.test(path)) {
      return repository.recordMetricEvent({
        sessionKey: key,
        eventId,
        increments: { retries: 1 },
        occurredAt: now,
      });
    }
    if (/\/reflection$/.test(path)) {
      return repository.appendEntry({
        sessionKey: key,
        eventId,
        entry: {
          eventId,
          sequence: Number(result?.version) || 0,
          kind: "reflection",
          learnerText: cleanText(body.reflection, 3000),
          prospectText: null,
          outcome: "reflection submitted",
          latencyMs: null,
          occurredAt: now,
        },
        increments: { learnerWords: wordCount(body.reflection) },
        occurredAt: now,
      });
    }
    if (/\/complete$/.test(path)) {
      await repository.finish({ sessionKey: key, endedAt: now, endReason: "completed" });
      return repository.findBySessionKey(key);
    }
    return repository.touch({ sessionKey: key, occurredAt: now });
  }

  async function observeCourseError({ user, path, status, code }) {
    if (!isMonitored(user)) return null;
    const attemptId = attemptIdFrom({ path });
    if (!attemptId) return null;
    await ensureCourseSession({ user, attemptId });
    return repository.recordMetricEvent({
      sessionKey: sessionKey("trainer_section", attemptId),
      eventId: safeEventId("course-error"),
      increments: { errors: 1, conflicts: Number(status) === 409 ? 1 : 0 },
      errorCode: cleanText(code || `TRAINER_COURSE_HTTP_${status || 500}`, 80),
      occurredAt: clock(),
    });
  }

  async function endFreeConversation({ user, sourceId, reason = "user_ended" }) {
    if (!isMonitored(user) || !sourceId) return null;
    return repository.finish({
      sessionKey: sessionKey("free_conversation", sourceId),
      endedAt: clock(),
      endReason: reason,
    });
  }

  async function closeStale() {
    const now = clock();
    const stale = await repository.findStaleActive({
      staleBefore: new Date(now.getTime() - config.idleMs),
      limit: 25,
    });
    for (const session of stale) {
      await repository.finish({
        sessionKey: session.sessionKey,
        endedAt: session.lastActivityAt || now,
        endReason: "abandoned_idle",
      });
    }
    return stale.length;
  }

  async function processOneReport() {
    if (!config.enabled || config.recipients.length === 0) return null;
    const now = clock();
    const session = await repository.claimNextReport({
      now,
      staleBefore: new Date(now.getTime() - 10 * 60_000),
      maxAttempts: config.maxReportAttempts,
    });
    if (!session) return null;
    try {
      let trainee;
      try {
        trainee = await gradeTraineeSession(session, {
          anthropicClient: options.anthropicClient,
          model: config.reportModel,
        });
      } catch {
        trainee = fallbackTraineeAssessment(session);
      }
      const software = softwareAssessment(session);
      const rendered = renderReport(session, trainee, software);
      const from = getInternalFromEmail();
      const delivery = await mailer.sendMail("TAG", {
        to: config.recipients,
        from,
        replyTo: from,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      const report = {
        trainee,
        software,
        elapsedMs: rendered.elapsedMs,
        generatedAt: now,
        deliveryMessageId: cleanText(delivery?.messageId, 200) || null,
      };
      return repository.markReported({
        sessionKey: session.sessionKey,
        generation: session.reportGeneration,
        report,
        reportedAt: clock(),
      });
    } catch (error) {
      const delayMs = Math.min(30 * 60_000, Math.max(60_000, Number(session.reportAttempts || 1) * 5 * 60_000));
      await repository.markReportFailed({
        sessionKey: session.sessionKey,
        generation: session.reportGeneration,
        errorCode: publicErrorCode(error),
        nextAttemptAt: new Date(clock().getTime() + delayMs),
      });
      return null;
    }
  }

  async function runOnce() {
    if (!config.enabled || running) return { skipped: true };
    running = true;
    try {
      const staleClosed = await closeStale();
      const report = await processOneReport();
      return { skipped: false, staleClosed, reportProcessed: Boolean(report) };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!config.enabled || timer) return false;
    timer = setInterval(() => {
      void runOnce().catch(() => {
        /* report failures remain in the durable outbox */
      });
    }, config.intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    config,
    closeStale,
    endFreeConversation,
    ensureCourseSession,
    isMonitored,
    observeCourseError,
    observeCourseResult,
    openFreeConversation,
    processOneReport,
    recordFreeConversationError,
    recordFreeConversationTurn,
    runOnce,
    start,
    stop,
  };
}

module.exports = {
  SESSION_GRADE_TOOL,
  cleanText,
  createTrainerSessionAuditService,
  fallbackTraineeAssessment,
  formatDuration,
  getTrainerSessionAuditConfig,
  gradeLetter,
  gradeTraineeSession,
  parseList,
  renderReport,
  sessionKey,
  softwareAssessment,
  transcriptText,
};
