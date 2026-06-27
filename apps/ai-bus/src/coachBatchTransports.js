"use strict";

/**
 * coachBatchTransports — the two injected model transports for the whole-floor
 * batch coach. Both satisfy the runner contract the floor loop expects:
 *
 *   async (req:{system,prompt,schema}) => { ok, json?, text, usage? }
 *
 * which parseBatchGuidance() consumes directly.
 *
 *   DEEP_PULL  — Opus on `claude -p` (Max pool). Reuses scripts/claudeAgentRunner
 *                (strips ANTHROPIC_API_KEY -> Max session), fast-mode + 0 thinking.
 *   REACTOR    — Haiku via Anthropic direct fetch on a SEPARATE metered key
 *                (LIVE_COACH_REACTOR_ANTHROPIC_API_KEY) so high-frequency churn
 *                never 429s the Max account. If that key is unset the reactor is
 *                DISABLED (returns null) — it never falls back to the shared key.
 *
 * Lives in apps/ai-bus (next to the other model transports + liveCoachModelPolicy),
 * NOT in shared-services — the pure loop/runner/runtime-mode stay transport-free.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createClaudeAgentRunner } = require("../../../scripts/claudeAgentRunner");
const { createCodexMcpClient } = require("../../../scripts/codex-agent/codexMcpClient");

function envBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

let resolveCoachModel;
try {
  ({ resolveCoachModel } = require("./liveCoachModelPolicy"));
} catch (_error) {
  resolveCoachModel = (_key, _role, envDefault) => envDefault;
}

function extractJsonFromText(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_error) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        const parsed = JSON.parse(raw.slice(first, last + 1));
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch (_innerError) {
        return null;
      }
    }
  }
  return null;
}

// Fast-mode settings file (written once, content-stable) so the Opus deep pull
// rides Haiku-accelerated output. File form is shell-safe under claude -p.
function fastSettingsPath() {
  const p = path.join(os.tmpdir(), "coach-deep-fast-settings.json");
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify({ fastMode: true }));
  } catch (_error) {
    /* best-effort */
  }
  return p;
}

/**
 * DEEP PULL — Opus on claude -p (Max pool). Always available (no key needed; it
 * uses the logged-in Max session). Returns the injected-runner function.
 */
function createDeepPullTransport(opts = {}) {
  const { logger = null, timeoutMs, fast = true, spawnImpl, env = process.env } = opts;
  const model = resolveCoachModel(
    "liveCoach.deepPull",
    null,
    String(env.LIVE_COACH_DEEP_MODEL || "opus").trim() || "opus",
  );
  const extraArgs = fast ? ["--settings", fastSettingsPath()] : [];
  const runner = createClaudeAgentRunner({
    model,
    maxThinkingTokens: 0, // strategic but fast; the spine read doesn't need extended thinking on fed content
    timeoutMs: Math.max(20000, Number(timeoutMs || env.LIVE_COACH_DEEP_TIMEOUT_MS || 180000) || 180000),
    extraArgs,
    ...(spawnImpl ? { spawnImpl } : {}),
  });

  return async function runDeep(req) {
    const res = await runner(req);
    if (!res || res.ok === false) {
      logger?.warn?.("coach_deep.transport_error", { error: res && res.error });
    }
    return res;
  };
}

/**
 * REACTOR — Haiku via Anthropic direct fetch on a SEPARATE metered key.
 * Returns null (disabled) when LIVE_COACH_REACTOR_ANTHROPIC_API_KEY is unset —
 * never falls back to the shared/Max key (that would defeat rate-limit isolation).
 */
function createReactorTransport(opts = {}) {
  const { logger = null, fetchImpl, env = process.env } = opts;
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const apiKey = String(env.LIVE_COACH_REACTOR_ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    logger?.info?.("coach_reactor.disabled", { reason: "no LIVE_COACH_REACTOR_ANTHROPIC_API_KEY" });
    return null;
  }
  if (!doFetch) {
    logger?.warn?.("coach_reactor.disabled", { reason: "no fetch implementation" });
    return null;
  }
  const model = resolveCoachModel(
    "liveCoach.reactor",
    null,
    String(env.LIVE_COACH_REACTOR_MODEL || "claude-haiku-4-5").trim() || "claude-haiku-4-5",
  );
  const maxTokens = Math.max(256, Math.min(2000, Number(env.LIVE_COACH_REACTOR_MAX_TOKENS || 700) || 700));
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs || env.LIVE_COACH_REACTOR_TIMEOUT_MS || 20000) || 20000);

  return async function runReactor(req = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // Stable prefix (reference + output contract) -> cached; volatile turns -> user message.
          system: [{ type: "text", text: String(req.system || ""), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: String(req.prompt || "") }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn?.("coach_reactor.http_error", { status: response.status, body: body.slice(0, 200) });
        return { ok: false, error: `reactor ${response.status}`, text: "" };
      }
      const payload = await response.json();
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((block) => block && block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { ok: true, text, usage: payload.usage || null, model: payload.model || model };
    } catch (error) {
      logger?.warn?.("coach_reactor.error", { error: error.message });
      return { ok: false, error: error.message, text: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * SUMMARY — the rolling semantic summary sidecar transport (the SUMMARY cadence's runner).
 * The DESIGN substrate is Codex (the OpenAI $200 sub; isolated CODEX_HOME, OPENAI_API_KEY
 * stripped) so this heavy "read-everything + hold memory" load stays OFF the Anthropic
 * budget. That MCP/JSON runner is a separate integration; until it is wired here the
 * `codex` substrate returns null (the floor loop then simply never runs the summary tick).
 *
 * Substrate is selected by LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE (default 'codex'):
 *   codex|openai -> null for now (documented seam — wire the Codex JSON runner here)
 *   api          -> a REAL, rate-isolated Anthropic-fetch runner on its OWN metered key
 *                   (LIVE_COACH_SUMMARY_ANTHROPIC_API_KEY) so the cadence is exercisable now
 *   off|unknown  -> null (disabled)
 * Returns null (disabled) whenever the selected substrate isn't configured — same
 * "no runner => cadence dormant" contract the reactor uses.
 */
function createSummaryTransport(opts = {}) {
  const {
    logger = null,
    fetchImpl,
    env = process.env,
    resolveCodexClient,
    codexClient,
  } = opts;
  const substrate = String(env.LIVE_COACH_ROLLING_SUMMARY_SUBSTRATE || "codex").trim().toLowerCase();
  if (substrate === "off" || substrate === "none" || substrate === "") {
    logger?.info?.("coach_summary.disabled", { reason: "substrate=off" });
    return null;
  }
  if (substrate === "codex") {
    if (!envBoolean(env.AI_AGENT_CODEX_ENABLED, false)) {
      logger?.info?.("coach_summary.disabled", { reason: "AI_AGENT_CODEX_ENABLED is false" });
      return null;
    }
    const selectCodexClient = () => {
      if (codexClient) return codexClient;
      if (typeof resolveCodexClient === "function") return resolveCodexClient();
      return null;
    };
    let client = selectCodexClient();
    const buildClient = () => {
      client = createCodexMcpClient({
        codexBin: env.CODEX_CLI_PATH,
        codexHome: env.CODEX_HOME,
        model: env.CODEX_AGENT_MODEL,
        timeoutMs: Number(opts.timeoutMs || env.LIVE_COACH_SUMMARY_TIMEOUT_MS || 60000),
      });
      return client;
    };
    const runner = async function runSummary(req = {}) {
      try {
        const activeClient = client || selectCodexClient() || buildClient();
        if (!client) client = activeClient;
        const message = [
          "Return strict JSON only.",
          `System instructions:\n${String(req.system || "")}`,
          `Prompt:\n${String(req.prompt || "")}`,
          req.schema ? `Output schema:\n${JSON.stringify(req.schema)}` : "Output schema: liveCoach rolling summary shape.",
        ].join("\n\n");
        const response = await activeClient.ask(message, {
          timeoutMs: Number(opts.timeoutMs || env.LIVE_COACH_SUMMARY_TIMEOUT_MS || 60000),
          sandbox: "read-only",
          approvalPolicy: "never",
        });
        const json = response && typeof response.json === "object" && response.json !== null
          ? response.json
          : extractJsonFromText(response && response.text);
        if (!json || typeof json !== "object") {
          return {
            ok: false,
            error: "summary response is not valid JSON",
            text: String(response && response.text ? response.text : ""),
          };
        }
        return { ok: true, json, usage: null, model: response.model || response.threadId || "codex" };
      } catch (error) {
        logger?.warn?.("coach_summary.error", { error: error.message });
        return { ok: false, error: error.message, text: "" };
      }
    };
    runner.stop = () => {
      try {
        if (client) client.stop();
      } catch (_error) {}
    };
    return runner;
  }
  if (substrate === "openai") {
    logger?.warn?.("coach_summary.disabled", {
      reason: "openai summary substrate is not wired here yet",
    });
    return null;
  }
  if (substrate !== "api") {
    logger?.warn?.("coach_summary.disabled", { reason: `unknown substrate '${substrate}'` });
    return null;
  }
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const apiKey = String(env.LIVE_COACH_SUMMARY_ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    logger?.info?.("coach_summary.disabled", { reason: "no LIVE_COACH_SUMMARY_ANTHROPIC_API_KEY" });
    return null;
  }
  if (!doFetch) {
    logger?.warn?.("coach_summary.disabled", { reason: "no fetch implementation" });
    return null;
  }
  const model = resolveCoachModel(
    "liveCoach.rollingSummary",
    null,
    String(env.LIVE_COACH_SUMMARY_MODEL || "claude-haiku-4-5").trim() || "claude-haiku-4-5",
  );
  const maxTokens = Math.max(512, Math.min(4000, Number(env.LIVE_COACH_SUMMARY_MAX_TOKENS || 1500) || 1500));
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs || env.LIVE_COACH_SUMMARY_TIMEOUT_MS || 60000) || 60000);

  return async function runSummary(req = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // Stable append-only contract (system) -> cached; the volatile transcript rows -> user message.
          system: [{ type: "text", text: String(req.system || ""), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: String(req.prompt || "") }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn?.("coach_summary.http_error", { status: response.status, body: body.slice(0, 200) });
        return { ok: false, error: `summary ${response.status}`, text: "" };
      }
      const payload = await response.json();
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((block) => block && block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { ok: true, text, usage: payload.usage || null, model: payload.model || model };
    } catch (error) {
      logger?.warn?.("coach_summary.error", { error: error.message });
      return { ok: false, error: error.message, text: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * STUB — a no-spend dev transport so the cockpit COMPONENT can be built against the
 * REAL pipeline (real loop -> real dispatch/steering -> real SSE) with no keys, no model.
 * It reads the live routing keys (sessionId/uii/agent) out of the request prompt that
 * renderConversation already emits ("--- sessionId=… uii=… agent=… ---") and echoes a
 * canned guidance row per active call — so it routes to whatever real sessions are live,
 * with no fixture-session coupling. kind 'deep' returns cockpit STATE; 'reactor' returns
 * a live nudge. Enable with LIVE_COACH_BATCH_TRANSPORT=stub.
 */
function extractRoutingKeys(prompt = "") {
  const keys = [];
  const re = /--- sessionId=(\S+)(?: uii=(\S+))?(?: agent=(\S+))?/g;
  let m;
  while ((m = re.exec(String(prompt)))) {
    keys.push({ sessionId: m[1], uii: m[2] || null, agentEmail: m[3] || null });
  }
  return keys;
}

function createStubTransport(opts = {}) {
  const { kind = "reactor", logger = null, env = process.env } = opts;
  // Defense in depth: never serve canned guidance in production, even if a caller forgets the gate.
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
    logger?.warn?.("coach_stub.refused_in_production", { kind });
    return null;
  }
  const deepRow = (r) => ({
    sessionId: r.sessionId,
    uii: r.uii,
    agentEmail: r.agentEmail,
    currentSection: "2",
    beats: [
      { point: "Confirm the notice/levy deadline", status: "pending" },
      { point: "Anchor the full fee first", status: "pending" },
    ],
    remember: [{ text: "Price-sensitive — lead with value, hold the fee", kind: "watch" }],
    says: [
      { type: "objection", tag: "price", rec: true, text: "What has waiting on this already cost you each month?" },
      { type: "tactic", tag: "anchor", text: "Most clients in your spot open the case in full so it moves today." },
    ],
    priorFlags: [],
  });
  const reactorRow = (r) => ({
    sessionId: r.sessionId,
    uii: r.uii,
    agentEmail: r.agentEmail,
    mode: "reaction",
    read: "Price hesitation just surfaced.",
    steer: "Run the cost-of-waiting frame before re-anchoring on the fee.",
    say: { type: "objection", tag: "price", text: "What has waiting on this already cost you?" },
  });
  return async function runStub(req = {}) {
    const keys = extractRoutingKeys(req.prompt);
    const guidance = keys.map((r) => (kind === "deep" ? deepRow(r) : reactorRow(r)));
    logger?.info?.("coach_stub.run", { kind, rows: guidance.length });
    return { ok: true, json: { schemaVersion: "live-coach.batch-guidance.v2", guidance }, model: `stub-${kind}` };
  };
}

module.exports = {
  createDeepPullTransport,
  createReactorTransport,
  createSummaryTransport,
  createStubTransport,
  fastSettingsPath,
};
