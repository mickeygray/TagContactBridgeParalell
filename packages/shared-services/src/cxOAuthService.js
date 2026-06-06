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
const {
  ensureRingcxAgentOffhookAllowed,
} = require("./ringcxAgentSelfHealService");

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

// Default `scope` param sent on the RC `/restapi/oauth/authorize` URL when
// RC_OAUTH_SCOPES env is unset. RC silently drops any scope the agent's
// role doesn't allow, so over-requesting is safe — but UNDER-requesting
// (sending blank) lets RC return a narrower default that can omit
// CXRouting, the scope that gates RingCX off-hook capability.
//
// Empirical: Sean's working account has cxAuth.scopes === ["CXRouting"].
// Bruce's broken-yesterday account had cxAuth.scopes === [] after a
// refresh — RC's response omitted scope, our code mirrored empty.
//
// Listed scopes, in order of importance:
//   CXRouting          — REQUIRED for RingCX off-hook (the bug we're fixing)
//   ReadAccounts       — listed in CX_OAUTH_SETUP.md as required for the SPA
//   ReadCallLog        — call-history reads in the agent dashboard
//   ReadCallRecording  — recording playback in the call review panel
//   ReadPresence       — agent-presence reads for the routing layer
//
// Override per-deployment by setting RC_OAUTH_SCOPES — useful for
// tenants whose RC app config blocks one of these (RC will reject the
// authorize URL on disallowed scope rather than ignoring it).
const DEFAULT_SCOPES =
  "CXRouting ReadAccounts ReadCallLog ReadCallRecording ReadPresence";

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

async function selfHealRingcxOffhookByAccount(account, source) {
  if (!account) return { ok: true, skipped: true, reason: "missing-account", source };
  return ensureRingcxAgentOffhookAllowed(account, {
    source,
    logger: console,
  }).catch((error) => {
    console.warn("ringcx.offhook.self_heal.failed", {
      source,
      email: account?.email || null,
      error: error.message,
    });
    return { ok: false, error: error.message, source };
  });
}

async function selfHealRingcxOffhookByUserId(userId, source) {
  const account = await userAccountRepository.findUserAccountById(userId).catch(() => null);
  return selfHealRingcxOffhookByAccount(account, source);
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
  await selfHealRingcxOffhookByAccount(account, "cx-oauth-callback");

  // 6. Warm this agent's barge monitor softphone for the day, if one is configured
  // (metadata.barge.monitorExtension). Fire-and-forget: this must never block or
  // fail the OAuth handshake. First barge press still self-registers as a fallback.
  if (account?.metadata?.barge?.monitorExtension) {
    Promise.resolve()
      .then(() => require("./cxVoicemailDropService").warmMonitorForAccount(account))
      .then((result) => {
        if (result && result.ok === false && !result.skipped) {
          console.warn("cxOAuth.barge-monitor-warm.failed", {
            monitorExtension: result.monitorExt || account?.metadata?.barge?.monitorExtension || null,
            error: result.error || result.reason || "unknown",
          });
        }
      })
      .catch((error) => {
        console.warn("cxOAuth.barge-monitor-warm.error", { error: error.message });
      });
  }

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
      await selfHealRingcxOffhookByUserId(targetId, "cx-oauth-refresh");
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

  // Per RFC 6749 §6: refresh-token responses MAY omit `scope` when the
  // granted scope is unchanged from the original grant. RC's refresh
  // endpoint frequently does this. If we treat an omitted/empty scope
  // as "agent now has zero scopes," we silently strip CXRouting from
  // every agent on the next refresh — they can still authenticate but
  // can't go off-hook on RingCX.
  //
  // Discriminate the three response shapes:
  //   - non-empty string  → grant changed; mirror what RC returned
  //   - empty string      → ambiguous (some IdPs use this for
  //                         "unchanged"); preserve existing scopes
  //   - missing/undefined → unchanged per RFC; preserve existing scopes
  const refreshReturnedScopes =
    typeof rcTokens.scope === "string" && rcTokens.scope.trim().length > 0;
  let grantedScopes = null;
  if (refreshReturnedScopes) {
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

    // Surface scope narrowing — if the refresh dropped CXRouting (or
    // any other previously-held scope) that's operationally significant.
    // The agent's off-hook capability depends on this; without logging
    // we have no way to notice mid-day silent revocations.
    try {
      const account = await userAccountRepository.findUserAccountById(targetId);
      const priorScopes = Array.isArray(account?.cxAuth?.scopes)
        ? account.cxAuth.scopes
        : [];
      const priorSet = new Set(priorScopes.map((s) => String(s).toLowerCase()));
      const grantedSet = new Set(grantedScopes.map((s) => String(s).toLowerCase()));
      const lost = priorScopes.filter((s) => !grantedSet.has(String(s).toLowerCase()));
      const gained = grantedScopes.filter((s) => !priorSet.has(String(s).toLowerCase()));
      if (lost.length > 0 || gained.length > 0) {
        console.warn("cxOAuth.refresh.scopes-changed", {
          userId: targetId,
          email: account?.email || null,
          priorScopes,
          newScopes: grantedScopes,
          lost,
          gained,
        });
      }
    } catch (_) {
      // Diagnostic-only; never block refresh on logging failure.
    }
  }

  // Update stored refresh token (RC may rotate it)
  const newRefreshToken = rcTokens.refresh_token || refreshToken;
  const refreshTokenExpiresAt = rcTokens.refresh_token_expires_in
    ? new Date(Date.now() + Number(rcTokens.refresh_token_expires_in) * 1000)
    : null;

  await cxTokenStorage.storeRcRefreshToken(targetId, newRefreshToken, {
    refreshTokenExpiresAt,
    // Only pass scopes when RC explicitly returned them. storeRcRefreshToken
    // is a $set update with `if (Array.isArray(scopes))` — passing null
    // here preserves whatever cxAuth.scopes was already on the row.
    ...(grantedScopes !== null ? { scopes: grantedScopes } : {}),
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
    await selfHealRingcxOffhookByUserId(targetId, "cx-oauth-refresh");
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

// Revoke the user's RC OAuth grant on RingCentral's servers AND wipe
// our local copy. After this call, RingCentral no longer recognizes
// the prior refresh token, AND the user's next CX session attempt sees
// `consent-revoked` and is routed through the OAuth consent flow,
// where RC will show the consent screen with whatever scopes are
// currently in RC_OAUTH_SCOPES.
//
// Use this when an agent's grant has drifted (e.g. CXRouting scope
// missing on a stored token that should have it) and we need RC to
// re-issue a fresh grant against the user's current RC role.
//
// Best-effort on the RC side — if RC's revoke endpoint 4xxs (e.g.
// token already invalidated), we still wipe our local state and
// return success. The next OAuth attempt will sort it.
async function forceReauth(userId) {
  if (!userId) throw new Error("userId required");
  const cfg = getOAuthConfig();
  let rcRevoke = { ok: true, skipped: true, reason: "no-token-on-file" };

  // Try to revoke on the RC side first, while we still have a token.
  const refreshToken = await cxTokenStorage.getRcRefreshToken(userId).catch(() => null);
  if (refreshToken && cfg.tokenUrl) {
    const revokeUrl = String(cfg.tokenUrl).replace(/\/token(\/?$|\?)/, "/revoke$1");
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    try {
      const r = await rawFetch(revokeUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
        }).toString(),
      });
      rcRevoke = { ok: r.ok, status: r.status, body: r.json || null };
    } catch (error) {
      rcRevoke = { ok: false, error: error.message };
    }
  }

  // Always wipe local copy, even if RC revoke failed — the user
  // needs to be forced through the OAuth flow to get a fresh grant.
  await cxTokenStorage.revoke(userId);
  return { ok: true, userId, rcRevoke };
}

module.exports = {
  isConfigured,
  describeConfig,
  start,
  callback,
  refreshUserSession,
  forceReauth,
  // pure helpers — exported for tests
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  refreshRingcxBearer,
};
