"use strict";

// RingCX Voice (outbound dialer) client.
//
// Owns the two-step auth (RC OAuth/JWT → RingCX bearer), in-process
// token cache + auto-refresh, and the raw HTTP methods scoped to
// /voice/api/v1/admin/accounts/{accountId}/...
//
// RingCX live agent/IQ session endpoints are kept separate from the
// campaign/lead/gate/active-call surface. In the live tenant these sit
// under /voice/api/v1/admin/accounts/{accountId}/...; the bare /v1/admin
// path returns the RingCX web app shell instead of JSON.
//
// Higher-level orchestrators (cxCampaignService) consume this client
// and stitch together the "build campaign / load lead / dial / etc"
// lifecycle. Callers should generally NOT hit `client.post(path, …)`
// directly — use the named methods below so the path placement of
// {accountId}, {dialGroupId}, {agentGroupId}, {campaignId}, {uii}
// stays in one place.
//
// Auth model:
//   1. POST  RC_BASE/restapi/oauth/token             (JWT-bearer grant)
//      → { access_token, token_type, expires_in, owner_id, ... }
//   2. POST  RINGCX_VOICE_BASE/api/auth/login/rc/accesstoken?includeRefresh=true
//      Body: rcAccessToken=<rc>&rcTokenType=Bearer
//      → { accessToken, refreshToken, tokenType, mainAccountId,
//          rcUser:{email,firstName,lastName}, agentDetails?, ... }
//   3. Use RingCX bearer on /voice/api/v1/...; refresh every <5 min
//      via POST /api/auth/token/refresh (refresh_token=<rt>&rcTokenType=Bearer)
//
// Env contract (see scripts/rcx-voice-discover.js — that script
// captures these into .env from a live API call):
//   RINGCX_PLATFORM_JWT_TOKEN
//   RINGCX_PLATFORM_CLIENT_ID
//   RINGCX_PLATFORM_CLIENT_SECRET
//   RING_CENTRAL_SERVER_URL                          (default https://platform.ringcentral.com)
//   RINGCX_VOICE_BASE_URL                            (default https://ringcx.ringcentral.com)
//   RINGCX_VOICE_TOKEN_EXCHANGE_PATH                 (default /api/auth/login/rc/accesstoken)
//   RINGCX_VOICE_TOKEN_REFRESH_PATH                  (default /api/auth/token/refresh)
//   RINGCX_VOICE_ACCOUNT_ID                          ← sub-account id, USE THIS
//   RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID               (optional)
//   RINGCX_VOICE_DEFAULT_CAMPAIGN_ID                 (optional)
//   RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID              (optional)
//   RINGCX_VOICE_AUX_AVAILABLE_STATE_ID              (numeric stateId, see auxStates GET)

const { ExternalServiceError } = require("../../shared-errors/src");
const { queueRateLimitAlert } = require("./rateLimitAlertService");

const DEFAULT_RC_BASE = "https://platform.ringcentral.com";
const DEFAULT_RCX_BASE = "https://ringcx.ringcentral.com";
const DEFAULT_TOKEN_EXCHANGE_PATH = "/api/auth/login/rc/accesstoken";
const DEFAULT_TOKEN_REFRESH_PATH = "/api/auth/token/refresh";
const DEFAULT_SESSION_ADMIN_PATH_PREFIX = "/voice/api/v1/admin";

// RingCX bearer expires every 5 minutes. We refresh proactively when
// fewer than this many ms remain so a long-running orchestrator never
// catches a 401 mid-batch.
const TOKEN_REFRESH_HEADROOM_MS = 60 * 1000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60 * 1000;
const DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const DEFAULT_REQUEST_MIN_INTERVALS_MS = {
  "admin-read": 750,
  "admin-write": 1500,
  "agent-read": 750,
  "agent-write": 1500,
  "active-call-list": 1000,
  "active-call-control": 1250,
  "manual-outbound": 1500,
  "lead-action": 1500,
  "campaign-read": 750,
  "campaign-write": 1500,
  "recording-metadata": 31 * 1000,
  "recording-download": 2500,
};

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v != null && v !== "" ? String(v) : fallback;
}

function ensure(value, name) {
  if (!value) {
    throw new ExternalServiceError("ringcx-voice", `Missing required env: ${name}`, {
      status: 500,
      retryable: false,
      details: { env: name },
    });
  }
  return value;
}

function normalizeRingcxPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function normalizeRingcxUsername(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/%[0-9a-f]{2}/i.test(raw)) {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

// ── Token cache ──────────────────────────────────────────────────────
//
// Module-level cache keyed by the RingCX platform credential so multiple
// `createRingcxVoiceClient()` calls share the same bearer (no extra
// token-exchange calls per invocation). Reset via `client.auth.revoke()`.
const TOKEN_CACHE = new Map();
const TOKEN_RESOLVE_IN_FLIGHT = new Map();
let AUTH_BACKOFF_UNTIL_MS = 0;
let AUTH_BACKOFF_LAST_ERROR = null;
const API_BACKOFF_BY_SCOPE = new Map();
const API_THROTTLE_BY_SCOPE = new Map();

function getCacheKey(config = {}) {
  return (
    config.platformClientId
    || readEnv("RINGCX_PLATFORM_CLIENT_ID")
    || readEnv("RING_CENTRAL_CLIENT_ID2")
    || "default"
  );
}

function clearCache(cacheKey) {
  const key = cacheKey || getCacheKey();
  TOKEN_CACHE.delete(key);
  TOKEN_RESOLVE_IN_FLIGHT.delete(key);
}

function isRateLimitError(error) {
  const status = Number(error?.status || error?.details?.responseStatus || 0);
  return status === 429;
}

function envDurationMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scopeToEnvToken(scope) {
  return String(scope || "api")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase() || "API";
}

function classifyApiScope(method, path) {
  const verb = String(method || "GET").toUpperCase();
  const p = String(path || "").toLowerCase();
  if (p.includes("interaction-metadata")) return "recording-metadata";
  if (p.includes("recordings/dialogs/")) return "recording-download";
  if (p.includes("activecalls/createmanualagentcall")) return "manual-outbound";
  if (p.includes("activecalls/list")) return "active-call-list";
  if (p.includes("activecalls/")) return "active-call-control";
  if (p.includes("campaignleads/actions")) return "lead-action";
  if (p.includes("/campaigns") || p.includes("dialgroups")) {
    return verb === "GET" ? "campaign-read" : "campaign-write";
  }
  if (p.includes("agentgroups") || p.includes("gategroups")) {
    return verb === "GET" ? "agent-read" : "agent-write";
  }
  return verb === "GET" ? "admin-read" : "admin-write";
}

function normalizeRateLimitGroup(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function classifyApiUsageGroups(scope) {
  const normalized = String(scope || "api").toLowerCase();
  const groups = ["ringcx-api"];
  if (["active-call-list", "active-call-control", "manual-outbound"].includes(normalized)) {
    groups.push("active-calls");
  } else if (["campaign-read", "campaign-write", "lead-action"].includes(normalized)) {
    groups.push("campaigns");
  } else if (["agent-read", "agent-write"].includes(normalized)) {
    groups.push("agents");
  } else if (normalized.startsWith("recording-")) {
    groups.push("recordings");
  }
  return [...new Set(groups)];
}

function apiBackoffKeys(scope, error = null) {
  const keys = [String(scope || "api")];
  const headerGroup = normalizeRateLimitGroup(error?.details?.rateLimitHeaders?.group);
  if (headerGroup) keys.push(`group:${headerGroup}`);
  for (const group of classifyApiUsageGroups(scope)) {
    keys.push(`group:${group}`);
  }
  return [...new Set(keys)];
}

function getScopeMinIntervalMs(scope) {
  const fallback = DEFAULT_REQUEST_MIN_INTERVALS_MS[scope]
    ?? DEFAULT_REQUEST_MIN_INTERVALS_MS["admin-write"];
  return envDurationMs(
    `RINGCX_${scopeToEnvToken(scope)}_MIN_INTERVAL_MS`,
    envDurationMs("RINGCX_API_MIN_INTERVAL_MS", fallback),
  );
}

function isProactiveThrottleEnabled() {
  return parseBooleanFlag(process.env.RINGCX_PROACTIVE_THROTTLE_ENABLED, true);
}

function parseRetryAfterMs(error) {
  const raw = error?.details?.retryAfter || error?.details?.retryAfterSeconds;
  if (raw == null || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = new Date(String(raw));
  if (!Number.isNaN(date.getTime())) {
    return Math.max(date.getTime() - Date.now(), 0);
  }
  return null;
}

function getRateLimitBackoffMs(error, envName, fallbackEnvName = "RINGCX_RATE_LIMIT_BACKOFF_MS") {
  const configured = envDurationMs(
    envName,
    envDurationMs(fallbackEnvName, envDurationMs("RINGCX_RATE_LIMIT_BACKOFF_MS", DEFAULT_RATE_LIMIT_BACKOFF_MS)),
  );
  const max = envDurationMs("RINGCX_RATE_LIMIT_MAX_BACKOFF_MS", DEFAULT_MAX_RATE_LIMIT_BACKOFF_MS);
  const minPenalty = envDurationMs("RINGCX_RATE_LIMIT_MIN_BACKOFF_MS", DEFAULT_RATE_LIMIT_BACKOFF_MS);
  const retryAfterMs = parseRetryAfterMs(error);
  const candidate = retryAfterMs == null ? configured : Math.max(retryAfterMs, minPenalty);
  return Math.min(Math.max(candidate, minPenalty), max);
}

function getAuthBackoffMs(error) {
  return getRateLimitBackoffMs(error, "RINGCX_AUTH_RATE_LIMIT_BACKOFF_MS");
}

function getApiBackoffMs(error, scope) {
  return getRateLimitBackoffMs(
    error,
    `RINGCX_${scopeToEnvToken(scope)}_RATE_LIMIT_BACKOFF_MS`,
    "RINGCX_API_RATE_LIMIT_BACKOFF_MS",
  );
}

function setAuthBackoff(error) {
  const delayMs = getAuthBackoffMs(error);
  AUTH_BACKOFF_UNTIL_MS = Date.now() + delayMs;
  AUTH_BACKOFF_LAST_ERROR = error?.message || "RingCX auth rate limited";
  queueRateLimitAlert({
    platform: "RingCX",
    service: "ringcx-voice",
    scope: "auth",
    openedAt: new Date().toISOString(),
    nextAttemptAt: new Date(AUTH_BACKOFF_UNTIL_MS).toISOString(),
    error,
  });
}

function setApiBackoff(error, scope = "api") {
  const delayMs = getApiBackoffMs(error, scope);
  const untilMs = Date.now() + delayMs;
  const lastError = error?.message || "RingCX API rate limited";
  const keys = apiBackoffKeys(scope, error);
  for (const key of keys) {
    API_BACKOFF_BY_SCOPE.set(key, {
      untilMs,
      lastError,
      method: error?.details?.method || null,
      path: error?.details?.path || null,
      scope,
      usageGroup: key.startsWith("group:") ? key.slice("group:".length) : null,
    });
  }
  queueRateLimitAlert({
    platform: "RingCX",
    service: "ringcx-voice",
    scope,
    usageGroup: keys.filter((key) => key.startsWith("group:")).map((key) => key.slice("group:".length)).join(", "),
    openedAt: new Date().toISOString(),
    nextAttemptAt: new Date(untilMs).toISOString(),
    method: error?.details?.method,
    path: error?.details?.path,
    error,
  });
}

function assertNotInAuthBackoff() {
  if (!AUTH_BACKOFF_UNTIL_MS || AUTH_BACKOFF_UNTIL_MS <= Date.now()) return;
  const error = new ExternalServiceError(
    "ringcx-voice",
    `RingCX auth in rate-limit backoff until ${new Date(AUTH_BACKOFF_UNTIL_MS).toISOString()}`,
    {
      status: 429,
      retryable: true,
      details: {
        rateLimitedCircuitOpen: true,
        scope: "auth",
        nextAuthAttemptAt: new Date(AUTH_BACKOFF_UNTIL_MS).toISOString(),
        lastAuthError: AUTH_BACKOFF_LAST_ERROR,
      },
    },
  );
  // Hourly job queue honors top-level nextAttemptAt — jobs that hit an open
  // circuit reschedule for exactly when it reopens.
  error.nextAttemptAt = new Date(AUTH_BACKOFF_UNTIL_MS).toISOString();
  throw error;
}

function assertNotInApiBackoff(method, path, scope = "api") {
  for (const key of apiBackoffKeys(scope)) {
    const record = API_BACKOFF_BY_SCOPE.get(key);
    if (!record) continue;
    if (record.untilMs <= Date.now()) {
      API_BACKOFF_BY_SCOPE.delete(key);
      continue;
    }
    const error = new ExternalServiceError(
      "ringcx-voice",
      `RingCX ${record.scope || scope} in rate-limit backoff until ${new Date(record.untilMs).toISOString()}`,
      {
        status: 429,
        retryable: true,
        details: {
          rateLimitedCircuitOpen: true,
          scope: record.scope || scope,
          usageGroup: record.usageGroup,
          method,
          path,
          nextApiAttemptAt: new Date(record.untilMs).toISOString(),
          lastApiError: record.lastError,
        },
      },
    );
    error.nextAttemptAt = new Date(record.untilMs).toISOString();
    throw error;
  }
}

async function withApiThrottle(scope, operation) {
  if (!isProactiveThrottleEnabled()) return operation();
  const minIntervalMs = getScopeMinIntervalMs(scope);
  if (!minIntervalMs) return operation();

  let limiter = API_THROTTLE_BY_SCOPE.get(scope);
  if (!limiter) {
    limiter = { nextAt: 0, tail: Promise.resolve() };
    API_THROTTLE_BY_SCOPE.set(scope, limiter);
  }

  const run = limiter.tail.catch(() => {}).then(async () => {
    const waitMs = Math.max(limiter.nextAt - Date.now(), 0);
    if (waitMs > 0) await sleep(waitMs);
    limiter.nextAt = Date.now() + minIntervalMs;
    return operation();
  });
  limiter.tail = run.catch(() => {});
  return run;
}

function getRateLimitState() {
  const now = Date.now();
  const api = {};
  for (const [scope, record] of API_BACKOFF_BY_SCOPE.entries()) {
    if (!record || record.untilMs <= now) {
      API_BACKOFF_BY_SCOPE.delete(scope);
      continue;
    }
    api[scope] = {
      nextApiAttemptAt: new Date(record.untilMs).toISOString(),
      lastApiError: record.lastError,
      method: record.method,
      path: record.path,
      scope: record.scope || scope,
      usageGroup: record.usageGroup || null,
    };
  }
  return {
    auth: AUTH_BACKOFF_UNTIL_MS > now
      ? {
          nextAuthAttemptAt: new Date(AUTH_BACKOFF_UNTIL_MS).toISOString(),
          lastAuthError: AUTH_BACKOFF_LAST_ERROR,
        }
      : null,
    api,
    proactiveThrottleEnabled: isProactiveThrottleEnabled(),
    minIntervalsMs: Object.fromEntries(
      Object.keys(DEFAULT_REQUEST_MIN_INTERVALS_MS).map((scope) => [scope, getScopeMinIntervalMs(scope)]),
    ),
  };
}

// Generic auth-failure cooldown: ANY failed RingCX auth (not just 429) opens
// the circuit — "not dialed into the platform: back off, try again in 3
// minutes." Without this, every caller re-attempts the full token exchange
// immediately during an outage, which is how auth-endpoint 429 cascades start.
const DEFAULT_AUTH_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
function setAuthFailureBackoff(error) {
  const delayMs = envDurationMs("RINGCX_AUTH_FAILURE_BACKOFF_MS", DEFAULT_AUTH_FAILURE_BACKOFF_MS);
  AUTH_BACKOFF_UNTIL_MS = Date.now() + delayMs;
  AUTH_BACKOFF_LAST_ERROR = error?.message || "RingCX auth failed";
}

async function retryAuthOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (isRateLimitError(error)) setAuthBackoff(error);
    else setAuthFailureBackoff(error);
    throw error;
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────
//
// Thin wrappers over the global `fetch` to keep the client free of
// extra deps. Returns `{ status, json, text }` and throws an
// `ExternalServiceError` on a non-2xx response so callers get
// consistent error shapes.

async function rawFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text, headers: res.headers };
}

function asError(method, path, response) {
  // On 429, capture all of RC's rate-limit headers so we have visibility
  // into the actual configured ceiling on the next throttle event.
  // X-Rate-Limit-Group tells us which bucket (Light/Medium/Heavy/Auth)
  // fired; Limit + Window give the configured rate.
  const rateLimitHeaders = response.status === 429 ? {
    retryAfter: response.headers?.get?.("retry-after") || null,
    limit:      response.headers?.get?.("x-rate-limit-limit") || null,
    remaining:  response.headers?.get?.("x-rate-limit-remaining") || null,
    window:     response.headers?.get?.("x-rate-limit-window") || null,
    group:      response.headers?.get?.("x-rate-limit-group") || null,
  } : null;
  return new ExternalServiceError(
    "ringcx-voice",
    `${method} ${path} failed: ${response.status}`,
    {
      status: response.status >= 500 ? 502 : response.status,
      retryable: response.status >= 500 || response.status === 429,
      details: {
        method,
        path,
        responseStatus: response.status,
        responseBody: response.json || response.text,
        retryAfter: response.headers?.get?.("retry-after") || null,
        rateLimitHeaders,
      },
    },
  );
}

// ── Auth ────────────────────────────────────────────────────────────
//
// Step 1: RC OAuth via JWT-bearer grant.
async function fetchRcAccessToken(rcBase, credentials = {}) {
  const jwt = ensure(
    credentials.jwtToken,
    "RINGCX_PLATFORM_JWT_TOKEN or RING_CENTRAL_JWT_TOKEN2",
  );
  const clientId = ensure(
    credentials.clientId,
    "RINGCX_PLATFORM_CLIENT_ID or RING_CENTRAL_CLIENT_ID2",
  );
  const clientSecret = ensure(
    credentials.clientSecret,
    "RINGCX_PLATFORM_CLIENT_SECRET or RING_CENTRAL_CLIENT_SECRET2",
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const r = await rawFetch(`${rcBase}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) throw asError("POST", "/restapi/oauth/token", r);
  return r.json;
}

// Step 2: trade RC token for RingCX bearer.
async function exchangeForRingcxToken(rcxBase, exchangePath, rcAccessToken, rcTokenType) {
  const body = new URLSearchParams({
    rcAccessToken,
    rcTokenType: rcTokenType || "Bearer",
  });
  const r = await rawFetch(`${rcxBase}${exchangePath}?includeRefresh=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) throw asError("POST", exchangePath, r);
  return r.json;
}

// Step 4: refresh the RingCX bearer.
async function refreshRingcxToken(rcxBase, refreshPath, refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    rcTokenType: "Bearer",
  });
  const r = await rawFetch(`${rcxBase}${refreshPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) throw asError("POST", refreshPath, r);
  return r.json;
}

// Resolve a RingCX bearer that's good for at least
// TOKEN_REFRESH_HEADROOM_MS more, refreshing if needed. Cached so
// back-to-back calls reuse the same token without re-exchanging.
async function resolveBearerUncached(config, cacheKey) {
  const key = cacheKey || getCacheKey();
  const cached = TOKEN_CACHE.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt - now > TOKEN_REFRESH_HEADROOM_MS) {
    return cached;
  }

  if (cached?.refreshToken) {
    try {
      assertNotInAuthBackoff();
      const refreshed = await retryAuthOperation(
        () => refreshRingcxToken(
          config.rcxBase,
          config.refreshPath,
          cached.refreshToken,
        ),
      );
      const next = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || cached.refreshToken,
        tokenType: refreshed.tokenType || "Bearer",
        // RingCX bearer lifetime is 5 min; assume fresh if not specified.
        expiresAt: now + (Number(refreshed.expiresIn) * 1000 || 5 * 60 * 1000),
        rcUser: cached.rcUser,
        mainAccountId: cached.mainAccountId,
      };
      TOKEN_CACHE.set(key, next);
      return next;
    } catch (error) {
      if (isRateLimitError(error)) throw error;
      // Fall through to a full re-auth on refresh failure.
      TOKEN_CACHE.delete(key);
    }
  }

  assertNotInAuthBackoff();
  const rc = await retryAuthOperation(() => fetchRcAccessToken(config.rcBase, {
    clientId: config.platformClientId,
    clientSecret: config.platformClientSecret,
    jwtToken: config.platformJwtToken,
  }));
  const voice = await retryAuthOperation(
    () => exchangeForRingcxToken(
      config.rcxBase,
      config.exchangePath,
      rc.access_token,
      rc.token_type,
    ),
  );
  const next = {
    accessToken: voice.accessToken,
    refreshToken: voice.refreshToken || null,
    tokenType: voice.tokenType || "Bearer",
    expiresAt: now + 5 * 60 * 1000,
    rcUser: voice.rcUser || null,
    mainAccountId: voice.mainAccountId || null,
  };
  TOKEN_CACHE.set(key, next);
  return next;
}

// Cutover kill-switch — when PARALLEL_RC_SUSPENDED is set, refuse to
// resolve any bearer token. Same flag as ringcentralClient so a single
// env entry silences ALL RC traffic from this process during cutover.
function rcSuspendedByEnv() {
  const raw = String(process.env.PARALLEL_RC_SUSPENDED || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

async function resolveBearer(config) {
  if (rcSuspendedByEnv()) {
    const err = new Error("RingCX suspended via PARALLEL_RC_SUSPENDED");
    err.code = "PARALLEL_RC_SUSPENDED";
    err.status = 503;
    throw err;
  }

  const key = getCacheKey(config);
  const cached = TOKEN_CACHE.get(key);
  const now = Date.now();

  if (cached && cached.expiresAt - now > TOKEN_REFRESH_HEADROOM_MS) {
    return cached;
  }

  const inFlight = TOKEN_RESOLVE_IN_FLIGHT.get(key);
  if (inFlight) return inFlight;

  const promise = resolveBearerUncached(config, key).finally(() => {
    if (TOKEN_RESOLVE_IN_FLIGHT.get(key) === promise) {
      TOKEN_RESOLVE_IN_FLIGHT.delete(key);
    }
  });
  TOKEN_RESOLVE_IN_FLIGHT.set(key, promise);
  return promise;
}

// ── Public client factory ───────────────────────────────────────────

function createRingcxVoiceClient(options = {}) {
  const config = {
    rcBase: (options.rcBase || readEnv("RING_CENTRAL_SERVER_URL", DEFAULT_RC_BASE)).replace(/\/$/, ""),
    rcxBase: (options.rcxBase || readEnv("RINGCX_VOICE_BASE_URL", DEFAULT_RCX_BASE)).replace(/\/$/, ""),
    exchangePath: options.exchangePath || readEnv("RINGCX_VOICE_TOKEN_EXCHANGE_PATH", DEFAULT_TOKEN_EXCHANGE_PATH),
    refreshPath: options.refreshPath || readEnv("RINGCX_VOICE_TOKEN_REFRESH_PATH", DEFAULT_TOKEN_REFRESH_PATH),
    sessionAdminPathPrefix: (
      options.sessionAdminPathPrefix
      || readEnv("RINGCX_SESSION_ADMIN_PATH_PREFIX", DEFAULT_SESSION_ADMIN_PATH_PREFIX)
    ).replace(/\/$/, ""),
    accountId: options.accountId || ensure(readEnv("RINGCX_VOICE_ACCOUNT_ID"), "RINGCX_VOICE_ACCOUNT_ID"),
    defaultDialGroupId: options.defaultDialGroupId || readEnv("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID"),
    defaultCampaignId: options.defaultCampaignId || readEnv("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID"),
    defaultAgentGroupId: options.defaultAgentGroupId || readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID"),
    availableStateId: options.availableStateId || readEnv("RINGCX_VOICE_AUX_AVAILABLE_STATE_ID"),
    rcUserEmail: options.rcUserEmail || readEnv("RINGCX_VOICE_RC_USER_EMAIL"),
    // RingCX Voice can intentionally use a different RC JWT app than EX
    // call-log/presence. Prefer the dedicated CX lane, with the historical
    // secondary lane kept as a compatibility alias.
    platformClientId:
      options.platformClientId
      || readEnv("RINGCX_PLATFORM_CLIENT_ID")
      || readEnv("RING_CENTRAL_CLIENT_ID2"),
    platformClientSecret:
      options.platformClientSecret
      || readEnv("RINGCX_PLATFORM_CLIENT_SECRET")
      || readEnv("RING_CENTRAL_CLIENT_SECRET2"),
    platformJwtToken:
      options.platformJwtToken
      || readEnv("RINGCX_PLATFORM_JWT_TOKEN")
      || readEnv("RING_CENTRAL_JWT_TOKEN2"),
    // Default agent for placeManualCall — ballen (dedicated agent
    // license), with mgray (admin) as a fallback. The admin can dial
    // too if needed but the agent license is the supported path.
    agentEmail: options.agentEmail
      || readEnv("RINGCX_VOICE_AGENT_EMAIL")
      || readEnv("RINGCX_VOICE_RC_USER_EMAIL"),
  };

  // Per-user bearer override. When the SPA / dialService passes a
  // pre-resolved bearer (from cxTokenStorageService.getRcxSession),
  // we use that on every request instead of admin JWT-bearer flow.
  // Used for SSO-driven calls where each agent has their own RingCX
  // session bearer (3-legged OAuth → exchange → bearer-per-user).
  //
  // Shape: { accessToken, tokenType?, refreshToken?, expiresAt }
  const userBearer = options.userBearer || null;

  function adminPath(suffix) {
    const tail = suffix.startsWith("/") ? suffix.slice(1) : suffix;
    return `/voice/api/v1/admin/accounts/${config.accountId}/${tail}`;
  }

  function sessionAdminPath(suffix) {
    const tail = suffix.startsWith("/") ? suffix.slice(1) : suffix;
    return `${config.sessionAdminPathPrefix}/accounts/${config.accountId}/${tail}`;
  }

  function pathSegment(value, name) {
    const normalized = String(ensure(value, name)).trim();
    return encodeURIComponent(normalized);
  }

  async function request(method, path, { body, query, headers = {}, scope } = {}) {
    const apiScope = scope || classifyApiScope(method, path);
    assertNotInApiBackoff(method, path, apiScope);
    return withApiThrottle(apiScope, async () => {
      assertNotInApiBackoff(method, path, apiScope);
      const bearer = userBearer
        ? { accessToken: userBearer.accessToken, tokenType: userBearer.tokenType || "Bearer" }
        : await resolveBearer(config);
      let url = `${config.rcxBase}${path}`;
      if (query && Object.keys(query).length > 0) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null) qs.append(k, String(v));
        }
        const sep = url.includes("?") ? "&" : "?";
        url += `${sep}${qs.toString()}`;
      }
      const init = {
        method,
        headers: {
          Authorization: `${bearer.tokenType} ${bearer.accessToken}`,
          Accept: "application/json",
          "User-Agent": "tagcontactbridge-parallel/0.1 (ringcx-voice)",
          ...headers,
        },
      };
      if (body !== undefined && body !== null) {
        init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }

      const r = await rawFetch(url, init);
      if (r.ok) return r.json;

      if (r.status === 429) {
        const error = asError(method, path, r);
        if (error.details) {
          error.details.rateLimitedCircuitOpened = true;
          error.details.scope = apiScope;
        }
        setApiBackoff(error, apiScope);
        throw error;
      }

      throw asError(method, path, r);
    });
  }

  // ── auth ──────────────────────────────────────────────────────────
  const auth = {
    async ensureToken() { return resolveBearer(config); },
    revoke() { clearCache(getCacheKey(config)); },
    async whoami() {
      const t = await resolveBearer(config);
      return {
        rcUser: t.rcUser,
        mainAccountId: t.mainAccountId,
        accountId: config.accountId,
        bearerExpiresAt: new Date(t.expiresAt).toISOString(),
      };
    },
  };

  // ── account-level meta ────────────────────────────────────────────
  async function listAccounts() {
    return request("GET", "/voice/api/v1/admin/accounts");
  }

  // ── dial groups ───────────────────────────────────────────────────
  // Dial groups are the parent container for outbound campaigns. Pick
  // the dial mode at create time: PREVIEW (agent reviews before dial),
  // PROGRESSIVE (auto-dial after a delay), PREDICTIVE (system-pacing),
  // MANUAL (agent dials with no system involvement).
  async function listDialGroups() {
    return request("GET", adminPath("dialGroups"));
  }
  async function getDialGroup(dialGroupId) {
    return request("GET", adminPath(`dialGroups/${dialGroupId}`));
  }
  async function createDialGroup(payload) {
    return request("POST", adminPath("dialGroups"), { body: payload });
  }
  async function updateDialGroup(dialGroupId, patch) {
    return request("PUT", adminPath(`dialGroups/${dialGroupId}`), { body: patch });
  }
  async function assignAgentsToDialGroup(dialGroupId, payload = {}) {
    return request(
      "PUT",
      adminPath(`dialGroups/${pathSegment(dialGroupId, "dialGroupId")}/assignAgents`),
      { body: payload },
    );
  }

  // ── campaigns (nested under dial groups) ──────────────────────────
  async function listCampaigns(dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId (or RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID)");
    return request("GET", adminPath(`dialGroups/${dialGroupId}/campaigns`));
  }
  async function getCampaign(campaignId, dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId");
    return request("GET", adminPath(`dialGroups/${dialGroupId}/campaigns/${campaignId}`));
  }
  async function listCampaignDispositions(campaignId, dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId");
    ensure(campaignId, "campaignId");
    return request("GET", adminPath(`dialGroups/${dialGroupId}/campaigns/${campaignId}/campaignDispositions`));
  }
  async function createCampaign(payload, dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId (or RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID)");
    return request("POST", adminPath(`dialGroups/${dialGroupId}/campaigns`), { body: payload });
  }
  async function updateCampaign(campaignId, patch, dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId");
    ensure(campaignId, "campaignId");
    return request("PUT", adminPath(`dialGroups/${dialGroupId}/campaigns/${campaignId}`), { body: patch });
  }
  async function cloneCampaign(campaignId, { newCampaignName, newCountryCode = "USA" } = {}, dialGroupId = config.defaultDialGroupId) {
    ensure(dialGroupId, "dialGroupId");
    return request("POST", adminPath(`dialGroups/${dialGroupId}/campaigns/${campaignId}/clone`), {
      query: { newCampaignName, newCountryCode },
    });
  }

  // ── leads ─────────────────────────────────────────────────────────
  // The lead loader API takes either one row or many in `uploadLeads`.
  async function loadLeads(campaignId, payload) {
    return request("POST", adminPath(`campaigns/${campaignId}/leadLoader/direct`), { body: payload });
  }
  async function searchLeads(payload) {
    return request("POST", adminPath("campaignLeads/leadSearch"), { body: payload });
  }
  async function leadAction(action, body) {
    // action ∈ { RESET_LEADS, CANCEL_LEADS, DELETE_LEADS, PAUSE_LEADS,
    //   READY_LEADS, MANUAL_LEADS, SUPPRESS_LEADS, UNSUPPRESS_LEADS,
    //   CALLBACK_LEADS, MOVE_TO_CAMPAIGN, EMAIL_LEADS, AGENT_RESERVATION }
    return request("PUT", adminPath("campaignLeads/actions"), {
      query: { leadAction: action },
      body,
    });
  }

  // ── agent groups + agents ─────────────────────────────────────────
  async function listAgentGroups() {
    return request("GET", adminPath("agentGroups"));
  }
  async function createAgentGroup(payload) {
    return request("POST", adminPath("agentGroups"), { body: payload });
  }
  async function listAgents(agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId (or RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID)");
    return request("GET", adminPath(`agentGroups/${agentGroupId}/agents`));
  }
  async function getAgent(agentId, agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId");
    return request("GET", adminPath(`agentGroups/${agentGroupId}/agents/${agentId}`));
  }
  async function createAgent(payload, agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId (or RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID)");
    return request("POST", adminPath(`agentGroups/${agentGroupId}/agents`), { body: payload });
  }
  async function updateAgent(agentId, patch, agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId");
    return request("PUT", adminPath(`agentGroups/${agentGroupId}/agents/${agentId}`), { body: patch });
  }
  async function getAgentLogin(agentId, agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId");
    return request(
      "GET",
      sessionAdminPath(`agentGroups/${pathSegment(agentGroupId, "agentGroupId")}/agents/${pathSegment(agentId, "agentId")}/login`),
    );
  }
  async function setAgentState(agentId, state, agentGroupId = config.defaultAgentGroupId) {
    ensure(agentGroupId, "agentGroupId");
    ensure(state, "state");
    return request(
      "POST",
      sessionAdminPath(`agentGroups/${pathSegment(agentGroupId, "agentGroupId")}/agents/${pathSegment(agentId, "agentId")}/setAgentState`),
      { query: { state } },
    );
  }
  async function setAgentStateByUsername(username, state) {
    ensure(username, "username");
    ensure(state, "state");
    return request(
      "POST",
      sessionAdminPath(`agentGroups/setStateByUsername/${pathSegment(username, "username")}`),
      { query: { state } },
    );
  }
  async function updateAgentLoginDialGroup(dialGroupId, payload = {}) {
    return request(
      "POST",
      sessionAdminPath(`agentGroups/updateAgentLoginDialGroup/${pathSegment(dialGroupId, "dialGroupId")}`),
      { body: payload },
    );
  }
  async function listGateAgentAccessLogin({ gateGroupId, gateId } = {}) {
    return request(
      "GET",
      adminPath(`gateGroups/${pathSegment(gateGroupId, "gateGroupId")}/gates/${pathSegment(gateId, "gateId")}/gateAgentAccessLogin`),
    );
  }

  // ── agent state (auxStates) ───────────────────────────────────────
  async function listAuxStates({ activeOnly = true } = {}) {
    return request("GET", adminPath("auxStates"), { query: { activeOnly } });
  }

  // ── active calls ──────────────────────────────────────────────────
  // placeManualCall kicks an outbound dial through whatever device the
  // logged-in agent has selected. Agent must be in AVAILABLE state on
  // the dashboard for this to succeed. RingCX support specifically
  // wants the generated RingCX username here, not the plain office email.
  async function placeManualCall({ username: usernameArg, agentEmail, destination, callerId, ringDuration = 5 } = {}) {
    // Resolution order: explicit username → legacy agentEmail arg →
    // AGENT_EMAIL (ballen) → RC_USER_EMAIL (mgray fallback).
    const username = normalizeRingcxUsername(usernameArg || agentEmail || config.agentEmail || config.rcUserEmail);
    const normalizedDestination = normalizeRingcxPhone(destination);
    const normalizedCallerId = normalizeRingcxPhone(callerId);
    ensure(username, "username (or RINGCX_VOICE_AGENT_EMAIL / _RC_USER_EMAIL)");
    ensure(normalizedDestination, "destination");
    // URLSearchParams encodes this query once: "+" -> "%2B", "@" -> "%40".
    return request("POST", adminPath("activeCalls/createManualAgentCall"), {
      query: {
        username,
        destination: normalizedDestination,
        ringDuration,
        callerId: normalizedCallerId || undefined,
      },
    });
  }
  async function listActiveCalls(options = {}) {
    const hasProduct = Object.prototype.hasOwnProperty.call(options, "product");
    const hasProductId = Object.prototype.hasOwnProperty.call(options, "productId");
    const product = hasProduct ? options.product : "ACCOUNT";
    const productId = hasProductId ? options.productId : config.accountId;
    return request("GET", adminPath("activeCalls/list"), {
      query: {
        product,
        productId,
        externalId: options.externalId,
      },
    });
  }
  async function getCallHistory(uii) {
    return request("GET", adminPath(`callHistory/${pathSegment(uii, "uii")}`));
  }
  async function dispositionCall(uii, { disposition, callback, callBackDTS, notes, phone } = {}) {
    return request("POST", adminPath(`activeCalls/${uii}/dispositionCall`), {
      query: { disposition, callback, callBackDTS, notes },
      body: phone ? { phone } : undefined,
    });
  }
  async function hangupCall(uii) {
    return request("POST", adminPath(`activeCalls/${uii}/hangupCall`));
  }
  async function addSessionToCall(uii, { destination, sessionType }) {
    // sessionType ∈ { MONITOR, BARGEIN, COACHING }
    return request("POST", adminPath(`activeCalls/${uii}/addSessionToCall`), {
      query: { destination, sessionType },
    });
  }
  async function toggleCallRecording(uii, record) {
    return request("POST", adminPath(`activeCalls/${uii}/toggleCallRecording`), {
      query: { record: Boolean(record) },
    });
  }

  // ── CX integration v1 (call recordings) ────────────────────────────
  //
  // The recordings endpoints live under a DIFFERENT path prefix than
  // the admin endpoints above:
  //   /voice/api/cx/integration/v1/accounts/{rcAccountId}/sub-accounts/{subAccountId}/...
  //
  // - rcAccountId  = the parent RingCentral account id (the bearer's
  //                  mainAccountId — `t.mainAccountId` from the token
  //                  exchange) or the explicit RINGCX_RECORDING_RC_ACCOUNT_ID
  //                  env override
  // - subAccountId = our existing RINGCX_VOICE_ACCOUNT_ID (the RingCX
  //                  sub-account where the call lived)
  //
  // Per RingCX docs: 2 calls/min metadata rate limit, 15-min media
  // processing window after call end, polling only (no webhook).
  // Recording must be manually activated on the account by RC.
  //
  // The base URL is overridable via RINGCX_RECORDING_BASE_URL so we
  // can point at engage.ringcentral.com if the recordings backend
  // diverges from ringcx.ringcentral.com.
  const cxIntegrationBase = (
    options.cxIntegrationBase
      || readEnv("RINGCX_RECORDING_BASE_URL")
      || config.rcxBase
  ).replace(/\/$/, "");
  const cxIntegrationPathPrefix = (
    options.cxIntegrationPathPrefix
      || readEnv("RINGCX_RECORDING_PATH_PREFIX", "/voice/api/cx/integration/v1")
  ).replace(/\/$/, "");

  function getRcAccountIdResolver(bearer) {
    return (
      options.rcAccountId
      || readEnv("RINGCX_RECORDING_RC_ACCOUNT_ID")
      || bearer?.mainAccountId
      || null
    );
  }

  function cxIntegrationPath(suffix, { rcAccountId, subAccountId }) {
    const tail = suffix.startsWith("/") ? suffix.slice(1) : suffix;
    return `${cxIntegrationPathPrefix}/accounts/${rcAccountId}/sub-accounts/${subAccountId}/${tail}`;
  }

  async function cxIntegrationRequest(method, suffix, {
    body,
    query,
    headers = {},
    acceptBinary = false,
  } = {}) {
    const apiScope = classifyApiScope(method, suffix);
    assertNotInApiBackoff(method, suffix, apiScope);
    await withApiThrottle(apiScope, async () => {
      assertNotInApiBackoff(method, suffix, apiScope);
    });
    const bearer = userBearer
      ? { accessToken: userBearer.accessToken, tokenType: userBearer.tokenType || "Bearer", mainAccountId: userBearer.mainAccountId }
      : await resolveBearer(config);
    const rcAccountId = getRcAccountIdResolver(bearer);
    ensure(rcAccountId, "rcAccountId (RINGCX_RECORDING_RC_ACCOUNT_ID or bearer.mainAccountId)");
    const subAccountId = config.accountId;
    const path = cxIntegrationPath(suffix, { rcAccountId, subAccountId });

    let url = `${cxIntegrationBase}${path}`;
    if (query && Object.keys(query).length > 0) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.append(k, String(v));
      }
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}${qs.toString()}`;
    }

    const init = {
      method,
      headers: {
        Authorization: `${bearer.tokenType} ${bearer.accessToken}`,
        Accept: acceptBinary ? "audio/wav" : "application/json",
        "User-Agent": "tagcontactbridge-parallel/0.1 (ringcx-recordings)",
        ...headers,
      },
    };
    if (body !== undefined && body !== null) {
      init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    // Inline the fetch because rawFetch always JSON-parses, which would
    // corrupt a binary WAV download.
    const response = await fetch(url, init);
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const rateLimitHeaders = response.status === 429 ? {
        retryAfter: response.headers?.get?.("retry-after") || null,
        limit:      response.headers?.get?.("x-rate-limit-limit") || null,
        remaining:  response.headers?.get?.("x-rate-limit-remaining") || null,
        window:     response.headers?.get?.("x-rate-limit-window") || null,
        group:      response.headers?.get?.("x-rate-limit-group") || null,
      } : null;
      const err = new ExternalServiceError("ringcx-voice", `${method} ${suffix} → HTTP ${response.status}`, {
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
        details: {
          method,
          path: suffix,
          scope: apiScope,
          responseStatus: response.status,
          responseBody: errText.slice(0, 500),
          retryAfter: response.headers.get("retry-after"),
          rateLimitHeaders,
          rateLimitedCircuitOpened: response.status === 429 ? true : undefined,
        },
      });
      if (response.status === 429) setApiBackoff(err, apiScope);
      throw err;
    }
    if (acceptBinary) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        mimeType: response.headers.get("content-type") || "audio/wav",
        contentLength: Number(response.headers.get("content-length") || buffer.length) || buffer.length,
      };
    }
    return response.json();
  }

  // Metadata polling — returns interaction segments in the requested
  // time window. The metadata endpoint is rate-limited to 2 calls/min,
  // so callers should pull bulk windows (e.g. the previous hour) not
  // per-call.
  //
  // Empirical request body shape (verified by the 400 validation
  // response from a live request):
  //
  //   {
  //     "segmentEndTime": "YYYY-MM-DD HH:MM:SS",   // end of window, in
  //                                                // the supplied timeZone
  //     "timeInterval":   <seconds>,               // lookback duration,
  //                                                // e.g. 3600 for 1h
  //     "timeZone":       "America/Los_Angeles"    // IANA TZ id
  //   }
  //
  // So a 1-hour window ending at 13:45 PT becomes
  // { segmentEndTime: "2026-05-12 13:45:00", timeInterval: 3600,
  //   timeZone: "America/Los_Angeles" }.
  //
  // Callers can still pass startTime + endTime (Date objects) — we
  // compute timeInterval from the delta. Or pass segmentEndTime +
  // timeInterval directly.
  async function fetchInteractionMetadata({
    startTime,
    endTime,
    segmentEndTime,
    timeInterval,
    timeZone = "America/Los_Angeles",
    agentIds,
    agentGroupIds,
    extra = {},
  } = {}) {
    function formatLocalTs(date, tz) {
      // Format YYYY-MM-DD HH:MM:SS in the supplied IANA timeZone (no
      // offset suffix — RingCX takes the wall-clock time and applies
      // the timeZone field separately).
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const parts = fmt.formatToParts(date);
      const pick = (type) => parts.find((p) => p.type === type)?.value || "00";
      const hour = pick("hour") === "24" ? "00" : pick("hour");
      return `${pick("year")}-${pick("month")}-${pick("day")} ${hour}:${pick("minute")}:${pick("second")}`;
    }

    let endTs;
    let intervalSec;

    if (segmentEndTime && timeInterval) {
      endTs = segmentEndTime instanceof Date ? segmentEndTime : new Date(segmentEndTime);
      intervalSec = Number(timeInterval);
    } else {
      ensure(startTime, "startTime (or segmentEndTime + timeInterval)");
      ensure(endTime, "endTime (or segmentEndTime + timeInterval)");
      const startTs = startTime instanceof Date ? startTime : new Date(startTime);
      endTs = endTime instanceof Date ? endTime : new Date(endTime);
      intervalSec = Math.max(Math.round((endTs.getTime() - startTs.getTime()) / 1000), 1);
    }

    const body = {
      segmentEndTime: formatLocalTs(endTs, timeZone),
      timeInterval: intervalSec,
      timeZone,
      ...extra,
    };
    if (Array.isArray(agentIds) && agentIds.length > 0) {
      body.agentIds = agentIds.map((id) => Number(id) || id);
    }
    if (Array.isArray(agentGroupIds) && agentGroupIds.length > 0) {
      body.agentGroupIds = agentGroupIds.map((id) => Number(id) || id);
    }

    return cxIntegrationRequest("POST", "interaction-metadata", { body });
  }

  // Stream a single segment recording as a WAV buffer. Pair with
  // fetchInteractionMetadata to get the (dialogId, segmentId) pair —
  // those come from the metadata response. Returns
  //   { buffer, mimeType, contentLength }
  async function downloadRecordingBySegment({ dialogId, segmentId } = {}) {
    ensure(dialogId, "dialogId");
    ensure(segmentId, "segmentId");
    return cxIntegrationRequest(
      "GET",
      `recordings/dialogs/${dialogId}/segments/${segmentId}`,
      { acceptBinary: true },
    );
  }

  return {
    config,
    auth,
    getRateLimitState,
    // raw escape hatches
    request,
    get: (path, options) => request("GET", path, options),
    post: (path, options) => request("POST", path, options),
    put: (path, options) => request("PUT", path, options),
    delete: (path, options) => request("DELETE", path, options),

    listAccounts,

    listDialGroups,
    getDialGroup,
    createDialGroup,
    updateDialGroup,
    assignAgentsToDialGroup,

    listCampaigns,
    getCampaign,
    listCampaignDispositions,
    createCampaign,
    updateCampaign,
    cloneCampaign,

    loadLeads,
    searchLeads,
    leadAction,

    listAgentGroups,
    createAgentGroup,
    listAgents,
    getAgent,
    createAgent,
    updateAgent,
    getAgentLogin,
    setAgentState,
    setAgentStateByUsername,
    updateAgentLoginDialGroup,
    listGateAgentAccessLogin,

    listAuxStates,

    placeManualCall,
    listActiveCalls,
    getCallHistory,
    dispositionCall,
    hangupCall,
    addSessionToCall,
    toggleCallRecording,

    // CX integration v1 — recordings
    fetchInteractionMetadata,
    downloadRecordingBySegment,
  };
}

module.exports = {
  createRingcxVoiceClient,
  getRingcxVoiceRateLimitState: getRateLimitState,
  normalizeRingcxPhone,
  // Exported for the discovery/bootstrap scripts so they can clear the
  // cache between runs without instantiating a client first.
  _clearTokenCache: clearCache,
};
