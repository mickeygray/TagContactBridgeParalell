"use strict";

const express = require("express");
const {
  createAccounts,
  findAccountByEmail,
  getWorkspaceForUser,
  issueOtpChallenge,
  issueLoginToken,
  requireAuth,
  verifyOtpChallenge,
} = require("../../../../packages/shared-auth/src");

function createAuthRouter(config) {
  const router = express.Router();

  router.post("/send-code", async (req, res) => {
    try {
      const account = findAccountByEmail(config, req.body?.email);
      if (!account) {
        return res.status(400).json({ ok: false, error: "Unknown account" });
      }

      const challenge = await issueOtpChallenge(config, account, {
        ip: req.ip,
      });

      return res.json({
        ok: true,
        challengeId: challenge.challengeId,
        email: challenge.email,
        expiresAt: challenge.expiresAt,
        delivery: {
          channel: "email",
          previewEnabled: config.authOtpPreview,
        },
        ...(config.authOtpPreview ? { previewCode: challenge.code } : {}),
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  router.post("/verify-code", async (req, res) => {
    try {
      const account = findAccountByEmail(config, req.body?.email);
      if (!account) {
        return res.status(400).json({ ok: false, error: "Unknown account" });
      }

      await verifyOtpChallenge(config, account, String(req.body?.code || ""));

      const token = issueLoginToken(config, account);
      return res.json({
        ok: true,
        token,
        user: account,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  router.get("/me", requireAuth(config), (req, res) => {
    return res.json({
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      audience: req.user.audience,
      capabilities: req.user.capabilities || [],
      views: req.user.views || [],
      workspace: req.user.workspace || "general",
      stationLabel: req.user.stationLabel || null,
      company: req.user.company || null,
      extensionId: req.user.extensionId || null,
      cxAgentId: req.user.cxAgentId || null,
    });
  });

  router.get("/accounts", requireAuth(config), (req, res) => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    return res.json({
      ok: true,
      accounts: createAccounts(config),
    });
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

  router.post("/logout", (_req, res) => {
    return res.json({ ok: true });
  });

  return router;
}

module.exports = {
  createAuthRouter,
};
