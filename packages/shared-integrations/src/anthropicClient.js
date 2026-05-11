"use strict";

const { ExternalServiceError } = require("../../shared-errors/src");
const { getSharedConfig, env } = require("../../shared-config/src");

function getAnthropicConfig() {
  const config = getSharedConfig();
  return {
    apiKey: env("ANTHROPIC_API_KEY", ""),
    model: env("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
    fallbackModels: [
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
    ],
    maxTokens: Number(env("ANTHROPIC_MAX_TOKENS", 1200)),
    temperature: Number(env("ANTHROPIC_TEMPERATURE", 0)),
    serviceName: config.serviceNames.controlPlane,
  };
}

function extractTextBlocks(payload) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

/**
 * Return the first `tool_use` block whose `name` matches `toolName`.
 * Returns `null` if none was produced — caller decides whether that's
 * a failure or a signal (some prompts legitimately skip the tool).
 */
function extractToolUse(payload, toolName) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  for (const block of content) {
    if (!block || block.type !== "tool_use") continue;
    if (toolName && block.name !== toolName) continue;
    return { name: block.name, input: block.input || {}, id: block.id || null };
  }
  return null;
}

function createAnthropicClient() {
  const config = getAnthropicConfig();

  async function createMessage({
    system,
    messages,
    model,
    maxTokens,
    temperature,
    tools,
    toolChoice,
    timeoutMs,
  }) {
    if (!config.apiKey) {
      throw new ExternalServiceError("anthropic", "Anthropic API key is missing", {
        status: 500,
        retryable: false,
      });
    }

    // Per-request timeout. Defaults to 25s — enough for a long Sonnet
    // tool-use turn on slow days, but short enough that a hung
    // connection doesn't wedge an upstream handler (inbound SMS,
    // activity review, hourly sweeper). Caller can override.
    const effectiveTimeoutMs = Math.max(
      Number(timeoutMs) || Number(config.timeoutMs) || 25_000,
      1000,
    );

    const requestedModel = model || config.model;
    const modelCandidates = [requestedModel, ...config.fallbackModels.filter((item) => item !== requestedModel)];
    let lastError = null;

    for (const modelName of modelCandidates) {
      const body = {
        model: modelName,
        max_tokens: maxTokens || config.maxTokens,
        temperature:
          temperature !== undefined && temperature !== null
            ? temperature
            : config.temperature,
        system,
        messages,
      };
      if (Array.isArray(tools) && tools.length > 0) {
        body.tools = tools;
        // Default `tool_choice` to "any" when tools are provided — we
        // explicitly want the model to call one of them, not return free text.
        body.tool_choice = toolChoice || { type: "any" };
      }

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

      let response;
      try {
        response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: abortController.signal,
        });
      } catch (fetchError) {
        clearTimeout(timeoutHandle);
        const isAbort = fetchError?.name === "AbortError";
        lastError = new ExternalServiceError(
          "anthropic",
          isAbort
            ? `Anthropic request timed out after ${effectiveTimeoutMs}ms`
            : `Anthropic request failed: ${fetchError.message}`,
          {
            status: isAbort ? 504 : 502,
            retryable: true,
            details: {
              attemptedModel: modelName,
              timeoutMs: effectiveTimeoutMs,
              reason: isAbort ? "timeout" : "network",
            },
          },
        );
        // Timeouts don't benefit from iterating through every fallback
        // model (each would also time out), so bail out immediately.
        if (isAbort) throw lastError;
        // Network errors — try the next fallback model.
        continue;
      }
      clearTimeout(timeoutHandle);

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }

      if (response.ok) {
        return {
          ...data,
          model: modelName,
        };
      }

      lastError = new ExternalServiceError(
        "anthropic",
        `Anthropic request failed: ${response.status}`,
        {
          status: 502,
          retryable: response.status >= 500 || response.status === 429,
          details: {
            responseStatus: response.status,
            responseBody: data,
            attemptedModel: modelName,
          },
        },
      );

      const notFound = response.status === 404;
      if (!notFound) {
        throw lastError;
      }
    }

    throw lastError;
  }

  return {
    config,
    createMessage,
    extractTextBlocks,
    extractToolUse,
  };
}

module.exports = {
  createAnthropicClient,
  extractTextBlocks,
  extractToolUse,
  getAnthropicConfig,
};
