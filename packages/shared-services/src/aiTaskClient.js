"use strict";

// AI task client — the app-side sender. A control-plane (5001) service calls
// runAiTask(...) and this ships it to the bus on 7000 over loopback HTTP, then
// returns the envelope. Mirrors the proven resolution-pitch proxy
// (apps/control-plane/src/routes/resolutionIntelligence.js): AbortController
// timeout + fetch + x-service-secret.
//
// TIMING — the point of this layer: every call carries a timing breakdown so we
// can plan delivery efficiency.
//   roundTripMs  = wall time the caller waited (measured here)
//   busMs        = time the bus spent (model + validation), reported in the envelope
//   transportMs  = roundTripMs - busMs = the COST OF READING SOMEWHERE ELSE
//                  (serialization + loopback + the other process), isolated from model time.
//
// Transport failures fail closed (ok:false, code transport_*) so a down/slow bus
// never crashes the caller — it gets the task's safeFallback to act on.

const { getSharedConfig, env } = require("../../shared-config/src");

function createAiTaskClient({ baseUrl, secret, defaultTimeoutMs = 30000, fetchImpl, now } = {}) {
  const config = (() => {
    try {
      return getSharedConfig();
    } catch {
      return {};
    }
  })();
  const base = (baseUrl || env("AI_BUS_BASE_URL", `http://127.0.0.1:${env("AI_BUS_PORT", "7000")}`)).replace(/\/+$/, "");
  const svcSecret = secret !== undefined ? secret : config.internalServiceSecret || env("INTERNAL_SERVICE_SECRET", "");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const clock = now || (() => Date.now());

  async function runAiTask(taskId, payload = {}, options = {}) {
    if (!doFetch) throw new Error("aiTaskClient: no fetch implementation available");
    const timeoutMs = Math.max(Number(options.timeoutMs) || defaultTimeoutMs, 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = clock();

    let response = null;
    let body = null;
    let transportError = null;
    try {
      response = await doFetch(`${base}/api/ai/tasks/${encodeURIComponent(taskId)}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(svcSecret ? { "x-service-secret": String(svcSecret) } : {}),
        },
        body: JSON.stringify({ payload, options }),
        signal: controller.signal,
      });
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch (err) {
      transportError = err;
    } finally {
      clearTimeout(timer);
    }
    const roundTripMs = clock() - startedAt;

    // Transport-level failure — the bus wasn't reachable / didn't answer cleanly.
    if (transportError || !response || !response.ok || !body) {
      const aborted = transportError && transportError.name === "AbortError";
      return {
        ok: false,
        taskId,
        code: aborted ? "transport_timeout" : transportError ? "transport_error" : `bus_http_${response && response.status}`,
        error: transportError ? transportError.message : response ? `bus returned ${response.status}` : "no response",
        safeFallback: options.safeFallback !== undefined ? options.safeFallback : null,
        timing: { roundTripMs, busMs: null, transportMs: roundTripMs },
      };
    }

    const busMs = body.timing && typeof body.timing.busMs === "number" ? body.timing.busMs : null;
    const transportMs = busMs == null ? roundTripMs : Math.max(0, roundTripMs - busMs);
    return { ...body, timing: { ...(body.timing || {}), roundTripMs, busMs, transportMs } };
  }

  // Tier shorthand over a named task (the spend plan's useAi). The tier becomes
  // the qualityMode the bus resolves against.
  function useAi(qualityMode, taskId, payload = {}, options = {}) {
    return runAiTask(taskId, payload, { ...options, qualityMode });
  }

  return { runAiTask, useAi, baseUrl: base };
}

module.exports = { createAiTaskClient };
