"use strict";

/**
 * coachSoloTransport — the ONE model transport for the collapsed single-call coach
 * (coachSoloLoop). Sonnet via Anthropic direct fetch on a DEDICATED metered key
 * (LIVE_COACH_SOLO_ANTHROPIC_API_KEY) so the 10s cadence never 429s the Max account and
 * the coach spend is measurable on its own key (the "run API a few days, then decide"
 * plan). The big DEEP prompt (reference + beat catalog + output contract) is the STABLE
 * system prefix -> cache_control ephemeral; only the growing transcript (user message) is
 * uncached, so each tick is "entirely cached except for the transcript".
 *
 * Returns null (dormant) when the key is unset — same "no runner => loop idles" contract
 * the reactor/summary transports use. Satisfies the runner contract parseBatchGuidance
 * consumes directly:  async (req:{system,prompt,schema}) => { ok, text, usage?, model? }
 *
 * Lives in apps/ai-bus (next to coachBatchTransports + liveCoachModelPolicy), NOT in
 * shared-services — the pure loop/runner stay transport-free.
 */

let resolveCoachModel;
try {
  ({ resolveCoachModel } = require("./liveCoachModelPolicy"));
} catch (_error) {
  resolveCoachModel = (_key, _role, envDefault) => envDefault;
}

/**
 * SOLO — Sonnet via Anthropic fetch on its own metered key. Default model claude-sonnet-5
 * (the cheapest "smart" model; intro $2/$10). Returns null when the key is unset.
 */
function createSoloTransport(opts = {}) {
  const { logger = null, fetchImpl, env = process.env } = opts;
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const apiKey = String(env.LIVE_COACH_SOLO_ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) {
    logger?.info?.("coach_solo.disabled", { reason: "no LIVE_COACH_SOLO_ANTHROPIC_API_KEY" });
    return null;
  }
  if (!doFetch) {
    logger?.warn?.("coach_solo.disabled", { reason: "no fetch implementation" });
    return null;
  }
  const model = resolveCoachModel(
    "liveCoach.solo",
    null,
    String(env.LIVE_COACH_SOLO_MODEL || "claude-sonnet-5").trim() || "claude-sonnet-5",
  );
  const maxTokens = Math.max(512, Math.min(8000, Number(env.LIVE_COACH_SOLO_MAX_TOKENS || 2000) || 2000));
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs || env.LIVE_COACH_SOLO_TIMEOUT_MS || 30000) || 30000);

  return async function runSolo(req = {}) {
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
          // Stable big prompt (reference + beat catalog + output contract) -> cached;
          // the volatile transcript -> user message.
          system: [{ type: "text", text: String(req.system || ""), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: String(req.prompt || "") }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        logger?.warn?.("coach_solo.http_error", { status: response.status, body: body.slice(0, 200) });
        return { ok: false, error: `solo ${response.status}`, text: "" };
      }
      const payload = await response.json();
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((block) => block && block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { ok: true, text, usage: payload.usage || null, model: payload.model || model };
    } catch (error) {
      logger?.warn?.("coach_solo.error", { error: error.message });
      return { ok: false, error: error.message, text: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = { createSoloTransport };
