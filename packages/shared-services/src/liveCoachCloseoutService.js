"use strict";

const fs = require("fs");
const path = require("path");

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMultilineText(value, maxLength = 1800) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => cleanText(line, 500))
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}

function cleanUpper(value, maxLength = 40) {
  return cleanText(value, maxLength).toUpperCase();
}

function splitEmailList(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s;]+/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const email = cleanText(item, 180).toLowerCase();
    if (!email || !email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForFile(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-");
}

function parseDateMs(value) {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function approxDurationSec(session = {}) {
  const start = parseDateMs(session.createdAt || session.metadata?.startedAt);
  const end = parseDateMs(session.updatedAt || session.lastEventAt) || Date.now();
  if (!start || !end || end < start) return 0;
  return Math.round((end - start) / 1000);
}

function compactList(values, limit = 6, maxLength = 120) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const clean = cleanText(value, maxLength);
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function sessionMetadata(session = {}) {
  const metadata = session.metadata || {};
  const bindingMetadata = session.binding?.metadata || {};
  return {
    domain: cleanUpper(metadata.domain || bindingMetadata.domain || "", 40),
    caseId: cleanText(metadata.caseId || bindingMetadata.caseId || "", 80),
    contactName: cleanText(metadata.contactName || bindingMetadata.contactName || "", 160),
    phone: cleanText(metadata.phone || metadata.contactPhone || bindingMetadata.phone || "", 80),
    agentName: cleanText(metadata.agentName || bindingMetadata.agentName || "", 120),
    agentEmail: cleanText(metadata.agentEmail || bindingMetadata.agentEmail || "", 180).toLowerCase(),
    agentExtension: cleanText(metadata.agentExtension || metadata.agentExtensionId || bindingMetadata.agentExtension || "", 80),
    uii: cleanText(metadata.uii || bindingMetadata.uii || "", 160),
    queueItemId: cleanText(metadata.queueItemId || bindingMetadata.queueItemId || "", 160),
    callSessionId: cleanText(metadata.callSessionId || bindingMetadata.callSessionId || "", 160),
  };
}

function transcriptRows(session = {}) {
  const rows = Array.isArray(session.memory?.transcripts) ? session.memory.transcripts : [];
  const latest = session.latest?.transcript;
  const combined = latest?.text ? [...rows, latest] : rows;
  return combined
    .map((row) => ({
      role: cleanText(row?.role || "prospect", 40),
      text: cleanText(row?.text || "", 1000),
      at: row?.at || row?.createdAt || null,
      channel: cleanText(row?.channel || "", 30),
    }))
    .filter((row) => row.text);
}

function prospectRows(session = {}) {
  return transcriptRows(session).filter((row) => row.role !== "agent" && row.role !== "system");
}

function selectedContextRows(session = {}) {
  const contexts = Array.isArray(session.memory?.contexts) ? session.memory.contexts : [];
  const latest = session.latest?.context;
  const rows = latest?.id ? [...contexts, latest] : contexts;
  return rows.filter(Boolean);
}

function selectedContextKeys(session = {}) {
  return compactList(
    selectedContextRows(session)
      .flatMap((row) => [
        row.primaryContextKey,
        ...(Array.isArray(row.matches) ? row.matches.map((match) => match?.key) : []),
        ...(Array.isArray(row.miniJudgement?.selectedKeys) ? row.miniJudgement.selectedKeys : []),
      ]),
    10,
    80,
  );
}

function selectedContextLabels(session = {}) {
  return compactList(
    selectedContextRows(session)
      .flatMap((row) => (Array.isArray(row.matches) ? row.matches.map((match) => match?.label || match?.key) : [])),
    6,
    120,
  );
}

function coachSuggestions(session = {}) {
  const rows = Array.isArray(session.memory?.coachingSuggestions) ? session.memory.coachingSuggestions : [];
  const latest = session.latest?.dialog;
  const combined = latest?.id || latest?.say ? [...rows, latest] : rows;
  return combined
    .map((row) => cleanText(row?.say || row?.guidance || row?.label || "", 600))
    .filter(Boolean);
}

function recentProspectSnippets(session = {}) {
  return compactList(
    prospectRows(session)
      .slice(-5)
      .map((row) => row.text),
    5,
    220,
  );
}

function summarizeFacts(session = {}) {
  const facts = session.factLedger && typeof session.factLedger === "object" ? session.factLedger : {};
  return Object.entries(facts)
    .map(([key, value]) => {
      const label = cleanText(key, 80).replace(/[_-]+/g, " ");
      const text = cleanText(
        value && typeof value === "object"
          ? value.value || value.text || value.summary || JSON.stringify(value)
          : value,
        180,
      );
      return label && text ? `${label}: ${text}` : "";
    })
    .filter(Boolean)
    .slice(0, 8);
}

function classifyOutcome(session = {}, reason = "") {
  const status = cleanText(session.status || "", 80);
  const lower = `${status} ${reason}`.toLowerCase();
  if (lower.includes("voicemail")) return "voicemail";
  if (lower.includes("stale")) return "stale";
  if (lower.includes("release") || lower.includes("ended") || lower.includes("disposition")) return "completed";
  if (status === "stopped") return "completed";
  return status || "completed";
}

function inferMajorIssue(session = {}) {
  const labels = selectedContextLabels(session);
  if (labels.length) return labels.slice(0, 3).join(", ");
  const facts = summarizeFacts(session);
  if (facts.length) return facts.slice(0, 2).join("; ");
  const latestMeaning = cleanText(session.latest?.context?.miniJudgement?.transcriptMeaning || "", 220);
  if (latestMeaning) return latestMeaning;
  const snippets = recentProspectSnippets(session);
  if (snippets.length) return snippets[snippets.length - 1];
  return "No substantial tax discussion captured.";
}

function inferNextStep(session = {}) {
  const latestDialog = cleanText(session.latest?.dialog?.say || session.latest?.dialog?.guidance || "", 260);
  if (latestDialog && !/^wait\b/i.test(latestDialog)) return latestDialog;
  const latestSteer = cleanText(session.latest?.context?.miniJudgement?.transcriptMeaning || "", 220);
  if (latestSteer) return `Continue from: ${latestSteer}`;
  const suggestions = coachSuggestions(session);
  if (suggestions.length) return suggestions[suggestions.length - 1];
  return "Review case facts and decide next contact step.";
}

function buildSparseOperationalSummary(session = {}, input = {}) {
  const metadata = sessionMetadata(session);
  const durationSec = approxDurationSec(session);
  const outcome = classifyOutcome(session, input.reason);
  const majorIssue = inferMajorIssue(session);
  const nextStep = inferNextStep(session);
  const factLines = summarizeFacts(session).slice(0, 4);
  const lines = [
    `Outcome: ${outcome}`,
    `Agent: ${metadata.agentName || metadata.agentEmail || metadata.agentExtension || "unknown"}`,
    durationSec ? `Duration: ${durationSec}s` : "",
    `Discussed: ${majorIssue}`,
    factLines.length ? `Facts captured: ${factLines.join("; ")}` : "",
    `Next step: ${nextStep}`,
  ].filter(Boolean);

  return {
    outcome,
    durationSec,
    majorIssue,
    nextStep,
    text: lines.join("\n"),
  };
}

function buildAgentFeedback(session = {}, input = {}) {
  const counters = session.counters || {};
  const durationSec = approxDurationSec(session);
  const prospects = prospectRows(session);
  const suggestions = coachSuggestions(session);
  const facts = summarizeFacts(session);
  const contextKeys = selectedContextKeys(session);
  const outcome = classifyOutcome(session, input.reason);
  let score = 70;
  if (outcome === "voicemail") score -= 20;
  if (durationSec >= 180) score += 5;
  if (prospects.length >= 4) score += 5;
  if (facts.length >= 3) score += 8;
  if (suggestions.length >= 2) score += 3;
  if (!prospects.length) score -= 20;
  score = Math.max(0, Math.min(100, score));

  const strengths = [];
  if (facts.length) strengths.push("Captured usable case facts.");
  if (contextKeys.some((key) => /objection|price|fee|spouse|think/i.test(key))) {
    strengths.push("The call surfaced a sales objection or decision barrier.");
  }
  if (durationSec >= 180) strengths.push("Conversation lasted long enough for real discovery.");

  const opportunities = [];
  if (!facts.length) opportunities.push("Capture notice type, year, balance, income type, and ability to pay.");
  if (!contextKeys.length) opportunities.push("No strong context keys were selected; review transcript quality or call substance.");
  if (suggestions.length && facts.length < 3) opportunities.push("Use coach guideposts to move from rapport into concrete discovery facts.");
  if (outcome === "voicemail") opportunities.push("No agent feedback needed; this appears to be voicemail or machine audio.");

  return {
    score,
    outcome,
    durationSec,
    transcriptCount: prospects.length,
    coachTurnCount: suggestions.length,
    selectedKeys: contextKeys,
    strengths: strengths.length ? strengths : ["No clear strength inferred yet."],
    opportunities: opportunities.length ? opportunities : ["Keep advancing through discovery and close around the next concrete step."],
    recentProspectSnippets: recentProspectSnippets(session),
  };
}

function shouldSkipCloseout(closeout, config = {}) {
  const outcome = closeout?.sparse?.outcome || "";
  const prospectCharCount = Number(closeout?.metrics?.prospectCharCount || 0);
  const durationSec = Number(closeout?.sparse?.durationSec || 0);
  const coachTurnCount = Number(closeout?.metrics?.coachTurnCount || 0);
  const minChars = Number(config.minTranscriptChars || 80);
  const minDurationSec = Number(config.minDurationSec || 20);
  if (["voicemail", "no_answer"].includes(outcome)) return "machine-or-no-answer";
  if (prospectCharCount < minChars && durationSec < minDurationSec && coachTurnCount === 0) {
    return "too-short";
  }
  return "";
}

function buildLiveCoachCloseout(session = {}, input = {}) {
  const metadata = sessionMetadata(session);
  const prospects = prospectRows(session);
  const suggestions = coachSuggestions(session);
  const sparse = buildSparseOperationalSummary(session, input);
  const agentFeedback = buildAgentFeedback(session, input);
  const contextKeys = selectedContextKeys(session);
  const facts = summarizeFacts(session);
  const now = new Date();
  return {
    id: `${session.id || "session"}:${timestampForFile(now)}`,
    sessionId: session.id || "",
    createdAt: now.toISOString(),
    reason: cleanText(input.reason || "", 120),
    metadata,
    sparse,
    agentFeedback,
    facts,
    contextKeys,
    metrics: {
      durationSec: sparse.durationSec,
      transcriptCount: prospects.length,
      prospectCharCount: prospects.reduce((sum, row) => sum + row.text.length, 0),
      coachTurnCount: suggestions.length,
      contextCount: selectedContextRows(session).length,
      askCount: Array.isArray(session.memory?.asks) ? session.memory.asks.length : 0,
      counters: session.counters || {},
    },
  };
}

function numericScore(value, fallback = null) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeStringList(values, limit = 6, maxLength = 220) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (typeof value === "string") return cleanText(value, maxLength);
      if (value && typeof value === "object") {
        return cleanText(value.text || value.note || value.summary || value.value || JSON.stringify(value), maxLength);
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, limit);
}

function buildCallGraderInput(session = {}, closeout = {}) {
  const transcripts = transcriptRows(session)
    .slice(-120)
    .map((row) => ({
      role: row.role,
      text: cleanText(row.text, 700),
      at: row.at || null,
      channel: row.channel || null,
    }));
  const contexts = selectedContextRows(session)
    .slice(-24)
    .map((row) => ({
      phrase: cleanText(row.phraseText || row.text || "", 500),
      selectedKeys: compactList([
        row.primaryContextKey,
        ...(Array.isArray(row.matches) ? row.matches.map((match) => match?.key || match?.label) : []),
        ...(Array.isArray(row.miniJudgement?.selectedKeys) ? row.miniJudgement.selectedKeys : []),
      ], 8, 80),
      meaning: cleanText(row.miniJudgement?.transcriptMeaning || row.contextBrief || row.actionReason || "", 260),
    }))
    .filter((row) => row.phrase || row.selectedKeys.length || row.meaning);
  return {
    metadata: closeout.metadata || sessionMetadata(session),
    outcome: closeout.sparse?.outcome || classifyOutcome(session, closeout.reason),
    durationSec: closeout.sparse?.durationSec || approxDurationSec(session),
    sparseSummary: closeout.sparse?.text || "",
    transcriptRows: transcripts,
    selectedContexts: contexts,
    contextKeys: closeout.contextKeys || selectedContextKeys(session),
    facts: closeout.facts || summarizeFacts(session),
    coachSuggestions: coachSuggestions(session).slice(-30),
    priorCallSummary: cleanText(session.callSummary || "", 1200),
    counters: session.counters || {},
  };
}

function normalizeCallGrade(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const scores = value.scores && typeof value.scores === "object" ? value.scores : {};
  return {
    overallScore: numericScore(value.overallScore ?? value.score, 0),
    verdict: cleanText(value.verdict || value.summary || "", 320),
    callPhaseReached: cleanText(value.callPhaseReached || value.phase || "", 80),
    outcome: cleanText(value.outcome || "", 80),
    scores: {
      rapport: numericScore(scores.rapport ?? scores.empathy),
      discovery: numericScore(scores.discovery),
      control: numericScore(scores.control ?? scores.callControl),
      taxComprehension: numericScore(scores.taxComprehension ?? scores.taxUnderstanding),
      salesPivot: numericScore(scores.salesPivot ?? scores.offerBuilding),
      compliance: numericScore(scores.compliance),
      close: numericScore(scores.close ?? scores.nextStep),
    },
    whatWorked: normalizeStringList(value.whatWorked || value.strengths, 6, 220),
    missedOpportunities: normalizeStringList(value.missedOpportunities || value.opportunities, 6, 240),
    coachingNotes: normalizeStringList(value.coachingNotes || value.notes, 8, 260),
    nextCallFocus: normalizeStringList(value.nextCallFocus || value.nextSteps, 5, 220),
    riskFlags: normalizeStringList(value.riskFlags || value.complianceFlags, 5, 180),
    factsCaptured: normalizeStringList(value.factsCaptured || value.keyFacts, 8, 180),
    summaryForAgent: cleanText(value.summaryForAgent || value.agentSummary || "", 700),
  };
}

function hasSubstantiveCloseoutEvidence(closeout = {}, options = {}) {
  const transcriptChars = Number(closeout.metrics?.prospectCharCount || 0);
  const transcriptCount = Number(closeout.metrics?.transcriptCount || 0);
  const coachTurnCount = Number(closeout.metrics?.coachTurnCount || 0);
  const contextCount = Number(closeout.metrics?.contextCount || 0);
  const factCount = Array.isArray(closeout.facts) ? closeout.facts.length : 0;
  const minTranscriptChars = Math.max(1, Number(options.minTranscriptChars || 120));
  const artifactMinChars = Math.min(minTranscriptChars, 80);

  return (
    transcriptChars >= minTranscriptChars ||
    (transcriptCount >= 2 && transcriptChars >= Math.min(minTranscriptChars, 120)) ||
    ((coachTurnCount > 0 || contextCount > 0) && transcriptChars >= artifactMinChars) ||
    factCount > 0
  );
}

function gradeIndicatesInsufficientEvidence(grade = {}) {
  const text = [
    grade.verdict,
    grade.outcome,
    grade.callPhaseReached,
    grade.summaryForAgent,
    ...(Array.isArray(grade.riskFlags) ? grade.riskFlags : []),
    ...(Array.isArray(grade.coachingNotes) ? grade.coachingNotes : []),
  ].map((value) => cleanText(value, 500)).join(" ").toLowerCase();

  return /insufficient evidence|no transcript|no usable call content|no observable|low confidence|transcript lacks/.test(text);
}

function formatLogicsActivityComment(closeout = {}) {
  return cleanMultilineText(closeout.sparse?.text || "", 1800);
}

function formatAgentEmailText(closeout = {}) {
  const feedback = closeout.agentFeedback || {};
  const grade = closeout.callGrade?.grade || null;
  return [
    "Live coach call summary",
    "",
    closeout.sparse?.text || "",
    "",
    `Score: ${grade?.overallScore ?? feedback.score ?? "n/a"}`,
    grade?.verdict ? `Verdict: ${grade.verdict}` : "",
    grade?.callPhaseReached ? `Phase reached: ${grade.callPhaseReached}` : "",
    "",
    "What worked:",
    ...((grade?.whatWorked?.length ? grade.whatWorked : feedback.strengths) || []).map((line) => `- ${line}`),
    "",
    "Watch next time:",
    ...((grade?.missedOpportunities?.length ? grade.missedOpportunities : feedback.opportunities) || []).map((line) => `- ${line}`),
    grade?.coachingNotes?.length ? "" : "",
    grade?.coachingNotes?.length ? "Coaching notes:" : "",
    ...(grade?.coachingNotes || []).map((line) => `- ${line}`),
    grade?.nextCallFocus?.length ? "" : "",
    grade?.nextCallFocus?.length ? "Next call focus:" : "",
    ...(grade?.nextCallFocus || []).map((line) => `- ${line}`),
    "",
    feedback.recentProspectSnippets?.length ? "Recent prospect snippets:" : "",
    ...(feedback.recentProspectSnippets || []).map((line) => `- ${line}`),
  ].filter((line, index, list) => line || list[index - 1]).join("\n").trim();
}

function formatManagerOutlierEmailText(closeout = {}) {
  const grade = closeout.callGrade?.grade || {};
  const feedback = closeout.agentFeedback || {};
  const score = grade.overallScore ?? feedback.score ?? "n/a";
  return [
    "Live coach outlier grade",
    "",
    `Score: ${score}`,
    grade.verdict ? `Verdict: ${grade.verdict}` : "",
    grade.callPhaseReached ? `Phase reached: ${grade.callPhaseReached}` : "",
    grade.outcome ? `Outcome: ${grade.outcome}` : "",
    "",
    closeout.sparse?.text || "",
    "",
    grade.riskFlags?.length ? "Risk flags:" : "",
    ...(grade.riskFlags || []).map((line) => `- ${line}`),
    "",
    grade.whatWorked?.length ? "What worked:" : "",
    ...(grade.whatWorked || []).map((line) => `- ${line}`),
    "",
    grade.missedOpportunities?.length ? "Missed opportunities:" : "",
    ...(grade.missedOpportunities || []).map((line) => `- ${line}`),
    "",
    grade.coachingNotes?.length ? "Coaching notes:" : "",
    ...(grade.coachingNotes || []).map((line) => `- ${line}`),
    "",
    "Session:",
    `- Agent: ${closeout.metadata?.agentName || closeout.metadata?.agentEmail || closeout.metadata?.agentExtension || "unknown"}`,
    `- Case: ${closeout.metadata?.domain || "?"} ${closeout.metadata?.caseId || "?"}`,
    `- Contact: ${closeout.metadata?.contactName || closeout.metadata?.phone || "unknown"}`,
    `- UII: ${closeout.metadata?.uii || "unknown"}`,
  ].filter((line, index, list) => line || list[index - 1]).join("\n").trim();
}

function shouldSendManagerOutlierEmail(closeout = {}, config = {}) {
  if (!config.agentEmailManagersEnabled) return { ok: false, reason: "manager-email-disabled" };
  const score = Number(closeout.callGrade?.grade?.overallScore);
  if (!Number.isFinite(score)) return { ok: false, reason: "missing-grade-score" };
  const durationSec = Number(closeout.metrics?.durationSec || closeout.sparse?.durationSec || 0);
  const transcriptChars = Number(closeout.metrics?.prospectCharCount || 0);
  const minDurationSec = Number(config.agentEmailManagerMinDurationSec || 300);
  const minChars = Number(config.agentEmailManagerMinTranscriptChars || 800);
  const evidenceEnough = hasSubstantiveCloseoutEvidence(closeout, {
    minTranscriptChars: Math.min(minChars, 250),
  });
  if (!evidenceEnough) return { ok: false, reason: "below-manager-email-evidence-threshold", score };
  if (gradeIndicatesInsufficientEvidence(closeout.callGrade?.grade || {})) {
    return { ok: false, reason: "insufficient-evidence-grade", score };
  }
  const longEnough = durationSec >= minDurationSec || transcriptChars >= minChars;
  if (!longEnough) return { ok: false, reason: "below-manager-email-length-threshold" };
  const high = Number(config.agentEmailManagerHighScore || 90);
  const low = Number(config.agentEmailManagerLowScore || 55);
  if (score >= high) return { ok: true, reason: "high-grade", score };
  if (score <= low) return { ok: true, reason: "low-grade", score };
  return { ok: false, reason: "not-outlier-grade", score };
}

function createLiveCoachCloseoutWorker({
  rootDir,
  logger,
  caseProfileRepository = null,
  leadCadenceRepository = null,
  logicsClientFactory = null,
  sendAgentEmail = null,
  callGrader = null,
  config = {},
} = {}) {
  const enabled = config.enabled !== false;
  const runtimeRoot = path.join(rootDir || process.cwd(), "runtime", "ai-bus", "live-coach", "closeout");
  const queued = new Set();
  const completed = new Set();
  const stats = {
    queued: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    graded: 0,
    gradeSkipped: 0,
    gradeFailed: 0,
    lastResult: null,
  };

  async function writeArtifact(closeout) {
    ensureDir(runtimeRoot);
    const dayDir = path.join(runtimeRoot, closeout.createdAt.slice(0, 10));
    ensureDir(dayDir);
    const safeSession = cleanText(closeout.sessionId || "session", 160).replace(/[^a-z0-9@._-]+/gi, "-");
    const file = path.join(dayDir, `${safeSession}-${timestampForFile(new Date(closeout.createdAt))}.json`);
    const artifact = { ...closeout, artifactPath: file };
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
    fs.appendFileSync(path.join(runtimeRoot, "closeout.ndjson"), `${JSON.stringify(artifact)}\n`);
    return file;
  }

  async function writeCaseProfileCommunication(closeout) {
    if (!config.caseProfileCommunicationEnabled || !caseProfileRepository?.appendCommunicationEntry) {
      return { skipped: true, reason: "case-profile-disabled" };
    }
    const { domain, caseId, phone, agentEmail, agentName } = closeout.metadata || {};
    if (!domain || !Number.isFinite(Number(caseId))) {
      return { skipped: true, reason: "missing-domain-or-case" };
    }
    const result = await caseProfileRepository.appendCommunicationEntry(domain, Number(caseId), "call", {
      direction: "outbound",
      status: closeout.sparse?.outcome || "completed",
      provider: "live-coach",
      threadKey: `live-coach:${closeout.sessionId}`,
      phone: phone || null,
      subject: "Live coach call summary",
      body: closeout.sparse?.text || "",
      actorEmail: agentEmail || null,
      actorName: agentName || null,
      happenedAt: closeout.createdAt,
      source: "live-coach-closeout",
      metadata: {
        sessionId: closeout.sessionId,
        uii: closeout.metadata?.uii || null,
        queueItemId: closeout.metadata?.queueItemId || null,
        contextKeys: closeout.contextKeys || [],
        durationSec: closeout.sparse?.durationSec || 0,
      },
    });
    return { skipped: false, id: result?._id ? String(result._id) : null };
  }

  async function writeLeadCadenceSummary(closeout) {
    if (!config.leadCadenceSummaryEnabled || !leadCadenceRepository?.saveLiveCoachCloseoutSummary) {
      return { skipped: true, reason: "lead-cadence-disabled" };
    }
    const { domain, caseId } = closeout.metadata || {};
    if (!domain || !Number.isFinite(Number(caseId))) {
      return { skipped: true, reason: "missing-domain-or-case" };
    }
    return leadCadenceRepository.saveLiveCoachCloseoutSummary(domain, Number(caseId), {
      sessionId: closeout.sessionId,
      at: closeout.createdAt,
      outcome: closeout.sparse?.outcome || null,
      summary: closeout.sparse?.text || "",
      nextStep: closeout.sparse?.nextStep || "",
      contextKeys: closeout.contextKeys || [],
      facts: closeout.facts || [],
      grade: closeout.callGrade?.grade
        ? {
          overallScore: closeout.callGrade.grade.overallScore,
          verdict: closeout.callGrade.grade.verdict,
          callPhaseReached: closeout.callGrade.grade.callPhaseReached,
          riskFlags: closeout.callGrade.grade.riskFlags || [],
        }
        : null,
      metrics: closeout.metrics || {},
    });
  }

  async function writeLogicsActivity(closeout) {
    if (!config.logicsActivityEnabled || typeof logicsClientFactory !== "function") {
      return { skipped: true, reason: "logics-disabled" };
    }
    const { domain, caseId } = closeout.metadata || {};
    if (!domain || !Number.isFinite(Number(caseId))) {
      return { skipped: true, reason: "missing-domain-or-case" };
    }
    const client = logicsClientFactory(domain);
    const result = await client.createActivity({
      CaseID: Number(caseId),
      ActivityType: config.logicsActivityType || "General",
      Subject: config.logicsSubject || "CX call summary",
      Comment: formatLogicsActivityComment(closeout),
      Popup: false,
      Pin: false,
    });
    return { skipped: false, result };
  }

  async function maybeSendAgentEmail(closeout) {
    if (!config.agentEmailEnabled || typeof sendAgentEmail !== "function") {
      return { skipped: true, reason: "agent-email-disabled" };
    }
    const to = cleanText(config.agentEmailOverride || closeout.metadata?.agentEmail || "", 180);
    if (!to) return { skipped: true, reason: "missing-agent-email" };
    const minDurationSec = Number(config.agentEmailMinDurationSec || 180);
    const minChars = Number(config.agentEmailMinTranscriptChars || 400);
    const evidenceEnough = hasSubstantiveCloseoutEvidence(closeout, {
      minTranscriptChars: Math.min(minChars, 250),
    });
    const meaningful =
      evidenceEnough &&
      (
        Number(closeout.metrics?.durationSec || 0) >= minDurationSec ||
        Number(closeout.metrics?.prospectCharCount || 0) >= minChars ||
        Number(closeout.metrics?.coachTurnCount || 0) > 0 ||
        Number(closeout.metrics?.contextCount || 0) > 0 ||
        (Array.isArray(closeout.facts) && closeout.facts.length > 0)
      );
    if (!meaningful) return { skipped: true, reason: "below-agent-email-threshold" };
    const response = {
      skipped: false,
      agent: null,
      managers: null,
    };
    response.agent = await sendAgentEmail(closeout.metadata?.domain || "TAG", {
      to,
      subject: `[Live Coach] ${closeout.metadata?.contactName || "Call"} summary`,
      text: formatAgentEmailText(closeout),
    });
    const managerGate = shouldSendManagerOutlierEmail(closeout, config);
    const managerRecipients = splitEmailList(config.agentEmailManagerRecipients);
    if (!managerGate.ok) {
      response.managers = { skipped: true, reason: managerGate.reason, score: managerGate.score ?? null };
      return response;
    }
    if (!managerRecipients.length) {
      response.managers = { skipped: true, reason: "missing-manager-recipients", score: managerGate.score };
      return response;
    }
    response.managers = await sendAgentEmail(closeout.metadata?.domain || "TAG", {
      to: managerRecipients,
      subject: `[Live Coach ${managerGate.reason}] ${managerGate.score} - ${closeout.metadata?.agentName || closeout.metadata?.agentEmail || "Agent"}`,
      text: formatManagerOutlierEmailText(closeout),
    });
    return response;
  }

  async function maybeGradeCall(session, closeout, skipReason) {
    if (skipReason) {
      stats.gradeSkipped += 1;
      return { skipped: true, reason: skipReason };
    }
    if (!config.callGraderEnabled || typeof callGrader !== "function") {
      stats.gradeSkipped += 1;
      return { skipped: true, reason: config.callGraderEnabled ? "grader-unavailable" : "grader-disabled" };
    }
    const minDurationSec = Number(config.callGraderMinDurationSec || 90);
    const minChars = Number(config.callGraderMinTranscriptChars || 350);
    const evidenceEnough = hasSubstantiveCloseoutEvidence(closeout, {
      minTranscriptChars: Math.min(minChars, 200),
    });
    const meaningful =
      evidenceEnough &&
      (
        Number(closeout.metrics?.durationSec || 0) >= minDurationSec ||
        Number(closeout.metrics?.prospectCharCount || 0) >= minChars ||
        Number(closeout.metrics?.coachTurnCount || 0) > 0 ||
        Number(closeout.metrics?.contextCount || 0) > 0 ||
        (Array.isArray(closeout.facts) && closeout.facts.length > 0)
      );
    if (!meaningful) {
      stats.gradeSkipped += 1;
      return { skipped: true, reason: "below-grader-threshold" };
    }
    const payload = buildCallGraderInput(session, closeout);
    try {
      const result = await callGrader(payload);
      const grade = normalizeCallGrade(result?.grade || result);
      stats.graded += 1;
      return {
        skipped: false,
        provider: result?.provider || "openai",
        model: result?.model || null,
        elapsedMs: result?.elapsedMs || null,
        usage: result?.usage || null,
        grade,
      };
    } catch (error) {
      stats.gradeFailed += 1;
      logger?.warn?.("live_coach.closeout.grade_failed", {
        sessionId: closeout.sessionId,
        error: error.message,
      });
      return { skipped: true, reason: "grader-error", error: error.message };
    }
  }

  async function runJob(job) {
    const closeout = buildLiveCoachCloseout(job.session, job.input);
    const skipReason = shouldSkipCloseout(closeout, config);
    closeout.skipReason = skipReason || null;
    closeout.callGrade = await maybeGradeCall(job.session, closeout, skipReason);
    const artifactPath = await writeArtifact(closeout);
    closeout.artifactPath = artifactPath;

    const result = {
      sessionId: closeout.sessionId,
      skipped: Boolean(skipReason),
      skipReason: skipReason || null,
      artifactPath,
      caseProfile: null,
      leadCadence: null,
      logics: null,
      agentEmail: null,
    };

    if (!skipReason) {
      result.caseProfile = await writeCaseProfileCommunication(closeout);
      result.leadCadence = await writeLeadCadenceSummary(closeout);
      result.logics = await writeLogicsActivity(closeout);
      result.agentEmail = await maybeSendAgentEmail(closeout);
    }

    completed.add(closeout.sessionId);
    stats.completed += 1;
    if (skipReason) stats.skipped += 1;
    stats.lastResult = result;
    logger?.info?.("live_coach.closeout.completed", {
      sessionId: closeout.sessionId,
      skipped: result.skipped,
      skipReason: result.skipReason,
      artifactPath,
    });
    return result;
  }

  function enqueue(session, input = {}) {
    if (!enabled) return { ok: false, skipped: true, reason: "disabled" };
    const sessionId = cleanText(session?.id || "", 160);
    if (!sessionId) return { ok: false, skipped: true, reason: "missing-session-id" };
    if (queued.has(sessionId) || completed.has(sessionId)) {
      return { ok: true, skipped: true, reason: "already-queued", sessionId };
    }
    queued.add(sessionId);
    stats.queued += 1;
    const job = {
      session: JSON.parse(JSON.stringify(session)),
      input: { ...input },
    };
    Promise.resolve()
      .then(() => runJob(job))
      .catch((error) => {
        stats.failed += 1;
        stats.lastResult = { sessionId, error: error.message };
        logger?.warn?.("live_coach.closeout.failed", {
          sessionId,
          error: error.message,
        });
      })
      .finally(() => {
        queued.delete(sessionId);
      });
    return { ok: true, queued: true, sessionId };
  }

  return {
    enqueue,
    getStats() {
      return {
        ...stats,
        queuedSessionCount: queued.size,
        completedSessionCount: completed.size,
      };
    },
    buildLiveCoachCloseout,
  };
}

module.exports = {
  buildCallGraderInput,
  buildLiveCoachCloseout,
  createLiveCoachCloseoutWorker,
  formatAgentEmailText,
  formatLogicsActivityComment,
  formatManagerOutlierEmailText,
  gradeIndicatesInsufficientEvidence,
  hasSubstantiveCloseoutEvidence,
  normalizeCallGrade,
  shouldSendManagerOutlierEmail,
};
