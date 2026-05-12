"use strict";

const express = require("express");
const {
  cancelDeployRun,
  runLocalDeployCommand,
  triggerDeploy,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { createRateLimiter } = require("../middleware/rateLimit");

// Deploy commands are admin-only but still rate-limited to guard against a
// compromised admin session or a pathological "click storm". Six dispatches
// per minute per IP is enough for normal ops; anything more is probably a bug.
const deployLimit = createRateLimiter({
  windowMs: 60_000,
  max: 6,
  message: "Too many deploy requests. Try again shortly.",
});

function createCommandsDeployRouter(auth) {
  const router = express.Router();

  function trigger(action) {
    return async (req, res) => {
      try {
        const targetKey = String(
          req.body?.targetKey || req.body?.target || req.params.targetKey || "",
        ).trim();
        if (!targetKey) {
          return res
            .status(400)
            .json({ ok: false, error: "targetKey is required" });
        }
        const result = await triggerDeploy({
          targetKey,
          action,
          actor: req.user,
          note: req.body?.note,
          confirm: req.body?.confirm,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    };
  }

  router.post(
    "/full",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    trigger("full"),
  );
  router.post(
    "/content-push",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    trigger("content"),
  );
  router.post(
    "/restart-service",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    trigger("restart"),
  );

  router.post(
    "/local/:action",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    async (req, res) => {
      try {
        const targetKey = String(
          req.body?.targetKey || req.body?.target || "",
        ).trim();
        if (!targetKey) {
          return res
            .status(400)
            .json({ ok: false, error: "targetKey is required" });
        }
        const result = await runLocalDeployCommand({
          targetKey,
          action: req.params.action,
          actor: req.user,
          note: req.body?.note,
          confirm: req.body?.confirm,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/cancel/:runId",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    async (req, res) => {
      try {
        const targetKey = String(
          req.body?.targetKey || req.query.targetKey || "",
        ).trim();
        if (!targetKey) {
          return res
            .status(400)
            .json({ ok: false, error: "targetKey is required to cancel a run" });
        }
        const result = await cancelDeployRun({
          runId: String(req.params.runId),
          targetKey,
          actor: req.user,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createCommandsDeployRouter,
};
