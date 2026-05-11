"use strict";

const crypto = require("crypto");
const {
  bootstrapSeedAccounts,
  findAccountByEmail,
  listAccounts,
} = require("../../shared-data/src/accounts");
const { getWorkspaceForUser } = require("../../shared-services/src/workspaceService");
const { issueOtpChallenge, verifyOtpChallenge } = require("./otpService");
const {
  decryptField,
  encryptField,
  formatSsnForLogics,
  isFieldEncryptionConfigured,
  maskSsn,
} = require("./fieldCrypto");
const {
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_ROLES,
  isKnownPermission,
  isKnownRole,
  getRoleDefaults,
  effectivePermissionsFor,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  normalizePermissionList,
} = require("./permissionsCatalog");

function signToken(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || !token.includes(".")) {
    throw new Error("Invalid token");
  }

  const [encoded, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const providedBuffer = Buffer.from(sig, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error("Bad signature");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (payload.expiresAt && Number(payload.expiresAt) < Date.now()) {
    throw new Error("Token expired");
  }

  return payload;
}

function issueLoginToken(config, account, { clampExpiresAt = null } = {}) {
  const issuedAt = Date.now();
  const ttlHours = Number(config.jwtTtlHours || 12);
  // For non-admin agents, the caller can pass clampExpiresAt to force
  // logout at end-of-window. We pick the EARLIER of the two ceilings
  // so admins (no clamp) keep their full TTL while agents auto-expire
  // at end of business day.
  const baseExpiresAt = issuedAt + ttlHours * 60 * 60 * 1000;
  const expiresAt = clampExpiresAt
    ? Math.min(baseExpiresAt, new Date(clampExpiresAt).getTime())
    : baseExpiresAt;
  // Tenant-prefixed Logics identity fields travel in the token so the
  // frontend doesn't render nulls between login and the first `/me`
  // refresh. Credential material (apiKeyHash, secretHash, etc.) is
  // NEVER in the JWT — only status/mode/scopes for UI gating.
  const logicsAuth = account.logicsAuth
    ? {
        credentialMode: account.logicsAuth.credentialMode || "company",
        credentialStatus: account.logicsAuth.credentialStatus || "pending",
        scopes: Array.isArray(account.logicsAuth.scopes)
          ? account.logicsAuth.scopes
          : [],
        permissionsLabel: account.logicsAuth.permissionsLabel || null,
      }
    : null;
  // Effective permissions are computed at issue time and snapshotted in
  // the token. Middleware uses the token's permissions array directly,
  // so revoking a permission requires the user to refresh their token
  // (or we add a per-request refresh path — see GET /api/auth/me).
  const permissions = effectivePermissionsFor(account);
  return signToken(
    {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.role,
      audience: account.audience,
      capabilities: account.capabilities,
      views: account.views || [],
      workspace: account.workspace,
      stationLabel: account.stationLabel,
      company: account.company || null,
      extensionId: account.extensionId || null,
      extensionNumber: account.extensionNumber || null,
      cxAgentId: account.cxAgentId || null,
      phone: account.phone || null,
      logicsUserId: account.logicsUserId || null,
      logicsDisplayName: account.logicsDisplayName || null,
      tagLogicsId: account.tagLogicsId || null,
      tagEmail: account.tagEmail || null,
      tagLogicsName: account.tagLogicsName || null,
      tagLogicsRoles: account.tagLogicsRoles || null,
      wynnLogicsId: account.wynnLogicsId || null,
      wynnEmail: account.wynnEmail || null,
      wynnLogicsName: account.wynnLogicsName || null,
      wynnLogicsRoles: account.wynnLogicsRoles || null,
      logicsAuth,
      permissions,
      issuedAt,
      expiresAt,
    },
    config.jwtSecret,
  );
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.slice("Bearer ".length);
}

function requireAuth(config) {
  return (req, res, next) => {
    try {
      const token = getBearerToken(req);
      if (!token) {
        return res.status(401).json({ ok: false, error: "Authentication required" });
      }

      req.user = verifyToken(token, config.jwtSecret);
      return next();
    } catch (error) {
      return res.status(401).json({ ok: false, error: error.message });
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    return next();
  };
}

// requirePermission(key) — gate an endpoint on a single permission key.
// Admin role always passes (carries all permissions implicitly).
// User must have a valid JWT (run after requireAuth in the chain).
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    if (!hasPermission(req.user, key)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
        requiredPermission: key,
      });
    }
    return next();
  };
}

// requireAnyPermission([key1, key2, ...]) — pass if user has at least one
function requireAnyPermission(keys = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    if (!hasAnyPermission(req.user, keys)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
        requiredAnyOf: keys,
      });
    }
    return next();
  };
}

// requireAllPermissions([key1, key2, ...]) — pass only if user has all
function requireAllPermissions(keys = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    if (!hasAllPermissions(req.user, keys)) {
      return res.status(403).json({
        ok: false,
        error: "Forbidden",
        requiredAllOf: keys,
      });
    }
    return next();
  };
}

module.exports = {
  bootstrapSeedAccounts,
  decryptField,
  encryptField,
  findAccountByEmail,
  formatSsnForLogics,
  getWorkspaceForUser,
  isFieldEncryptionConfigured,
  issueOtpChallenge,
  issueLoginToken,
  listAccounts,
  maskSsn,
  requireAuth,
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  verifyOtpChallenge,
  verifyToken,
  // permissions catalog — exported for admin endpoints + tests
  PERMISSIONS_CATALOG,
  ROLE_DEFAULT_PERMISSIONS,
  ALL_PERMISSIONS,
  ALL_ROLES,
  isKnownPermission,
  isKnownRole,
  getRoleDefaults,
  effectivePermissionsFor,
  hasPermission,
  hasAnyPermission,
  hasAllPermissions,
  normalizePermissionList,
};
