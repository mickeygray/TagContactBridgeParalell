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
const CODEX_KINDS = new Set(["compose", "json", "classify"]);
// Agentic web-search loop: Anthropic's server-side web_search tool + a forced
// submit tool, run as a bounded multi-turn loop INSIDE the adapter, returning the
// submit tool's input as { json }. Anthropic-only today (OpenAI's adapter returns
// supports()=false, so the runner skips it); the future `claude -p` agent adapter
// implements the same kind natively. Kept OUT of REASONING_KINDS so the existing
// single-shot compose/json/classify paths are completely unaffected.
const SEARCH_KINDS = new Set(["search"]);
const OPENAI_KINDS = new Set(["compose", "json", "classify", "transcribe", "image", "tts"]);

// Bounded web_search → submit loop. Mirrors the proven blogger loop: the model
// gets [web_search, submit], tool_choice is OMITTED (toolChoice:false) so it can
// search or submit freely, server-side web_search results return inline, and a
// total deadline bounds the turns. Returns the submit tool's input.
async function runAnthropicSearch(client, sys, request, opts) {
  const { user, tools, submitTool, maxToolTurns, maxTokens, temperature, timeoutMs } = request;
  const submitName = submitTool && submitTool.name;
  if (!submitName) {
    const err = new Error("anthropic search: request.submitTool.name is required");
    err.unsupported = true;
    err.retryable = false;
    throw err;
  }
  const submitDef = {
    name: submitName,
    description: submitTool.description || "Submit the finished structured result.",
    input_schema: submitTool.schema || { type: "object" },
  };
  const allTools = [...(Array.isArray(tools) ? tools : []), submitDef];
  const maxTurns = Math.max(1, Number(maxToolTurns) || 6);
  const totalTimeoutMs = Math.max(Number(timeoutMs) || 0, 1000);
  const deadlineAt = Date.now() + totalTimeoutMs;
  let messages = [{ role: "user", content: String(user ?? "") }];
  let model = opts.model;
  let usage = null;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      const err = new Error(`anthropic search: timed out after ${totalTimeoutMs}ms`);
      err.retryable = true;
      throw err;
    }
    const res = await client.createMessage({
      system: sys,
      messages,
      model: opts.model,
      maxTokens,
      temperature,
      tools: allTools,
      toolChoice: false, // omit — let the model search or submit freely
      timeoutMs: Math.min(remainingMs, 45000),
    });
    model = res.model || model;
    usage = res.usage || usage;
    const submitted = client.extractToolUse(res, submitName);
    if (submitted) {
      return { json: submitted.input || {}, model, usage, provider: "anthropic" };
    }
    // No submit yet. If the model stopped for any non-tool reason it gave up.
    if (res.stop_reason && res.stop_reason !== "tool_use") {
      const err = new Error(`anthropic search: model stopped without submitting (stop_reason: ${res.stop_reason})`);
      err.retryable = true;
      throw err;
    }
    // Carry the assistant turn forward (server-side web_search results ride
    // inline) and let the model continue on the next turn.
    messages = messages.concat([{ role: "assistant", content: res.content || [] }]);
  }
  const err = new Error(`anthropic search: hit maxToolTurns (${maxTurns}) without submitting`);
  err.retryable = true;
  throw err;
}

function unsupportedError(provider, kind) {
  const err = new Error(`${provider}: unsupported kind "${kind}"`);
  err.unsupported = true;
  err.retryable = false;
  return err;
}

function extractJsonFromText(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1));
      } catch (_innerError) {
        return null;
      }
    }
  }
  return null;
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
      return REASONING_KINDS.has(kind) || SEARCH_KINDS.has(kind);
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
      if (kind === "search") {
        return runAnthropicSearch(client, sys, request, opts);
      }
      throw unsupportedError("anthropic", kind);
    },
  };
}

// ── OpenAI adapter ───────────────────────────────────────────────────────────
// Reasoning runs through the Responses API; json/classify parse a JSON object
// out of the text. Modality kinds map to the dedicated endpoints.
// Codex adapter â€” JSON/compose via MCP sessioned codex tool calls.
function createCodexAdapter(client) {
  return {
    id: "codex",
    supports(kind) {
      return CODEX_KINDS.has(kind);
    },
    async run(kind, request = {}, opts = {}) {
      if (!client || typeof client.ask !== "function") {
        const err = new Error("codex adapter requires a client with ask()");
        err.unsupported = true;
        err.retryable = false;
        throw err;
      }
      const { system, user, schema, tool, timeoutMs } = request;
      const userText = String(user ?? request.input ?? request.prompt ?? "");
      const message = [
        userText,
        system ? `System instructions:\n${String(system)}` : null,
        (kind === "json" || kind === "classify") ? "Return only valid JSON." : "Return plain text.",
        tool?.name ? `Tool name hint: ${tool.name}` : null,
        schema ? `Output schema hint: ${JSON.stringify(schema)}` : null,
      ].filter(Boolean).join("\n\n");
      const response = await client.ask(message, {
        model: opts.model || undefined,
        timeoutMs,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      const text = String(response && response.text ? response.text : "").trim();
      if (kind === "compose") {
        return { text, model: response.model || response.threadId || "codex", usage: null, provider: "codex" };
      }
      if (kind === "json" || kind === "classify") {
        const json = extractJsonFromText(text);
        if (!json) {
          const err = new Error("codex output is not valid JSON");
          err.unsupported = false;
          err.retryable = true;
          throw err;
        }
        return { json, model: response.model || response.threadId || "codex", usage: null, provider: "codex" };
      }
      throw unsupportedError("codex", kind);
    },
  };
}

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
function createAiProviders({ anthropic, openai, codex } = {}) {
  const providers = {};
  if (anthropic) providers.anthropic = createAnthropicAdapter(anthropic);
  if (openai) providers.openai = createOpenAiAdapter(openai);
  if (codex) providers.codex = createCodexAdapter(codex);
  return providers;
}

module.exports = {
  createAiProviders,
  createAnthropicAdapter,
  createCodexAdapter,
  createOpenAiAdapter,
  REASONING_KINDS,
  SEARCH_KINDS,
};
