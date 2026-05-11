"use strict";

// RingCX Voice (outbound dialer) client.
//
// Owns the two-step auth (RC OAuth/JWT → RingCX bearer), in-process
// token cache + auto-refresh, and the raw HTTP methods scoped to
// /voice/api/v1/admin/accounts/{accountId}/...
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
//   RING_CENTRAL_JWT_TOKEN
//   RING_CENTRAL_CLIENT_ID
//   RING_CENTRAL_CLIENT_SECRET
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

const DEFAULT_RC_BASE = "https://platform.ringcentral.com";
const DEFAULT_RCX_BASE = "https://ringcx.ringcentral.com";
const DEFAULT_TOKEN_EXCHANGE_PATH = "/api/auth/login/rc/accesstoken";
const DEFAULT_TOKEN_REFRESH_PATH = "/api/auth/token/refresh";

// RingCX bearer expires every 5 minutes. We refresh proactively when
// fewer than this many ms remain so a long-running orchestrator never
// catches a 401 mid-batch.
const TOKEN_REFRESH_HEADROOM_MS = 60 * 1000;

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

// ── Token cache ──────────────────────────────────────────────────────
//
// Module-level cache keyed by RING_CENTRAL_CLIENT_ID so multiple
// `createRingcxVoiceClient()` calls share the same bearer (no extra
// token-exchange calls per invocation). Reset via `client.auth.revoke()`.
const TOKEN_CACHE = new Map();
const TOKEN_RESOLVE_IN_FLIGHT = new Map();

function getCacheKey() {
  return readEnv("RING_CENTRAL_CLIENT_ID", "default");
}

function clearCache() {
  TOKEN_CACHE.delete(getCacheKey());
  TOKEN_RESOLVE_IN_FLIGHT.delete(getCacheKey());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const status = Number(error?.status || error?.details?.responseStatus || 0);
  return status === 429;
}

function parseRetryAfterMs(error) {
  const raw = error?.details?.retryAfter || error?.details?.retryAfterSeconds;
  if (raw == null || raw === "") return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 20_000);
  }
  const date = new Date(String(raw));
  if (!Number.isNaN(date.getTime())) {
    return Math.min(Math.max(date.getTime() - Date.now(), 0), 20_000);
  }
  return null;
}

function getAuthRetryDelayMs(error, attemptIndex) {
  const retryAfterMs = parseRetryAfterMs(error);
  if (retryAfterMs != null) return retryAfterMs;
  const configured = String(process.env.RINGCX_AUTH_RETRY_DELAYS_MS || "")
    .split(/[,\s]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const defaults = [2_000, 5_000, 10_000];
  const delays = configured.length > 0 ? configured : defaults;
  return delays[Math.min(attemptIndex, delays.length - 1)];
}

async function retryAuthOperation(operation) {
  const maxAttempts = Math.max(1, Number(process.env.RINGCX_AUTH_MAX_ATTEMPTS) || 4);
  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt >= maxAttempts - 1) {
        throw error;
      }
      await sleep(getAuthRetryDelayMs(error, attempt));
    }
  }
  throw lastError;
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
      },
    },
  );
}

// ── Auth ────────────────────────────────────────────────────────────
//
// Step 1: RC OAuth via JWT-bearer grant.
async function fetchRcAccessToken(rcBase) {
  const jwt = ensure(readEnv("RING_CENTRAL_JWT_TOKEN"), "RING_CENTRAL_JWT_TOKEN");
  const clientId = ensure(readEnv("RING_CENTRAL_CLIENT_ID"), "RING_CENTRAL_CLIENT_ID");
  const clientSecret = ensure(readEnv("RING_CENTRAL_CLIENT_SECRET"), "RING_CENTRAL_CLIENT_SECRET");

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

  const rc = await retryAuthOperation(() => fetchRcAccessToken(config.rcBase));
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

async function resolveBearer(config) {
  const key = getCacheKey();
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
    accountId: options.accountId || ensure(readEnv("RINGCX_VOICE_ACCOUNT_ID"), "RINGCX_VOICE_ACCOUNT_ID"),
    defaultDialGroupId: options.defaultDialGroupId || readEnv("RINGCX_VOICE_DEFAULT_DIAL_GROUP_ID"),
    defaultCampaignId: options.defaultCampaignId || readEnv("RINGCX_VOICE_DEFAULT_CAMPAIGN_ID"),
    defaultAgentGroupId: options.defaultAgentGroupId || readEnv("RINGCX_VOICE_DEFAULT_AGENT_GROUP_ID"),
    availableStateId: options.availableStateId || readEnv("RINGCX_VOICE_AUX_AVAILABLE_STATE_ID"),
    rcUserEmail: options.rcUserEmail || readEnv("RINGCX_VOICE_RC_USER_EMAIL"),
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

  async function request(method, path, { body, query, headers = {} } = {}) {
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
    if (!r.ok) throw asError(method, path, r);
    return r.json;
  }

  // ── auth ──────────────────────────────────────────────────────────
  const auth = {
    async ensureToken() { return resolveBearer(config); },
    revoke() { clearCache(); },
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

  // ── agent state (auxStates) ───────────────────────────────────────
  async function listAuxStates({ activeOnly = true } = {}) {
    return request("GET", adminPath("auxStates"), { query: { activeOnly } });
  }

  // ── active calls ──────────────────────────────────────────────────
  // placeManualCall kicks an outbound dial through whatever device the
  // logged-in agent has selected. Agent must be in AVAILABLE state on
  // the dashboard for this to succeed.
  async function placeManualCall({ agentEmail, destination, callerId, ringDuration = 5 } = {}) {
    // Resolution order: explicit arg → AGENT_EMAIL (ballen) → RC_USER_EMAIL (mgray fallback)
    const username = agentEmail || config.agentEmail || config.rcUserEmail;
    const normalizedDestination = normalizeRingcxPhone(destination);
    const normalizedCallerId = normalizeRingcxPhone(callerId);
    ensure(username, "agentEmail (or RINGCX_VOICE_AGENT_EMAIL / _RC_USER_EMAIL)");
    ensure(normalizedDestination, "destination");
    return request("POST", adminPath("activeCalls/createManualAgentCall"), {
      query: {
        username,
        destination: normalizedDestination,
        ringDuration,
        callerId: normalizedCallerId || undefined,
      },
    });
  }
  async function listActiveCalls({ product = "ACCOUNT", productId = config.accountId } = {}) {
    return request("GET", adminPath("activeCalls/list"), {
      query: { product, productId },
    });
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

  return {
    config,
    auth,
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

    listAuxStates,

    placeManualCall,
    listActiveCalls,
    dispositionCall,
    hangupCall,
    addSessionToCall,
    toggleCallRecording,
  };
}

module.exports = {
  createRingcxVoiceClient,
  normalizeRingcxPhone,
  // Exported for the discovery/bootstrap scripts so they can clear the
  // cache between runs without instantiating a client first.
  _clearTokenCache: clearCache,
};
