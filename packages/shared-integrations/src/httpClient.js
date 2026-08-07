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
      // THE TIMER STAYS ARMED THROUGH THE BODY READ.
      //
      // It used to be cleared here, one line before parseResponse — which
      // disarmed the abort exactly when the remaining work was unbounded.
      // `response.text()` streams: a server that sends headers and then stalls
      // the body left this await hanging FOREVER, with no timeout and no retry,
      // wedging whatever worker called it. Every integration goes through this
      // client, so that was a hang available to Logics, RingCentral, CallRail
      // and PhoneBurner alike.
      //
      // Aborting mid-body rejects text() with an AbortError, which the catch
      // below already treats as a normal timeout — so the retry policy now
      // covers a stalled body the same way it covers a stalled connection.
      const data = await parseResponse(response);
      const retryAfter = typeof response.headers?.get === "function"
        ? response.headers.get("retry-after")
        : null;

      if (!response.ok && retryStatuses.has(response.status) && attempt < retries) {
        await pause((attempt + 1) * 500);
        continue;
      }

      return {
        ok: response.ok,
        status: response.status,
        data,
        ...(retryAfter == null ? {} : { headers: { "retry-after": retryAfter } }),
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
      await pause((attempt + 1) * 500);
    } finally {
      // Every exit from the attempt — return, continue, throw — disarms it
      // here, so moving the clear past the body read cannot leak a timer.
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("HTTP request failed");
}

module.exports = {
  parseResponse,
  requestJson,
};
