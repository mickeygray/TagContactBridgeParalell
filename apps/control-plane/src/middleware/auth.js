"use strict";

const {
  effectivePermissionsFor,
  requireAllPermissions,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} = require("../../../../packages/shared-auth/src");
const { userAccountRepository } = require("../../../../packages/shared-repositories/src");
const { ROLES } = require("../../../../packages/shared-types/src");
const {
  deriveOAuthValidity,
  isCxUserOAuthRequired,
} = require("../../../../packages/shared-services/src/cxTokenStorageService");

// Loosened in tandem with cxOAuthService.REQUIRED_RINGCX_SCOPES so the dial
// route doesn't 403 agents whose RC app grant lacks ReadAccounts. Tighten
// back to ["ReadAccounts"] when the RC app permissions are corrected.
const REQUIRED_CX_RINGCENTRAL_SCOPES = Object.freeze([]);

function hasRequiredCxScopes(account = {}) {
  const granted = new Set(
    (Array.isArray(account.cxAuth?.scopes) ? account.cxAuth.scopes : [])
      .map((scope) => String(scope || "").trim().toLowerCase())
      .filter(Boolean),
  );
  return REQUIRED_CX_RINGCENTRAL_SCOPES.every((scope) => granted.has(scope.toLowerCase()));
}

/**
 * Load the fresh account record for `req.user.email` from Mongo and verify the
 * account is still `active`. On success, refreshes `req.user` with whatever
 * the DB says today (role, audience, extensionId, etc.) so downstream code
 * sees the live view rather than what the JWT was issued with.
 *
 * Returns `true` if the account is live, or sends a 403 and returns `false`.
 *
 * Per-request memoization: once a request has successfully loaded the live
 * account, `req._liveAccountLoaded` is set to true. Subsequent calls (e.g.
 * if a future middleware chain lists both `requireUser` and `requireAdmin`)
 * skip the second Mongo lookup. Cheap defensive guard — at the time of
 * writing no chain duplicates the load, but cost is negligible and it
 * protects against accidental DB amplification under polling bursts.
 */
async function loadLiveAccount(req, res) {
  if (!req.user?.email) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return false;
  }

  if (req._liveAccountLoaded === true) {
    return true;
  }

  const account = await userAccountRepository.findUserAccountByEmail(
    req.user.email,
  );
  if (!account || account.status !== "active") {
    res.status(403).json({ ok: false, error: "Account is not active" });
    return false;
  }

  req.user = {
    ...req.user,
    role: account.role || req.user.role,
    audience: account.audience || req.user.audience,
    company: account.company || req.user.company,
    workspace: account.workspace || req.user.workspace,
    stationLabel: account.stationLabel || req.user.stationLabel,
    phone: account.phone || req.user.phone,
    logicsUserId: account.logicsUserId || req.user.logicsUserId,
    logicsDisplayName: account.logicsDisplayName || req.user.logicsDisplayName,
    tagLogicsId: account.tagLogicsId || req.user.tagLogicsId,
    tagEmail: account.tagEmail || req.user.tagEmail,
    tagLogicsName: account.tagLogicsName || req.user.tagLogicsName,
    tagLogicsRoles: account.tagLogicsRoles || req.user.tagLogicsRoles || [],
    wynnLogicsId: account.wynnLogicsId || req.user.wynnLogicsId,
    wynnEmail: account.wynnEmail || req.user.wynnEmail,
    wynnLogicsName: account.wynnLogicsName || req.user.wynnLogicsName,
    wynnLogicsRoles: account.wynnLogicsRoles || req.user.wynnLogicsRoles || [],
    logicsAuth: account.logicsAuth || req.user.logicsAuth || null,
    permissions: effectivePermissionsFor(account),
    extensionId: account.extensionId || req.user.extensionId,
    extensionNumber: account.extensionNumber || req.user.extensionNumber,
    cxAgentId: account.cxAgentId || req.user.cxAgentId,
    cxAuth: account.cxAuth || null,
    cxSession: account.cxSession || null,
    exShells: Array.isArray(account.exShells) ? account.exShells : [],
    accountStatus: account.status,
  };
  req._liveAccountLoaded = true;
  return true;
}

async function requireAdmin(req, res, next) {
  try {
    const live = await loadLiveAccount(req, res);
    if (!live) return;
    if (req.user?.role !== ROLES.ADMIN) {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireUser(req, res, next) {
  try {
    const live = await loadLiveAccount(req, res);
    if (!live) return;
    // Admin is a superset of user access: let admins enter the CX/user shell
    // and hit user-scoped routes without having to dual-tag the account.
    if (req.user?.role === ROLES.ADMIN) return next();
    if (req.user?.audience !== "user") {
      return res
        .status(403)
        .json({ ok: false, error: "User workspace access required" });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

async function requireCxOAuth(req, res, next) {
  try {
    if (!isCxUserOAuthRequired()) return next();
    if (req.user?.role === ROLES.ADMIN) return next();
    const validity = deriveOAuthValidity(req.user?.cxAuth, req.user?.cxSession);
    if (!validity.isOAuthValidated) {
      return res.status(403).json({
        ok: false,
        error: "RingCentral CX authorization required",
        code: "cx-oauth-required",
        reason: validity.reason,
      });
    }
    if (!hasRequiredCxScopes(req.user)) {
      return res.status(403).json({
        ok: false,
        error: "RingCentral CX authorization is missing required scopes",
        code: "cx-oauth-scope-missing",
        requiredScopes: REQUIRED_CX_RINGCENTRAL_SCOPES,
        grantedScopes: Array.isArray(req.user?.cxAuth?.scopes) ? req.user.cxAuth.scopes : [],
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function buildAuthMiddleware(config) {
  return {
    requireAuth: requireAuth(config),
    requireAdmin,
    requireAllPermissions,
    requireAnyPermission,
    requireCxOAuth,
    requirePermission,
    requireUser,
  };
}

module.exports = {
  buildAuthMiddleware,
};
