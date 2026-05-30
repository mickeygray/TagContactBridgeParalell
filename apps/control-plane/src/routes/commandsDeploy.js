"use strict";

const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const {
  cancelDeployRun,
  runLocalDeployCommand,
  triggerDeploy,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { createRateLimiter } = require("../middleware/rateLimit");

const PARALLEL_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const BLOG_BOT_RUNNER = path.join(
  PARALLEL_ROOT,
  "scripts",
  "blogger-daily-runner.js",
);

// Deploy commands are admin-only but still rate-limited to guard against a
// compromised admin session or a pathological "click storm". Six dispatches
// per minute per IP is enough for normal ops; anything more is probably a bug.
const deployLimit = createRateLimiter({
  windowMs: 60_000,
  max: 6,
  message: "Too many deploy requests. Try again shortly.",
});

function createCommandsDeployRouter(auth, options = {}) {
  const router = express.Router();
  const bloggerRuntime = options.bloggerRuntime || null;

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

  // Manually fire the blog bot's daily-runner. Useful when the
  // scheduled cron didn't fire (machine asleep at 8am PT) or when the
  // operator wants to test the pipeline. Always passes --force so the
  // "already ran today" guard doesn't block. The runner enforces its
  // own preflight, dedup, and (now) the failure-recovery agent — so
  // this endpoint is just a remote-fire-and-forget trigger.
  //
  // Fire-and-forget by design: the runner can take several minutes
  // (image render + npm build x2 + ssh deploy x2). We return 202 as
  // soon as the child process is spawned; the operator sees the
  // result via the Blog Bot card refresh (new run log appears, state
  // file updates) or the summary email.
  router.post(
    "/blog-bot/run",
    auth.requireAuth,
    auth.requireAdmin,
    deployLimit,
    async (req, res) => {
      try {
        if (bloggerRuntime) {
          const result = bloggerRuntime.startBloggerRun({
            force: req.body?.force !== undefined ? Boolean(req.body.force) : true,
            preflight: Boolean(req.body?.preflight),
            dryRun: Boolean(req.body?.dryRun),
            override: req.body?.override,
            scheduled: false,
            actor: req.user?.email || null,
          });
          const status = result.accepted ? 202 : 409;
          return res.status(status).json({
            ok: Boolean(result.ok),
            message: result.accepted
              ? "Blogger run accepted by control-plane runtime. Watch the Blog Bot card for logs, state, and alerts."
              : result.reason || "Blogger run was not accepted.",
            spawnedAt: result.startedAt || new Date().toISOString(),
            actor: req.user?.email || null,
            result,
          });
        }

        const child = spawn(
          process.execPath,
          [BLOG_BOT_RUNNER, "--force"],
          {
            cwd: PARALLEL_ROOT,
            stdio: "ignore",
            detached: true,
            env: process.env,
          },
        );
        child.on("error", (err) => {
          console.error("[blog-bot/run] spawn error:", err.message);
        });
        child.unref();
        return res.status(202).json({
          ok: true,
          message:
            "Daily-runner spawned in background. Watch the Blog Bot card for the new run log + state update.",
          spawnedAt: new Date().toISOString(),
          actor: req.user?.email || null,
        });
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
