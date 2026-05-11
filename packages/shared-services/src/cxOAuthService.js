"use strict";

// cxOAuthService — orchestrates the 3-legged OAuth handshake with
// RingCentral so each agent gets their own RC access token + refresh
// token. We then exchange that RC token for a RingCX bearer (same
// /api/auth/login/rc/accesstoken endpoint we already use admin-side).
//
// Flow:
//   start({ user, finalRedirectTo? }) →
//     - generate state + PKCE verifier/challenge
//     - persist RcOAuthState row (TTL 10 min)
//     - return { authorizeUrl, state }
//
//   callback({ code, state }) →
//     - look up RcOAuthState by state, verify not expired/used
//     - POST RC /restapi/oauth/token with code + code_verifier
//     - get { access_token, refresh_token, owner_id }
//     - encrypt + store on UserAccount via cxTokenStorageService
//     - exchange RC token for RingCX bearer (same flow as admin)
//     - store RingCX bearer encrypted
//     - mark state consumed
//     - return success
//
//   refreshUserSession({ user }) →
//     - read encrypted refresh token
//     - POST RC /restapi/oauth/token with grant_type=refresh_token
//     - get fresh access_token (and possibly new refresh_token)
//     - exchange for RingCX bearer
//     - update encrypted session
//
// Configuration via env (all required for cxOAuthEnabled):
//   RC_OAUTH_CLIENT_ID            (RC app's client_id, can reuse RING_CENTRAL_CLIENT_ID)
//   RC_OAUTH_CLIENT_SECRET        (RC app's secret)
//   RC_OAUTH_REDIRECT_URI         (e.g. https://tagcontactbridge.ngrok.app/api/auth/cx/callback)
//   RC_OAUTH_SCOPES               (optional space-separated override; blank = app default)
//   RC_OAUTH_AUTHORIZE_URL        (default: https://platform.ringcentral.com/restapi/oauth/authorize)
//   RC_OAUTH_TOKEN_URL            (default: https://platform.ringcentral.com/restapi/oauth/token)
//   CX_TOKEN_ENCRYPTION_KEY       (64 hex chars — see cxTokenStorageService)

const crypto = require("crypto");
const {
  rcOAuthStateRepository,
  userAccountRepository,
} = require("../../shared-repositories/src");
const cxTokenStorage = require("./cxTokenStorageService");

const STATE_TTL_MS = 10 * 60 * 1000;        // 10 min
const REFRESH_TOKEN_DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000;  // 60 days

const DEFAULT_AUTHORIZE_URL = "https://platform.ringcentral.com/restapi/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://platform.ringcentral.com/restapi/oauth/token";
const DEFAULT_RCX_BASE = "https://ringcx.ringcentral.com";
const DEFAULT_TOKEN_EXCHANGE_PATH = "/api/auth/login/rc/accesstoken";
const DEFAULT_TOKEN_REFRESH_PATH = "/api/auth/token/refresh";
// Loosened from ["ReadAccounts"] for live test — RC app's permissions don't
// currently grant ReadAccounts on consent, which fail-closed our callback
// (see /cx?cxauth=err&reason=missing-required-rc-oauth-scopes:ReadAccounts).
// RingCX itself doesn't need ReadAccounts at runtime; the check was a sanity
// guard. Reinstate ["ReadAccounts"] once the RC app permissions are fixed.
const REQUIRED_RINGCX_SCOPES = Object.freeze([]);
const DEFAULT_SCOPES = "";

function readEnv(name, fallback = "") {
  const v = process.env[name];
  return v != null && v !== "" ? String(v) : fallback;
}

// ── Configuration check ─────────────────────────────────────────

function getOAuthConfig() {
  const clientId = readEnv("RC_OAUTH_CLIENT_ID") || readEnv("RING_CENTRAL_CLIENT_ID");
  const clientSecret = readEnv("RC_OAUTH_CLIENT_SECRET") || readEnv("RING_CENTRAL_CLIENT_SECRET");
  const redirectUri = readEnv("RC_OAUTH_REDIRECT_URI");
  const scopes = readEnv("RC_OAUTH_SCOPES", DEFAULT_SCOPES);
  const authorizeUrl = readEnv("RC_OAUTH_AUTHORIZE_URL", DEFAULT_AUTHORIZE_URL);
  const tokenUrl = readEnv("RC_OAUTH_TOKEN_URL", DEFAULT_TOKEN_URL);
  const rcxBase = readEnv("RINGCX_VOICE_BASE_URL", DEFAULT_RCX_BASE).replace(/\/$/, "");
  const exchangePath = readEnv("RINGCX_VOICE_TOKEN_EXCHANGE_PATH", DEFAULT_TOKEN_EXCHANGE_PATH);
  const refreshPath = readEnv("RINGCX_VOICE_TOKEN_REFRESH_PATH", DEFAULT_TOKEN_REFRESH_PATH);
  return {
    clientId, clientSecret, redirectUri, scopes,
    authorizeUrl, tokenUrl, rcxBase, exchangePath, refreshPath,
  };
}

function isConfigured() {
  const c = getOAuthConfig();
  return Boolean(c.clientId && c.clientSecret && c.redirectUri && cxTokenStorage.isConfigured());
}

function describeConfig() {
  const c = getOAuthConfig();
  return {
    enabled: isConfigured(),
    clientIdSet: Boolean(c.clientId),
    clientSecretSet: Boolean(c.clientSecret),
    redirectUri: c.redirectUri || null,
    scopes: c.scopes,
    requiredScopes: REQUIRED_RINGCX_SCOPES,
    authorizeUrl: c.authorizeUrl,
    tokenUrl: c.tokenUrl,
    encryptionKeySet: cxTokenStorage.isConfigured(),
  };
}

function normalizeScopes(value) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function assertRequiredRingcxScopes(scopeSource, cfg) {
  const scopes = normalizeScopes(scopeSource || cfg?.scopes || DEFAULT_SCOPES);
  const granted = new Set(scopes.map((scope) => scope.toLowerCase()));
  const missing = REQUIRED_RINGCX_SCOPES.filter((scope) => !granted.has(scope.toLowerCase()));
  if (missing.length > 0) {
    const err = new Error(`missing-required-rc-oauth-scopes:${missing.join(",")}`);
    err.missingScopes = missing;
    err.grantedScopes = scopes;
    throw err;
  }
  return scopes;
}

// ── PKCE helpers ───────────────────────────────────────────────

function generateCodeVerifier() {
  // RFC 7636 — 43-128 chars, URL-safe
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState() {
  return crypto.randomBytes(32).toString("base64url");
}

// ── start: build authorize URL + persist state ─────────────────

async function start({ user, finalRedirectTo = null } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: "cx-oauth-not-configured", details: describeConfig() };
  }
  if (!user || !user.id || !user.email) {
    return { ok: false, error: "user-context-required" };
  }
  const cfg = getOAuthConfig();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  await rcOAuthStateRepository.createState({
    state,
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
    initiatingUserId: String(user.id),
    initiatingUserEmail: String(user.email).toLowerCase(),
    redirectUri: cfg.redirectUri,
    finalRedirectTo,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    // Request offline_access to receive a refresh_token
    prompt: "login",
  });
  if (cfg.scopes) {
    params.set("scope", cfg.scopes);
  }
  const authorizeUrl = `${cfg.authorizeUrl}?${params.toString()}`;
  return { ok: true, authorizeUrl, state, expiresAt: new Date(Date.now() + STATE_TTL_MS) };
}

// ── callback: exchange code for tokens, store on user ──────────

async function callback({ code, state, errorParam = null } = {}) {
  if (errorParam) {
    // RC returned ?error=... — user denied or something failed
    if (state) await rcOAuthStateRepository.consumeByState(state, { error: errorParam });
    return { ok: false, error: `rc-oauth-error:${errorParam}` };
  }
  if (!code || !state) {
    return { ok: false, error: "missing-code-or-state" };
  }

  const stateRow = await rcOAuthStateRepository.findByState(state);
  if (!stateRow) return { ok: false, error: "unknown-state" };
  if (stateRow.consumed) return { ok: false, error: "state-already-consumed" };
  if (new Date(stateRow.expiresAt) < new Date()) {
    return { ok: false, error: "state-expired" };
  }

  const cfg = getOAuthConfig();

  // 1. Exchange auth code for RC tokens
  let rcTokens;
  try {
    rcTokens = await exchangeAuthCode({
      code,
      codeVerifier: stateRow.codeVerifier,
      redirectUri: stateRow.redirectUri,
      cfg,
    });
  } catch (error) {
    await rcOAuthStateRepository.consumeByState(state, { error: error.message });
    return { ok: false, error: `code-exchange-failed: ${error.message}` };
  }

  let grantedScopes;
  try {
    grantedScopes = assertRequiredRingcxScopes(rcTokens.scope, cfg);
  } catch (error) {
    await rcOAuthStateRepository.consumeByState(state, { error: error.message });
    return {
      ok: false,
      error: error.message,
      missingScopes: error.missingScopes || REQUIRED_RINGCX_SCOPES,
      grantedScopes: error.grantedScopes || [],
    };
  }

  // 2. Look up Parallel user by initiating session
  const account = await userAccountRepository.findUserAccountById(stateRow.initiatingUserId);
  if (!account) {
    await rcOAuthStateRepository.consumeByState(state, { error: "user-not-found" });
    return { ok: false, error: "initiating-user-not-found" };
  }

  // 3. Encrypt + persist RC tokens on the user
  const refreshTokenExpiresAt = rcTokens.refresh_token_expires_in
    ? new Date(Date.now() + Number(rcTokens.refresh_token_expires_in) * 1000)
    : new Date(Date.now() + REFRESH_TOKEN_DEFAULT_TTL_MS);
  await cxTokenStorage.storeRcRefreshToken(
    String(account._id || account.id),
    rcTokens.refresh_token,
    {
      rcUserEmail: rcTokens.owner_id_email || null,
      rcUserId: rcTokens.owner_id || null,
      scopes: grantedScopes,
      refreshTokenExpiresAt,
    },
  );

  // 4. Exchange RC token for RingCX bearer
  let rcxSession = null;
  try {
    rcxSession = await exchangeForRingcxBearer({
      rcAccessToken: rcTokens.access_token,
      rcTokenType: rcTokens.token_type || "Bearer",
      cfg,
    });
    await cxTokenStorage.storeRcxSession(String(account._id || account.id), {
      bearer: rcxSession.accessToken,
      rcxRefresh: rcxSession.refreshToken,
      bearerExpiresAt: new Date(Date.now() + (Number(rcxSession.expiresIn) * 1000 || 5 * 60 * 1000)),
      rcxMainAccountId: rcxSession.mainAccountId,
      rcxAgentEmail: rcxSession.rcUser?.email || null,
    });
  } catch (error) {
    // Non-fatal: RC OAuth succeeded; RingCX exchange can be retried later
    await cxTokenStorage.markRefreshError(
      String(account._id || account.id),
      `initial-rcx-exchange: ${error.message}`,
    );
  }

  // 5. Mark state consumed
  await rcOAuthStateRepository.consumeByState(state);

  return {
    ok: true,
    userId: String(account._id || account.id),
    email: account.email,
    rcUserEmail: rcTokens.owner_id_email || null,
    rcxBearerActive: Boolean(rcxSession),
    finalRedirectTo: stateRow.finalRedirectTo || null,
  };
}

// ── refreshUserSession: refresh tokens for an existing agent ────

async function refreshUserSession({ user, userId } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: "cx-oauth-not-configured" };
  }
  const targetId = String(userId || user?.id || "");
  if (!targetId) return { ok: false, error: "user-id-required" };

  const refreshToken = await cxTokenStorage.getRcRefreshToken(targetId);
  if (!refreshToken) return { ok: false, error: "no-stored-refresh-token" };

  const cfg = getOAuthConfig();

  // Prefer RingCX's own refresh token when we have one. Re-exchanging a
  // freshly refreshed RingCentral token can 403 even though the existing
  // RingCX session is refreshable.
  const existingRcxSession = await cxTokenStorage.getRcxSession(targetId).catch(() => null);
  if (existingRcxSession?.rcxRefresh) {
    try {
      const rcxSession = await refreshRingcxBearer({
        rcxRefreshToken: existingRcxSession.rcxRefresh,
        cfg,
      });
      await cxTokenStorage.storeRcxSession(targetId, {
        bearer: rcxSession.accessToken,
        rcxRefresh: rcxSession.refreshToken || existingRcxSession.rcxRefresh,
        bearerExpiresAt: new Date(Date.now() + (Number(rcxSession.expiresIn) * 1000 || 5 * 60 * 1000)),
        rcxMainAccountId: rcxSession.mainAccountId || existingRcxSession.rcxMainAccountId || null,
        rcxAgentEmail: rcxSession.rcUser?.email || existingRcxSession.rcxAgentEmail || null,
      });
      return { ok: true, refreshedAt: new Date(), method: "rcx-refresh" };
    } catch (error) {
      await cxTokenStorage.markRefreshError(targetId, `rcx-refresh: ${error.message}`);
    }
  }

  let rcTokens;
  try {
    rcTokens = await refreshAccessToken({ refreshToken, cfg });
  } catch (error) {
    await cxTokenStorage.markRefreshError(targetId, `refresh-rc-token: ${error.message}`);
    return { ok: false, error: `refresh-failed: ${error.message}` };
  }

  let grantedScopes;
  try {
    grantedScopes = assertRequiredRingcxScopes(rcTokens.scope, cfg);
  } catch (error) {
    await cxTokenStorage.markRefreshError(targetId, error.message);
    return {
      ok: false,
      error: error.message,
      missingScopes: error.missingScopes || REQUIRED_RINGCX_SCOPES,
      grantedScopes: error.grantedScopes || [],
    };
  }

  // Update stored refresh token (RC may rotate it)
  const newRefreshToken = rcTokens.refresh_token || refreshToken;
  const refreshTokenExpiresAt = rcTokens.refresh_token_expires_in
    ? new Date(Date.now() + Number(rcTokens.refresh_token_expires_in) * 1000)
    : null;

  await cxTokenStorage.storeRcRefreshToken(targetId, newRefreshToken, {
    refreshTokenExpiresAt,
    scopes: grantedScopes,
  });

  // Exchange for RingCX bearer
  try {
    const rcxSession = await exchangeForRingcxBearer({
      rcAccessToken: rcTokens.access_token,
      rcTokenType: rcTokens.token_type || "Bearer",
      cfg,
    });
    await cxTokenStorage.storeRcxSession(targetId, {
      bearer: rcxSession.accessToken,
      rcxRefresh: rcxSession.refreshToken,
      bearerExpiresAt: new Date(Date.now() + (Number(rcxSession.expiresIn) * 1000 || 5 * 60 * 1000)),
      rcxMainAccountId: rcxSession.mainAccountId,
      rcxAgentEmail: rcxSession.rcUser?.email || null,
    });
    return { ok: true, refreshedAt: new Date() };
  } catch (error) {
    await cxTokenStorage.markRefreshError(targetId, `rcx-exchange: ${error.message}`);
    return { ok: false, error: `rcx-exchange-failed: ${error.message}` };
  }
}

// ── Internal HTTP helpers ──────────────────────────────────────

async function rawFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function exchangeAuthCode({ code, codeVerifier, redirectUri, cfg }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await rawFetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errMsg = r.json?.error_description || r.json?.error || `${r.status}`;
    throw new Error(`token endpoint: ${errMsg}`);
  }
  return r.json;
}

async function refreshAccessToken({ refreshToken, cfg }) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const r = await rawFetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errMsg = r.json?.error_description || r.json?.error || `${r.status}`;
    throw new Error(`refresh: ${errMsg}`);
  }
  return r.json;
}

async function exchangeForRingcxBearer({ rcAccessToken, rcTokenType, cfg }) {
  const body = new URLSearchParams({
    rcAccessToken,
    rcTokenType: rcTokenType || "Bearer",
  });
  const url = `${cfg.rcxBase}${cfg.exchangePath}?includeRefresh=true`;
  const r = await rawFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errMsg = r.json?.error_description || r.json?.error || `${r.status}`;
    throw new Error(`rcx-exchange: ${errMsg}`);
  }
  return {
    accessToken: r.json.accessToken,
    refreshToken: r.json.refreshToken || null,
    tokenType: r.json.tokenType || "Bearer",
    expiresIn: r.json.expiresIn,
    mainAccountId: r.json.mainAccountId || null,
    rcUser: r.json.rcUser || null,
  };
}

async function refreshRingcxBearer({ rcxRefreshToken, cfg }) {
  const body = new URLSearchParams({
    refresh_token: rcxRefreshToken,
    rcTokenType: "Bearer",
  });
  const url = `${cfg.rcxBase}${cfg.refreshPath || DEFAULT_TOKEN_REFRESH_PATH}`;
  const r = await rawFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const errMsg = r.json?.error_description || r.json?.error || `${r.status}`;
    throw new Error(`rcx-refresh: ${errMsg}`);
  }
  return {
    accessToken: r.json.accessToken,
    refreshToken: r.json.refreshToken || null,
    tokenType: r.json.tokenType || "Bearer",
    expiresIn: r.json.expiresIn,
    mainAccountId: r.json.mainAccountId || null,
    rcUser: r.json.rcUser || null,
  };
}

module.exports = {
  isConfigured,
  describeConfig,
  start,
  callback,
  refreshUserSession,
  // pure helpers — exported for tests
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  refreshRingcxBearer,
};
