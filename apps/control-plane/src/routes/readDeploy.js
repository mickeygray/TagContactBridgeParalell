"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  buildBlogBotStatus,
  buildDeployState,
  buildDeployWorkspace,
  buildLocalDeployState,
  listDeployRuns,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

const PARALLEL_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const LANDING_PAGES_DIR = path.join(PARALLEL_ROOT, "runtime", "landing-pages");

function listGeneratedLandingPages() {
  if (!fs.existsSync(LANDING_PAGES_DIR)) return [];
  const files = fs
    .readdirSync(LANDING_PAGES_DIR)
    .filter((name) => name.endsWith(".json"));
  const rows = [];
  for (const name of files) {
    try {
      const fullPath = path.join(LANDING_PAGES_DIR, name);
      const stat = fs.statSync(fullPath);
      const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const slug = data.slug || name.replace(/\.json$/, "");
      const heroFile = path.join(LANDING_PAGES_DIR, `${slug}.png`);
      const hasHero = fs.existsSync(heroFile);
      rows.push({
        slug,
        brand: data.brand || null,
        generatedAt:
          data.generatedAt || stat.mtime.toISOString() || null,
        composerDraft: data.composerDraft || null,
        pageDraft: data.pageDraft || null,
        claudeModel: data.claudeModel || null,
        claudeUsage: data.claudeUsage || null,
        heroImageUrl: hasHero
          ? `/api/read/landing-pages/${encodeURIComponent(slug)}/hero.png`
          : null,
        mtime: stat.mtime.toISOString(),
        status: "pending-review", // until the backend pipeline lands
      });
    } catch {
      // skip unreadable / malformed files
    }
  }
  rows.sort(
    (a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime(),
  );
  return rows;
}

function createReadDeployRouter(auth) {
  const router = express.Router();

  router.get("/runs", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listDeployRuns({
        target: req.query.target || null,
        limit: Number(req.query.limit) || 20,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/local", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildLocalDeployState();
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Blog bot status: state file + recent run logs + recovery audits +
  // cross-repo slug-sync state + last-published per repo. Backs the
  // Blog Bot card in the Deploy workspace.
  router.get(
    "/blog-bot/status",
    auth.requireAuth,
    auth.requireAdmin,
    async (_req, res) => {
      try {
        const result = await buildBlogBotStatus();
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Landing pages — pending review feed. Reads
  // runtime/landing-pages/*.json that the test-landing-page-end-to-end
  // script (or the real generator pipeline once wired) writes.
  router.get(
    "/landing-pages/pending",
    auth.requireAuth,
    auth.requireAdmin,
    async (_req, res) => {
      try {
        const rows = listGeneratedLandingPages();
        return res.json({ ok: true, result: { rows } });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Hero image static serve (PNG). Auth-gated like everything else
  // under /api/read/. Filename is the slug — sanitized to alphanumerics
  // + hyphens so we never serve outside runtime/landing-pages/.
  router.get(
    "/landing-pages/:slug/hero.png",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const safeSlug = String(req.params.slug || "").replace(
          /[^a-z0-9-]/gi,
          "",
        );
        if (!safeSlug) return res.status(400).end();
        const filePath = path.join(LANDING_PAGES_DIR, `${safeSlug}.png`);
        if (!fs.existsSync(filePath)) return res.status(404).end();
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "private, max-age=60");
        return fs.createReadStream(filePath).pipe(res);
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const [deployWorkspace, deployState, localDeployState] = await Promise.all([
        buildDeployWorkspace(req.params.domain),
        buildDeployState(),
        buildLocalDeployState(),
      ]);
      return res.json({
        ok: true,
        result: {
          ...deployWorkspace,
          deploy: deployState,
          localDeploy: localDeployState,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadDeployRouter,
};
