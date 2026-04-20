"use strict";

const { ExternalServiceError } = require("../../shared-errors/src");
const { getSharedConfig } = require("../../shared-config/src");

function getAnthropicConfig() {
  const config = getSharedConfig();
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
    fallbackModels: [
      "claude-3-5-haiku-20241022",
      "claude-3-5-sonnet-20241022",
      "claude-3-7-sonnet-20250219",
      "claude-sonnet-4-20250514",
      "claude-opus-4-20250514",
    ],
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 1200),
    temperature: Number(process.env.ANTHROPIC_TEMPERATURE || 0),
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

function createAnthropicClient() {
  const config = getAnthropicConfig();

  async function createMessage({ system, messages, model, maxTokens, temperature }) {
    if (!config.apiKey) {
      throw new ExternalServiceError("anthropic", "Anthropic API key is missing", {
        status: 500,
        retryable: false,
      });
    }

    const requestedModel = model || config.model;
    const modelCandidates = [requestedModel, ...config.fallbackModels.filter((item) => item !== requestedModel)];
    let lastError = null;

    for (const modelName of modelCandidates) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: maxTokens || config.maxTokens,
          temperature:
            temperature !== undefined && temperature !== null
              ? temperature
              : config.temperature,
          system,
          messages,
        }),
      });

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
  };
}

module.exports = {
  createAnthropicClient,
  extractTextBlocks,
  getAnthropicConfig,
};
