"use strict";

// Anthropic Messages API runner for the coach eval — same shape as the production coach transport
// (createSoloTransport): system prefix is cache_control:ephemeral so the big reference caches across
// checkpoint calls. Reads the key from the repo .env. Reports real token usage + $ (Sonnet 5 intro
// rates). Thinking is OMITTED by default (Sonnet 5 is snappy/no-extended-thinking by default), which
// is the "thinking off" we settled on.

const fs = require("node:fs");
// Parse model JSON exactly as production does (tolerant of a trailing comma / prose wrapper), so the
// eval's pass/fail mirrors the live path (transport -> parseBatchGuidance -> coerceResponse).
const { repairModelJson } = require("../../packages/shared-services/src/coachBatchRunner");

function loadEnvKey(envPath) {
  try {
    const txt = fs.readFileSync(envPath, "utf8");
    const m = txt.match(/^\s*ANTHROPIC_API_KEY\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  } catch (_) {}
  return process.env.ANTHROPIC_API_KEY || null;
}

// Sonnet 5 intro pricing, $/MTok: input 2, cache-write 2.5 (1.25x), cache-read 0.2 (0.1x), output 10.
const RATES = { in: 2, cacheWrite: 2.5, cacheRead: 0.2, out: 10 };
function usdFromUsage(u = {}) {
  const inp = u.input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const out = u.output_tokens || 0;
  return (inp * RATES.in + cw * RATES.cacheWrite + cr * RATES.cacheRead + out * RATES.out) / 1e6;
}

function createApiRunner(opts = {}) {
  const {
    apiKey,
    model = "claude-sonnet-5",
    maxTokens = 4000,
    thinking = null, // null => omit (Sonnet 5 default = snappy). Pass {type:"disabled"} to be explicit.
    baseUrl = "https://api.anthropic.com",
  } = opts;

  return async function run(req = {}) {
    try {
      const body = {
        model,
        max_tokens: maxTokens,
        system: [{ type: "text", text: String(req.system || ""), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: String(req.prompt || "") }],
      };
      if (thinking) body.thinking = thinking;

      const resp = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        return { ok: false, error: `http ${resp.status}: ${t.slice(0, 400)}` };
      }
      const payload = await resp.json();
      const text = (Array.isArray(payload.content) ? payload.content : [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const json = repairModelJson(text);
      return { ok: true, json, text, usage: payload.usage, cost: usdFromUsage(payload.usage), model: payload.model };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
}

module.exports = { createApiRunner, loadEnvKey, usdFromUsage };
