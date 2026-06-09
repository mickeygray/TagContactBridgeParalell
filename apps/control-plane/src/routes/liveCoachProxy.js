"use strict";

const http = require("http");
const https = require("https");
const express = require("express");
const { PORTS } = require("../../../../packages/shared-config/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const MANAGER_ROLES = new Set(["admin", "manager"]);

// Reusable keep-alive agents so proxied requests to ai-bus (:7000) pool their
// sockets instead of opening a fresh TCP+HTTP connection per request. ai-bus is
// reached over plain HTTP today; the https agent is kept for symmetry in case
// the upstream scheme ever changes.
// NOTE: Node's global fetch() is undici-based and IGNORES the `agent` option
// (undici pools via a `dispatcher` instead), so on the global fetch path these
// agents are currently a no-op. They are harmless and become active if/when the
// upstream calls move to http.request or an `undici.Agent` dispatcher. In prod,
// connection reuse to ai-bus is already handled by nginx (upstream `keepalive`
// + `Connection ""`), so this is an efficiency nicety, not a correctness gap.
const aiBusHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 128,
  maxFreeSockets: 10,
});
const aiBusHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 128,
  maxFreeSockets: 10,
});

function agentForUrl(url) {
  const protocol = typeof url === "string" ? new URL(url).protocol : url.protocol;
  return protocol === "https:" ? aiBusHttpsAgent : aiBusHttpAgent;
}

function clean(value, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function firstClean(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function normalizeEmail(value) {
  return clean(value, 320).toLowerCase();
}

function idsMatch(left, right) {
  const a = clean(left).toLowerCase();
  const b = clean(right).toLowerCase();
  return Boolean(a && b && a === b);
}

function isManager(user = {}) {
  return MANAGER_ROLES.has(String(user.role || "").trim().toLowerCase());
}

function buildAiBusUrl(path, query = null) {
  const url = new URL(path, `http://127.0.0.1:${PORTS.aiBus}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function buildInternalHeaders(config, extra = {}) {
  const headers = new Headers(extra);
  if (config.internalServiceSecret) {
    headers.set("x-service-secret", String(config.internalServiceSecret));
  }
  return headers;
}

function proxyTimeoutMs(config, fallback = 8000) {
  return Math.max(
    1000,
    Number(config?.liveCoachProxyTimeoutMs || process.env.LIVE_COACH_PROXY_TIMEOUT_MS || fallback) || fallback,
  );
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = init.signal;
  const abortFromCaller = () => controller.abort();
  if (callerSignal?.aborted) controller.abort();
  else callerSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
  try {
    return await fetch(url, {
      ...init,
      agent: init.agent || agentForUrl(url),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      const timeoutError = new Error(`Live coach proxy timed out after ${timeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener?.("abort", abortFromCaller);
  }
}

function resolveAgentScope(req) {
  const input = req.method === "GET" ? req.query || {} : req.body || {};
  const user = req.user || {};
  const manager = isManager(user);
  const requestedEmail = normalizeEmail(input.agentEmail);
  const requestedExtension = firstClean(input.agentExtensionId, input.agentExtension, input.extensionId);
  const userEmail = normalizeEmail(user.email);
  const userExtensions = [
    user.extensionId,
    user.extensionNumber,
    user.cxAgentId,
    user.stationLabel,
  ].map((value) => clean(value)).filter(Boolean);

  if (!manager) {
    if (requestedEmail && userEmail && requestedEmail !== userEmail) {
      const error = new Error("Coach session is outside this agent scope");
      error.status = 403;
      throw error;
    }
    if (
      requestedExtension &&
      userExtensions.length > 0 &&
      !userExtensions.some((extension) => idsMatch(extension, requestedExtension))
    ) {
      const error = new Error("Coach session is outside this agent scope");
      error.status = 403;
      throw error;
    }
  }

  return {
    agentEmail: manager ? requestedEmail || userEmail : userEmail || requestedEmail,
    agentExtensionId: manager
      ? requestedExtension || userExtensions[0] || ""
      : userExtensions[0] || requestedExtension,
    agentName: firstClean(input.agentName, user.name, user.logicsDisplayName, user.tagLogicsName),
  };
}

function assertSessionScope(req, session) {
  if (isManager(req.user || {})) return;
  const user = req.user || {};
  const metadata = session?.metadata || {};
  const userEmail = normalizeEmail(user.email);
  const sessionEmail = normalizeEmail(metadata.agentEmail);
  const userExtensions = [
    user.extensionId,
    user.extensionNumber,
    user.cxAgentId,
    user.stationLabel,
  ].map((value) => clean(value)).filter(Boolean);
  const sessionExtension = firstClean(metadata.agentExtensionId, metadata.agentExtension, metadata.extensionId);

  if (sessionEmail && userEmail && sessionEmail !== userEmail) {
    const error = new Error("Coach session is outside this agent scope");
    error.status = 403;
    throw error;
  }
  if (
    sessionExtension &&
    userExtensions.length > 0 &&
    !userExtensions.some((extension) => idsMatch(extension, sessionExtension))
  ) {
    const error = new Error("Coach session is outside this agent scope");
    error.status = 403;
    throw error;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return { ok: false, error: text };
  }
}

async function fetchAiBusJson(config, path, { method = "GET", body = null, query = null } = {}) {
  const headers = buildInternalHeaders(config);
  const init = {
    method,
    headers,
  };
  if (body !== null && body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  const response = await fetchWithTimeout(buildAiBusUrl(path, query), init, proxyTimeoutMs(config));
  const data = await readJson(response);
  return { response, data };
}

async function proxyJson(res, requestPromise) {
  const { response, data } = await requestPromise;
  return res.status(response.status).json(data || { ok: response.ok });
}

async function getInternalSession(config, sessionId) {
  const { response, data } = await fetchAiBusJson(
    config,
    `/api/ai/live-coach/grpc/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok || !data?.session) {
    const error = new Error(data?.error || `Coach session lookup failed (${response.status})`);
    error.status = response.status || 502;
    throw error;
  }
  return data.session;
}

function createLiveCoachProxyRouter(auth, { config, logger } = {}) {
  const router = express.Router();

  router.use(auth.requireAuth, auth.requireUser, auth.requirePermission("coach.view"));

  router.get("/dashboard/sessions", async (req, res) => {
    try {
      if (!isManager(req.user || {})) {
        return res.status(403).json({ ok: false, error: "Manager access required" });
      }
      return proxyJson(
        res,
        fetchAiBusJson(config, "/api/ai/live-coach/grpc/dashboard/sessions", {
          query: {
            summary: firstClean(req.query?.summary, "1") || "1",
          },
        }),
      );
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/sync-current", async (req, res) => {
    try {
      if (!isManager(req.user || {})) {
        return res.status(403).json({ ok: false, error: "Manager access required" });
      }
      return proxyJson(
        res,
        fetchAiBusJson(config, "/api/ai/live-coach/grpc/mongo/sync-current", {
          method: "POST",
          body: {
            lookbackMs: Number(req.body?.lookbackMs || req.query?.lookbackMs || 5 * 60 * 1000) || 5 * 60 * 1000,
            limit: Number(req.body?.limit || req.query?.limit || 120) || 120,
          },
        }),
      );
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/session-for-call", async (req, res) => {
    try {
      const agentScope = resolveAgentScope(req);
      const input = req.query || {};
      const body = {
        ...agentScope,
        agentExtension: agentScope.agentExtensionId,
        uii: firstClean(input.uii, input.rcxUii, input.callUii),
        queueItemId: firstClean(input.queueItemId, input.queueTicketId),
        callSessionId: firstClean(input.callSessionId, input.sessionId),
        caseId: firstClean(input.caseId),
        contactName: firstClean(input.contactName),
        source: "control-plane-cx",
        retireReplaced: true,
      };
      return proxyJson(
        res,
        fetchAiBusJson(config, "/api/ai/live-coach/grpc/mongo/bind/latest", {
          method: "POST",
          body,
        }),
      );
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/sessions/:sessionId", async (req, res) => {
    try {
      const session = await getInternalSession(config, req.params.sessionId);
      assertSessionScope(req, session);
      return res.json({ ok: true, session });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/sessions/:sessionId/stop", async (req, res) => {
    try {
      const session = await getInternalSession(config, req.params.sessionId);
      assertSessionScope(req, session);
      return proxyJson(
        res,
        fetchAiBusJson(config, `/api/ai/live-coach/grpc/${encodeURIComponent(req.params.sessionId)}/stop`, {
          method: "POST",
          body: {
            ...(req.body || {}),
            reason: firstClean(req.body?.reason, "control-plane-client-release"),
          },
        }),
      );
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/sessions/:sessionId/release", async (req, res) => {
    try {
      const session = await getInternalSession(config, req.params.sessionId);
      assertSessionScope(req, session);
      return proxyJson(
        res,
        fetchAiBusJson(config, `/api/ai/live-coach/grpc/${encodeURIComponent(req.params.sessionId)}/stop`, {
          method: "POST",
          body: {
            ...(req.body || {}),
            reason: firstClean(req.body?.reason, "control-plane-client-release"),
            status: firstClean(req.body?.status, "released"),
          },
        }),
      );
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/sessions/:sessionId/events", async (req, res) => {
    const controller = new AbortController();
    const timeoutMs = proxyTimeoutMs(config, 8000);
    const connectTimeout = setTimeout(() => controller.abort(), timeoutMs);
    let clientClosed = false;
    try {
      const session = await getInternalSession(config, req.params.sessionId);
      assertSessionScope(req, session);

      const upstreamUrl = buildAiBusUrl(
        `/api/ai/live-coach/grpc/sessions/${encodeURIComponent(req.params.sessionId)}/events`,
      );
      const upstream = await fetch(upstreamUrl, {
        headers: buildInternalHeaders(config),
        agent: agentForUrl(upstreamUrl),
        signal: controller.signal,
      });
      clearTimeout(connectTimeout);

      if (!upstream.ok || !upstream.body) {
        const data = await readJson(upstream);
        return res.status(upstream.status).json(data || { ok: false, error: "Coach event stream unavailable" });
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      req.on("close", () => {
        clientClosed = true;
        controller.abort();
      });

      for await (const chunk of upstream.body) {
        if (res.destroyed || res.writableEnded) break;
        if (!res.write(Buffer.from(chunk))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (error) {
      clearTimeout(connectTimeout);
      if (clientClosed || res.destroyed || res.writableEnded) return;
      logger?.warn?.("live_coach.sse_proxy.failed", {
        sessionId: req.params.sessionId,
        error: error.message,
      });
      if (!res.headersSent) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
      res.end();
    }
  });

  return router;
}

module.exports = {
  createLiveCoachProxyRouter,
};
