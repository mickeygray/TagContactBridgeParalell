"use strict";

// Shared OpenAI client — the OpenAI peer of anthropicClient.js.
//
// Until now OpenAI was invoked ad-hoc (raw fetch to /v1/responses) in several
// places with no shared client, while Anthropic had createAnthropicClient().
// This formalises the OpenAI side so the AI bus can treat the two providers
// symmetrically. Like anthropicClient it uses raw fetch (no SDK), a
// same-provider model ladder, a per-request timeout, and ExternalServiceError
// shapes so the task runner can classify retryable failures.

const { ExternalServiceError } = require("../../shared-errors/src");
const { env } = require("../../shared-config/src");

function uniq(list) {
  return Array.from(new Set(list.filter(Boolean)));
}

function getOpenAiConfig() {
  const model = env("OPENAI_MODEL", "gpt-5.4-mini");
  return {
    apiKey: env("OPENAI_API_KEY", ""),
    model,
    // Same-provider ladder, walked on 404/network like the Anthropic client.
    fallbackModels: uniq([model, "gpt-5.4-mini", "gpt-5.4", "gpt-5-mini"]),
    maxOutputTokens: Number(env("OPENAI_MAX_OUTPUT_TOKENS", 900)) || 900,
    serviceTier: env("OPENAI_SERVICE_TIER", ""),
    timeoutMs: Number(env("OPENAI_TIMEOUT_MS", 30000)) || 30000,
  };
}

// Mirror of the proven extractor in apps/ai-bus/src/server.js — the Responses
// API can put text in output_text or nested output[].content[].text(.value).
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

function parseJsonObject(text, label = "OpenAI response") {
  const raw = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000)
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
  throw new Error(`${label} did not return JSON`);
}

function createOpenAiClient() {
  const config = getOpenAiConfig();

  function requireKey() {
    if (!config.apiKey) {
      throw new ExternalServiceError("openai", "OpenAI API key is missing", {
        status: 500,
        retryable: false,
      });
    }
  }

  // The reasoning primitive used by compose/json/classify. Walks the model
  // ladder on 404/network, bails immediately on timeout (a retry would also
  // time out). Returns a normalised { text, json?, model, usage }.
  async function createResponse({
    system,
    user,
    model,
    maxOutputTokens,
    serviceTier,
    promptCacheKey,
    promptCacheRetention,
    temperature,
    json = false,
    schema,
    timeoutMs,
    signal,
  } = {}) {
    requireKey();
    const effectiveTimeoutMs = Math.max(Number(timeoutMs) || config.timeoutMs, 1000);
    const requested = model || config.model;
    const candidates = uniq([requested, ...config.fallbackModels]);
    const tier = serviceTier !== undefined ? serviceTier : config.serviceTier;
    let lastError = null;

    // Structured outputs: when a schema is supplied, enforce it via the Responses
    // API json_schema format so REQUIRED fields can't be omitted — the
    // provider-neutral analog of Anthropic's forced tool_use (without this, OpenAI
    // returns plausible-but-incomplete JSON and fails the contract). OpenAI strict
    // mode requires every property be required + additionalProperties:false.
    const strictify = (node) => {
      if (!node || typeof node !== "object") return node;
      if (node.type === "object") {
        const props = node.properties || {};
        const properties = {};
        for (const [k, v] of Object.entries(props)) properties[k] = strictify(v);
        return { ...node, properties, required: Object.keys(props), additionalProperties: false };
      }
      if (node.type === "array" && node.items) return { ...node, items: strictify(node.items) };
      return node;
    };
    const rawSchema = schema && schema.input_schema ? schema.input_schema : schema;
    const strictSchema = json && rawSchema && rawSchema.type === "object" ? strictify(rawSchema) : null;

    for (const modelName of candidates) {
      const body = {
        model: modelName,
        input: [
          ...(system ? [{ role: "developer", content: String(system) }] : []),
          { role: "user", content: String(user ?? "") },
        ],
        max_output_tokens: maxOutputTokens || config.maxOutputTokens,
      };
      if (tier) body.service_tier = tier;
      if (promptCacheKey) {
        body.prompt_cache_key = promptCacheKey;
        body.prompt_cache_retention = promptCacheRetention || "in_memory";
      }
      // Reasoning models reject temperature; only send it when explicitly asked.
      if (temperature !== undefined && temperature !== null) body.temperature = temperature;
      if (strictSchema) {
        body.text = { format: { type: "json_schema", name: "result", schema: strictSchema, strict: true } };
      }

      const controller = new AbortController();
      const onParentAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onParentAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);

      let response;
      try {
        response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (fetchError) {
        clearTimeout(timer);
        if (signal) signal.removeEventListener?.("abort", onParentAbort);
        const isAbort = fetchError?.name === "AbortError";
        lastError = new ExternalServiceError(
          "openai",
          isAbort
            ? `OpenAI request timed out after ${effectiveTimeoutMs}ms`
            : `OpenAI request failed: ${fetchError.message}`,
          {
            status: isAbort ? 504 : 502,
            retryable: true,
            details: { attemptedModel: modelName, reason: isAbort ? "timeout" : "network" },
          },
        );
        if (isAbort) throw lastError;
        continue;
      }
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", onParentAbort);

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (response.ok) {
        const outText = extractOpenAiResponseText(data);
        const result = {
          text: outText,
          model: data?.model || modelName,
          usage: data?.usage || null,
          raw: data,
        };
        if (json) {
          try {
            result.json = parseJsonObject(outText, "OpenAI response");
          } catch (parseError) {
            // Non-JSON output is retryable: walk to the next model candidate
            // instead of throwing out of the ladder. If the ladder is exhausted
            // the runner fails over to the other provider.
            lastError = new ExternalServiceError("openai", `OpenAI returned non-JSON: ${parseError.message}`, {
              status: 502,
              retryable: true,
              details: { attemptedModel: modelName },
            });
            continue;
          }
        }
        return result;
      }

      lastError = new ExternalServiceError("openai", `OpenAI request failed: ${response.status}`, {
        status: 502,
        retryable: response.status >= 500 || response.status === 429,
        details: { responseStatus: response.status, responseBody: data, attemptedModel: modelName },
      });
      if (response.status !== 404) throw lastError;
    }
    throw lastError;
  }

  // Modality primitives. OpenAI implements these; the Anthropic adapter reports
  // supports()===false so the runner never routes them to Claude.
  async function transcribeAudio({ file, fileName = "audio.wav", model, responseFormat = "json", language, timeoutMs } = {}) {
    requireKey();
    if (!file) {
      throw new ExternalServiceError("openai", "Audio file is required for transcription", {
        status: 400,
        retryable: false,
      });
    }
    const form = new FormData();
    // Node Buffers are not directly appendable as a file part — wrap them.
    const filePart = file instanceof Blob ? file : new Blob([file], { type: "application/octet-stream" });
    form.append("file", filePart, fileName);
    form.append("model", model || env("WHISPER_MODEL", "gpt-4o-mini-transcribe"));
    form.append("response_format", responseFormat);
    if (language) form.append("language", language);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 120000, 1000));
    try {
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ExternalServiceError("openai", `OpenAI transcription failed: ${response.status} ${body.slice(0, 160)}`, {
          status: 502,
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function generateImage({ prompt, model, size = "1024x1024", quality, n = 1, timeoutMs } = {}) {
    requireKey();
    const body = { model: model || env("OPENAI_IMAGE_MODEL", "gpt-image-1"), prompt, size, n };
    if (quality) body.quality = quality;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 120000, 1000));
    try {
      const response = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ExternalServiceError("openai", `OpenAI image failed: ${response.status} ${text.slice(0, 160)}`, {
          status: 502,
          retryable: response.status >= 500,
        });
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function synthesizeSpeech({ input, model, voice = "cedar", speed = 1, format = "mp3", timeoutMs } = {}) {
    requireKey();
    const body = {
      model: model || env("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
      input: String(input || "").slice(0, 4000),
      voice,
      speed,
      response_format: format,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(Number(timeoutMs) || 30000, 1000));
    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new ExternalServiceError("openai", `OpenAI speech failed: ${response.status} ${text.slice(0, 160)}`, {
          status: 502,
          retryable: response.status >= 500,
        });
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    config,
    createResponse,
    transcribeAudio,
    generateImage,
    synthesizeSpeech,
    extractOpenAiResponseText,
    parseJsonObject,
  };
}

module.exports = {
  createOpenAiClient,
  getOpenAiConfig,
  extractOpenAiResponseText,
  parseJsonObject,
};
