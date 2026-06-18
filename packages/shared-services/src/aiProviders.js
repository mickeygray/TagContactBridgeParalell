"use strict";

// AI provider capability adapters — the ONE place a provider name appears.
//
// The whole point of the unified bus: a task is provider-neutral. It declares a
// KIND and a provider-neutral request; the runner picks a provider and fails
// over to the other if one is down. Neither the task nor the caller ever says
// "this runs on OpenAI". That decision lives only here.
//
// Reasoning kinds — implemented by BOTH providers, so any reasoning task can
// run on either and swap in either direction:
//   - "compose"  : free text out          → { text }
//   - "json"     : a JSON object out       → { json }
//   - "classify" : a single structured     → { json }  (same as json; the task
//                  label/record                supplies a tool name + schema)
//
// Modality kinds — only providers that physically can implement them return
// supports()===true, so failover transparently skips a provider that can't:
//   - "transcribe" (audio→text), "image", "tts"  → OpenAI only today.
//
// Each adapter.run() returns a normalised result: { text? , json? , model,
// usage, provider }. Errors carry .retryable (transport/5xx/timeout) and
// .unsupported (kind not implemented) so the runner can decide failover.

const REASONING_KINDS = new Set(["compose", "json", "classify"]);
const OPENAI_KINDS = new Set(["compose", "json", "classify", "transcribe", "image", "tts"]);

function unsupportedError(provider, kind) {
  const err = new Error(`${provider}: unsupported kind "${kind}"`);
  err.unsupported = true;
  err.retryable = false;
  return err;
}

// The descriptor's cache policy decides whether the (stable) system prompt rides
// as a cacheable block. Anthropic caches a system *block* with cache_control;
// passing a plain string means no warm-prefix reuse. schema.cache.anthropic =
// { ephemeralSystem: true } turns it on.
function buildAnthropicSystem(system, cache) {
  if (!system) return system;
  if (cache && cache.anthropic && cache.anthropic.ephemeralSystem) {
    return [{ type: "text", text: String(system), cache_control: { type: "ephemeral" } }];
  }
  return system;
}

// ── Anthropic adapter ────────────────────────────────────────────────────────
// json/classify are produced via a forced tool_use carrying the task's schema —
// the most reliable way to get strict structured output from Claude. compose is
// a plain messages turn.
function createAnthropicAdapter(client) {
  return {
    id: "anthropic",
    supports(kind) {
      return REASONING_KINDS.has(kind);
    },
    async run(kind, request = {}, opts = {}) {
      const { system, user, schema, tool, maxTokens, temperature, timeoutMs, cache } = request;
      const sys = buildAnthropicSystem(system, cache);
      if (kind === "compose") {
        const res = await client.createMessage({
          system: sys,
          messages: [{ role: "user", content: String(user ?? "") }],
          model: opts.model,
          maxTokens,
          temperature,
          timeoutMs,
        });
        return {
          text: client.extractTextBlocks(res),
          model: res.model,
          usage: res.usage || null,
          provider: "anthropic",
        };
      }
      if (kind === "json" || kind === "classify") {
        const toolName = tool?.name || "emit_result";
        const toolDef = {
          name: toolName,
          description: tool?.description || "Return the structured result for this task.",
          input_schema: schema || tool?.schema || { type: "object" },
        };
        const res = await client.createMessage({
          system: sys,
          messages: [{ role: "user", content: String(user ?? "") }],
          model: opts.model,
          maxTokens,
          temperature,
          tools: [toolDef],
          toolChoice: { type: "tool", name: toolName },
          timeoutMs,
        });
        const used = client.extractToolUse(res, toolName);
        if (!used) {
          // Model returned free text instead of calling the tool — treat as a
          // retryable miss so the runner can fail over (and ultimately fail
          // closed) rather than silently losing the result.
          const err = new Error("anthropic: model did not call the result tool");
          err.retryable = true;
          throw err;
        }
        return { json: used.input || {}, model: res.model, usage: res.usage || null, provider: "anthropic" };
      }
      throw unsupportedError("anthropic", kind);
    },
  };
}

// ── OpenAI adapter ───────────────────────────────────────────────────────────
// Reasoning runs through the Responses API; json/classify parse a JSON object
// out of the text. Modality kinds map to the dedicated endpoints.
function createOpenAiAdapter(client) {
  return {
    id: "openai",
    supports(kind) {
      return OPENAI_KINDS.has(kind);
    },
    async run(kind, request = {}, opts = {}) {
      const { system, user, schema, tool, maxTokens, temperature, timeoutMs, cache } = request;
      if (kind === "compose" || kind === "json" || kind === "classify") {
        const oa = (cache && cache.openai) || {};
        const res = await client.createResponse({
          system,
          user,
          model: opts.model,
          maxOutputTokens: maxTokens,
          temperature,
          promptCacheKey: oa.promptCacheKey,
          promptCacheRetention: oa.retention,
          serviceTier: oa.serviceTier,
          json: kind !== "compose",
          // Forward the task schema so json/classify enforce required fields
          // (provider-neutral structured output, matching the Anthropic tool path).
          schema: kind === "compose" ? undefined : schema || (tool && tool.schema),
          timeoutMs,
        });
        if (kind === "compose") {
          return { text: res.text, model: res.model, usage: res.usage || null, provider: "openai" };
        }
        return { json: res.json ?? {}, model: res.model, usage: res.usage || null, provider: "openai" };
      }
      if (kind === "transcribe") {
        const model = opts.model || request.model;
        const out = await client.transcribeAudio({ ...request, model });
        return { json: out, model: model || "openai-transcribe", usage: null, provider: "openai" };
      }
      if (kind === "image") {
        const model = opts.model || request.model;
        const out = await client.generateImage({ ...request, model });
        return { json: out, model: model || "openai-image", usage: null, provider: "openai" };
      }
      if (kind === "tts") {
        const model = opts.model || request.model;
        const out = await client.synthesizeSpeech({ ...request, model });
        return { audio: out, model: model || "openai-tts", usage: null, provider: "openai" };
      }
      throw unsupportedError("openai", kind);
    },
  };
}

// Build the adapter map from already-constructed provider clients. Injectable so
// the runner can be unit-tested with fakes (no network).
function createAiProviders({ anthropic, openai } = {}) {
  const providers = {};
  if (anthropic) providers.anthropic = createAnthropicAdapter(anthropic);
  if (openai) providers.openai = createOpenAiAdapter(openai);
  return providers;
}

module.exports = {
  createAiProviders,
  createAnthropicAdapter,
  createOpenAiAdapter,
  REASONING_KINDS,
};
