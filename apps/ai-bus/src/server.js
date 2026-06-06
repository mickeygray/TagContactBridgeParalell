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

function cleanText(value, maxLength = 4000) {
  return String(value || "")
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
      "",
    80,
  );
  const timeoutMs = Math.max(2500, Number(process.env.LIVE_COACH_CONTEXT_JUDGE_TIMEOUT_MS || 6000) || 6000);
  const maxOutputTokens = Math.max(
    120,
    Math.min(1200, Number(process.env.LIVE_COACH_CONTEXT_JUDGE_MAX_OUTPUT_TOKENS || 450) || 450),
  );

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
        summary: cleanText(candidate.guidance || candidate.summary || "", 240),
      }))
      .filter((candidate) => candidate.key);
    const recentProspect = (session?.memory?.transcripts || [])
      .filter((row) => row.role === "prospect")
      .slice(-4)
      .map((row) => cleanText(row.text, 320))
      .filter(Boolean);
    const requestBody = {
      model,
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      instructions: [
        "You are the semantic context judge between STT and a live tax-resolution sales coach.",
        "The candidate list is deterministic and intentionally over-inclusive. Pick every candidate key that genuinely helps answer or guide the specific prospect statement.",
        "Use only exact keys from candidates. Do not invent keys.",
        "Reject voicemail, automated prompts, call screeners, filler, greetings, and fragments with no useful sales/tax/human context.",
        "Return JSON only with this shape:",
        '{"shouldCompose":boolean,"completeThought":boolean,"selectedKeys":[{"key":"exact_key","confidence":0.0,"reason":"short reason"}],"rejected":[{"key":"exact_key","reason":"short reason"}],"transcriptMeaning":"one sentence meaning","actionReason":"short machine reason","confidence":0.0}',
        "If no key matches but the prospect asked a meaningful direct question, set shouldCompose true and selectedKeys empty.",
        "If the prospect is still mid-thought or nothing useful should be said yet, set shouldCompose false.",
      ].join("\n"),
      input: [
        {
          role: "user",
          content: JSON.stringify({
            agentName: metadata.agentName || context?.metadata?.agentName || "",
            firmName: metadata.firmName || context?.metadata?.firmName || "Tax Advocate Group",
            phraseText: transcript?.text || context?.phraseText || "",
            localCompleteness: {
              completeThought: Boolean(context?.completeThought),
              reason: context?.completenessReason || "",
              localShouldCompose: Boolean(context?.shouldCompose),
              localActionReason: context?.actionReason || "",
            },
            recentProspect,
            candidates,
          }),
        },
      ],
      max_output_tokens: maxOutputTokens,
    };

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
      return {
        ...parsed,
        provider: "openai",
        model: payload.model || model,
        usage: payload.usage || null,
      };
    } catch (error) {
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

  return async function composeWithAnthropic({ dialog, onDelta, abortSignal } = {}) {
    const promptPayload = dialog?.promptPayload || {};
    if (!promptPayload.shouldCompose) {
      return { say: "", composer: "anthropic", model };
    }

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
          max_tokens: maxTokens,
          temperature: 0.25,
          stream: true,
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
              ? String(event.delta.text || "")
              : "";
            if (delta) {
              output += delta;
              onDelta?.(delta, cleanText(output, 1000));
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

    return {
      say: cleanText(output, 1000),
      composer: "anthropic",
      model,
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
      return ["stopped", "stale", "voicemail_rejected"].includes(String(session?.status || ""));
    }

    function isLiveSession(session) {
      const source = String(session?.metadata?.source || "").toLowerCase();
      if (source.includes("fixture")) return false;
      return source.includes("grpc") || source === "mongo-cx";
    }

    function sessionSortMs(session) {
      return Date.parse(session?.lastEventAt || session?.updatedAt || session?.createdAt || "") || 0;
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
        .sort((a, b) => sessionSortMs(b) - sessionSortMs(a));
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
    setInterval(refreshSessions, 2500);
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
      gap: 7px;
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
    .pill.live { border-color: #bfdbfe; color: var(--blue); font-weight: 800; }
    .pill.waiting { color: var(--amber); }
    .pill.rejected { border-color: #fecaca; color: var(--red); font-weight: 800; }
    main {
      display: grid;
      grid-template-columns: repeat(var(--lane-count, 3), minmax(0, 1fr));
      gap: 12px;
      padding: 12px;
      min-width: 1180px;
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
      <span class="pill" id="updated">waiting</span>
    </div>
  </header>
  <main id="lanes"></main>
  <script>
    const SHOW_UNBOUND = new URLSearchParams(window.location.search).get("debug") === "unbound";
    const AGENTS = [
      { key: "cbolt", label: "Chris Bolt", aliases: ["cbolt", "cbolt@", "chrisbolt", "chris bolt", "63914586004"] },
      { key: "bhansen", label: "Brad Hansen", aliases: ["bhansen", "bhansen@", "bradhansen", "brad hansen", "63914587004"] },
      { key: "jsharp", label: "J. Sharp", aliases: ["jsharp", "jsharp@", "james sharp", "jay sharp", "63914621004"] },
      ...(SHOW_UNBOUND ? [{ key: "unbound", label: "Unbound Stream", aliases: [], fallback: true }] : []),
    ];

    const els = {
      lanes: document.getElementById("lanes"),
      liveCount: document.getElementById("live-count"),
      updated: document.getElementById("updated"),
    };
    const laneState = new Map();
    const eventSources = new Map();
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
      ].join(" ").toLowerCase().replace(/[^a-z0-9@+._ -]+/g, "");
    }

    function agentMatches(agent, session) {
      const haystack = compactAgentText(session);
      return agent.aliases.some((alias) => haystack.includes(alias.toLowerCase()));
    }

    function matchesKnownAgent(session) {
      return AGENTS
        .filter((agent) => !agent.fallback)
        .some((agent) => agentMatches(agent, session));
    }

    function isTerminalSession(session) {
      return ["stopped", "stale", "voicemail_rejected"].includes(String(session?.status || ""));
    }

    function isLiveSession(session) {
      const source = String(session?.metadata?.source || "").toLowerCase();
      if (source.includes("fixture")) return false;
      return source.includes("grpc") || source === "mongo-cx";
    }

    function sessionSortMs(session) {
      return Date.parse(session?.lastEventAt || session?.updatedAt || session?.createdAt || "") || 0;
    }

    function isDisplayable(session) {
      if (!isLiveSession(session)) return false;
      return !isTerminalSession(session);
    }

    function pickSessionForAgent(agent, sessions) {
      if (agent.fallback) {
        return sessions
          .filter((session) => isDisplayable(session) && !matchesKnownAgent(session))
          .sort((a, b) => {
            const activeDelta = Number(isTerminalSession(a)) - Number(isTerminalSession(b));
            if (activeDelta) return activeDelta;
            return sessionSortMs(b) - sessionSortMs(a);
          })[0] || null;
      }
      return sessions
        .filter((session) => isDisplayable(session) && agentMatches(agent, session))
        .sort((a, b) => {
          const activeDelta = Number(isTerminalSession(a)) - Number(isTerminalSession(b));
          if (activeDelta) return activeDelta;
          return sessionSortMs(b) - sessionSortMs(a);
        })[0] || null;
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
      const current = laneState.get(agent.key) || { agent, session: null, transcript: null, context: null, dialog: null };
      laneState.set(agent.key, { ...current, ...patch });
      renderLane(agent);
    }

    function renderShell() {
      document.documentElement.style.setProperty("--lane-count", String(AGENTS.length));
      els.lanes.innerHTML = AGENTS.map((agent) =>
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
      for (const agent of AGENTS) setLane(agent);
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

    function renderLane(agent) {
      const state = laneState.get(agent.key) || {};
      const session = state.session;
      const metadata = session?.metadata || {};
      setHtml(agent.key + "-agent-meta", session ? metadataPills(session) : "<span class=\\"pill waiting\\">waiting for stream</span>");

      const transcript = state.transcript || session?.latest?.provisionalTranscript || session?.latest?.transcript;
      setText(agent.key + "-transcript", transcript?.text || "", "Waiting for prospect speech...");
      setStatePill(agent.key + "-transcript-state", transcript?.text ? (transcript.provisional ? "live" : "heard") : "waiting", transcript?.text ? "live" : "waiting");
      setHtml(agent.key + "-transcript-meta", phaseMeta([
        transcript?.model || transcript?.source || "",
        transcript?.at ? fmtTime(transcript.at) : "",
        transcript?.wordCount ? transcript.wordCount + " words" : "",
      ]));

      const context = state.context || session?.latest?.context;
      setText(agent.key + "-context", formatContext(context), "Waiting for mini context...");
      setStatePill(agent.key + "-context-state", context ? (context.shouldCompose ? "compose" : "hold") : "waiting", context?.shouldCompose ? "live" : "waiting");
      setHtml(agent.key + "-context-meta", phaseMeta([
        context?.jurisdiction || "",
        context?.completeThought ? "complete" : context ? "collecting" : "",
        context?.primaryContextKey || "",
        context?.miniJudgement?.candidateCount ? context.miniJudgement.candidateCount + " candidates" : "",
      ]));

      const dialog = state.dialog || session?.latest?.dialog;
      const rejected = dialog?.status === "rejected";
      setText(agent.key + "-dialog", dialog?.say || "", rejected ? "Call rejected for voicemail match." : "Coach line will appear here.");
      setStatePill(agent.key + "-dialog-state", dialog?.label || dialog?.status || "waiting", rejected ? "rejected" : dialog?.status === "ready" ? "live" : "waiting");
      setHtml(agent.key + "-dialog-meta", phaseMeta([
        dialog?.composer || dialog?.model || "",
        dialog?.at ? fmtTime(dialog.at) : "",
        dialog?.guidance || "",
      ]));
    }

    function handleEvent(agent, payload) {
      if (["session.stop", "session.stale", "voicemail.reject"].includes(String(payload?.type || ""))) {
        closeLaneSource(agent);
        setLane(agent, { session: null, transcript: null, context: null, dialog: null });
        els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
        return;
      }
      const patch = {};
      if (payload.session) patch.session = payload.session;
      if (payload.provisionalTranscript?.role === "prospect") patch.transcript = payload.provisionalTranscript;
      if (payload.transcript?.role === "prospect") patch.transcript = payload.transcript;
      if (payload.context) patch.context = payload.context;
      if (payload.dialog) patch.dialog = payload.dialog;
      if (Object.keys(patch).length) setLane(agent, patch);
      els.updated.textContent = payload.at ? fmtTime(payload.at) : fmtTime(new Date().toISOString());
    }

    function closeLaneSource(agent) {
      const source = eventSources.get(agent.key);
      if (source) source.close();
      eventSources.delete(agent.key);
    }

    function subscribeLane(agent, session) {
      const current = laneState.get(agent.key);
      if (current?.session?.id === session?.id && eventSources.has(agent.key)) return;
      closeLaneSource(agent);
      setLane(agent, {
        session,
        transcript: session?.latest?.provisionalTranscript || session?.latest?.transcript || null,
        context: session?.latest?.context || null,
        dialog: session?.latest?.dialog || null,
      });
      if (!session?.id || isTerminalSession(session)) return;
      const source = new EventSource(dashboardUrl("/api/ai/live-coach/dashboard/sessions/" + encodeURIComponent(session.id) + "/events"));
      ["snapshot", "transcript.provisional", "transcript", "context", "dialog", "voicemail.reject", "session.stop", "session.stale"].forEach((eventName) => {
        source.addEventListener(eventName, (event) => handleEvent(agent, JSON.parse(event.data)));
      });
      eventSources.set(agent.key, source);
    }

    async function loadSessions() {
      const response = await fetch(dashboardUrl("/api/ai/live-coach/dashboard/sessions"));
      const data = await response.json();
      const sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter(isLiveSession);
      const active = sessions.filter((session) => !isTerminalSession(session));
      els.liveCount.textContent = active.length + " live";
      els.updated.textContent = fmtTime(new Date().toISOString());
      for (const agent of AGENTS) {
        const session = pickSessionForAgent(agent, sessions);
        if (!session) {
          closeLaneSource(agent);
          setLane(agent, { session: null, transcript: null, context: null, dialog: null });
        } else {
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

    renderShell();
    refreshSessions();
    setInterval(refreshSessions, 2500);
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
  const coachBus = createLiveCoachBus({
    rootDir: config.rootDir,
    logger,
    persistence: coachPersistence,
    dialogComposer: createAnthropicDialogComposer({ logger }),
    semanticContextJudge: createOpenAiSemanticContextJudge({ logger }),
    composeDedupWindowMs: Number(process.env.LIVE_COACH_COMPOSE_DEDUP_WINDOW_MS || 4000) || 4000,
    composeRateLimitPerMinute: Number(process.env.LIVE_COACH_COMPOSE_RATE_LIMIT_PER_MINUTE || 3) || 3,
    composeDeltaThrottleMs: Number(process.env.LIVE_COACH_COMPOSE_DELTA_THROTTLE_MS || 100) || 100,
    asyncContextPipeline: boolFromEnv(process.env.LIVE_COACH_ASYNC_CONTEXT_PIPELINE, true),
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

  app.get("/api/ai/live-coach/dashboard/sessions", requireDashboardAccess, (req, res) => {
    const summaryOnly = ["1", "true", "yes"].includes(String(req.query.summary || "").trim().toLowerCase());
    res.json({
      ok: true,
      sessions: summaryOnly ? coachBus.listSessionSummaries() : coachBus.listSessions(),
    });
  });

  app.get("/api/ai/live-coach/dashboard/session-for-call", requireDashboardAccess, requireMongoBridge, async (req, res, next) => {
    try {
      const input = req.query || {};
      const result = await mongoBridge.resolveCoachBinding({
        ...input,
        requireCurrentForAgent: true,
      });
      if (!result.binding?.active) {
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

  app.get("/api/ai/live-coach/dashboard/sessions/:sessionId/events", requireDashboardAccess, (req, res) => {
    const session = coachBus.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ ok: false, error: "Session not found" });
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify({ type: "snapshot", session })}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString(), sessionId: req.params.sessionId })}\n\n`);
    }, 15_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    const unsubscribe = coachBus.subscribe(req.params.sessionId, (event) => {
      res.write(`event: ${event.type || "event"}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
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
      firmName: input.firmName || "Tax Advocate Group",
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
    res.write(`event: snapshot\n`);
    res.write(`data: ${JSON.stringify({ type: "snapshot", session })}\n\n`);
    const heartbeat = setInterval(() => {
      res.write(`event: heartbeat\n`);
      res.write(`data: ${JSON.stringify({ type: "heartbeat", at: new Date().toISOString(), sessionId })}\n\n`);
    }, 15_000);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    const unsubscribe = coachBus.subscribe(sessionId, (event) => {
      res.write(`event: ${event.type || "event"}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
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
            "GET /api/ai/live-coach/dashboard/session-for-call",
            "POST /api/ai/live-coach/dashboard/sessions/:sessionId/stop",
            "POST /api/ai/live-coach/fixture",
            "POST /api/ai/live-coach/provisional-fixture",
            "POST /api/ai/live-coach/replay",
            "POST /api/ai/live-coach/cleanup-stale",
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
