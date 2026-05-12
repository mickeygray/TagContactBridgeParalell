"use strict";

const express = require("express");
const {
  findAccountByEmail,
  getWorkspaceForUser,
  issueOtpChallenge,
  issueLoginToken,
  listAccounts,
  requireAuth,
  verifyOtpChallenge,
  effectivePermissionsFor,
} = require("../../../../packages/shared-auth/src");
const {
  userAccountRepository,
} = require("../../../../packages/shared-repositories/src");
const { createRateLimiter } = require("../middleware/rateLimit");

// Per-IP rate limits. The OTP service already enforces a per-email cooldown
// (AUTH_OTP_REQUEST_COOLDOWN_SECONDS); these add a second layer against an IP
// that cycles through many emails.
const sendCodeLimit = createRateLimiter({
  windowMs: 60_000,
  max: 8,
  message: "Too many login code requests. Try again shortly.",
});
const verifyCodeLimit = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: "Too many verification attempts. Try again shortly.",
});

function createAuthRouter(config, options = {}) {
  const router = express.Router();
  const logger = options.logger || console;

  function emitAuthLog(level, event, meta = {}) {
    const sink = typeof logger[level] === "function" ? logger[level] : logger.log;
    if (typeof sink !== "function") return;
    sink.call(logger, event, meta);
  }

  function getRequestMeta(req, extra = {}) {
    return {
      ip: req.ip || null,
      forwardedFor: req.get("x-forwarded-for") || null,
      origin: req.get("origin") || null,
      referer: req.get("referer") || null,
      userAgent: req.get("user-agent") || null,
      ...extra,
    };
  }

  function attachSendCodeResponseLog(req, res, email) {
    const startedAt = Date.now();
    res.once("finish", () => {
      emitAuthLog("info", "auth.send_code.response", getRequestMeta(req, {
        email,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    });
  }

  async function requireActiveAccount(req, res, next) {
    try {
      const account = await userAccountRepository.findUserAccountByEmail(req.user?.email);
      if (!account || account.status !== "active") {
        return res.status(403).json({ ok: false, error: "Account is not active" });
      }
      req.liveAccount = account;
      req.user = {
        ...req.user,
        ...account,
        permissions: effectivePermissionsFor(account),
      };
      return next();
    } catch (error) {
      return next(error);
    }
  }

  function sanitizeFinalRedirectTo(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (!raw.startsWith("/") || raw.startsWith("//")) return "/cx";
    return raw;
  }

  function buildPublicAuthUser(user) {
    const account = user || {};
    return {
      id: account.id || String(account._id || ""),
      email: account.email,
      name: account.name,
      role: account.role,
      audience: account.audience,
      capabilities: account.capabilities || [],
      permissions: effectivePermissionsFor(account),
      views: account.views || [],
      workspace: account.workspace || "general",
      stationLabel: account.stationLabel || null,
      company: account.company || null,
      extensionId: account.extensionId || null,
      extensionNumber: account.extensionNumber || null,
      cxAgentId: account.cxAgentId || null,
      phone: account.phone || null,
      exShells: Array.isArray(account.exShells) ? account.exShells : [],
      logicsUserId: account.logicsUserId || null,
      logicsDisplayName: account.logicsDisplayName || null,
      tagLogicsId: account.tagLogicsId || null,
      tagSOId: account.tagSOId || null,
      tagEmail: account.tagEmail || null,
      tagLogicsName: account.tagLogicsName || null,
      tagLogicsRoles: account.tagLogicsRoles || null,
      wynnLogicsId: account.wynnLogicsId || null,
      wynnSOId: account.wynnSOId || null,
      wynnEmail: account.wynnEmail || null,
      wynnLogicsName: account.wynnLogicsName || null,
      wynnLogicsRoles: account.wynnLogicsRoles || null,
      logicsAuth: account.logicsAuth
        ? {
            credentialMode: account.logicsAuth.credentialMode || "company",
            credentialStatus: account.logicsAuth.credentialStatus || "pending",
            scopes: account.logicsAuth.scopes || [],
            permissionsLabel: account.logicsAuth.permissionsLabel || null,
          }
        : null,
      cxAuth: (() => {
        try {
          const { summarizeOAuthValidityFromAccount } =
            require("../../../../packages/shared-services/src/cxTokenStorageService");
          return summarizeOAuthValidityFromAccount(account);
        } catch {
          return {
            oauthRequired: true,
            isOAuthValidated: false,
            invalidReason: "service-unavailable",
          };
        }
      })(),
      status: account.status || "active",
    };
  }

  function isAgentLoginWindowLimited(account = {}) {
    const role = String(account.role || "").trim().toLowerCase();
    const audience = String(account.audience || "").trim().toLowerCase();
    if (role === "admin" || role === "manager" || audience === "admin") return false;
    return role === "internal-agent" || role === "widget-user" || audience === "user";
  }

  router.post(
    "/send-code",
    (req, res, next) => {
      const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
      attachSendCodeResponseLog(req, res, normalizedEmail || null);
      emitAuthLog("info", "auth.send_code.request", getRequestMeta(req, {
        email: normalizedEmail || null,
        hasJsonBody: Boolean(req.body && typeof req.body === "object"),
      }));
      return next();
    },
    sendCodeLimit,
    async (req, res) => {
      const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
      try {
        const account = await findAccountByEmail(normalizedEmail);
        if (!account || account.status === "disabled") {
          emitAuthLog("warn", "auth.send_code.rejected", getRequestMeta(req, {
            email: normalizedEmail || null,
            reason: account ? "disabled-account" : "unknown-account",
            accountFound: Boolean(account),
            accountStatus: account?.status || null,
          }));
          return res.status(400).json({ ok: false, error: "Unknown account" });
        }

        const challenge = await issueOtpChallenge(config, account, {
          ip: req.ip,
        });

        emitAuthLog("info", "auth.send_code.delivered", getRequestMeta(req, {
          email: challenge.email,
          challengeId: challenge.challengeId,
          accountStatus: account.status,
          accountRole: account.role,
          previewEnabled: Boolean(config.authOtpPreview),
        }));

        return res.json({
          ok: true,
          challengeId: challenge.challengeId,
          email: challenge.email,
          expiresAt: challenge.expiresAt,
          attemptsRemaining: challenge.attemptsRemaining,
          delivery: {
            channel: "email",
            previewEnabled: config.authOtpPreview,
          },
          ...(config.authOtpPreview ? { previewCode: challenge.code } : {}),
        });
      } catch (error) {
        emitAuthLog("warn", "auth.send_code.failed", getRequestMeta(req, {
          email: normalizedEmail || null,
          status: error.status || 500,
          error: error.message,
        }));
        return res.status(error.status || 500).json({ ok: false, error: error.message });
      }
    },
  );

  router.post("/verify-code", verifyCodeLimit, async (req, res) => {
    try {
      const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
      const account = await findAccountByEmail(normalizedEmail);
      if (!account || account.status === "disabled") {
        return res.status(400).json({ ok: false, error: "Unknown account" });
      }

      // ── Agent login window check (non-admins only) ───────────────
      // Agents can only obtain a session inside the configured window.
      // Admins are exempt — they need access for off-hours admin work.
      if (isAgentLoginWindowLimited(account)) {
        try {
          const { getPacingConfig } = require("../../../../packages/shared-services/src");
          const { isAgentLoginWindowOpen } = require("../../../../packages/shared-services/src/businessHoursGuard");
          const pacing = await getPacingConfig();
          if (!isAgentLoginWindowOpen(pacing)) {
            return res.status(403).json({
              ok: false,
              error: "outside-login-window",
              hint: `Agent logins allowed ${pacing.agentLoginStartHour}:00–${pacing.agentLoginEndHour}:00 ${pacing.agentLoginTimezone || pacing.businessHoursTimezone}`,
            });
          }
        } catch (_) {
          // If pacing config is unavailable for any reason, fall through
          // (don't block login on a config-load failure). The strict-mode
          // startup validator catches misconfigurations.
        }
      }

      try {
        await verifyOtpChallenge(config, account, String(req.body?.code || ""));
      } catch (verifyError) {
        // Surface the attempts-remaining count so the UI can show
        // "2 attempts left" instead of a generic error.
        return res.status(verifyError.status || 401).json({
          ok: false,
          error: verifyError.message,
          attemptsRemaining: verifyError.attemptsRemaining ?? null,
        });
      }
      await userAccountRepository.touchUserAccountLogin(account.email);
      if (account.status === "invited") {
        await userAccountRepository.updateUserAccount(account.id, {
          status: "active",
        });
      }

      const latest = (await findAccountByEmail(normalizedEmail)) || account;

      // Clamp JWT expiry to today's window-close for non-admins.
      // SPA's existing 401 handler will auto-logout when the token expires.
      let clampExpiresAt = null;
      if (isAgentLoginWindowLimited(latest)) {
        try {
          const { getPacingConfig } = require("../../../../packages/shared-services/src");
          const { todaysAgentLoginWindowClose } = require("../../../../packages/shared-services/src/businessHoursGuard");
          const pacing = await getPacingConfig();
          clampExpiresAt = todaysAgentLoginWindowClose(pacing);
        } catch (_) { /* fall through, no clamp */ }
      }

      const token = issueLoginToken(config, latest, { clampExpiresAt });
      return res.json({
        ok: true,
        token,
        user: buildPublicAuthUser(latest),
        expiresAt: clampExpiresAt || null,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // Lightweight auth verification endpoint for nginx's auth_request
  // subrequest gate. The gate proxies to /api/auth/check and only
  // cares about the status code — 2xx means "let the original
  // request through to the upstream," anything else triggers the
  // configured error_page. We return 204 (no content) on success
  // since the body would be discarded anyway, and let the existing
  // requireAuth middleware return 401 on missing/expired/invalid
  // tokens. Distinct from /me, which exists for the SPA to fetch
  // the full session profile and so should keep returning a JSON
  // body — using /me as the gate would mean issuing the full
  // profile fetch on every authed request through nginx.
  router.get("/check", requireAuth(config), requireActiveAccount, (_req, res) => {
    return res.sendStatus(204);
  });

  router.get("/me", requireAuth(config), requireActiveAccount, async (req, res) => {
    const account = req.liveAccount || req.user;
    const user = (await findAccountByEmail(account.email)) || account;
    return res.json(buildPublicAuthUser(user));
  });

  router.get("/accounts", requireAuth(config), async (req, res) => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    const accounts = await listAccounts({ limit: 500 });
    return res.json({ ok: true, accounts });
  });

  router.get("/workspace", requireAuth(config), (req, res) => {
    return res.json({
      ok: true,
      workspace: getWorkspaceForUser(req.user),
    });
  });

  router.get("/views", requireAuth(config), (req, res) => {
    return res.json({
      ok: true,
      views: req.user.views || [],
      audience: req.user.audience,
      role: req.user.role,
    });
  });

  router.get("/runtime-defaults", requireAuth(config), (req, res) => {
    return res.json({
      ok: true,
      defaults: config.runtimeDefaults,
    });
  });

  router.post("/logout", requireAuth(config), async (req, res) => {
    try {
      const account = await userAccountRepository.findUserAccountByEmail(req.user?.email)
        .catch(() => null);
      const extensionId = String(account?.extensionId || req.user?.extensionId || "").trim();
      if (!extensionId) {
        return res.json({
          ok: true,
          queueRelease: {
            ok: true,
            released: 0,
            reason: "no-extension-id",
          },
        });
      }

      const { releaseAssignedCxQueueForAgent } =
        require("../../../../packages/shared-services/src/cxCadenceService");
      const { touchCxWorkspacePresence } =
        require("../../../../packages/shared-services/src");
      await touchCxWorkspacePresence(extensionId, {
        active: false,
        source: "auth-logout",
        userEmail: account?.email || req.user?.email || null,
      }).catch(() => null);
      const queueRelease = await releaseAssignedCxQueueForAgent({
        extensionId,
        actorEmail: account?.email || req.user?.email || null,
        reason: "auth-logout",
      });

      return res.json({ ok: true, queueRelease });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // ── CX (RingCX) OAuth: start handshake ─────────────────────────
  //
  // POST /api/auth/cx/start  (authenticated; user kicks off their own SSO)
  // Body: { finalRedirectTo?: string }
  // Returns: { authorizeUrl, state, expiresAt }
  //
  // SPA flow: agent clicks "Connect RingCentral" → POST /api/auth/cx/start
  //  → receives authorizeUrl → window.location.href = authorizeUrl
  //  → user authorizes at RC → RC redirects to /api/auth/cx/callback
  //  → callback redirects user back to finalRedirectTo (or /cx)
  router.post("/cx/start", requireAuth(config), requireActiveAccount, async (req, res) => {
    try {
      const { cxOAuthService } = require("../../../../packages/shared-services/src");
      const result = await cxOAuthService.start({
        user: req.user,
        finalRedirectTo: sanitizeFinalRedirectTo(req.body?.finalRedirectTo),
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  // GET /api/auth/cx/callback?code=…&state=…  (PUBLIC — RC redirects here)
  //
  // RC's redirect URI lands here. We exchange the code for tokens, store
  // them encrypted on the agent's UserAccount, then 302 the user back to
  // the SPA. No JSON response — this is a browser-driven flow.
  router.get("/cx/callback", async (req, res) => {
    try {
      const { cxOAuthService } = require("../../../../packages/shared-services/src");
      const result = await cxOAuthService.callback({
        code: req.query.code,
        state: req.query.state,
        errorParam: req.query.error,
      });
      // Redirect target: configured fallback or /cx
      const fallback = "/cx";
      const target = result.ok
        ? (result.finalRedirectTo || fallback) + "?cxauth=ok"
        : `${fallback}?cxauth=err&reason=${encodeURIComponent(result.error || "unknown")}`;
      return res.redirect(302, target);
    } catch (error) {
      return res.redirect(302, `/cx?cxauth=err&reason=${encodeURIComponent(error.message)}`);
    }
  });

  // POST /api/auth/cx/refresh   (authenticated; user manually refreshes)
  router.post("/cx/refresh", requireAuth(config), requireActiveAccount, async (req, res) => {
    try {
      const { cxOAuthService } = require("../../../../packages/shared-services/src");
      const result = await cxOAuthService.refreshUserSession({ user: req.user });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  // GET /api/auth/cx/status   (authenticated; reads describe() — no plaintext)
  router.get("/cx/status", requireAuth(config), requireActiveAccount, async (req, res) => {
    try {
      const { cxTokenStorageService, cxOAuthService } = require("../../../../packages/shared-services/src");
      const userId = String(req.user?.id || "");
      const desc = userId ? await cxTokenStorageService.describe(userId) : null;
      return res.json({
        ok: true,
        config: cxOAuthService.describeConfig(),
        session: desc,
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  // POST /api/auth/cx/revoke   (authenticated; user clears their own tokens)
  router.post("/cx/revoke", requireAuth(config), requireActiveAccount, async (req, res) => {
    try {
      const { cxTokenStorageService } = require("../../../../packages/shared-services/src");
      const userId = String(req.user?.id || "");
      if (!userId) return res.status(400).json({ ok: false, error: "user-id-required" });
      await cxTokenStorageService.revoke(userId);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
