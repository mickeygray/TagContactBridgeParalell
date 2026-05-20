"use strict";

// cxTokenStorageService — encrypts/decrypts per-agent RingCX tokens
// (RC refresh, RingCX bearer, RingCX refresh) and stores them on the
// UserAccount.cxAuth + cxSession subdocs.
//
// Encryption: AES-256-GCM with a service-level key from
// CX_TOKEN_ENCRYPTION_KEY (hex, 64 chars = 32 bytes). NO key
// derivation; the env value IS the key.
//
// Wire format (base64):  IV(12B) || AUTH_TAG(16B) || CIPHERTEXT(N)
//
// Why GCM: authenticated — tampering with cipher bytes makes decrypt
// throw (not silently produce garbage). Ideal for tokens.
//
// The service exposes:
//   encrypt(plaintext)            → opaque base64 blob
//   decrypt(blob)                 → plaintext (throws on tamper)
//   storeRcRefreshToken(userId, refreshToken, meta)
//   getRcRefreshToken(userId)     → plaintext (or null if not set)
//   storeRcxSession(userId, { bearer, rcxRefresh, expiresAt, ... })
//   getRcxSession(userId)         → { bearer, rcxRefresh, expiresAt, ... }
//   markRefreshError(userId, error)
//   revoke(userId)                → clears cxAuth + cxSession
//   isConfigured()                → true if env key is set + valid

const crypto = require("crypto");
const { userAccountRepository } = require("../../shared-repositories/src");

const ENV_KEY = "CX_TOKEN_ENCRYPTION_KEY";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;       // GCM nonce
const TAG_LEN = 16;      // GCM authentication tag

let cachedKey = null;
let cachedKeyError = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  if (cachedKeyError) throw cachedKeyError;
  const hex = String(process.env[ENV_KEY] || "").trim();
  if (!hex) {
    cachedKeyError = new Error(`${ENV_KEY} not configured — cannot encrypt/decrypt CX tokens`);
    throw cachedKeyError;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    cachedKeyError = new Error(`${ENV_KEY} must be 64 hex chars (32 bytes); got ${hex.length} chars`);
    throw cachedKeyError;
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

function isConfigured() {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function isCxUserOAuthRequired() {
  // Current production CX dialing is executed through the platform/JWT
  // RingCX control path, while the app supplies the logged-in agent's
  // extension/profile as the target. Per-user RC OAuth remains available
  // behind this flag, but it should not block the queue workspace.
  return envFlag("RC_CX_REQUIRE_USER_OAUTH", false);
}

// For tests — bust the cache so a different env value can be picked up.
function resetCache() {
  cachedKey = null;
  cachedKeyError = null;
}

// ── encrypt / decrypt ─────────────────────────────────────────────

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // IV || TAG || CIPHERTEXT, base64-encoded
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decrypt(blob) {
  if (!blob) return null;
  const key = loadKey();
  const buf = Buffer.from(String(blob), "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("encrypted blob too short to be valid");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// ── User account integration ─────────────────────────────────────

async function storeRcRefreshToken(userId, refreshToken, {
  rcUserEmail,
  rcUserId,
  scopes,
  refreshTokenExpiresAt,
} = {}) {
  if (!userId) throw new Error("userId required");
  const update = {
    "cxAuth.refreshTokenEnc": encrypt(refreshToken),
    "cxAuth.consentGrantedAt": new Date(),
    "cxAuth.consentRevokedAt": null,
    "cxAuth.lastTokenIssuedAt": new Date(),
    "cxAuth.lastRefreshError": null,
  };
  if (rcUserEmail !== undefined) update["cxAuth.rcUserEmail"] = rcUserEmail || null;
  if (rcUserId !== undefined) update["cxAuth.rcUserId"] = rcUserId || null;
  if (refreshTokenExpiresAt !== undefined) {
    update["cxAuth.refreshTokenExpiresAt"] = refreshTokenExpiresAt || null;
  }
  if (Array.isArray(scopes)) {
    update["cxAuth.scopes"] = scopes;
    // Off-hook scope auto-heal back-off: when this write is the result
    // of a fresh consent (callback) or an explicit scope-returning
    // refresh, mirror that evidence into scopeReauthAttemptedAt:
    //   - CXRouting present → clear the stamp; the user has the scope
    //     and any prior back-off no longer applies.
    //   - CXRouting absent → set the stamp to now; deriveOAuthValidity
    //     will stop nagging this user for the back-off window because
    //     RC's response indicates their role doesn't permit it.
    update["cxAuth.scopeReauthAttemptedAt"] = scopesIncludeOffHook(scopes)
      ? null
      : new Date();
  }
  return userAccountRepository.updateUserAccount(userId, update);
}

async function getRcRefreshToken(userId) {
  const account = await userAccountRepository.findUserAccountById(userId);
  if (!account) return null;
  const enc = account.cxAuth?.refreshTokenEnc;
  if (!enc) return null;
  return decrypt(enc);
}

async function storeRcxSession(userId, {
  bearer,
  rcxRefresh = null,
  bearerExpiresAt,
  rcxMainAccountId = null,
  rcxAgentEmail = null,
} = {}) {
  if (!userId) throw new Error("userId required");
  const update = {
    "cxSession.bearerEnc": encrypt(bearer),
    "cxSession.rcxRefreshTokenEnc": rcxRefresh ? encrypt(rcxRefresh) : null,
    "cxSession.bearerExpiresAt": bearerExpiresAt,
    "cxSession.rcxMainAccountId": rcxMainAccountId,
    "cxSession.rcxAgentEmail": rcxAgentEmail,
    "cxSession.refreshedAt": new Date(),
    "cxSession.lastError": null,
    "cxSession.lastErrorAt": null,
    "cxAuth.lastRefreshError": null,
    "cxAuth.lastRefreshErrorAt": null,
  };
  return userAccountRepository.updateUserAccount(userId, update);
}

async function getRcxSession(userId) {
  const account = await userAccountRepository.findUserAccountById(userId);
  if (!account) return null;
  const sess = account.cxSession || {};
  return {
    bearer: sess.bearerEnc ? decrypt(sess.bearerEnc) : null,
    rcxRefresh: sess.rcxRefreshTokenEnc ? decrypt(sess.rcxRefreshTokenEnc) : null,
    bearerExpiresAt: sess.bearerExpiresAt || null,
    rcxMainAccountId: sess.rcxMainAccountId || null,
    rcxAgentEmail: sess.rcxAgentEmail || null,
    refreshedAt: sess.refreshedAt || null,
    lastUsedAt: sess.lastUsedAt || null,
    lastError: sess.lastError || null,
  };
}

async function markBearerUsed(userId) {
  if (!userId) return null;
  return userAccountRepository.updateUserAccount(userId, {
    "cxSession.lastUsedAt": new Date(),
  });
}

async function markRefreshError(userId, error) {
  if (!userId) return null;
  const message = String(error?.message || error || "unknown").slice(0, 500);
  return userAccountRepository.updateUserAccount(userId, {
    "cxAuth.lastRefreshError": message,
    "cxSession.lastError": message,
    "cxSession.lastErrorAt": new Date(),
  });
}

async function revoke(userId) {
  if (!userId) throw new Error("userId required");
  return userAccountRepository.updateUserAccount(userId, {
    "cxAuth.refreshTokenEnc": null,
    "cxAuth.refreshTokenExpiresAt": null,
    "cxAuth.consentRevokedAt": new Date(),
    "cxSession.bearerEnc": null,
    "cxSession.rcxRefreshTokenEnc": null,
    "cxSession.bearerExpiresAt": null,
  });
}

// Derive whether the agent's stored OAuth credentials are USABLE right
// now. SPA reads this single boolean to decide "show SSO prompt" vs
// "skip it and let them dial."
//
// True iff:
//   - a refresh token is stored
//   - consent has not been revoked
//   - the refresh token hasn't expired (or has no recorded expiry)
//
// Note: bearer expiry is NOT part of this — bearers refresh silently
// from the refresh token. Only refresh-token failure forces re-auth.
// Required for RingCX off-hook capability. When this is missing from
// cxAuth.scopes, the agent can authenticate but can't dial. The auto-
// heal at deriveOAuthValidity flips them to "needs-reconnect" so the
// SPA's existing reconnect banner picks them up — and the OAuth
// authorize URL's default scope set re-requests it on the round trip.
const OFFHOOK_SCOPE = "CXRouting";
const OFFHOOK_SCOPE_REAUTH_BACKOFF_DAYS = 7;

function isOffHookScopeAutoHealEnabled() {
  const raw = String(process.env.CX_REQUIRE_OFFHOOK_SCOPE || "true")
    .trim()
    .toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

function scopesIncludeOffHook(scopes) {
  if (!Array.isArray(scopes)) return false;
  const target = OFFHOOK_SCOPE.toLowerCase();
  return scopes.some((s) => String(s || "").toLowerCase() === target);
}

function deriveOAuthValidity(authSubdoc, sessionSubdoc, asOf = new Date()) {
  const auth = authSubdoc || {};
  const sess = sessionSubdoc || {};
  if (!auth.refreshTokenEnc) {
    return { isOAuthValidated: false, reason: "no-refresh-token" };
  }
  if (auth.consentRevokedAt) {
    return { isOAuthValidated: false, reason: "consent-revoked" };
  }
  if (auth.refreshTokenExpiresAt && new Date(auth.refreshTokenExpiresAt) <= asOf) {
    return { isOAuthValidated: false, reason: "refresh-token-expired" };
  }
  // If a recent refresh attempt failed AND we have no fresh bearer,
  // surface that as a reason to re-auth. Otherwise we're good.
  if (auth.lastRefreshError && !sess.bearerEnc) {
    return { isOAuthValidated: false, reason: "refresh-failed" };
  }
  // Off-hook scope auto-heal — if the granted scope set doesn't include
  // CXRouting, the agent can't dial. The SPA's existing reconnect
  // banner is the right surface for this: flip validity false, let the
  // banner prompt them through OAuth, the new default authorize-URL
  // scope set requests CXRouting on the round trip.
  //
  // Anti-loop: if we already tried and the most-recent consent came
  // back without CXRouting, RC's response means the agent's role
  // doesn't permit it. Don't nag — `scopeReauthAttemptedAt` is the
  // back-off stamp set by the OAuth callback in that case. After the
  // back-off window we try once more (in case the RC admin updates
  // their role).
  if (isOffHookScopeAutoHealEnabled() && !scopesIncludeOffHook(auth.scopes)) {
    const stampedAt = auth.scopeReauthAttemptedAt
      ? new Date(auth.scopeReauthAttemptedAt)
      : null;
    const backOffMs = OFFHOOK_SCOPE_REAUTH_BACKOFF_DAYS * 24 * 60 * 60 * 1000;
    const recentlyTried =
      stampedAt && asOf.getTime() - stampedAt.getTime() < backOffMs;
    if (!recentlyTried) {
      return { isOAuthValidated: false, reason: "missing-cx-routing-scope" };
    }
  }
  return { isOAuthValidated: true, reason: null };
}

// ── Read-only summary for admin UI (no plaintext leakage) ────────

async function describe(userId) {
  const account = await userAccountRepository.findUserAccountById(userId);
  if (!account) return null;
  const auth = account.cxAuth || {};
  const sess = account.cxSession || {};
  const validity = deriveOAuthValidity(auth, sess);
  return {
    isOAuthValidated: validity.isOAuthValidated,
    invalidReason: validity.reason,
    hasRcRefreshToken: Boolean(auth.refreshTokenEnc),
    rcUserEmail: auth.rcUserEmail || null,
    rcUserId: auth.rcUserId || null,
    scopes: auth.scopes || [],
    hasOffHookScope: scopesIncludeOffHook(auth.scopes),
    scopeReauthAttemptedAt: auth.scopeReauthAttemptedAt || null,
    refreshTokenExpiresAt: auth.refreshTokenExpiresAt || null,
    consentGrantedAt: auth.consentGrantedAt || null,
    consentRevokedAt: auth.consentRevokedAt || null,
    lastTokenIssuedAt: auth.lastTokenIssuedAt || null,
    lastRefreshAt: auth.lastRefreshAt || null,
    lastRefreshError: auth.lastRefreshError || null,
    hasRcxBearer: Boolean(sess.bearerEnc),
    bearerExpiresAt: sess.bearerExpiresAt || null,
    rcxMainAccountId: sess.rcxMainAccountId || null,
    rcxAgentEmail: sess.rcxAgentEmail || null,
    refreshedAt: sess.refreshedAt || null,
    lastUsedAt: sess.lastUsedAt || null,
    lastError: sess.lastError || null,
    lastErrorAt: sess.lastErrorAt || null,
  };
}

// Cheap version for /api/auth/me — boolean + reason only, no Mongo
// extra-field reads. Pass the user account's cxAuth/cxSession subdocs
// (already loaded by findAccountByEmail). This is what the SPA gates
// the "Connect RingCentral" banner on.
function summarizeOAuthValidityFromAccount(account) {
  const auth = account?.cxAuth || {};
  const sess = account?.cxSession || {};
  const oauthRequired = isCxUserOAuthRequired();
  if (!oauthRequired) {
    return {
      oauthRequired,
      isOAuthValidated: true,
      invalidReason: null,
      rcUserEmail: auth.rcUserEmail || null,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt || null,
      consentGrantedAt: auth.consentGrantedAt || null,
    };
  }
  const v = deriveOAuthValidity(auth, sess);
  return {
    oauthRequired,
    isOAuthValidated: v.isOAuthValidated,
    invalidReason: v.reason,
    rcUserEmail: auth.rcUserEmail || null,
    refreshTokenExpiresAt: auth.refreshTokenExpiresAt || null,
    consentGrantedAt: auth.consentGrantedAt || null,
  };
}

module.exports = {
  isConfigured,
  encrypt,
  decrypt,
  storeRcRefreshToken,
  getRcRefreshToken,
  storeRcxSession,
  getRcxSession,
  markBearerUsed,
  markRefreshError,
  revoke,
  describe,
  deriveOAuthValidity,
  isCxUserOAuthRequired,
  summarizeOAuthValidityFromAccount,
  // exposed for tests
  resetCache,
};
