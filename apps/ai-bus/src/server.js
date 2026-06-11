"use strict";

const express = require("express");
const cors = require("cors");
const {
  getCorsOriginResolver,
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
} = require("../../../packages/shared-utils/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");
const { createLogger } = require("../../../packages/shared-observability/src");
const { toErrorResponse } = require("../../../packages/shared-errors/src");
const {
  connectMongo,
  disconnectMongo,
  getMongoState,
  EventRecord,
} = require("../../../packages/event-core/src");
const {
  CallSession,
  LiveCoachSession,
  WorkflowRecord,
} = require("../../../packages/shared-models/src");
const {
  createLiveCoachBus,
} = require("../../../packages/shared-services/src/liveCoachBusService");
const {
  createLiveCoachMongoBridge,
} = require("../../../packages/shared-services/src/liveCoachMongoBridgeService");
const {
  createLiveCoachMongoPersistence,
} = require("../../../packages/shared-services/src/liveCoachPersistenceService");
const {
  CONTEXT_RULES,
} = require("../../../packages/shared-services/src/liveCoachSanitizedPipeline");
const {
  createLiveCoachVmTransferTrigger,
} = require("../../../packages/shared-services/src/liveCoachVmTransferService");

let processCrashLogger = null;

function logProcessCrash(type, error) {
  const err = error instanceof Error ? error : new Error(String(error || "unknown process error"));
  const payload = {
    error: err.message,
    stack: err.stack || null,
  };
  if (processCrashLogger?.error) {
    processCrashLogger.error(type, payload);
  } else {
    console.error(`[${type}] ${err.stack || err.message}`);
  }
}

process.on("uncaughtException", (error) => {
  logProcessCrash("process.uncaught_exception", error);
});

process.on("unhandledRejection", (reason) => {
  logProcessCrash("process.unhandled_rejection", reason);
});

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

const LIVE_COACH_DIAGNOSTIC_LOGGING = boolFromEnv(process.env.LIVE_COACH_DIAGNOSTIC_LOGGING, true);
const LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY = Math.max(
  0,
  Number(process.env.LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY || 20) || 20,
);
const LIVE_COACH_DIAGNOSTIC_SLOW_MS = Math.max(
  0,
  Number(process.env.LIVE_COACH_DIAGNOSTIC_SLOW_MS || 1500) || 1500,
);
const liveCoachDiagnosticCounters = new Map();

function shouldLogLiveCoachDiagnostic(name, elapsedMs = 0) {
  if (!LIVE_COACH_DIAGNOSTIC_LOGGING) return false;
  if (LIVE_COACH_DIAGNOSTIC_SLOW_MS > 0 && Number(elapsedMs || 0) >= LIVE_COACH_DIAGNOSTIC_SLOW_MS) return true;
  if (LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY <= 0) return false;
  const key = cleanText(name, 120) || "default";
  const next = (liveCoachDiagnosticCounters.get(key) || 0) + 1;
  liveCoachDiagnosticCounters.set(key, next);
  return next === 1 || next % LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY === 0;
}

function logLiveCoachDiagnostic(logger, name, fields = {}, { level = "info", elapsedMs = 0, force = false } = {}) {
  if (!force && !shouldLogLiveCoachDiagnostic(name, elapsedMs)) return;
  const log = logger?.[level] || logger?.info;
  log?.call(logger, name, {
    ...fields,
    diagnosticSampleEvery: LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY,
    diagnosticSlowMs: LIVE_COACH_DIAGNOSTIC_SLOW_MS,
  });
}

function textValue(value, depth = 0) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 3) return "";
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item, depth + 1)).filter(Boolean).join("");
  }
  if (typeof value === "object") {
    return textValue(
      value.text ??
        value.value ??
        value.output_text ??
        value.outputText ??
        value.content ??
        value.message ??
        value.say ??
        "",
      depth + 1,
    );
  }
  return String(value || "");
}

function cleanText(value, maxLength = 4000) {
  return textValue(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function extractOpenAiResponseText(payload = {}) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const parts = [];
  for (const output of Array.isArray(payload.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      if (typeof content?.text === "string") parts.push(content.text);
      else if (typeof content?.text?.value === "string") parts.push(content.text.value);
      else if (typeof content?.output_text === "string") parts.push(content.output_text);
    }
  }
  return parts.join("\n");
}

function parseJsonObject(text) {
  const raw = cleanText(text, 20_000)
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error("OpenAI context judge did not return JSON");
}

const MINI_CONTEXT_JUDGE_PROMPT_VERSION = "live-coach-mini-context-v4";
const MATCHABLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "but",
  "for",
  "i",
  "im",
  "i'm",
  "is",
  "it",
  "me",
  "my",
  "of",
  "or",
  "so",
  "that",
  "the",
  "this",
  "to",
  "uh",
  "um",
  "you",
]);

function normalizeMatchableTerm(value = "") {
  return cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandMatchableTerms(hit = "") {
  const normalized = normalizeMatchableTerm(hit);
  if (!normalized) return [];
  const terms = [normalized];
  const words = normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 1 && !MATCHABLE_STOPWORDS.has(word));
  terms.push(...words);
  return [...new Set(terms)].slice(0, 8);
}

function buildGroupedMatchables(candidates = [], {
  maxTerms = 18,
  maxCandidatesPerTerm = 6,
} = {}) {
  const groups = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const key = cleanText(candidate.key, 120);
    if (!key) continue;
    const candidateRow = {
      key,
      label: cleanText(candidate.label, 120),
      family: cleanText(candidate.family, 80),
      priority: Number(candidate.priority || 0),
      score: Number(candidate.score || 0),
      summary: cleanText(candidate.summary || candidate.guidance || "", 240),
      fragment: cleanText(candidate.fragment || candidate.transcriptFragment || "", 220),
    };
    const hits = Array.isArray(candidate.hits) && candidate.hits.length
      ? candidate.hits
      : [candidate.key, candidate.label].filter(Boolean);
    for (const term of hits.flatMap((hit) => expandMatchableTerms(hit))) {
      if (!term || MATCHABLE_STOPWORDS.has(term)) continue;
      if (!groups.has(term)) groups.set(term, []);
      const rows = groups.get(term);
      if (!rows.some((row) => row.key === candidateRow.key)) rows.push(candidateRow);
    }
  }
  return [...groups.entries()]
    .map(([matchable, rows]) => ({
      matchable,
      candidates: rows
        .sort((a, b) => b.score - a.score || b.priority - a.priority || a.key.localeCompare(b.key))
        .slice(0, maxCandidatesPerTerm),
    }))
    .sort((a, b) => {
      const aScore = a.candidates[0]?.score || 0;
      const bScore = b.candidates[0]?.score || 0;
      return bScore - aScore || b.candidates.length - a.candidates.length || a.matchable.localeCompare(b.matchable);
    })
    .slice(0, maxTerms);
}

const MINI_CONTEXT_JUDGE_STATIC_PROMPT = [
  `Prompt version: ${MINI_CONTEXT_JUDGE_PROMPT_VERSION}`,
  "You are the semantic context judge between STT and a live tax-resolution sales coach.",
  "Your job is one mini/API pass: understand the server-VAD transcript, filter/rank the local lookup matchables, and decide whether the capped unresolved VAD buffer is ready for the writer.",
  "The dynamic user message contains vad, currentVad, matched, unresolvedVadBuffer, bufferPolicy, recentProspect, and recentFiltered.",
  "matched is the output of the local JS lookup tool. It is deterministic word/phrase evidence grouped as matchable -> possible candidate keys/summaries. It is intentionally over-inclusive.",
  "Use only exact keys present inside matched[].candidates. Do not invent keys and do not assume access to a hidden catalog.",
  "Reject voicemail, automated prompts, call screeners, filler, greetings, and fragments with no useful sales/tax/human context.",
  "Read vad together with unresolvedVadBuffer. If the thought is clearly coachable now, set shouldCompose true. If bufferPolicy.forceReleaseByCap is true, set shouldCompose true even if the thought is imperfect so the writer can work it out.",
  "If not ready and not forced by cap, set shouldCompose false and preserve useful activeIssues in contextBrief.",
  "approvedKeys must be objects, not strings. For each approved key, include a short snippet copied/paraphrased from the CURRENT grouped thought that proves why the key applies.",
  "contextBrief is the single compact meaning+memory sentence for the writer: current meaning, relevant prior unresolved VADs, and the next logical direction. Do not duplicate it into a second meaning field.",
  "Return JSON only with this shape:",
  '{"shouldCompose":boolean,"completeThought":boolean,"approvedKeys":[{"key":"exact_key","confidence":0.0,"reason":"short reason","snippet":"short associated phrase from current grouped thought"}],"rejected":[{"key":"exact_key","reason":"short reason"}],"contextBrief":"one compact meaning+memory+next-direction sentence","thoughtVadIds":["vad-id"],"actionReason":"short machine reason","confidence":0.0}',
  "If no key matches but the prospect asked a meaningful direct question, set shouldCompose true and approvedKeys empty.",
  "shouldCompose is a JUNK FILTER, not a completeness gate: set it false ONLY for non-coachable input -- voicemail, automated prompts, call screeners, pure filler or greetings.",
  "Do NOT set shouldCompose false solely because the sentence is slightly imperfect; the writer is allowed to make sense of grouped VAD chunks.",
].join("\n");

function buildMiniContextJudgeCacheKey({ model, metadata = {}, scope = "agent" } = {}) {
  const parts = ["live-coach-mini", MINI_CONTEXT_JUDGE_PROMPT_VERSION, cleanText(model, 80) || "model"];
  const normalizedScope = cleanText(scope || "agent", 40).toLowerCase();
  if (normalizedScope === "agent") {
    const agent = cleanText(metadata.agentExtension || metadata.agentExtensionId || metadata.agentEmail || metadata.agentName || "floor", 80)
      .toLowerCase()
      .replace(/[^a-z0-9@._-]+/g, "-");
    parts.push(agent || "floor");
  } else if (normalizedScope && normalizedScope !== "global") {
    parts.push(normalizedScope.replace(/[^a-z0-9@._-]+/g, "-"));
  }
  return cleanText(parts.filter(Boolean).join(":"), 180);
}

// ── Rolling relevance digest (mini's dual-VAD role) ─────────────────────────
// Mini continuously reads the fast channel's caught packets against the last
// completed turns + recent coach lines. It is explicitly NOT judging the
// present (Sonnet reads the present at turn time) — its one question is: in
// the broad context of what's already been said, is this caught info relevant?
const MINI_ROLLING_DIGEST_PROMPT_VERSION = "digest-v1";
const MINI_ROLLING_DIGEST_STATIC_PROMPT = [
  "You are the rolling relevance reader for a live tax-resolution sales call.",
  "You are NOT trying to understand what is being said right now - the coach reads the present at turn time. Your only question: in the broad context of what has ALREADY been said (the last completed turns and recent coach lines), is the newly caught tax/sales info RELEVANT to the live thread of this conversation?",
  "Input JSON: lastTurns (last completed thoughts, both speakers), coachLines (recent coach suggestions), packets (newest fast speech fragments, each with deterministically caught keys and snippets).",
  "Drop catches that are echoes, already-resolved topics, side noise, or keyword misfires. Keep catches that extend, answer, or complicate the live thread.",
  'Reply ONLY with JSON: {"relevantKeys":[{"key":"...","snippet":"...","why":"<=15 words"}] (max 5), "droppedKeys":["..."], "brief":{"whatHappened":"<=140 chars - the immediate past in one beat","continueFrom":"<=100 chars - where the thread is heading"}, "read":"<=120 chars - what the prospect feels and wants right now"}',
].join("\n");

function createOpenAiRollingDigest({ logger } = {}) {
  const enabled = boolFromEnv(process.env.LIVE_COACH_MINI_DIGEST_ENABLED, true);
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!enabled || !apiKey) return null;
  const model = String(
    process.env.LIVE_COACH_MINI_DIGEST_MODEL ||
      process.env.LIVE_COACH_CONTEXT_JUDGE_MODEL ||
      process.env.LIVE_COACH_MINI_MODEL ||
      "gpt-5.4-mini",
  ).trim();
  const serviceTier = cleanText(process.env.LIVE_COACH_OPENAI_SERVICE_TIER || "priority", 80);
  const timeoutMs = Math.max(2000, Number(process.env.LIVE_COACH_MINI_DIGEST_TIMEOUT_MS || 5000) || 5000);
  const maxOutputTokens = Math.max(
    150,
    Math.min(600, Number(process.env.LIVE_COACH_MINI_DIGEST_MAX_OUTPUT_TOKENS || 300) || 300),
  );
  logLiveCoachDiagnostic(logger, "live_coach.rolling_digest.config", {
    enabled: true,
    model,
    serviceTier: serviceTier || null,
    promptVersion: MINI_ROLLING_DIGEST_PROMPT_VERSION,
    maxOutputTokens,
    timeoutMs,
  }, { force: true });

  return async function rollingDigestWithOpenAi({ lastTurns = [], coachLines = [], packets = [] } = {}) {
    const requestBody = {
      model,
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      prompt_cache_key: `live-coach-rolling-digest:${MINI_ROLLING_DIGEST_PROMPT_VERSION}`,
      prompt_cache_retention: "in_memory",
      input: [
        { role: "developer", content: MINI_ROLLING_DIGEST_STATIC_PROMPT },
        { role: "user", content: JSON.stringify({ lastTurns, coachLines, packets }) },
      ],
      max_output_tokens: maxOutputTokens,
    };
    const startedAtMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`rolling digest failed: ${response.status} ${body.slice(0, 160)}`);
      }
      const payload = await response.json();
      const parsed = parseJsonObject(extractOpenAiResponseText(payload));
      const elapsedMs = Date.now() - startedAtMs;
      logLiveCoachDiagnostic(logger, "live_coach.rolling_digest.result", {
        elapsedMs,
        model: payload.model || model,
        packetCount: packets.length,
        relevantCount: Array.isArray(parsed.relevantKeys) ? parsed.relevantKeys.length : 0,
        droppedCount: Array.isArray(parsed.droppedKeys) ? parsed.droppedKeys.length : 0,
        usage: payload.usage || null,
      }, { elapsedMs });
      return parsed;
    } catch (error) {
      logger?.warn?.("live_coach.rolling_digest.error", {
        elapsedMs: Date.now() - startedAtMs,
        model,
        packetCount: packets.length,
        error: error.message,
      });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function createOpenAiSemanticContextJudge({ logger } = {}) {
  const enabled = boolFromEnv(process.env.LIVE_COACH_CONTEXT_JUDGE_ENABLED, false);
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!enabled || !apiKey) return null;

  const model = String(
    process.env.LIVE_COACH_CONTEXT_JUDGE_MODEL ||
      process.env.LIVE_COACH_MINI_MODEL ||
      "gpt-5.4-mini",
  ).trim();
  const serviceTier = cleanText(
    process.env.LIVE_COACH_CONTEXT_JUDGE_SERVICE_TIER ||
      process.env.LIVE_COACH_OPENAI_SERVICE_TIER ||
      "priority",
    80,
  );
  const promptCacheRetention = cleanText(
    process.env.LIVE_COACH_CONTEXT_JUDGE_PROMPT_CACHE_RETENTION ||
      process.env.LIVE_COACH_OPENAI_PROMPT_CACHE_RETENTION ||
      "in_memory",
    40,
  );
  const promptCacheScope = cleanText(
    process.env.LIVE_COACH_CONTEXT_JUDGE_PROMPT_CACHE_SCOPE || "global",
    40,
  );
  const timeoutMs = Math.max(2500, Number(process.env.LIVE_COACH_CONTEXT_JUDGE_TIMEOUT_MS || 6000) || 6000);
  const maxOutputTokens = Math.max(
    120,
    Math.min(1200, Number(process.env.LIVE_COACH_CONTEXT_JUDGE_MAX_OUTPUT_TOKENS || 550) || 550),
  );
  const staticPrompt = MINI_CONTEXT_JUDGE_STATIC_PROMPT;
  logLiveCoachDiagnostic(logger, "live_coach.context_judge.config", {
    enabled: true,
    model,
    serviceTier: serviceTier || null,
    promptCacheScope,
    promptCacheRetention: promptCacheRetention || null,
    promptVersion: MINI_CONTEXT_JUDGE_PROMPT_VERSION,
    maxOutputTokens,
    timeoutMs,
    staticPromptChars: staticPrompt.length,
  }, { force: true });

  return async function judgeWithOpenAi({
    session,
    transcript,
    context,
    deterministicCandidates = [],
    metadata = {},
    abortSignal,
  } = {}) {
    const candidates = (Array.isArray(deterministicCandidates) ? deterministicCandidates : [])
      .slice(0, 24)
      .map((candidate) => ({
        key: cleanText(candidate.key, 120),
        label: cleanText(candidate.label, 120),
        family: cleanText(candidate.family, 80),
        priority: Number(candidate.priority || 0),
        score: Number(candidate.score || 0),
        hits: Array.isArray(candidate.hits) ? candidate.hits.slice(0, 8).map((hit) => cleanText(hit, 80)) : [],
        fragment: cleanText(candidate.fragment || candidate.transcriptFragment || "", 220),
        summary: cleanText(candidate.guidance || candidate.summary || "", 240),
      }))
      .filter((candidate) => candidate.key);
    const recentProspect = (session?.memory?.transcripts || [])
      .filter((row) => row.role === "prospect")
      .slice(-10)
      .map((row) => cleanText(row.text, 320))
      .filter(Boolean);
    const recentFiltered = (session?.memory?.contexts || [])
      .slice(-8)
      .map((row) => ({
        phrase: cleanText(row.phraseText || row.text || "", 220),
        selectedKeys: Array.isArray(row.miniJudgement?.selectedKeys)
          ? row.miniJudgement.selectedKeys.slice(0, 6).map((key) => cleanText(key, 120)).filter(Boolean)
          : (Array.isArray(row.matches) ? row.matches.slice(0, 6).map((match) => cleanText(match.key, 120)).filter(Boolean) : []),
        snippets: [
          ...(Array.isArray(row.memoryBrief?.activeIssues) ? row.memoryBrief.activeIssues : []),
          ...(Array.isArray(row.miniJudgement?.memoryBrief?.activeIssues) ? row.miniJudgement.memoryBrief.activeIssues : []),
        ]
          .map((issue) => cleanText(issue?.snippet || "", 160))
          .filter(Boolean)
          .slice(0, 5),
        meaning: cleanText(row.miniJudgement?.transcriptMeaning || row.actionReason || "", 180),
      }))
      .filter((row) => row.phrase || row.selectedKeys.length || row.snippets.length || row.meaning);
    const thoughtBuffer = context?.thoughtBuffer || {};
    const dynamicPayload = {
      vad: transcript?.text || context?.phraseText || "",
      currentVad: thoughtBuffer.currentVad || {
        vadId: transcript?.id || context?.sourceTranscriptId || "",
        text: transcript?.text || context?.phraseText || "",
      },
      matched: buildGroupedMatchables(candidates),
      unresolvedVadBuffer: Array.isArray(thoughtBuffer.unresolved) ? thoughtBuffer.unresolved : [],
      bufferPolicy: {
        maxChars: Number(thoughtBuffer.maxChars || 0) || null,
        maxChunks: Number(thoughtBuffer.maxChunks || 0) || null,
        totalChars: Number(thoughtBuffer.totalChars || 0) || null,
        forceReleaseByCap: Boolean(thoughtBuffer.forceReleaseByCap),
      },
      localCompleteness: {
        completeThought: Boolean(context?.completeThought),
        reason: context?.completenessReason || "",
        localShouldCompose: Boolean(context?.shouldCompose),
        localActionReason: context?.actionReason || "",
      },
      recentProspect,
      recentFiltered,
    };
    const requestBody = {
      model,
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      prompt_cache_key: buildMiniContextJudgeCacheKey({
        model,
        metadata: {
          ...metadata,
          ...(context?.metadata || {}),
        },
        scope: promptCacheScope,
      }),
      ...(promptCacheRetention ? { prompt_cache_retention: promptCacheRetention } : {}),
      input: [
        {
          role: "developer",
          content: staticPrompt,
        },
        {
          role: "user",
          content: JSON.stringify(dynamicPayload),
        },
      ],
      max_output_tokens: maxOutputTokens,
    };

    const startedAtMs = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (abortSignal?.aborted) controller.abort();
    else abortSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn?.("live_coach.context_judge.http_error", {
          status: response.status,
          body: body.slice(0, 240),
        });
        throw new Error(`OpenAI context judge failed: ${response.status}`);
      }
      const payload = await response.json();
      const parsed = parseJsonObject(extractOpenAiResponseText(payload));
      const elapsedMs = Date.now() - startedAtMs;
      logLiveCoachDiagnostic(logger, "live_coach.context_judge.result", {
        elapsedMs,
        model: payload.model || model,
        serviceTier: serviceTier || null,
        promptCacheScope,
        promptCacheRetention: promptCacheRetention || null,
        candidateCount: candidates.length,
        matchGroupCount: Array.isArray(dynamicPayload.matched) ? dynamicPayload.matched.length : 0,
        unresolvedVadCount: Array.isArray(dynamicPayload.unresolvedVadBuffer) ? dynamicPayload.unresolvedVadBuffer.length : 0,
        forceReleaseByCap: Boolean(dynamicPayload.bufferPolicy?.forceReleaseByCap),
        shouldCompose: Boolean(parsed.shouldCompose),
        completeThought: Boolean(parsed.completeThought),
        approvedKeyCount: Array.isArray(parsed.approvedKeys) ? parsed.approvedKeys.length : 0,
        rejectedKeyCount: Array.isArray(parsed.rejected) ? parsed.rejected.length : 0,
        usage: payload.usage || null,
      }, { elapsedMs });
      return {
        ...parsed,
        provider: "openai",
        model: payload.model || model,
        usage: payload.usage || null,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAtMs;
      logger?.warn?.("live_coach.context_judge.error", {
        elapsedMs,
        model,
        serviceTier: serviceTier || null,
        candidateCount: candidates.length,
        error: error.message,
      });
      if (error?.name === "AbortError" || controller.signal.aborted || abortSignal?.aborted) {
        throw new Error(`OpenAI context judge timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener?.("abort", abortFromCaller);
    }
  };
}

function buildInternalAccessMiddleware(config) {
  const configuredSecret = String(config.internalServiceSecret || "").trim();
  const strictRuntime = String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";

  return (req, res, next) => {
    if (!configuredSecret && !strictRuntime) {
      req.user = { id: "local-ai-bus", role: "service", email: "local@ai-bus" };
      return next();
    }

    const providedSecret = String(
      req.headers["x-service-secret"] ||
        req.headers["x-internal-secret"] ||
        "",
    ).trim();

    if (configuredSecret && safeSecretEquals(providedSecret, configuredSecret)) {
      req.user = { id: "internal-service", role: "service", email: "internal@local" };
      return next();
    }

    return res.status(401).json({ ok: false, error: "Internal service secret required" });
  };
}

function buildDashboardAccessMiddleware() {
  const configuredToken = String(process.env.AI_BUS_DASHBOARD_TOKEN || "").trim();
  return (req, res, next) => {
    if (!configuredToken) return next();
    const provided = String(
      req.headers["x-ai-bus-dashboard-token"] ||
        req.query.accessToken ||
        req.query.dashboardToken ||
        req.body?.accessToken ||
        "",
    ).trim();
    if (provided && safeSecretEquals(provided, configuredToken)) return next();
    return res.status(401).json({ ok: false, error: "Live coach dashboard token required" });
  };
}

// Runtime-toggleable composer contemplativeness ("tier" = effort + thinking), flippable
// mid-day at the ai-bus (port 7000) via the dashboard endpoint with NO restart. The dialog
// composer reads getComposerTier() per request, so a toggle takes effect on the next turn.
// Default is medium effort with thinking OFF: adaptive thinking added 1-4s before the
// first visible token, which dominated coach-line latency on a live call. Dial UP to a
// thinking tier via the dashboard when contemplation matters more than speed. Override
// the boot default with LIVE_COACH_COMPOSER_TIER.
const COMPOSER_TIERS = Object.freeze({
  "high-thinking": { effort: "high", thinking: true },
  "medium-thinking": { effort: "medium", thinking: true },
  "medium-no-thinking": { effort: "medium", thinking: false },
  "low-no-thinking": { effort: "low", thinking: false },
});
const DEFAULT_COMPOSER_TIER = (() => {
  const fromEnv = String(process.env.LIVE_COACH_COMPOSER_TIER || "").trim().toLowerCase();
  return COMPOSER_TIERS[fromEnv] ? fromEnv : "medium-no-thinking";
})();
let liveComposerTier = DEFAULT_COMPOSER_TIER;
function getComposerTier() {
  return COMPOSER_TIERS[liveComposerTier] ? liveComposerTier : "high-thinking";
}
function setComposerTier(tier) {
  const normalized = String(tier || "").trim().toLowerCase();
  if (!COMPOSER_TIERS[normalized]) {
    return { ok: false, error: `unknown composer tier: ${tier}`, tier: getComposerTier(), tiers: Object.keys(COMPOSER_TIERS) };
  }
  liveComposerTier = normalized;
  return { ok: true, tier: liveComposerTier, config: COMPOSER_TIERS[liveComposerTier] };
}

function createAnthropicDialogComposer({ logger } = {}) {
  const enabled = boolFromEnv(process.env.LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED, false);
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!enabled || !apiKey) return null;

  const model = String(
    process.env.LIVE_COACH_ANTHROPIC_MODEL ||
      process.env.LIVE_COACH_SONNET_MODEL ||
      process.env.SALES_TRAINER_COACH_MODEL ||
      "claude-sonnet-4-6",
  ).trim();
  const timeoutMs = Math.max(3000, Number(process.env.LIVE_COACH_ANTHROPIC_TIMEOUT_MS || 15000) || 15000);
  const readTimeoutMs = Math.max(
    3000,
    Number(process.env.LIVE_COACH_ANTHROPIC_READ_TIMEOUT_MS || timeoutMs) || timeoutMs,
  );
  const maxTokens = Math.max(32, Math.min(500, Number(process.env.LIVE_COACH_ANTHROPIC_MAX_TOKENS || 160) || 160));
  // Thinking tiers need a larger output budget so adaptive thinking tokens (which count
  // toward max_tokens) don't crowd out the actual coach line.
  const thinkingMaxTokens = Math.max(
    maxTokens,
    Math.min(4000, Number(process.env.LIVE_COACH_ANTHROPIC_THINKING_MAX_TOKENS || 2000) || 2000),
  );
  logLiveCoachDiagnostic(logger, "live_coach.anthropic_composer.config", {
    enabled: true,
    model,
    defaultTier: getComposerTier(),
    defaultTierConfig: COMPOSER_TIERS[getComposerTier()],
    timeoutMs,
    readTimeoutMs,
    maxTokens,
    thinkingMaxTokens,
    deltaThrottleDefaultMs: Number(process.env.LIVE_COACH_COMPOSE_DELTA_THROTTLE_MS || 60) || 60,
  }, { force: true });

  return async function composeWithAnthropic({ dialog, onDelta, abortSignal } = {}) {
    const promptPayload = dialog?.promptPayload || {};
    if (!promptPayload.shouldCompose) {
      return { say: "", composer: "anthropic", model };
    }

    // Read the LIVE tier per request so a mid-day dashboard toggle takes effect next turn.
    const tier = COMPOSER_TIERS[getComposerTier()] || COMPOSER_TIERS["high-thinking"];
    const requestMaxTokens = tier.thinking ? thinkingMaxTokens : maxTokens;

    const startedAtMs = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    const abortFromCaller = () => abortController.abort();
    if (abortSignal?.aborted) abortController.abort();
    else abortSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
    let response;
    let reader = null;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: requestMaxTokens,
          stream: true,
          // Effort + thinking come from the live, mid-day-toggleable tier. When thinking is
          // on we omit temperature (sampling can conflict with thinking); when off we keep a
          // low temperature for fast, terse phrasing -- the prior behavior.
          output_config: { effort: tier.effort },
          ...(tier.thinking
            ? { thinking: { type: "adaptive" } }
            : { thinking: { type: "disabled" }, temperature: 0.25 }),
          // Stable standing directives ride a cache_control:ephemeral system prefix
          // (Anthropic prompt caching). Sent once, reused across turns; the per-turn
          // delta is the lean user message. If the prefix is under the cache minimum,
          // cache_control is simply ignored (no error) and we still save user tokens.
          system: promptPayload.systemCacheable
            ? [{ type: "text", text: String(promptPayload.system || "Return only the next agent line."), cache_control: { type: "ephemeral" } }]
            : (promptPayload.system || "Return only the next agent line."),
          messages: [{ role: "user", content: promptPayload.user || "" }],
        }),
        signal: abortController.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      abortSignal?.removeEventListener?.("abort", abortFromCaller);
      if (error?.name === "AbortError") {
        throw new Error(`Anthropic live coach timed out after ${timeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      clearTimeout(timeout);
      abortSignal?.removeEventListener?.("abort", abortFromCaller);
      logger?.warn?.("live_coach.anthropic_composer.http_error", {
        status: response.status,
        body: body.slice(0, 240),
      });
      throw new Error(`Anthropic live coach failed: ${response.status}`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      abortSignal?.removeEventListener?.("abort", abortFromCaller);
      throw new Error("Anthropic live coach response had no body");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let deltaCount = 0;
    let firstDeltaAtMs = 0;
    try {
      for (;;) {
        let readTimeout = null;
        const read = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            readTimeout = setTimeout(() => {
              abortController.abort();
              reject(new Error(`Anthropic live coach stream read timed out after ${readTimeoutMs}ms`));
            }, readTimeoutMs);
          }),
        ]).finally(() => {
          if (readTimeout) clearTimeout(readTimeout);
        });
        const { value, done } = read;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          if (data && data !== "[DONE]") {
            let event = null;
            try { event = JSON.parse(data); } catch {}
            const delta = event?.type === "content_block_delta" && event?.delta?.type === "text_delta"
              ? textValue(event.delta.text)
              : event?.type === "content_block_start"
                ? textValue(event.content_block?.text)
                : "";
            if (delta) {
              output += delta;
              deltaCount += 1;
              if (!firstDeltaAtMs) firstDeltaAtMs = Date.now();
              // Completeness gate: a bare "WAIT" is the coach's "not a complete thought"
              // hold sentinel, not a coach line. Suppress streaming ONLY while the output so
              // far IS the bare sentinel ("wait", or "wait" + trailing punctuation) -- the
              // same shape the final detection below uses. The instant a non-sentinel char
              // appears we stream, so legitimate lines (including ones opening "Wait, ..."
              // or "Was ...") never lose their first characters to the panel.
              const headTrim = output.trim();
              const stillMaybeWait = /^wait$/i.test(headTrim) || /^wait[\s.!,:;-]+$/i.test(headTrim);
              if (!stillMaybeWait) {
                onDelta?.(delta, cleanText(output, 1000));
              }
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error?.name === "AbortError" || abortController.signal.aborted || abortSignal?.aborted) {
        throw new Error("Anthropic live coach stream aborted");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      abortSignal?.removeEventListener?.("abort", abortFromCaller);
      await reader.cancel().catch(() => undefined);
    }

    // A leading "WAIT" means the coach judged the prospect had not completed a coachable
    // thought -> emit nothing as a coach line (the bus settles the dialog to a hold).
    const finalText = cleanText(output, 1000);
    const heldForIncompleteThought =
      /^\s*wait\b[\s.!,:;-]*$/i.test(output) ||
      finalText.replace(/[^a-z]/gi, "").toLowerCase() === "wait";
    const elapsedMs = Date.now() - startedAtMs;
    logLiveCoachDiagnostic(logger, "live_coach.anthropic_composer.result", {
      elapsedMs,
      firstDeltaMs: firstDeltaAtMs ? firstDeltaAtMs - startedAtMs : null,
      model,
      tier: getComposerTier(),
      tierConfig: tier,
      deltaCount,
      outputChars: finalText.length,
      heldForIncompleteThought,
      requestMaxTokens,
      systemCacheable: Boolean(promptPayload.systemCacheable),
      systemChars: cleanText(promptPayload.system || "", 20_000).length,
      userChars: cleanText(promptPayload.user || "", 20_000).length,
    }, { elapsedMs });
    return {
      say: heldForIncompleteThought ? "" : finalText,
      composer: "anthropic",
      model,
      heldForIncompleteThought,
    };
  };
}

function buildConfig() {
  const mongoEnabled = boolFromEnv(process.env.AI_BUS_MONGO_ENABLED, Boolean(process.env.MONGO_URI));
  const staleSweepIntervalMs = Math.max(
    15_000,
    Number(process.env.LIVE_COACH_STALE_SWEEP_INTERVAL_MS || 60_000) || 60_000,
  );
  const staleSweepMaxIdleMs = Math.max(
    60_000,
    Number(process.env.LIVE_COACH_STALE_MAX_IDLE_MS || 5 * 60_000) || 5 * 60_000,
  );
  const liveCoachHeartbeatIntervalMs = Math.max(
    1000,
    Number(process.env.LIVE_COACH_HEARTBEAT_INTERVAL_MS || 5000) || 5000,
  );
  const terminalPruneMaxAgeMs = Math.max(
    15_000,
    Number(process.env.LIVE_COACH_TERMINAL_PRUNE_MAX_AGE_MS || 2 * 60_000) || 2 * 60_000,
  );
  const terminalPruneMaxSessions = Math.max(
    0,
    Number(process.env.LIVE_COACH_TERMINAL_PRUNE_MAX_SESSIONS || 21) || 21,
  );
  return {
    ...getSharedConfig({
      // The AI playground can still boot without Mongo, but when a Mongo URI
      // is present we use it to bind RingCX stream UIIs to live agent calls.
      skipMongo: !mongoEnabled,
    }),
    serviceName: SERVICE_NAMES.aiBus,
    port: PORTS.aiBus,
    liveCoachStaleSweepEnabled: boolFromEnv(process.env.LIVE_COACH_STALE_SWEEP_ENABLED, true),
    liveCoachStaleSweepIntervalMs: staleSweepIntervalMs,
    liveCoachStaleMaxIdleMs: staleSweepMaxIdleMs,
    liveCoachHeartbeatIntervalMs,
    liveCoachTerminalPruneMaxAgeMs: terminalPruneMaxAgeMs,
    liveCoachTerminalPruneMaxSessions: terminalPruneMaxSessions,
  };
}

function createLiveCoachDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Coach</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #172033;
      --muted: #637083;
      --line: #d9dee7;
      --accent: #2563eb;
      --good: #047857;
      --warn: #b45309;
      --shadow: 0 14px 32px rgba(23, 32, 51, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.94);
      padding: 12px 16px;
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0;
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      padding: 3px 8px;
      white-space: nowrap;
    }
    .pill.strong {
      border-color: #bfdbfe;
      color: #1d4ed8;
      font-weight: 800;
    }
    .session-select {
      min-width: min(340px, 42vw);
      max-width: 42vw;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      color: var(--text);
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 4px 8px;
    }
    .link-button {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--accent);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      padding: 3px 9px;
      white-space: nowrap;
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      gap: 14px;
      padding: 14px;
    }
    section {
      min-height: 260px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
    }
    h2 {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .body {
      padding: 14px;
    }
    .heard-text {
      min-height: 175px;
      white-space: pre-wrap;
      font-size: 24px;
      line-height: 1.28;
      color: var(--text);
    }
    .heard-text.live {
      color: var(--muted);
      font-style: italic;
    }
    .say-text {
      min-height: 175px;
      white-space: pre-wrap;
      font-size: 28px;
      font-weight: 750;
      line-height: 1.22;
      color: #0f172a;
    }
    .empty {
      color: var(--muted);
      font-size: 18px;
      font-weight: 500;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .coach-ready { color: var(--good); }
    .coach-wait { color: var(--warn); }
    button {
      align-self: stretch;
      border: 1px solid #1d4ed8;
      border-radius: 7px;
      background: var(--accent);
      color: white;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      padding: 0 14px;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .modal[hidden] { display: none; }
    .modal {
      position: fixed;
      inset: 0;
      z-index: 10;
      display: grid;
      place-items: center;
      background: rgba(15, 23, 42, 0.36);
      padding: 18px;
    }
    .modal-panel {
      width: min(760px, 100%);
      max-height: 82vh;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 22px 60px rgba(15, 23, 42, 0.22);
      overflow: hidden;
    }
    .modal-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      padding: 12px 14px;
    }
    .modal-title {
      font-size: 14px;
      font-weight: 800;
    }
    .chat {
      max-height: 62vh;
      overflow-y: auto;
      background: #f8fafc;
      padding: 14px;
    }
    .bubble-row {
      display: flex;
      margin-bottom: 10px;
    }
    .bubble-row.right { justify-content: flex-end; }
    .bubble {
      max-width: 82%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 9px 10px;
      white-space: pre-wrap;
      line-height: 1.35;
      box-shadow: 0 2px 10px rgba(15, 23, 42, 0.05);
    }
    .bubble.prospect { border-color: #bfdbfe; }
    .bubble.agent { background: #111827; color: #fff; }
    .bubble.system { border-color: #fde68a; background: #fffbeb; }
    .bubble.live { border-style: dashed; opacity: 0.78; }
    .bubble-meta {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .heard-text { font-size: 20px; }
      .say-text { font-size: 23px; }
      button { min-height: 42px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>RingCX Live Coach</h1>
    <div class="status">
      <select class="session-select" id="session-select" aria-label="Live coach session">
        <option>waiting for live stream</option>
      </select>
      <span class="pill" id="session">no session</span>
      <span class="pill" id="state">idle</span>
      <span class="pill" id="updated">waiting</span>
    </div>
  </header>
  <main>
    <section>
      <div class="section-head">
        <h2>Prospect Said</h2>
        <div class="status">
          <button type="button" class="link-button" id="context-button">Transcript <span id="context-count">0</span></button>
          <span class="pill" id="heard-source">transcript</span>
        </div>
      </div>
      <div class="body">
        <div class="heard-text empty" id="heard">Waiting for prospect speech...</div>
        <div class="meta" id="heard-meta"></div>
      </div>
    </section>
    <section>
      <div class="section-head">
        <h2>Say This Next</h2>
        <span class="pill" id="dialog-status">waiting</span>
      </div>
      <div class="body">
        <div class="say-text empty" id="say">Coach line will appear here.</div>
        <div class="meta" id="say-meta"></div>
      </div>
    </section>
  </main>
  <div class="modal" id="context-modal" hidden>
    <div class="modal-panel">
      <div class="modal-head">
        <div>
          <div class="modal-title">Transcript context</div>
          <div class="status">Actual call transcript collected for this coach session</div>
        </div>
        <button type="button" class="link-button" id="context-close">Close</button>
      </div>
      <div class="chat" id="context-chat"></div>
    </div>
  </div>
  <script>
    const els = {
      session: document.getElementById("session"),
      state: document.getElementById("state"),
      updated: document.getElementById("updated"),
      heard: document.getElementById("heard"),
      heardMeta: document.getElementById("heard-meta"),
      heardSource: document.getElementById("heard-source"),
      say: document.getElementById("say"),
      sayMeta: document.getElementById("say-meta"),
      dialogStatus: document.getElementById("dialog-status"),
      contextButton: document.getElementById("context-button"),
      contextClose: document.getElementById("context-close"),
      contextModal: document.getElementById("context-modal"),
      contextChat: document.getElementById("context-chat"),
      contextCount: document.getElementById("context-count"),
      sessionSelect: document.getElementById("session-select"),
    };

    let activeSessionId = "";
    let selectedSessionId = "";
    let eventSource = null;
    let conversationItems = [];

    const fmtTime = (value) => {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    };

    function setText(el, text, emptyText) {
      const clean = String(text || "").trim();
      el.textContent = clean || emptyText;
      el.classList.toggle("empty", !clean);
    }

    function lastSentence(value) {
      const clean = String(value || "").replace(/\\s+/g, " ").trim();
      if (!clean) return "";
      const matches = clean.match(/[^.!?]+[.!?]*/g) || [];
      return (matches.map((part) => part.trim()).filter(Boolean).pop()) || clean;
    }

    function shortId(value, length = 10) {
      const clean = String(value || "").trim();
      if (!clean) return "";
      return clean.length <= length ? clean : clean.slice(-length);
    }

    function isTerminalSession(session) {
      return ["stopped", "stale", "voicemail_rejected", "released"].includes(String(session?.status || ""));
    }

    function isRejectedSession(session) {
      const status = String(session?.status || "");
      const dialogStatus = String(session?.latest?.dialog?.status || "");
      return status === "voicemail_rejected" ||
        dialogStatus === "rejected" ||
        Number(session?.counters?.voicemailRejected || 0) > 0;
    }

    function isLiveSession(session) {
      const source = String(session?.metadata?.source || "").toLowerCase();
      if (source.includes("fixture")) return false;
      return source.includes("grpc") || source === "mongo-cx";
    }

    function sessionSortMs(session) {
      return Date.parse(session?.lastEventAt || session?.updatedAt || session?.createdAt || "") || 0;
    }

    // Prefer sessions with real signal over empty control-plane shells (see the
    // wallboard's sessionSignalScore for rationale). Signal counts only while
    // fresh (30s): live audio refreshes lastEventAt every ~2.5s.
    function sessionSignalScore(session) {
      const latest = session?.latest || {};
      let score = 0;
      if (latest.dialog) score += 4;
      if (latest.transcript?.text || latest.provisionalTranscript?.text) score += 4;
      if (latest.context) score += 2;
      if (Number(session?.counters?.input || 0) > 0) score += 2;
      if (latest.streamStatus) score += 1;
      if (session?.metadata?.streamId) score += 1;
      return score;
    }

    function sessionPickRank(session) {
      const updatedMs = sessionSortMs(session);
      if (!updatedMs || Date.now() - updatedMs > 30000) return 0;
      return sessionSignalScore(session);
    }

    function sessionLabel(session) {
      const metadata = session?.metadata || {};
      return metadata.agentName ||
        metadata.agentEmail ||
        (metadata.agentExtension ? "ext " + metadata.agentExtension : "") ||
        metadata.contactName ||
        (metadata.phone ? "phone " + metadata.phone : "") ||
        (metadata.streamId ? "stream " + shortId(metadata.streamId, 8) : "") ||
        session?.id?.slice(0, 18) ||
        "live stream";
    }

    function sessionOptionLabel(session) {
      const metadata = session?.metadata || {};
      return [
        sessionLabel(session),
        metadata.phone ? "phone " + metadata.phone : "",
        metadata.uii ? "UII " + shortId(metadata.uii, 10) : "",
        metadata.streamId ? "stream " + shortId(metadata.streamId, 8) : "",
        isTerminalSession(session) ? session.status : "live",
      ].filter(Boolean).join(" | ");
    }

    function metadataPills(session, transcript = null) {
      const metadata = session?.metadata || {};
      return [
        metadata.source || "",
        metadata.agentName ? "agent " + metadata.agentName : "",
        metadata.agentExtension ? "ext " + metadata.agentExtension : "",
        metadata.phone ? "phone " + metadata.phone : "",
        metadata.uii ? "uii " + shortId(metadata.uii, 12) : "",
        metadata.streamId ? "stream " + shortId(metadata.streamId, 8) : "",
        transcript?.at ? "heard " + fmtTime(transcript.at) : "",
        transcript?.wordCount ? transcript.wordCount + " words" : "",
        transcript?.durationSec ? transcript.durationSec + "s" : "",
      ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + escapeHtml(x) + "</span>").join("");
    }

    function transcriptItem(transcript, forceLive) {
      const text = String(transcript?.text || "").trim();
      if (!text) return null;
      const role = transcript.role || "prospect";
      const live = Boolean(forceLive || transcript.provisional);
      return {
        id: live
          ? "pv:" + (transcript.itemId || transcript.id || role)
          : "tr:" + (transcript.itemId || transcript.id || transcript.at || text),
        at: transcript.at || new Date().toISOString(),
        side: role === "agent" ? "agent" : role === "system" || role === "unknown" ? "system" : "prospect",
        label: role === "agent" ? "Agent" : role === "system" ? "System" : role === "unknown" ? "Unknown" : "Prospect",
        text,
        provisional: live,
      };
    }

    function mergeConversationItem(item) {
      if (!item) return;
      const withoutReplacedLive = item.provisional
        ? conversationItems
        : conversationItems.filter((existing) => !(existing.provisional && existing.side === item.side));
      const index = withoutReplacedLive.findIndex((existing) => existing.id === item.id);
      conversationItems = index >= 0
        ? withoutReplacedLive.map((existing, rowIndex) => rowIndex === index ? item : existing)
        : withoutReplacedLive.concat(item);
      conversationItems = conversationItems
        .sort((left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0))
        .slice(-120);
      renderContext();
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
    }

    const dashboardToken = new URLSearchParams(window.location.search).get("accessToken") || "";
    function dashboardUrl(path) {
      if (!dashboardToken) return path;
      return path + (path.includes("?") ? "&" : "?") + "accessToken=" + encodeURIComponent(dashboardToken);
    }

    function renderContext() {
      els.contextCount.textContent = String(conversationItems.length);
      els.contextChat.innerHTML = conversationItems.length
        ? conversationItems.map((item) => {
          const right = item.side === "agent";
          return "<div class=\\"bubble-row " + (right ? "right" : "") + "\\">" +
            "<div class=\\"bubble " + item.side + (item.provisional ? " live" : "") + "\\">" +
              "<div class=\\"bubble-meta\\"><span>" + escapeHtml(item.provisional ? item.label + " live" : item.label) + "</span><span>" + escapeHtml(fmtTime(item.at)) + "</span></div>" +
              "<div>" + escapeHtml(item.text) + "</div>" +
            "</div>" +
          "</div>";
        }).join("")
        : "<div class=\\"bubble system\\">Transcript context will fill in as transcript arrives.</div>";
      els.contextChat.scrollTop = els.contextChat.scrollHeight;
    }

    function renderSession(session) {
      if (!session) return;
      els.session.textContent = sessionLabel(session);
      els.session.className = "pill strong";
      els.state.textContent = session.status || "unknown";
      els.updated.textContent = session.lastEventAt ? fmtTime(session.lastEventAt) : "new";
      const provisional = session.latest?.provisionalTranscript;
      const transcript = provisional || session.latest?.transcript;
      const dialog = session.latest?.dialog;
      if (transcript?.role === "prospect") {
        mergeConversationItem(transcriptItem(transcript, Boolean(provisional?.text)));
        setText(els.heard, lastSentence(transcript.text), "Waiting for prospect speech...");
        els.heard.classList.toggle("live", Boolean(provisional?.text));
        els.heardSource.textContent = provisional?.text
          ? "live transcript"
          : transcript.model || transcript.source || "transcript";
        els.heardMeta.innerHTML = metadataPills(session, transcript);
      }
      if (dialog) {
        setText(els.say, dialog.say, dialog.status === "rejected" ? "Call rejected for voicemail match." : "Coach line will appear here.");
        els.dialogStatus.textContent = dialog.label || dialog.status || "waiting";
        els.dialogStatus.className = "pill " + (dialog.status === "ready" ? "coach-ready" : "coach-wait");
        els.sayMeta.innerHTML = [
          dialog.at ? "updated " + fmtTime(dialog.at) : "",
          dialog.status || "",
          dialog.guidance || "",
        ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + x + "</span>").join("");
      }
    }

    function handleEvent(payload) {
      if (payload.session) renderSession(payload.session);
      if (payload.provisionalTranscript?.role === "prospect") {
        mergeConversationItem(transcriptItem(payload.provisionalTranscript, true));
        setText(els.heard, lastSentence(payload.provisionalTranscript.text), "Waiting for prospect speech...");
        els.heard.classList.add("live");
        els.heardSource.textContent = "live transcript";
        els.heardMeta.innerHTML = [
          payload.provisionalTranscript.at ? "heard " + fmtTime(payload.provisionalTranscript.at) : "",
          payload.provisionalTranscript.wordCount ? payload.provisionalTranscript.wordCount + " words" : "",
        ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + x + "</span>").join("");
      }
      if (payload.transcript?.role === "prospect") {
        mergeConversationItem(transcriptItem(payload.transcript, false));
        setText(els.heard, lastSentence(payload.transcript.text), "Waiting for prospect speech...");
        els.heard.classList.remove("live");
        els.heardSource.textContent = payload.transcript.model || payload.transcript.source || "transcript";
        els.heardMeta.innerHTML = [
          payload.transcript.at ? "heard " + fmtTime(payload.transcript.at) : "",
          payload.transcript.wordCount ? payload.transcript.wordCount + " words" : "",
        ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + x + "</span>").join("");
      }
      if (payload.dialog) {
        const rejected = payload.dialog.status === "rejected";
        setText(els.say, payload.dialog.say, rejected ? "Call rejected for voicemail match." : "Coach line will appear here.");
        els.dialogStatus.textContent = payload.dialog.label || payload.dialog.status || "waiting";
        els.dialogStatus.className = "pill " + (payload.dialog.status === "ready" ? "coach-ready" : "coach-wait");
        els.sayMeta.innerHTML = [
          payload.dialog.at ? "updated " + fmtTime(payload.dialog.at) : "",
          payload.dialog.status || "",
          payload.dialog.guidance || "",
        ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + x + "</span>").join("");
      }
      els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
    }

    async function loadSessions() {
      const response = await fetch(dashboardUrl("/api/ai/live-coach/dashboard/sessions"));
      const data = await response.json();
      const sessions = (Array.isArray(data.sessions) ? data.sessions : [])
        .filter(isLiveSession)
        .sort((a, b) => {
          const rankDelta = sessionPickRank(b) - sessionPickRank(a);
          if (rankDelta) return rankDelta;
          return sessionSortMs(b) - sessionSortMs(a);
        });
      const active = sessions.filter((session) => !isTerminalSession(session));
      const selectedStillExists = selectedSessionId && active.some((session) => session.id === selectedSessionId);
      const latest = selectedStillExists
        ? active.find((session) => session.id === selectedSessionId)
        : active[0];

      els.sessionSelect.innerHTML = active.length
        ? active.map((session) => "<option value=\\"" + escapeHtml(session.id) + "\\">" + escapeHtml(sessionOptionLabel(session)) + "</option>").join("")
        : "<option value=\\"\\">waiting for live stream</option>";

      if (!latest) {
        selectedSessionId = "";
        els.session.textContent = "waiting for RingCX stream";
        els.session.className = "pill";
        els.state.textContent = "idle";
        els.updated.textContent = "no live sessions";
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        activeSessionId = "";
        return;
      }
      selectedSessionId = latest.id;
      els.sessionSelect.value = latest.id;
      renderSession(latest);
      if (latest.id !== activeSessionId) {
        activeSessionId = latest.id;
        if (eventSource) eventSource.close();
        conversationItems = [];
        renderContext();
        eventSource = new EventSource(dashboardUrl("/api/ai/live-coach/dashboard/sessions/" + encodeURIComponent(latest.id) + "/events"));
        eventSource.addEventListener("snapshot", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("transcript.provisional", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("transcript", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("context.clear", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("dialog", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("voicemail.reject", (event) => handleEvent(JSON.parse(event.data)));
        eventSource.addEventListener("session.stop", (event) => handleEvent(JSON.parse(event.data)));
      }
    }

    let loadSessionsInFlight = false;
    async function refreshSessions() {
      if (loadSessionsInFlight) return;
      loadSessionsInFlight = true;
      try {
        await loadSessions();
      } catch (error) {
        console.warn("live coach session refresh failed", error);
      } finally {
        loadSessionsInFlight = false;
      }
    }

    els.sessionSelect.addEventListener("change", () => {
      selectedSessionId = els.sessionSelect.value || "";
      activeSessionId = "";
      refreshSessions();
    });

    els.contextButton.addEventListener("click", () => {
      renderContext();
      els.contextModal.hidden = false;
    });
    els.contextClose.addEventListener("click", () => {
      els.contextModal.hidden = true;
    });
    els.contextModal.addEventListener("click", (event) => {
      if (event.target === els.contextModal) els.contextModal.hidden = true;
    });

    refreshSessions();
    renderContext();
    setInterval(refreshSessions, 1500);
  </script>
</body>
</html>`;
}

function createLiveCoachWallboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RingCX Live Coach</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --text: #172033;
      --muted: #647084;
      --line: #d7dde8;
      --blue: #2563eb;
      --green: #047857;
      --amber: #b45309;
      --red: #b91c1c;
      --shadow: 0 10px 28px rgba(23, 32, 51, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.95);
      padding: 11px 14px;
      backdrop-filter: blur(10px);
    }
    h1 {
      margin: 0;
      font-size: 16px;
      letter-spacing: 0;
    }
    .status {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: center;
      gap: 7px;
      color: var(--muted);
      font-size: 12px;
    }
    button.action {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-weight: 750;
      padding: 3px 9px;
      white-space: nowrap;
    }
    button.action:disabled {
      cursor: wait;
      opacity: 0.6;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      padding: 3px 8px;
      white-space: nowrap;
    }
    .pill.live { border-color: #bfdbfe; color: var(--blue); font-weight: 800; }
    .pill.waiting { color: var(--amber); }
    .pill.rejected { border-color: #fecaca; color: var(--red); font-weight: 800; }
    .phase-text.flash {
      border-left: 4px solid #ef4444;
      background: #fff7f7;
      color: #991b1b;
      padding: 8px 10px;
      font-weight: 760;
    }
    main {
      display: grid;
      grid-template-columns: repeat(var(--lane-count, 3), minmax(0, 1fr));
      gap: 12px;
      padding: 12px;
      /* Scales with dynamic lane count: extra agents scroll horizontally
         instead of crushing every lane. */
      min-width: calc(var(--lane-count, 3) * 393px);
    }
    .lane {
      display: grid;
      grid-template-rows: auto minmax(150px, 1fr) minmax(150px, 1fr) minmax(180px, 1.15fr);
      gap: 10px;
      min-height: calc(100vh - 78px);
    }
    .lane-head,
    .phase {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .lane-head {
      padding: 10px 11px;
    }
    .agent-name {
      margin: 0 0 6px;
      font-size: 17px;
      font-weight: 850;
    }
    .agent-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      color: var(--muted);
      font-size: 11px;
    }
    .phase-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      border-bottom: 1px solid var(--line);
      padding: 8px 10px;
    }
    h2 {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      font-weight: 850;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .phase-body {
      padding: 10px;
    }
    .phase-text {
      min-height: 82px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 16px;
      line-height: 1.32;
    }
    .dialog-text {
      font-size: 19px;
      font-weight: 780;
      line-height: 1.26;
    }
    .context-text {
      font-size: 14px;
      color: #253044;
    }
    .empty {
      color: var(--muted);
      font-weight: 500;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 9px;
      color: var(--muted);
      font-size: 11px;
    }
    @media (max-width: 1180px) {
      main {
        min-width: 0;
        grid-template-columns: 1fr;
      }
      .lane {
        min-height: auto;
      }
    }
  </style>
</head>
<body>
  <header>
    <h1>RingCX Live Coach</h1>
    <div class="status">
      <span class="pill live" id="live-count">0 live</span>
      <span class="pill" id="sync-summary">sync waiting</span>
      <button class="action" id="sync-current" type="button">Sync current calls</button>
      <span class="pill" id="updated">waiting</span>
    </div>
  </header>
  <main id="lanes"></main>
  <script>
    const SHOW_UNBOUND = new URLSearchParams(window.location.search).get("debug") === "unbound";
    // Pinned lanes always render (known floor). Any OTHER agent with a live
    // session or a fresh call event gets a dynamic lane derived from their
    // identity. Identity-less sessions are OPTIMISTICALLY placed into the agent
    // lane whose fresh cx.call.placed event matches their phone (the event
    // knows agent+phone, the stream knows phone+uii) and the bridge's
    // enrichment heals the metadata in the background — the floor never sees
    // an "unbound" lane. Phone-labeled lanes appear only for sessions that
    // stay orphaned >60s; the debug Unbound lane only with ?debug=unbound.
    const PINNED_AGENTS = [
      { key: "cbolt", label: "Chris Bolt", aliases: ["cbolt", "cbolt@", "chrisbolt", "chris bolt", "63914586004"] },
      { key: "bhansen", label: "Brad Hansen", aliases: ["bhansen", "bhansen@", "bradhansen", "brad hansen", "63914587004"] },
      { key: "jsharp", label: "J. Sharp", aliases: ["jsharp", "jsharp@", "james sharp", "jay sharp", "63914621004"] },
    ];
    const UNBOUND_LANE = { key: "unbound", label: "Unbound Stream", aliases: [], fallback: true };
    let lanes = PINNED_AGENTS.concat(SHOW_UNBOUND ? [UNBOUND_LANE] : []);
    let laneSignature = "";

    const els = {
      lanes: document.getElementById("lanes"),
      liveCount: document.getElementById("live-count"),
      syncSummary: document.getElementById("sync-summary"),
      syncCurrent: document.getElementById("sync-current"),
      updated: document.getElementById("updated"),
    };
    const laneState = new Map();
    const eventSources = new Map();
    const VOICEMAIL_FLASH_MS = 5000;
    const dashboardToken = new URLSearchParams(window.location.search).get("accessToken") || "";

    function dashboardUrl(path) {
      if (!dashboardToken) return path;
      return path + (path.includes("?") ? "&" : "?") + "accessToken=" + encodeURIComponent(dashboardToken);
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
    }

    function fmtTime(value) {
      if (!value) return "";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }

    function shortId(value, length = 10) {
      const clean = String(value || "").trim();
      if (!clean) return "";
      return clean.length <= length ? clean : clean.slice(-length);
    }

    function compactAgentText(session) {
      const metadata = session?.metadata || {};
      return [
        metadata.agentEmail || "",
        metadata.agentEmail ? String(metadata.agentEmail).split("@")[0] : "",
        metadata.agentName || "",
        metadata.agentExtension || "",
        metadata.agentExtensionId || "",
        // Phone digits so identity-less sessions can match their per-phone lane
        // (live dialogInits carry no agent identity — phone is often all we have).
        String(metadata.phone || "").replace(/\D/g, ""),
      ].join(" ").toLowerCase().replace(/[^a-z0-9@+._ -]+/g, "");
    }

    function compactCallEventText(event) {
      return [
        event?.agentEmail || "",
        event?.agentEmail ? String(event.agentEmail).split("@")[0] : "",
        event?.agentName || "",
        event?.extensionId || "",
        event?.agentExtension || "",
        event?.agentExtensionId || "",
      ].join(" ").toLowerCase().replace(/[^a-z0-9@+._ -]+/g, "");
    }

    function agentMatches(agent, session) {
      const haystack = compactAgentText(session);
      return agent.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
    }

    function callEventMatches(agent, event) {
      const haystack = compactCallEventText(event);
      return agent.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
    }

    function matchesKnownAgent(session) {
      return lanes
        .filter((agent) => !agent.fallback)
        .some((agent) => agentMatches(agent, session));
    }

    function sessionHasAgentIdentity(session) {
      const metadata = session?.metadata || {};
      return Boolean(String(
        metadata.agentExtension || metadata.agentExtensionId || metadata.agentEmail || metadata.agentName || "",
      ).trim());
    }

    function sessionAgeMs(session) {
      const createdMs = Date.parse(session?.createdAt || "") || 0;
      return createdMs ? Date.now() - createdMs : 0;
    }

    function agentRecentEventPhones(agent, callEvents) {
      const phones = new Set();
      const maxAgeMs = 3 * 60 * 1000;
      for (const event of callEvents || []) {
        if (!event || event.expired) continue;
        const ms = callEventSortMs(event);
        if (!ms || Date.now() - ms > maxAgeMs) continue;
        if (!callEventMatches(agent, event)) continue;
        const digits = String(event.phone || "").replace(/\D/g, "");
        if (digits) phones.add(digits);
      }
      return phones;
    }

    // Optimistic attribution: an identity-less session whose phone matches one
    // of this agent's fresh call events belongs in this agent's lane NOW;
    // bridge enrichment makes it authoritative moments later (healing).
    function sessionMatchesAgentOptimistically(agent, session, callEvents) {
      if (agentMatches(agent, session)) return true;
      if (sessionHasAgentIdentity(session)) return false;
      const digits = String(session?.metadata?.phone || "").replace(/\D/g, "");
      if (!digits) return false;
      return agentRecentEventPhones(agent, callEvents).has(digits);
    }

    function dynamicLaneFromIdentity(ext, email, name, phone, session) {
      const cleanExt = String(ext || "").trim();
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanName = String(name || "").trim();
      const cleanPhone = String(phone || "").replace(/\D/g, "");
      if (!cleanExt && !cleanEmail && !cleanName) {
        // Last-resort visibility: only a PERSISTENT orphan (alive >60s with no
        // attribution) earns a phone lane — transient pre-event gaps stay
        // invisible because optimistic attribution or enrichment claims them.
        if (!cleanPhone || cleanPhone.length < 7) return null;
        if (!session || sessionAgeMs(session) < 60_000) return null;
        return {
          key: "dyn-ph-" + cleanPhone,
          label: "Phone " + cleanPhone.replace(/^(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3"),
          aliases: [cleanPhone],
          dynamic: true,
        };
      }
      const key = "dyn-" + (cleanExt || cleanEmail || cleanName).toLowerCase().replace(/[^a-z0-9@._-]+/g, "-").slice(0, 60);
      const aliases = [
        cleanExt,
        cleanEmail,
        cleanEmail ? cleanEmail.split("@")[0] : "",
        cleanName.toLowerCase(),
      ].filter(Boolean);
      const label = cleanName || (cleanEmail ? cleanEmail.split("@")[0] : "Ext " + cleanExt);
      return { key, label, aliases, dynamic: true };
    }

    function deriveDynamicLanes(sessions, callEvents) {
      const dynamic = new Map();
      // 1. Event-derived agent lanes first (events always carry agent identity)
      //    so identity-less sessions can be optimistically claimed by them.
      const maxEventAgeMs = 3 * 60 * 1000;
      for (const event of callEvents || []) {
        if (!event || event.expired) continue;
        const ms = callEventSortMs(event);
        if (!ms || Date.now() - ms > maxEventAgeMs) continue;
        if (PINNED_AGENTS.some((agent) => callEventMatches(agent, event))) continue;
        const lane = dynamicLaneFromIdentity(
          event.extensionId || event.agentExtension || event.agentExtensionId,
          event.agentEmail,
          event.agentName,
        );
        if (lane && !dynamic.has(lane.key)) dynamic.set(lane.key, lane);
      }
      // 2. Session-derived lanes: identified sessions get their agent lane;
      //    identity-less sessions claimed by ANY lane's fresh event-phone stay
      //    laneless (they render inside that agent's lane); persistent orphans
      //    (>60s, unclaimed) earn a last-resort phone lane.
      const claimLanes = PINNED_AGENTS.concat([...dynamic.values()]);
      for (const session of sessions || []) {
        if (!isDisplayable(session)) continue;
        if (claimLanes.some((agent) => sessionMatchesAgentOptimistically(agent, session, callEvents))) continue;
        const metadata = session.metadata || {};
        const lane = dynamicLaneFromIdentity(
          metadata.agentExtension || metadata.agentExtensionId,
          metadata.agentEmail,
          metadata.agentName,
          metadata.phone,
          session,
        );
        if (lane && !dynamic.has(lane.key)) dynamic.set(lane.key, lane);
      }
      const rows = [...dynamic.values()].sort((a, b) => a.label.localeCompare(b.label));
      if (SHOW_UNBOUND) rows.push(UNBOUND_LANE);
      return rows;
    }

    function syncLanes(sessions, callEvents) {
      const desired = PINNED_AGENTS.concat(deriveDynamicLanes(sessions, callEvents));
      const signature = desired.map((lane) => lane.key).join("|");
      if (signature === laneSignature) return;
      laneSignature = signature;
      const desiredKeys = new Set(desired.map((lane) => lane.key));
      for (const key of [...eventSources.keys()]) {
        if (!desiredKeys.has(key)) closeLaneSource({ key });
      }
      for (const key of [...laneState.keys()]) {
        if (!desiredKeys.has(key)) laneState.delete(key);
      }
      lanes = desired;
      renderShell();
    }

    function isTerminalSession(session) {
      return ["stopped", "stale", "voicemail_rejected", "released"].includes(String(session?.status || ""));
    }

    function isLiveSession(session) {
      const source = String(session?.metadata?.source || "").toLowerCase();
      if (source.includes("fixture")) return false;
      return source.includes("grpc") || source === "mongo-cx";
    }

    function sessionSortMs(session) {
      return Date.parse(session?.lastEventAt || session?.updatedAt || session?.createdAt || "") || 0;
    }

    function callEventSortMs(event) {
      return Date.parse(event?.createdAt || "") || 0;
    }

    function isRecentlyUpdated(session, windowMs = 180000) {
      const updatedMs = sessionSortMs(session);
      return updatedMs && Date.now() - updatedMs <= windowMs;
    }

    // Prefer sessions with real signal (audio/transcript/context/dialog) over
    // empty control-plane shells: sync-current re-ensures coach-cx shells every
    // 10s, which keeps bumping their recency, so "newest active" can stare at a
    // ghost while the session that actually has the stream sits underneath.
    function sessionSignalScore(session) {
      const latest = session?.latest || {};
      let score = 0;
      if (latest.dialog) score += 4;
      if (latest.transcript?.text || latest.provisionalTranscript?.text) score += 4;
      if (latest.context) score += 2;
      if (Number(session?.counters?.input || 0) > 0) score += 2;
      if (latest.streamStatus) score += 1;
      if (session?.metadata?.streamId) score += 1;
      return score;
    }

    // Signal only counts while FRESH: flowing audio refreshes lastEventAt every
    // ~2.5s (stream-status), so a live session always qualifies, while a dead
    // unstopped session from the previous call ages out of preference in 30s
    // instead of masking the new call until the 5-minute stale sweep.
    function sessionPickRank(session) {
      if (!isRecentlyUpdated(session, 30000)) return 0;
      return sessionSignalScore(session);
    }

    function isActiveFlash(flash) {
      return Boolean(flash?.expiresAt && Date.now() < flash.expiresAt);
    }

    function isDisplayable(session) {
      if (!isLiveSession(session)) return false;
      if (isRejectedSession(session)) return false;
      return !isTerminalSession(session);
    }

    function sessionWaitingForRingCxStream(session) {
      if (!session || isTerminalSession(session)) return false;
      const metadata = session?.metadata || {};
      const source = String(metadata.source || "").toLowerCase();
      const inputCount = Number(session?.counters?.input || 0);
      const hasTranscript = Boolean(session?.latest?.provisionalTranscript?.text || session?.latest?.transcript?.text);
      return source === "mongo-cx" && !metadata.streamId && inputCount <= 0 && !hasTranscript;
    }

    function eventMatchesFinishedSession(agent, event, sessions) {
      return (sessions || []).some((session) => {
        if (!isTerminalSession(session) || !agentMatches(agent, session)) return false;
        const metadata = session?.metadata || {};
        const eventUii = String(event?.uii || "");
        const sessionUii = String(metadata.uii || "");
        if (eventUii && sessionUii && eventUii === sessionUii) return true;
        const eventQueue = String(event?.queueItemId || "");
        const sessionQueue = String(metadata.queueItemId || "");
        if (eventQueue && sessionQueue && eventQueue === sessionQueue) return true;
        const eventPhone = String(event?.phone || "").replace(/\\D/g, "");
        const sessionPhone = String(metadata.phone || "").replace(/\\D/g, "");
        return Boolean(eventPhone && sessionPhone && eventPhone === sessionPhone);
      });
    }

    function pickSessionForAgent(agent, sessions, callEvents) {
      const bySignalThenRecency = (a, b) => {
        const activeDelta = Number(isTerminalSession(a)) - Number(isTerminalSession(b));
        if (activeDelta) return activeDelta;
        const rankDelta = sessionPickRank(b) - sessionPickRank(a);
        if (rankDelta) return rankDelta;
        return sessionSortMs(b) - sessionSortMs(a);
      };
      if (agent.fallback) {
        return sessions
          .filter((session) => isDisplayable(session) && !matchesKnownAgent(session))
          .sort(bySignalThenRecency)[0] || null;
      }
      return sessions
        .filter((session) => isDisplayable(session) && sessionMatchesAgentOptimistically(agent, session, callEvents))
        .sort(bySignalThenRecency)[0] || null;
    }

    function buildVoicemailFlash(source) {
      const session = source?.session || source;
      const transcript = source?.transcript || session?.latest?.transcript || null;
      const dialog = source?.dialog || session?.latest?.dialog || null;
      const text = transcript?.text
        ? "Voicemail detected. " + transcript.text
        : "Voicemail detected. Coach cleared this call.";
      return {
        text,
        at: source?.at || dialog?.at || transcript?.at || session?.lastEventAt || new Date().toISOString(),
        source: "voicemail gate",
        wordCount: transcript?.wordCount || 0,
        guidance: dialog?.guidance || "",
        phone: session?.metadata?.phone || "",
        uii: session?.metadata?.uii || "",
        expiresAt: Date.now() + VOICEMAIL_FLASH_MS,
      };
    }

    function pickRecentRejectedForAgent(agent, sessions) {
      return (sessions || [])
        .filter((session) => isRejectedSession(session) && agentMatches(agent, session))
        .filter((session) => isRecentlyUpdated(session, VOICEMAIL_FLASH_MS))
        .sort((a, b) => sessionSortMs(b) - sessionSortMs(a))[0] || null;
    }

    function pickCallEventForAgent(agent, callEvents, sessions = []) {
      if (agent.fallback) return null;
      const maxAgeMs = 3 * 60 * 1000;
      return (callEvents || [])
        .filter((event) => callEventMatches(agent, event))
        .filter((event) => !eventMatchesFinishedSession(agent, event, sessions))
        .filter((event) => {
          const ms = callEventSortMs(event);
          return ms && Date.now() - ms <= maxAgeMs;
        })
        .sort((a, b) => callEventSortMs(b) - callEventSortMs(a))[0] || null;
    }

    function metadataPills(session) {
      const metadata = session?.metadata || {};
      return [
        metadata.phone ? "phone " + metadata.phone : "",
        metadata.domain || "",
        metadata.caseId ? "case " + metadata.caseId : "",
        metadata.uii ? "UII " + shortId(metadata.uii, 12) : "",
        metadata.streamId ? "stream " + shortId(metadata.streamId, 8) : "",
        session?.status || "",
      ].filter(Boolean).map((x) => "<span class=\\"pill\\">" + escapeHtml(x) + "</span>").join("");
    }

    function callEventPills(event) {
      return [
        event?.phone ? "phone " + event.phone : "",
        event?.domain || "",
        event?.caseId ? "case " + event.caseId : "",
        event?.uii ? "UII " + shortId(event.uii, 12) : "no UII yet",
        event?.queueItemId ? "q " + shortId(event.queueItemId, 8) : "",
        event?.createdAt ? "placed " + fmtTime(event.createdAt) : "",
      ].filter(Boolean).map((x) => "<span class=\\"pill waiting\\">" + escapeHtml(x) + "</span>").join("");
    }

    function phaseMeta(items) {
      return items.filter(Boolean).map((x) => "<span class=\\"pill\\">" + escapeHtml(x) + "</span>").join("");
    }

    function formatContext(context) {
      if (!context) return "";
      const matches = Array.isArray(context.matches) ? context.matches : [];
      const selectedKeys = matches.map((match) => match.key || match.label).filter(Boolean).slice(0, 5).join(", ");
      const rawKeys = (Array.isArray(context.deterministicCandidates) ? context.deterministicCandidates : [])
        .map((candidate) => candidate.key || candidate.label)
        .filter(Boolean)
        .slice(0, 6)
        .join(", ");
      const rejectedKeys = (Array.isArray(context.miniJudgement?.rejected) ? context.miniJudgement.rejected : [])
        .map((candidate) => candidate.key)
        .filter(Boolean)
        .slice(0, 5)
        .join(", ");
      return [
        context.phraseText || context.text || "",
        rawKeys ? "Candidates: " + rawKeys : "",
        selectedKeys ? "Mini kept: " + selectedKeys : "Mini kept: none",
        rejectedKeys ? "Mini rejected: " + rejectedKeys : "",
        context.actionReason ? "Action: " + context.actionReason : "",
      ].filter(Boolean).join("\\n");
    }

    function setLane(agent, patch = {}) {
      const current = laneState.get(agent.key) || { agent, session: null, waitingCall: null, transcript: null, coachTranscript: null, context: null, dialog: null, transcriptFlash: null };
      laneState.set(agent.key, { ...current, ...patch });
      renderLane(agent);
    }

    const pendingLanePatches = new Map();
    let laneFlushScheduled = false;

    function queueLanePatch(agent, patch = {}) {
      if (!agent) return;
      const current = pendingLanePatches.get(agent.key) || {};
      pendingLanePatches.set(agent.key, { ...current, ...patch });
      if (laneFlushScheduled) return;
      laneFlushScheduled = true;
      requestAnimationFrame(() => {
        laneFlushScheduled = false;
        const rows = Array.from(pendingLanePatches.entries());
        pendingLanePatches.clear();
        for (const [agentKey, queuedPatch] of rows) {
          const rowAgent = lanes.find((candidate) => candidate.key === agentKey);
          if (rowAgent) setLane(rowAgent, queuedPatch);
        }
      });
    }

    function renderShell() {
      document.documentElement.style.setProperty("--lane-count", String(lanes.length));
      els.lanes.innerHTML = lanes.map((agent) =>
        "<div class=\\"lane\\" data-agent=\\"" + escapeHtml(agent.key) + "\\">" +
          "<div class=\\"lane-head\\">" +
            "<div class=\\"agent-name\\">" + escapeHtml(agent.label) + "</div>" +
            "<div class=\\"agent-meta\\" id=\\"" + agent.key + "-agent-meta\\"><span class=\\"pill waiting\\">waiting for stream</span></div>" +
          "</div>" +
          "<section class=\\"phase\\">" +
            "<div class=\\"phase-head\\"><h2>Transcript</h2><span class=\\"pill\\" id=\\"" + agent.key + "-transcript-state\\">waiting</span></div>" +
            "<div class=\\"phase-body\\">" +
              "<div class=\\"phase-text empty\\" id=\\"" + agent.key + "-transcript\\">Waiting for prospect speech...</div>" +
              "<div class=\\"meta\\" id=\\"" + agent.key + "-transcript-meta\\"></div>" +
            "</div>" +
          "</section>" +
          "<section class=\\"phase\\">" +
            "<div class=\\"phase-head\\"><h2>Context</h2><span class=\\"pill\\" id=\\"" + agent.key + "-context-state\\">waiting</span></div>" +
            "<div class=\\"phase-body\\">" +
              "<div class=\\"phase-text context-text empty\\" id=\\"" + agent.key + "-context\\">Waiting for mini context...</div>" +
              "<div class=\\"meta\\" id=\\"" + agent.key + "-context-meta\\"></div>" +
            "</div>" +
          "</section>" +
          "<section class=\\"phase\\">" +
            "<div class=\\"phase-head\\"><h2>Dialog</h2><span class=\\"pill\\" id=\\"" + agent.key + "-dialog-state\\">waiting</span></div>" +
            "<div class=\\"phase-body\\">" +
              "<div class=\\"phase-text dialog-text empty\\" id=\\"" + agent.key + "-dialog\\">Coach line will appear here.</div>" +
              "<div class=\\"meta\\" id=\\"" + agent.key + "-dialog-meta\\"></div>" +
            "</div>" +
          "</section>" +
        "</div>"
      ).join("");
      for (const agent of lanes) setLane(agent);
    }

    function setText(id, text, emptyText) {
      const el = document.getElementById(id);
      if (!el) return;
      const clean = String(text || "").trim();
      el.textContent = clean || emptyText;
      el.classList.toggle("empty", !clean);
    }

    function setHtml(id, html) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html || "";
    }

    function setStatePill(id, text, status) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text || "waiting";
      el.className = "pill " + (status || "");
    }

    function appendTranscriptText(existing, incoming) {
      const left = String(existing || "").trim();
      const right = String(incoming || "").trim();
      if (!left) return right;
      if (!right) return left;
      const normalizedLeft = left.toLowerCase();
      const normalizedRight = right.toLowerCase();
      if (normalizedLeft.endsWith(normalizedRight)) return left;
      if (normalizedRight.startsWith(normalizedLeft)) return right;
      if (/^[.,!?;:%)\]}]/.test(right)) return left + right;
      return left + " " + right;
    }

    function appendCoachTranscript(current, transcript) {
      const existing = current?.coachTranscript;
      const text = existing?.awaitingCoach
        ? appendTranscriptText(existing.text, transcript?.text)
        : String(transcript?.text || "").trim();
      return {
        ...(existing?.awaitingCoach ? existing : transcript),
        ...transcript,
        text,
        wordCount: text ? text.split(/\\s+/).filter(Boolean).length : 0,
        coachHeld: true,
        awaitingCoach: true,
      };
    }

    function renderLane(agent) {
      const state = laneState.get(agent.key) || {};
      const session = state.session;
      const waitingCall = state.waitingCall;
      const waitingForStream = sessionWaitingForRingCxStream(session);
      const streamStatus = state.streamStatus || session?.latest?.streamStatus || null;
      const transcriptFlash = isActiveFlash(state.transcriptFlash) ? state.transcriptFlash : null;
      const metadata = session?.metadata || {};
      setHtml(agent.key + "-agent-meta", session
        ? metadataPills(session)
        : waitingCall
          ? callEventPills(waitingCall)
          : "<span class=\\"pill waiting\\">waiting for stream</span>");

      const transcript = transcriptFlash || state.coachTranscript || state.transcript || session?.latest?.provisionalTranscript || session?.latest?.transcript;
      const waitingStreamText = waitingCall
        ? "Call event received. Waiting for RingCX stream..."
        : waitingForStream
          ? "Current CX call joined. Waiting for RingCX audio stream..."
          : streamStatus
            ? "Prospect audio frames are arriving. Waiting for STT to release speech..."
          : "Waiting for prospect speech...";
      setText(agent.key + "-transcript", transcript?.text || "", waitingStreamText);
      const transcriptEl = document.getElementById(agent.key + "-transcript");
      transcriptEl?.classList.toggle("flash", Boolean(transcriptFlash));
      setStatePill(agent.key + "-transcript-state", transcript?.text ? (transcriptFlash ? "voicemail" : transcript.coachHeld ? "coaching this" : transcript.provisional ? "streaming" : "VAD final") : waitingForStream ? "stream missing" : streamStatus ? "audio" : waitingCall ? "waiting stream" : "waiting", transcriptFlash ? "rejected" : transcript?.text || streamStatus ? "live" : waitingForStream ? "rejected" : "waiting");
      setHtml(agent.key + "-transcript-meta", phaseMeta([
        transcript?.model || transcript?.source || "",
        transcript?.at ? fmtTime(transcript.at) : "",
        transcript?.wordCount ? transcript.wordCount + " words" : "",
        streamStatus && streamStatus.bindState && streamStatus.bindState !== "bound" ? "linking call..." : "",
        streamStatus && Number(streamStatus.pendingDroppedBytes || 0) > 0 ? "audio dropped " + Math.round(Number(streamStatus.pendingDroppedBytes) / 1024) + "KB" : "",
        streamStatus && !transcript?.text ? Math.round(Number(streamStatus.durationSec || 0)) + "s audio" : "",
        streamStatus && !transcript?.text ? "active " + Number(streamStatus.activePct || 0).toFixed(1) + "%" : "",
        streamStatus && !transcript?.text ? "waiting on STT" : "",
        transcriptFlash?.guidance || "",
        transcriptFlash?.phone ? "phone " + transcriptFlash.phone : "",
        transcriptFlash?.uii ? "UII " + shortId(transcriptFlash.uii, 12) : "",
        transcript?.coachHeld ? "held until coach advances" : "",
        waitingForStream ? "joined current call; no streamId/input" : "",
        waitingCall && !transcript?.text ? "app fired cx.call.placed" : "",
      ]));

      const context = state.context || session?.latest?.context;
      const contextStatus = state.contextStatus || null;
      setText(agent.key + "-context", formatContext(context), "Waiting for mini context...");
      setStatePill(agent.key + "-context-state", context ? (context.shouldCompose ? "mini kept" : "mini hold") : contextStatus?.label || "waiting", context?.shouldCompose || contextStatus?.live ? "live" : "waiting");
      setHtml(agent.key + "-context-meta", phaseMeta([
        context?.jurisdiction || "",
        context?.completeThought ? "complete" : context ? "collecting" : "",
        context?.primaryContextKey || "",
        context?.miniJudgement?.candidateCount ? context.miniJudgement.candidateCount + " candidates" : "",
        ...(contextStatus?.meta || []),
      ]));

      const dialog = state.dialog || session?.latest?.dialog;
      const dialogStatus = state.dialogStatus || null;
      const rejected = dialog?.status === "rejected";
      setText(agent.key + "-dialog", dialog?.say || "", rejected ? "Call rejected for voicemail match." : "Coach line will appear here.");
      setStatePill(agent.key + "-dialog-state", dialog?.label || dialog?.status || dialogStatus?.label || "waiting", rejected ? "rejected" : dialog?.status === "ready" || dialog?.status === "streaming" || dialogStatus?.live ? "live" : "waiting");
      setHtml(agent.key + "-dialog-meta", phaseMeta([
        dialog?.composer || dialog?.model || "",
        dialog?.at ? fmtTime(dialog.at) : "",
        dialog?.guidance || "",
        ...(dialogStatus?.meta || []),
      ]));
    }

    function handleEvent(agent, payload) {
      const state = laneState.get(agent.key) || {};
      if (["session.stop", "session.stale", "voicemail.reject"].includes(String(payload?.type || ""))) {
        const flash = payload?.type === "voicemail.reject" || payload?.dialog?.status === "rejected" || isRejectedSession(payload?.session)
          ? buildVoicemailFlash(payload)
          : (isActiveFlash(state.transcriptFlash) ? state.transcriptFlash : null);
        closeLaneSource(agent);
        queueLanePatch(agent, {
          session: null,
          waitingCall: null,
          transcript: null,
          coachTranscript: null,
          context: null,
          dialog: null,
          contextStatus: null,
          dialogStatus: null,
          transcriptFlash: flash,
        });
        els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
        return;
      }
      if (payload.type === "context.clear") {
        queueLanePatch(agent, {
          transcript: {
            at: payload.at || payload.transcript?.at || new Date().toISOString(),
            role: "system",
            text: payload.transcript?.text
              ? "Hold prompt detected. Context cleared. " + payload.transcript.text
              : "Hold prompt detected. Context cleared.",
            source: "system context gate",
            wordCount: 0,
          },
          coachTranscript: null,
          context: null,
          dialog: null,
          contextStatus: { label: "context cleared", live: false, meta: [payload.hold?.match || payload.hold?.reason || ""].filter(Boolean) },
          dialogStatus: { label: "waiting", live: false, meta: ["Listening for the next prospect phrase"] },
        });
        els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
        return;
      }
      const patch = {};
      if (payload.session) {
        patch.session = payload.session;
        patch.streamStatus = payload.session.latest?.streamStatus || null;
      }
      if (payload.type === "stream.status" && payload.streamStatus) {
        patch.streamStatus = payload.streamStatus;
      }
      if (payload.provisionalTranscript?.role === "prospect" && !state.coachTranscript?.awaitingCoach) {
        patch.transcript = payload.provisionalTranscript;
      }
      if (payload.transcript?.role === "prospect") {
        patch.transcript = payload.transcript;
        patch.coachTranscript = appendCoachTranscript(state, payload.transcript);
        patch.contextStatus = { label: "mini queued", live: true, meta: ["VAD released"] };
        patch.dialogStatus = { label: "waiting on coach", live: true, meta: [] };
      }
      if (payload.type === "context.judge.start") {
        if (state.coachTranscript?.text) {
          patch.coachTranscript = { ...state.coachTranscript, coachHeld: true, awaitingCoach: true };
        }
        patch.contextStatus = {
          label: "mini checking",
          live: true,
          meta: [payload.candidateCount ? payload.candidateCount + " candidates" : ""].filter(Boolean),
        };
      }
      if (payload.type === "context.judge.done") {
        patch.contextStatus = {
          label: payload.shouldCompose ? "mini kept" : "mini hold",
          live: Boolean(payload.shouldCompose),
          meta: [
            payload.elapsedMs ? payload.elapsedMs + "ms" : "",
            Array.isArray(payload.selectedKeys) && payload.selectedKeys.length ? payload.selectedKeys.slice(0, 3).join(", ") : "",
          ].filter(Boolean),
        };
        if (!payload.shouldCompose && state.coachTranscript?.awaitingCoach) patch.coachTranscript = null;
      }
      if (payload.type === "pipeline.hold") {
        patch.contextStatus = {
          label: "hold",
          live: false,
          meta: [payload.action || payload.hold?.reason || ""].filter(Boolean),
        };
        if (state.coachTranscript?.awaitingCoach) patch.coachTranscript = null;
      }
      if (payload.context) {
        patch.context = payload.context;
        if (payload.context.shouldCompose && (payload.context.phraseText || payload.context.text)) {
          patch.coachTranscript = {
            ...(state.transcript || {}),
            id: payload.context.sourceTranscriptId || state.transcript?.id || null,
            at: payload.context.at || state.transcript?.at || new Date().toISOString(),
            role: "prospect",
            text: payload.context.phraseText || payload.context.text,
            source: "mini-context",
            model: payload.context.miniJudgement?.model || state.transcript?.model || null,
            wordCount: String(payload.context.phraseText || payload.context.text || "").trim().split(/\\s+/).filter(Boolean).length,
            coachHeld: true,
            awaitingCoach: false,
          };
        }
      }
      if (payload.type === "compose.start") {
        patch.dialogStatus = {
          label: "coach writing",
          live: true,
          meta: [payload.dialogId ? "dialog " + shortId(payload.dialogId, 8) : ""].filter(Boolean),
        };
      }
      if (payload.type === "compose.deduped" || payload.type === "compose.rate_limited") {
        patch.dialogStatus = {
          label: payload.type === "compose.deduped" ? "deduped" : "rate limited",
          live: false,
          meta: [payload.windowMs ? payload.windowMs + "ms window" : "", payload.rateLimitPerMinute ? payload.rateLimitPerMinute + "/min" : ""].filter(Boolean),
        };
      }
      if (payload.type === "compose.supersede") {
        patch.dialogStatus = { label: "coach updating", live: true, meta: [] };
      }
      if (payload.dialog) {
        patch.dialog = payload.dialog;
        const held = patch.coachTranscript || state.coachTranscript;
        if (held?.text && (payload.dialog.status === "streaming" || payload.dialog.status === "ready")) {
          patch.coachTranscript = { ...held, coachHeld: true, awaitingCoach: false };
        }
      }
      if (Object.keys(patch).length) queueLanePatch(agent, patch);
      els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
    }

    function closeLaneSource(agent) {
      const source = eventSources.get(agent.key);
      if (source) source.close();
      eventSources.delete(agent.key);
    }

    function subscribeLane(agent, session) {
      const current = laneState.get(agent.key);
      const latestSnapshot = {
        session,
        transcript: session?.latest?.provisionalTranscript || session?.latest?.transcript || null,
        coachTranscript: session?.latest?.context?.phraseText ? {
          ...(session?.latest?.transcript || {}),
          role: "prospect",
          text: session.latest.context.phraseText,
          source: "mini-context",
          model: session.latest.context.miniJudgement?.model || session?.latest?.transcript?.model || null,
          coachHeld: true,
        } : null,
        context: session?.latest?.context || null,
        dialog: session?.latest?.dialog || null,
        streamStatus: session?.latest?.streamStatus || null,
      };
      setLane(agent, latestSnapshot);
      if (current?.session?.id === session?.id && eventSources.has(agent.key)) return;
      closeLaneSource(agent);
      if (!session?.id || isTerminalSession(session)) return;
      const source = new EventSource(dashboardUrl("/api/ai/live-coach/dashboard/sessions/" + encodeURIComponent(session.id) + "/events"));
      [
        "snapshot",
        "stream.status",
        "transcript.provisional",
        "transcript",
        "context.clear",
        "context.judge.start",
        "context.judge.done",
        "pipeline.hold",
        "context",
        "compose.start",
        "compose.supersede",
        "compose.deduped",
        "compose.rate_limited",
        "dialog",
        "dialog.error",
        "voicemail.reject",
        "session.stop",
        "session.stale",
      ].forEach((eventName) => {
        source.addEventListener(eventName, (event) => handleEvent(agent, JSON.parse(event.data)));
      });
      eventSources.set(agent.key, source);
    }

    async function loadSessions() {
      const response = await fetch(dashboardUrl("/api/ai/live-coach/dashboard/sessions?summary=1"));
      const data = await response.json();
      const sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter(isLiveSession);
      const callEvents = Array.isArray(data.callEvents) ? data.callEvents : [];
      const active = sessions.filter((session) => !isTerminalSession(session));
      els.liveCount.textContent = active.length + " live";
      els.updated.textContent = fmtTime(new Date().toISOString());
      // Lanes follow the floor: add/remove dynamic lanes before painting.
      syncLanes(sessions, callEvents);
      for (const agent of lanes) {
        const session = pickSessionForAgent(agent, sessions, callEvents);
        const waitingCall = pickCallEventForAgent(agent, callEvents, sessions);
        const rejectedSession = pickRecentRejectedForAgent(agent, sessions);
        const current = laneState.get(agent.key) || {};
        const transcriptFlash = rejectedSession
          ? buildVoicemailFlash(rejectedSession)
          : isActiveFlash(current.transcriptFlash)
            ? current.transcriptFlash
            : null;
        if (!session) {
          closeLaneSource(agent);
          setLane(agent, { session: null, waitingCall, transcript: null, coachTranscript: null, context: null, dialog: null, transcriptFlash });
        } else {
          setLane(agent, { waitingCall: null, transcriptFlash: null });
          subscribeLane(agent, session);
        }
      }
    }

    let loadSessionsInFlight = false;
    async function refreshSessions() {
      if (loadSessionsInFlight) return;
      loadSessionsInFlight = true;
      try {
        await loadSessions();
      } catch (error) {
        console.warn("live coach wallboard refresh failed", error);
      } finally {
        loadSessionsInFlight = false;
      }
    }

    let syncCurrentInFlight = false;
    async function syncCurrentCalls(options = {}) {
      if (syncCurrentInFlight) return;
      syncCurrentInFlight = true;
      if (!options.quiet && els.syncCurrent) els.syncCurrent.disabled = true;
      try {
        const response = await fetch(dashboardUrl("/api/ai/live-coach/dashboard/sync-current"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lookbackMs: 5 * 60 * 1000, limit: 120 }),
        });
        const data = await response.json();
        if (!response.ok || data?.ok === false) {
          throw new Error(data?.error || "sync failed");
        }
        const summary = [
          (data.activeCount || 0) + " active",
          (data.ensuredCount || 0) + " joined",
          data.retiredCount ? data.retiredCount + " retired" : "",
          data.checkedAgents ? data.checkedAgents + " agents checked" : "",
        ].filter(Boolean).join(" | ");
        if (els.syncSummary) els.syncSummary.textContent = summary || "no active calls";
        if (!options.quiet) await refreshSessions();
      } catch (error) {
        if (els.syncSummary) els.syncSummary.textContent = "sync error";
        console.warn("live coach current-call sync failed", error);
      } finally {
        syncCurrentInFlight = false;
        if (els.syncCurrent) els.syncCurrent.disabled = false;
      }
    }

    els.syncCurrent?.addEventListener("click", () => syncCurrentCalls());
    renderShell();
    syncCurrentCalls({ quiet: true });
    refreshSessions();
    setInterval(refreshSessions, 1500);
    setInterval(() => syncCurrentCalls({ quiet: true }), 10000);
  </script>
</body>
</html>`;
}

async function main() {
  const config = buildConfig();
  const logger = createLogger(config.serviceName);
  processCrashLogger = logger;
  let mongoRuntime = { connected: false, skipped: Boolean(config.skipMongo) };
  try {
    mongoRuntime = await connectMongo(config);
  } catch (error) {
    mongoRuntime = {
      connected: false,
      skipped: false,
      error: error.message,
    };
    logger.warn("mongo.connect.skipped_after_error", { error: error.message });
  }
  const mongoBridge = mongoRuntime.connected
    ? createLiveCoachMongoBridge({
      EventRecord,
      CallSession,
      WorkflowRecord,
    })
    : null;
  const coachPersistence = mongoRuntime.connected
    ? createLiveCoachMongoPersistence({
      LiveCoachSession,
      logger,
    })
    : null;
  // SIMPLIFIED FLOW (default): the mini context judge is OFF — the
  // deterministic gates (voicemail/screener/filler/echo) protect the pipe,
  // every real utterance forwards with its ranked candidate keys, and Claude
  // decides (WAIT) and writes in one call. Live data drove this: the judge
  // held 61% of contexts and every layer of arbitration around it existed
  // because we didn't trust those holds. Re-enable the cost-gate era with
  // LIVE_COACH_CONTEXT_JUDGE_ENABLED=true.
  const semanticContextJudge = boolFromEnv(process.env.LIVE_COACH_CONTEXT_JUDGE_ENABLED, false)
    ? createOpenAiSemanticContextJudge({ logger })
    : null;
  const coachBus = createLiveCoachBus({
    rootDir: config.rootDir,
    logger,
    persistence: coachPersistence,
    dialogComposer: createAnthropicDialogComposer({ logger }),
    // semantic_vad only decides when STT should release text. This optional API judge is the
    // fuzzy filter that ranks deterministic candidates before Sonnet composes a line.
    semanticContextJudge,
    composeDedupWindowMs: Number(process.env.LIVE_COACH_COMPOSE_DEDUP_WINDOW_MS || 4000) || 4000,
    // 3/min silently starved fast objection sequences (3+ coachable turns inside
    // a minute is normal in live sales); the 4s dedupe window is the real
    // runaway-compose guard, so the per-minute cap can breathe.
    composeRateLimitPerMinute: Number(process.env.LIVE_COACH_COMPOSE_RATE_LIMIT_PER_MINUTE || 6) || 6,
    composeDeltaThrottleMs: Number(process.env.LIVE_COACH_COMPOSE_DELTA_THROTTLE_MS || 60) || 60,
    asyncContextPipeline: boolFromEnv(process.env.LIVE_COACH_ASYNC_CONTEXT_PIPELINE, true),
    thoughtBufferMaxChars: Number(process.env.LIVE_COACH_THOUGHT_BUFFER_MAX_CHARS || 900) || 900,
    thoughtBufferMaxChunks: Number(process.env.LIVE_COACH_THOUGHT_BUFFER_MAX_CHUNKS || 5) || 5,
    // Mini veto scope: "junk-only" (default) lets the mini hold composition only
    // for junk reasons (voicemail/screener/filler...); any other refusal composes
    // anyway and Claude's WAIT judges completeness. "all" restores the full veto.
    miniVetoScope: cleanText(process.env.LIVE_COACH_MINI_VETO_SCOPE || "junk-only", 20).toLowerCase(),
    // Non-strong-junk holds expire after this silence window and force-compose
    // the buffered thought (trailing-off prospects still get coached). 0 = off.
    holdExpiryMs: Math.max(0, Number(process.env.LIVE_COACH_HOLD_EXPIRY_MS ?? 2500) || 0),
    // Coach-triggered voicemail drop: default OFF; hard phone allowlist inside
    // the trigger (LIVE_COACH_VM_TRANSFER_* envs).
    vmTransferTrigger: createLiveCoachVmTransferTrigger({ logger }),
    // Mini's dual-VAD role: rolling relevance digest over the fast channel's
    // packets (default ON; LIVE_COACH_MINI_DIGEST_ENABLED=false disables).
    rollingDigest: createOpenAiRollingDigest({ logger }),
    // Mini wakes after the prospect's first N semantic turns; before that
    // Sonnet runs the scripted OPENING prompt with no memory.
    digestWarmupTurns: Math.max(0, Number(process.env.LIVE_COACH_DIGEST_WARMUP_TURNS || 3) || 3),
  });
  logger.info("live_coach.runtime_config", {
    mongoConnected: Boolean(mongoRuntime.connected),
    contextJudgeEnabled: Boolean(semanticContextJudge),
    contextJudgeModel: semanticContextJudge
      ? cleanText(process.env.LIVE_COACH_CONTEXT_JUDGE_MODEL || process.env.LIVE_COACH_MINI_MODEL || "gpt-5.4-mini", 120)
      : null,
    contextJudgeServiceTier: cleanText(
      process.env.LIVE_COACH_CONTEXT_JUDGE_SERVICE_TIER ||
        process.env.LIVE_COACH_OPENAI_SERVICE_TIER ||
        "priority",
      80,
    ),
    contextJudgePromptCacheScope: cleanText(process.env.LIVE_COACH_CONTEXT_JUDGE_PROMPT_CACHE_SCOPE || "global", 40),
    anthropicComposerEnabled: boolFromEnv(process.env.LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED, false),
    anthropicModel: boolFromEnv(process.env.LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED, false)
      ? cleanText(process.env.LIVE_COACH_ANTHROPIC_MODEL || process.env.LIVE_COACH_SONNET_MODEL || "claude-sonnet-4-6", 120)
      : null,
    composerTier: getComposerTier(),
    composeDedupWindowMs: Number(process.env.LIVE_COACH_COMPOSE_DEDUP_WINDOW_MS || 4000) || 4000,
    composeRateLimitPerMinute: Number(process.env.LIVE_COACH_COMPOSE_RATE_LIMIT_PER_MINUTE || 6) || 6,
    composeDeltaThrottleMs: Number(process.env.LIVE_COACH_COMPOSE_DELTA_THROTTLE_MS || 60) || 60,
    asyncContextPipeline: boolFromEnv(process.env.LIVE_COACH_ASYNC_CONTEXT_PIPELINE, true),
    thoughtBufferMaxChars: Number(process.env.LIVE_COACH_THOUGHT_BUFFER_MAX_CHARS || 900) || 900,
    thoughtBufferMaxChunks: Number(process.env.LIVE_COACH_THOUGHT_BUFFER_MAX_CHUNKS || 5) || 5,
    diagnosticLogging: LIVE_COACH_DIAGNOSTIC_LOGGING,
    diagnosticSampleEvery: LIVE_COACH_DIAGNOSTIC_SAMPLE_EVERY,
    diagnosticSlowMs: LIVE_COACH_DIAGNOSTIC_SLOW_MS,
  });

  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: getCorsOriginResolver(), credentials: true }));
  app.use(express.json({ limit: "12mb" }));
  app.use(express.text({ type: ["text/*", "application/octet-stream"], limit: "24mb" }));

  const requireHealthAccess = buildHealthAccessMiddleware(config);
  const requireInternalAccess = buildInternalAccessMiddleware(config);
  const requireDashboardAccess = buildDashboardAccessMiddleware();

  app.get("/health", requireHealthAccess, (req, res) => {
    const mongo = {
      ...getMongoState(),
      ...(mongoRuntime.error ? { error: mongoRuntime.error } : {}),
    };
    const extra = {
      port: config.port,
      sessions: coachBus.getSummary(),
      liveCoach: {
        contextJudgeEnabled: Boolean(semanticContextJudge),
        contextJudgeModel: semanticContextJudge
          ? cleanText(process.env.LIVE_COACH_CONTEXT_JUDGE_MODEL || process.env.LIVE_COACH_MINI_MODEL || "gpt-5.4-mini", 120)
          : null,
        anthropicComposerEnabled: boolFromEnv(process.env.LIVE_COACH_ANTHROPIC_COMPOSER_ENABLED, false),
        composeDedupWindowMs: Number(process.env.LIVE_COACH_COMPOSE_DEDUP_WINDOW_MS || 4000) || 4000,
        composeRateLimitPerMinute: Number(process.env.LIVE_COACH_COMPOSE_RATE_LIMIT_PER_MINUTE || 6) || 6,
      },
    };
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, mongo));
    }
    return res.json({
      ...buildServiceHealth(config, mongo),
      ...extra,
    });
  });

  app.get("/", (_req, res) => {
    res.redirect("/live-coach");
  });

  app.get("/live-coach", (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(createLiveCoachWallboardHtml());
  });

  function buildBindingFromCallEvent(event = {}) {
    return {
      status: event.expired ? "expired" : "active",
      active: !event.expired,
      reason: event.expired ? "event-expired" : "matched-cx-call-placed",
      event,
      metadata: {
        source: "mongo-cx",
        agentEmail: event.agentEmail || "",
        agentExtension: event.extensionId || "",
        agentName: event.agentName || "",
        firmName: "Wynn Tax Solutions",
        uii: event.uii || "",
        queueItemId: event.queueItemId || "",
        caseId: event.caseId || "",
        phone: event.phone || "",
        domain: event.domain || "",
        eventId: event.id || "",
        callSessionId: event.callSessionId || "",
      },
    };
  }

  function latestCallEventByAgent(callEvents = []) {
    const latestByAgent = new Map();
    for (const event of Array.isArray(callEvents) ? callEvents : []) {
      if (!event || event.expired) continue;
      const agentKey = cleanText(event.extensionId || event.agentEmail || "", 180).toLowerCase();
      const identity = cleanText(event.uii || event.queueItemId || event.id || "", 180);
      if (!agentKey || !identity) continue;
      const atMs = Number(event.createdAtMs || Date.parse(event.createdAt || "")) || 0;
      const current = latestByAgent.get(agentKey);
      if (!current || atMs > current.atMs) latestByAgent.set(agentKey, { event, atMs });
    }
    return latestByAgent;
  }

  function retireReplacedSessionsFromCallEvents(callEvents = []) {
    const latestByAgent = latestCallEventByAgent(callEvents);

    const retired = [];
    for (const { event } of latestByAgent.values()) {
      const result = coachBus.retireReplacedSessions(buildBindingFromCallEvent(event), { apply: true });
      if (result.retiredCount) retired.push(...result.retired);
    }
    return { checkedAgents: latestByAgent.size, retiredCount: retired.length, retired };
  }

  async function syncCurrentCoachCalls(input = {}) {
    if (!mongoBridge) {
      return { ok: false, error: "Mongo bridge is not available" };
    }
    const lookbackMs = Math.max(15_000, Number(input.lookbackMs || 5 * 60 * 1000) || 5 * 60 * 1000);
    const limit = Math.max(1, Math.min(500, Number(input.limit || 120) || 120));
    const callEventResult = await mongoBridge.listRecentCoachCallEvents({ lookbackMs, limit });
    const callEvents = callEventResult.events || [];
    const latestByAgent = latestCallEventByAgent(callEvents);
    const results = [];
    let ensuredCount = 0;
    let activeCount = 0;
    let retiredCount = 0;

    for (const { event } of latestByAgent.values()) {
      const query = {
        agentExtensionId: event.extensionId || undefined,
        agentEmail: event.agentEmail || undefined,
        uii: event.uii || undefined,
        queueItemId: event.queueItemId || undefined,
        callSessionId: event.callSessionId || undefined,
        requireCurrentForAgent: true,
      };
      const bindingResult = await mongoBridge.resolveCoachBinding(query);
      const row = {
        event,
        status: bindingResult.status || null,
        reason: bindingResult.binding?.reason || bindingResult.reason || null,
        active: Boolean(bindingResult.binding?.active),
        sessionId: bindingResult.binding?.sessionId || null,
        ensured: false,
        retired: null,
      };
      if (bindingResult.binding?.active) {
        activeCount += 1;
        const retired = coachBus.retireReplacedSessions(bindingResult.binding, { apply: true });
        retiredCount += retired.retiredCount || 0;
        const session = coachBus.ensureSession({
          ...bindingResult.binding.metadata,
          source: "mongo-cx",
          sessionId: bindingResult.binding.sessionId,
          binding: bindingResult.binding,
        });
        ensuredCount += 1;
        row.ensured = true;
        row.sessionId = session.id;
        row.sessionStatus = session.status;
        row.retired = {
          retiredCount: retired.retiredCount || 0,
        };
      }
      results.push(row);
    }

    return {
      ok: true,
      lookbackMs,
      callEventCount: callEvents.length,
      checkedAgents: latestByAgent.size,
      activeCount,
      ensuredCount,
      retiredCount,
      results,
    };
  }

  async function buildLiveCoachDashboardPayload(req) {
    const summaryOnly = ["1", "true", "yes"].includes(String(req.query.summary || "").trim().toLowerCase());
    const callEvents = mongoBridge
      ? (await mongoBridge.listRecentCoachCallEvents({
        lookbackMs: 5 * 60 * 1000,
        limit: 120,
      })).events
      : [];
    const retiredFromCallEvents = retireReplacedSessionsFromCallEvents(callEvents);
    return {
      ok: true,
      sessions: summaryOnly ? coachBus.listSessionSummaries() : coachBus.listSessions(),
      callEvents,
      retiredFromCallEvents: {
        checkedAgents: retiredFromCallEvents.checkedAgents,
        retiredCount: retiredFromCallEvents.retiredCount,
      },
    };
  }

  app.get("/api/ai/live-coach/dashboard/sessions", requireDashboardAccess, async (req, res, next) => {
    try {
      res.json(await buildLiveCoachDashboardPayload(req));
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/ai/live-coach/dashboard/sync-current", requireDashboardAccess, requireMongoBridge, async (req, res, next) => {
    try {
      res.json(await syncCurrentCoachCalls(req.body || {}));
    } catch (error) {
      return next(error);
    }
  });

  // Bus fallback for session-for-call: when the Mongo cx.call.placed lookup
  // misses (558/688 binding misses in one live window were "no matching
  // event"), the LIVE session store is the truth — the gRPC stream creates
  // sessions regardless of whether the workspace hook emitted an event. Match
  // by call identity first, then agent fields; rank by signal so a flowing
  // stream beats a control-plane shell; only FRESH sessions qualify so a dead
  // unstopped session can't be handed to the panel.
  function pickLiveSessionFallback(input = {}) {
    const ext = cleanText(input.agentExtensionId || input.agentExtension || "", 80).toLowerCase();
    const email = cleanText(input.agentEmail || "", 180).toLowerCase();
    const name = cleanText(input.agentName || "", 120).toLowerCase();
    const uii = cleanText(input.uii || "", 160);
    const queueItemId = cleanText(input.queueItemId || "", 160);
    const callSessionId = cleanText(input.callSessionId || "", 160);
    const TERMINAL = new Set(["stopped", "stale", "released", "voicemail_rejected", "pruned"]);
    const now = Date.now();
    const fresh = (s) => {
      const ms = Date.parse(s?.lastEventAt || s?.updatedAt || "") || 0;
      return ms && now - ms <= 45_000;
    };
    const signal = (s) => {
      const latest = s?.latest || {};
      let score = 0;
      if (latest.dialog) score += 4;
      if (latest.transcript?.text || latest.provisionalTranscript?.text) score += 4;
      if (latest.context) score += 2;
      if (Number(s?.counters?.input || 0) > 0) score += 2;
      if (latest.streamStatus) score += 1;
      return score;
    };
    const idScore = (s) => {
      const m = s?.metadata || {};
      const b = s?.binding?.metadata || {};
      if (uii && (String(m.uii || "") === uii || String(b.uii || "") === uii)) return 3;
      if (queueItemId && (String(m.queueItemId || "") === queueItemId || String(b.queueItemId || "") === queueItemId)) return 2;
      if (callSessionId && (String(m.callSessionId || "") === callSessionId || String(b.callSessionId || "") === callSessionId)) return 2;
      return 0;
    };
    const agentMatch = (s) => {
      const m = s?.metadata || {};
      const fields = [m.agentExtension, m.agentExtensionId, m.agentEmail, m.agentName]
        .map((v) => String(v || "").trim().toLowerCase())
        .filter(Boolean);
      if (ext && fields.includes(ext)) return true;
      if (email && fields.includes(email)) return true;
      return Boolean(name && String(m.agentName || "").trim().toLowerCase() === name);
    };
    const rows = (coachBus.listSessions() || [])
      .filter((s) => s && !TERMINAL.has(String(s.status || "")) && fresh(s))
      .map((s) => ({ s, id: idScore(s), agent: agentMatch(s) }))
      .filter((row) => row.id > 0 || row.agent);
    rows.sort((a, b) =>
      (b.id - a.id)
      || (signal(b.s) - signal(a.s))
      || ((Date.parse(b.s.lastEventAt || "") || 0) - (Date.parse(a.s.lastEventAt || "") || 0)));
    return rows[0]?.s || null;
  }

  app.get("/api/ai/live-coach/dashboard/session-for-call", requireDashboardAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const input = req.query || {};
      const result = await mongoBridge.resolveCoachBinding({
        ...input,
        requireCurrentForAgent: true,
      });
      if (!result.binding?.active) {
        const fallback = pickLiveSessionFallback(input);
        if (fallback) {
          logger.info("live_coach.session_for_call.bus_fallback", {
            sessionId: fallback.id,
            mongoStatus: result.status || null,
            agentExtensionId: cleanText(input.agentExtensionId || "", 80) || null,
            uii: cleanText(input.uii || "", 160) || null,
          });
          return res.json({
            ...result,
            status: "bus_fallback",
            fallback: true,
            retired: null,
            session: fallback,
          });
        }
        return res.json({
          ...result,
          retired: null,
          session: null,
        });
      }
      const binding = result.binding;
      const retired = coachBus.retireReplacedSessions(binding, { apply: true });
      const session = coachBus.ensureSession({
        ...binding.metadata,
        agentName: input.agentName || binding.metadata.agentName || "",
        contactName: input.contactName || binding.metadata.contactName || "",
        caseId: input.caseId || binding.metadata.caseId || "",
        source: "mongo-cx",
        sessionId: binding.sessionId,
        binding,
      });
      return res.json({
        ...result,
        retired,
        session,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/ai/live-coach/dashboard/sessions/:sessionId/stop", requireDashboardAccess, (req, res) => {
    const result = coachBus.stopSession(req.params.sessionId, {
      ...(req.body || {}),
      reason: req.body?.reason || "dashboard-client-release",
    });
    res.status(result.ok ? 200 : 404).json(result);
  });

  // Mid-day, no-restart toggle of Sonnet's contemplativeness (effort + thinking).
  // GET to read; POST { tier } to flip. Takes effect on the next coaching turn.
  app.get("/api/ai/live-coach/dashboard/composer-tier", requireDashboardAccess, (req, res) => {
    const tier = getComposerTier();
    res.json({ ok: true, tier, config: COMPOSER_TIERS[tier], tiers: Object.keys(COMPOSER_TIERS) });
  });

  app.post("/api/ai/live-coach/dashboard/composer-tier", requireDashboardAccess, (req, res) => {
    const priorTier = getComposerTier();
    const result = setComposerTier(req.body?.tier);
    logger.info("live_coach.composer_tier.update", {
      ok: Boolean(result.ok),
      from: priorTier,
      to: result.tier || priorTier,
      requested: cleanText(req.body?.tier || "", 80),
      config: result.config || COMPOSER_TIERS[priorTier] || null,
      error: result.error || null,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.get("/api/ai/live-coach/dashboard/sessions/:sessionId/events", requireDashboardAccess, (req, res) => {
    const session = coachBus.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify({ type: "snapshot", session })}\n\n`);
    res.flush?.();
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString(), sessionId: req.params.sessionId })}\n\n`);
      res.flush?.();
    }, config.liveCoachHeartbeatIntervalMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    const unsubscribe = coachBus.subscribe(req.params.sessionId, (event) => {
      res.write(`event: ${event.type || "event"}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    });
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post("/api/ai/live-coach/dashboard/fixture", requireDashboardAccess, async (req, res, next) => {
    try {
      const result = await coachBus.runFixture(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/dashboard/provisional-fixture", requireDashboardAccess, (req, res) => {
    const input = req.body || {};
    const session = coachBus.startSession({
      source: "fixture-provisional",
      agentEmail: input.agentEmail || "fixture@local",
      agentName: input.agentName || "Agent",
      firmName: input.firmName || "Wynn Tax Solutions",
      uii: input.uii || undefined,
    });
    const startDelayMs = Math.max(0, Math.min(2000, Number(input.startDelayMs ?? 350) || 0));
    setTimeout(() => {
      coachBus.runProvisionalFixture({
        ...input,
        sessionId: session.id,
      }).catch((error) => {
        logger.warn("live_coach.provisional_fixture.error", {
          sessionId: session.id,
          error: error.message,
        });
      });
    }, startDelayMs);
    res.json({ ok: true, session, background: true, startDelayMs });
  });

  function writeCoachSessionEventStream(req, res, sessionId) {
    const session = coachBus.getSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify({ type: "snapshot", session })}\n\n`);
    res.flush?.();
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString(), sessionId })}\n\n`);
      res.flush?.();
    }, config.liveCoachHeartbeatIntervalMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    const unsubscribe = coachBus.subscribe(sessionId, (event) => {
      res.write(`event: ${event.type || "event"}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.flush?.();
    });
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return undefined;
  }

  app.get("/api/ai/catalog", requireInternalAccess, (_req, res) => {
    res.json({
      ok: true,
      service: config.serviceName,
      port: config.port,
      workflows: [
        {
          key: "live-coach-monitor",
          status: "local-plumbing",
          routes: [
            "POST /api/ai/live-coach/monitor/start",
            "POST /api/ai/live-coach/grpc/start",
            "POST /api/ai/live-coach/monitor/:sessionId/input",
            "POST /api/ai/live-coach/grpc/:sessionId/input",
            "POST /api/ai/live-coach/monitor/:sessionId/stop",
            "POST /api/ai/live-coach/grpc/:sessionId/stop",
            "GET /api/ai/live-coach/monitor/sessions",
            "GET /api/ai/live-coach/grpc/sessions",
            "GET /api/ai/live-coach/monitor/sessions/:sessionId",
            "GET /api/ai/live-coach/grpc/sessions/:sessionId",
            "GET /api/ai/live-coach/monitor/sessions/:sessionId/events",
            "GET /api/ai/live-coach/grpc/sessions/:sessionId/events",
            "GET /api/ai/live-coach/grpc/mongo/recent-call-events",
            "GET /api/ai/live-coach/grpc/mongo/bind/latest",
            "POST /api/ai/live-coach/grpc/mongo/bind/latest",
            "POST /api/ai/live-coach/grpc/mongo/cleanup-dead-streams",
            "GET /api/ai/live-coach/grpc/dashboard/sessions",
            "GET /api/ai/live-coach/dashboard/session-for-call",
            "POST /api/ai/live-coach/dashboard/sessions/:sessionId/stop",
            "POST /api/ai/live-coach/fixture",
            "POST /api/ai/live-coach/provisional-fixture",
            "POST /api/ai/live-coach/replay",
            "POST /api/ai/live-coach/cleanup-stale",
            "POST /api/ai/live-coach/prune-terminal",
          ],
        },
      ],
    });
  });

  function requireMongoBridge(req, res, next) {
    if (mongoBridge) return next();
    return res.status(503).json({
      ok: false,
      error: mongoRuntime.error || "Mongo bridge is not available",
      mongo: {
        ...getMongoState(),
        ...(mongoRuntime.error ? { error: mongoRuntime.error } : {}),
      },
    });
  }

  app.post("/api/ai/live-coach/monitor/start", requireInternalAccess, (req, res) => {
    const session = coachBus.startSession(req.body || {});
    res.json({ ok: true, session });
  });

  app.post("/api/ai/live-coach/grpc/start", requireInternalAccess, (req, res) => {
    const session = coachBus.startSession({
      ...(req.body || {}),
      source: req.body?.source || "grpc",
    });
    res.json({ ok: true, session });
  });

  app.get("/api/ai/live-coach/monitor/sessions", requireInternalAccess, (_req, res) => {
    res.json({ ok: true, sessions: coachBus.listSessions() });
  });

  app.get("/api/ai/live-coach/grpc/sessions", requireInternalAccess, (_req, res) => {
    res.json({ ok: true, sessions: coachBus.listSessions() });
  });

  app.get("/api/ai/live-coach/grpc/dashboard/sessions", requireInternalAccess, async (req, res, next) => {
    try {
      res.json(await buildLiveCoachDashboardPayload(req));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ai/live-coach/monitor/sessions/:sessionId", requireInternalAccess, (req, res) => {
    const session = coachBus.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    res.json({ ok: true, session });
  });

  app.get("/api/ai/live-coach/grpc/sessions/:sessionId", requireInternalAccess, (req, res) => {
    const session = coachBus.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    res.json({ ok: true, session });
  });

  app.get("/api/ai/live-coach/monitor/sessions/:sessionId/events", requireInternalAccess, (req, res) => {
    writeCoachSessionEventStream(req, res, req.params.sessionId);
  });

  app.get("/api/ai/live-coach/grpc/sessions/:sessionId/events", requireInternalAccess, (req, res) => {
    writeCoachSessionEventStream(req, res, req.params.sessionId);
  });

  app.get("/api/ai/live-coach/grpc/mongo/recent-call-events", requireInternalAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const result = await mongoBridge.listRecentCoachCallEvents(req.query || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/ai/live-coach/grpc/mongo/bind/latest", requireInternalAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const result = await mongoBridge.resolveCoachBinding(req.query || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/grpc/mongo/sync-current", requireInternalAccess, requireMongoBridge, async (req, res, next) => {
    try {
      res.json(await syncCurrentCoachCalls(req.body || {}));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/grpc/mongo/bind/latest", requireInternalAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const input = req.body || {};
      const result = await mongoBridge.resolveCoachBinding(input);
      if (!result.binding?.active) {
        return res.json({
          ...result,
          session: null,
        });
      }
      const binding = result.binding;
      const retired = coachBus.retireReplacedSessions(binding, {
        apply: input.retireReplaced !== false,
      });
      const session = coachBus.ensureSession({
        ...binding.metadata,
        ...(input.metadata || {}),
        uii: input.uii || input.rcxUii || input.callUii || binding.metadata.uii || "",
        queueItemId: input.queueItemId || input.queueTicketId || binding.metadata.queueItemId || "",
        source: input.source || "grpc-mongo",
        sessionId: input.sessionId || binding.sessionId,
        streamId: input.streamId || input.metadata?.streamId || "",
        workflowInstanceId: input.workflowInstanceId || input.metadata?.workflowInstanceId || "",
        binding,
      });
      return res.json({
        ...result,
        retired,
        session,
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/ai/live-coach/grpc/mongo/cleanup-dead-streams", requireInternalAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const input = req.body || {};
      const result = await coachBus.cleanupDeadStreams({
        ...input,
        resolveBinding: (query) => mongoBridge.resolveCoachBinding({
          ...query,
          requireCurrentForAgent: true,
        }),
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/monitor/:sessionId/input", requireInternalAccess, async (req, res, next) => {
    try {
      const body = typeof req.body === "string" ? { text: req.body } : req.body || {};
      const result = await coachBus.appendInput(req.params.sessionId, body);
      res.status(result.ok ? 200 : result.statusCode || 404).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/grpc/:sessionId/input", requireInternalAccess, async (req, res, next) => {
    try {
      const body = typeof req.body === "string" ? { text: req.body } : req.body || {};
      const result = await coachBus.appendInput(req.params.sessionId, body);
      res.status(result.ok ? 200 : result.statusCode || 404).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/grpc/:sessionId/stream-status", requireInternalAccess, (req, res) => {
    const body = typeof req.body === "string" ? {} : req.body || {};
    const result = coachBus.appendStreamStatus(req.params.sessionId, body);
    res.status(result.ok ? 200 : result.statusCode || 404).json(result);
  });

  app.post("/api/ai/live-coach/monitor/:sessionId/stop", requireInternalAccess, (req, res) => {
    const result = coachBus.stopSession(req.params.sessionId, req.body || {});
    res.status(result.ok ? 200 : 404).json(result);
  });

  app.post("/api/ai/live-coach/grpc/:sessionId/stop", requireInternalAccess, (req, res) => {
    const result = coachBus.stopSession(req.params.sessionId, req.body || {});
    res.status(result.ok ? 200 : 404).json(result);
  });

  app.post("/api/ai/live-coach/fixture", requireInternalAccess, async (req, res, next) => {
    try {
      const result = await coachBus.runFixture(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/provisional-fixture", requireInternalAccess, async (req, res, next) => {
    try {
      const result = await coachBus.runProvisionalFixture(req.body || {});
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/replay", requireInternalAccess, async (req, res, next) => {
    try {
      const result = await coachBus.replaySession(req.body || {});
      res.status(result.ok ? 200 : 404).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ai/live-coach/cleanup-stale", requireInternalAccess, (req, res) => {
    const result = coachBus.cleanupStale(req.body || {});
    res.json(result);
  });

  app.post("/api/ai/live-coach/prune-terminal", requireInternalAccess, (req, res) => {
    const result = coachBus.pruneTerminalSessions({
      ...(req.body || {}),
      maxAgeMs: req.body?.maxAgeMs || config.liveCoachTerminalPruneMaxAgeMs,
      maxTerminalSessions: req.body?.maxTerminalSessions || config.liveCoachTerminalPruneMaxSessions,
    });
    res.json(result);
  });

  let staleSweepInFlight = false;
  const staleSweepTimer = mongoBridge && config.liveCoachStaleSweepEnabled
    ? setInterval(() => {
      if (staleSweepInFlight) {
        logger.warn("live_coach.stale_sweep.skipped_in_flight");
        return;
      }
      staleSweepInFlight = true;
      coachBus.cleanupDeadStreams({
        apply: true,
        maxIdleMs: config.liveCoachStaleMaxIdleMs,
        resolveBinding: (query) => mongoBridge.resolveCoachBinding({
          ...query,
          requireCurrentForAgent: true,
        }),
      }).then((cleanupResult) => {
        const pruneResult = coachBus.pruneTerminalSessions({
          apply: true,
          maxAgeMs: config.liveCoachTerminalPruneMaxAgeMs,
          maxTerminalSessions: config.liveCoachTerminalPruneMaxSessions,
        });
        if (cleanupResult.staleCount > 0 || pruneResult.prunedCount > 0) {
          logger.info("live_coach.stale_sweep.result", {
            checkedCount: cleanupResult.checkedCount,
            staleCount: cleanupResult.staleCount,
            prunedCount: pruneResult.prunedCount,
            terminalCount: pruneResult.terminalCount,
          });
        }
      }).catch((error) => {
        logger.warn("live_coach.stale_sweep.error", { error: error.message });
      }).finally(() => {
        staleSweepInFlight = false;
      });
    }, config.liveCoachStaleSweepIntervalMs)
    : null;
  if (staleSweepTimer && typeof staleSweepTimer.unref === "function") staleSweepTimer.unref();

  app.use((error, _req, res, _next) => {
    logger.error("request.error", { error: error.message });
    res.status(error.status || 500).json(toErrorResponse(error));
  });

  const server = app.listen(config.port, config.bindHost, () => {
    logger.info("listening", { host: config.bindHost, port: config.port });
  });

  function shutdown(reason) {
    logger.info("shutdown", { reason });
    if (staleSweepTimer) clearInterval(staleSweepTimer);
    server.close(async () => {
      await disconnectMongo().catch((error) => {
        logger.warn("mongo.disconnect.error", { error: error.message });
      });
      process.exit(0);
    });
  }

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
});
