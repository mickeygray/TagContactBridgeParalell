"use strict";

/**
 * coachTwoStationTransports — the TWO model transports for the two-station coach
 * (coachTwoStationLoop): B/STRATEGIST on Sonnet, A/COACH on Haiku, both direct
 * Anthropic fetch on the SAME dedicated metered key the solo coach uses
 * (LIVE_COACH_SOLO_ANTHROPIC_API_KEY; override LIVE_COACH_TWO_STATION_ANTHROPIC_API_KEY)
 * so coach spend stays measurable on its own key.
 *
 * Hardening the audit demanded (F4 essence) beyond the solo transport it mirrors:
 *   * stop_reason === "max_tokens" is FAILURE, not success — a truncated JSON must
 *     surface as ok:false so the loop cools down instead of parse-failing into the
 *     A2 permanent paid retry loop.
 *   * 429/529 return retryAfterMs (Retry-After honored, floor 30s) so the loop's
 *     cooldown is rate-limit aware.
 *
 * Same dormancy contract as every coach transport: returns nulls when the key is
 * unset — "no runner => loop idles". Cache layout mirrors solo: each station's
 * STABLE system prompt is the cached prefix; only the volatile prompt is uncached.
 * NOTE: B's ~7.4k-token system caches for real; A's ~770-token system sits BELOW the
 * cacheable-prefix floor, so its cache_control harmlessly no-ops — A is cheap enough
 * that this does not matter, but do not expect cacheRead tokens on the coach bucket.
 */

let resolveCoachModel;
try {
  ({ resolveCoachModel } = require("./liveCoachModelPolicy"));
} catch (_error) {
  resolveCoachModel = (_key, _role, envDefault) => envDefault;
}

function createStationRunner({ station, apiKey, doFetch, model, maxTokens, timeoutMs, logger }) {
  return async function run(req = {}) {
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
          system: [{ type: "text", text: String(req.system || ""), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: String(req.prompt || "") }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retryAfterSec = Number(response.headers?.get?.("retry-after")) || 0;
        const rateLimited = response.status === 429 || response.status === 529;
        logger?.warn?.(`coach_two_station.${station}.http_error`, {
          status: response.status,
          body: body.slice(0, 200),
        });
        return {
          ok: false,
          error: `${station} ${response.status}`,
          text: "",
          retryAfterMs: rateLimited ? Math.max(retryAfterSec * 1000, 30_000) : 0,
        };
      }
      const payload = await response.json();
      // Truncation is FAILURE (audit A2): a cut-off JSON never survives repair, and
      // treating it as success either drops the reground silently or retries forever.
      if (payload.stop_reason === "max_tokens") {
        logger?.warn?.(`coach_two_station.${station}.truncated`, { model, maxTokens });
        return { ok: false, error: `${station} truncated:max_tokens`, text: "", usage: payload.usage || null };
      }
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((block) => block && block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { ok: true, text, usage: payload.usage || null, model: payload.model || model };
    } catch (error) {
      logger?.warn?.(`coach_two_station.${station}.error`, { error: error.message });
      return { ok: false, error: error.message, text: "" };
    } finally {
      clearTimeout(timer);
    }
  };
}

function createTwoStationTransports(opts = {}) {
  const { logger = null, fetchImpl, env = process.env } = opts;
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const apiKey = String(
    env.LIVE_COACH_TWO_STATION_ANTHROPIC_API_KEY || env.LIVE_COACH_SOLO_ANTHROPIC_API_KEY || "",
  ).trim();
  if (!apiKey) {
    logger?.info?.("coach_two_station.disabled", { reason: "no metered anthropic key" });
    return { runStrategist: null, runCoach: null };
  }
  if (!doFetch) {
    logger?.warn?.("coach_two_station.disabled", { reason: "no fetch implementation" });
    return { runStrategist: null, runCoach: null };
  }

  const bModel = resolveCoachModel(
    "liveCoach.twoStation.b",
    null,
    String(env.LIVE_COACH_TWO_STATION_B_MODEL || "claude-sonnet-5").trim() || "claude-sonnet-5",
  );
  const aModel = resolveCoachModel(
    "liveCoach.twoStation.a",
    null,
    String(env.LIVE_COACH_TWO_STATION_A_MODEL || "claude-haiku-4-5-20251001").trim() || "claude-haiku-4-5-20251001",
  );
  const bMaxTokens = Math.max(512, Math.min(8000, Number(env.LIVE_COACH_TWO_STATION_B_MAX_TOKENS || 2500) || 2500));
  const aMaxTokens = Math.max(256, Math.min(4000, Number(env.LIVE_COACH_TWO_STATION_A_MAX_TOKENS || 700) || 700));
  const timeoutMs = Math.max(5000, Number(opts.timeoutMs || env.LIVE_COACH_TWO_STATION_TIMEOUT_MS || 30000) || 30000);

  return {
    runStrategist: createStationRunner({
      station: "b", apiKey, doFetch, model: bModel, maxTokens: bMaxTokens, timeoutMs, logger,
    }),
    runCoach: createStationRunner({
      station: "a", apiKey, doFetch, model: aModel, maxTokens: aMaxTokens, timeoutMs, logger,
    }),
  };
}

module.exports = { createTwoStationTransports };
