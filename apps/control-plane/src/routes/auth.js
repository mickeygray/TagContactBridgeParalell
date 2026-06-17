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
const {
  createCxLoginTrace,
} = require("../../../../packages/shared-services/src/cxLoginTraceService");
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

  async function timedAuthStep(timings, label, fn) {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      timings[label] = Date.now() - startedAt;
    }
  }

  async function ensureRingcxOffhookAllowed(account, source) {
    try {
      const {
        ensureRingcxAgentOffhookAllowed,
      } = require("../../../../packages/shared-services/src/ringcxAgentSelfHealService");
      return await ensureRingcxAgentOffhookAllowed(account, {
        source,
        logger,
      });
    } catch (error) {
      emitAuthLog("warn", "ringcx.offhook.self_heal.failed", {
        source,
        email: account?.email || null,
        error: error.message,
      });
      return { ok: false, error: error.message };
    }
  }

  function readBooleanEnv(name, fallback = false) {
    const raw = process.env[name];
    if (raw == null || raw === "") return fallback;
    const normalized = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
  }

  function loginThinEnabled() {
    return readBooleanEnv("CX_LOGIN_THIN_ENABLED", false);
  }

  function asyncOffhookSelfHealEnabled() {
    return loginThinEnabled() || readBooleanEnv("CX_LOGIN_ASYNC_OFFHOOK_SELF_HEAL", false);
  }

  function scheduleRingcxOffhookAllowed(account, source, meta = {}) {
    const startedAt = Date.now();
    Promise.resolve()
      .then(() => ensureRingcxOffhookAllowed(account, source))
      .then((result) => {
        emitAuthLog("info", "ringcx.offhook.self_heal.async.done", {
          source,
          email: account?.email || null,
          durationMs: Date.now() - startedAt,
          ok: result?.ok ?? null,
          skipped: Boolean(result?.skipped),
          reason: result?.reason || null,
          patched: Boolean(result?.patched),
          ...meta,
        });
      })
      .catch((error) => {
        emitAuthLog("warn", "ringcx.offhook.self_heal.async.failed", {
          source,
          email: account?.email || null,
          durationMs: Date.now() - startedAt,
          error: error.message,
          ...meta,
        });
      });
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
    const startedAt = Date.now();
    const timings = {};
    const normalizedEmail = String(req.body?.email || "").trim().toLowerCase();
    const traceLogin = createCxLoginTrace(logger, "otp-verify", {
      email: normalizedEmail || null,
      origin: req.get("origin") || null,
      referer: req.get("referer") || null,
    });
    traceLogin("start");
    try {
      const account = await timedAuthStep(timings, "findAccountMs", () => findAccountByEmail(normalizedEmail));
      traceLogin("account.lookup.done", {
        account,
        stepMs: timings.findAccountMs,
        reason: account ? "found" : "missing",
      });
      if (!account || account.status === "disabled") {
        traceLogin("account.rejected", {
          account,
          statusCode: 400,
          reason: account ? "disabled-account" : "unknown-account",
        });
        return res.status(400).json({ ok: false, error: "Unknown account" });
      }

      try {
        await timedAuthStep(timings, "verifyOtpMs", () =>
          verifyOtpChallenge(config, account, String(req.body?.code || "")));
        traceLogin("otp.verify.done", {
          account,
          stepMs: timings.verifyOtpMs,
        });
      } catch (verifyError) {
        // Surface the attempts-remaining count so the UI can show
        // "2 attempts left" instead of a generic error.
        traceLogin("otp.verify.failed", {
          account,
          stepMs: timings.verifyOtpMs,
          statusCode: verifyError.status || 401,
          error: verifyError.message,
        });
        return res.status(verifyError.status || 401).json({
          ok: false,
          error: verifyError.message,
          attemptsRemaining: verifyError.attemptsRemaining ?? null,
        });
      }
      await timedAuthStep(timings, "touchLoginMs", () =>
        userAccountRepository.touchUserAccountLogin(account.email));
      traceLogin("account.touch-login.done", {
        account,
        stepMs: timings.touchLoginMs,
      });
      if (account.status === "invited") {
        await timedAuthStep(timings, "activateInvitedAccountMs", () =>
          userAccountRepository.updateUserAccount(account.id, {
            status: "active",
          }));
        traceLogin("account.activate-invited.done", {
          account,
          stepMs: timings.activateInvitedAccountMs,
        });
      }

      const latest = (await timedAuthStep(timings, "reloadAccountMs", () =>
        findAccountByEmail(normalizedEmail))) || account;
      traceLogin("account.reload.done", {
        account: latest,
        stepMs: timings.reloadAccountMs,
      });
      let offhookResult = null;
      const thinLogin = loginThinEnabled();
      const asyncOffhookSelfHeal = asyncOffhookSelfHealEnabled();
      if (asyncOffhookSelfHeal) {
        timings.ringcxOffhookSelfHealScheduled = true;
        scheduleRingcxOffhookAllowed(latest, "auth-verify-code-async", {
          email: normalizedEmail || null,
          loginThinEnabled: thinLogin,
        });
        traceLogin("offhook.self-heal.scheduled", {
          account: latest,
          loginThinEnabled: thinLogin,
          asyncOffhookSelfHeal,
          offhookScheduled: true,
        });
      } else {
        offhookResult = await timedAuthStep(timings, "ringcxOffhookSelfHealMs", () =>
          ensureRingcxOffhookAllowed(latest, "auth-verify-code"));
        traceLogin("offhook.self-heal.done", {
          account: latest,
          stepMs: timings.ringcxOffhookSelfHealMs,
          loginThinEnabled: thinLogin,
          asyncOffhookSelfHeal,
          result: offhookResult,
        });
      }

      // Login is intentionally allowed outside the dialing window so agents
      // can review recordings after hours. Dialer/workspace access is gated
      // separately by business-hours checks.
      const token = await timedAuthStep(timings, "issueTokenMs", () =>
        Promise.resolve(issueLoginToken(config, latest)));
      traceLogin("token.issue.done", {
        account: latest,
        stepMs: timings.issueTokenMs,
      });
      emitAuthLog("info", "auth.verify_code.timing", getRequestMeta(req, {
        email: normalizedEmail || null,
        durationMs: Date.now() - startedAt,
        timings,
        loginThinEnabled: thinLogin,
        asyncOffhookSelfHeal,
        offhook: offhookResult
          ? {
            ok: offhookResult.ok,
            skipped: Boolean(offhookResult.skipped),
            reason: offhookResult.reason || null,
            patched: Boolean(offhookResult.patched),
          }
          : null,
      }));
      traceLogin("response.ready", {
        account: latest,
        statusCode: 200,
        stepMs: Date.now() - startedAt,
        loginThinEnabled: thinLogin,
        asyncOffhookSelfHeal,
        offhookScheduled: Boolean(timings.ringcxOffhookSelfHealScheduled),
      });
      return res.json({
        ok: true,
        token,
        user: buildPublicAuthUser(latest),
        expiresAt: null,
      });
    } catch (error) {
      traceLogin("failed", {
        statusCode: error.status || 500,
        stepMs: Date.now() - startedAt,
        error: error.message,
      });
      emitAuthLog("warn", "auth.verify_code.failed", getRequestMeta(req, {
        email: normalizedEmail || null,
        durationMs: Date.now() - startedAt,
        timings,
        error: error.message,
      }));
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

  router.get("/work-hours", requireAuth(config), requireActiveAccount, async (req, res) => {
    const account = req.liveAccount || req.user || {};
    const limited = isAgentLoginWindowLimited(account);
    try {
      const { getPacingConfig } = require("../../../../packages/shared-services/src");
      const { isAgentLoginWindowOpen, isOperatingNow } =
        require("../../../../packages/shared-services/src/businessHoursGuard");
      const pacing = await getPacingConfig();
      const cxWorkspaceOpen = isOperatingNow(pacing);
      const loginWindowOpen = isAgentLoginWindowOpen(pacing);
      return res.json({
        ok: true,
        limited,
        cxWorkspace: {
          allowed: !limited || cxWorkspaceOpen,
          open: cxWorkspaceOpen,
          timezone: pacing.businessHoursTimezone || "America/Los_Angeles",
          startHour: pacing.businessHoursStart,
          endHour: pacing.businessHoursEnd,
          days: pacing.businessDays || [],
        },
        login: {
          allowed: true,
          open: loginWindowOpen,
          timezone: pacing.agentLoginTimezone || pacing.businessHoursTimezone || "America/Los_Angeles",
          startHour: pacing.agentLoginStartHour,
          endHour: pacing.agentLoginEndHour,
          days: pacing.agentLoginDays || pacing.businessDays || [],
        },
      });
    } catch (error) {
      return res.status(503).json({
        ok: false,
        error: "Could not load work-hours configuration",
        detail: error.message,
      });
    }
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

  // Local/test lane for comparing a shallow-cloned OAuth path without changing
  // the production /cx route. The callback is shared; finalRedirectTo marks the
  // state so cxOAuthService can avoid blocking the browser on off-hook repair.
  router.post("/cx/prep/start", requireAuth(config), requireActiveAccount, async (req, res) => {
    try {
      const { cxOAuthService } = require("../../../../packages/shared-services/src");
      const result = await cxOAuthService.start({
        user: req.user,
        finalRedirectTo: sanitizeFinalRedirectTo(req.body?.finalRedirectTo) || "/cx/prep",
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
