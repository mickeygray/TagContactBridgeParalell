"use strict";

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function requestJson(url, options = {}, policy = {}) {
  const retries = Math.max(Number(policy.retries) || 0, 0);
  const timeoutMs = Number(policy.timeoutMs) || 15000;
  const retryStatuses = new Set(policy.retryStatuses || [408, 409, 425, 429, 500, 502, 503, 504]);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await parseResponse(response);

      if (!response.ok && retryStatuses.has(response.status) && attempt < retries) {
        await pause((attempt + 1) * 500);
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
      };
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
      await pause((attempt + 1) * 500);
    }
  }

  throw lastError || new Error("HTTP request failed");
}

module.exports = {
  parseResponse,
  requestJson,
};
