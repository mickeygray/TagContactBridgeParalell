"use strict";

const express = require("express");
const {
  buildDeployState,
  buildDeployWorkspace,
  buildLocalDeployState,
  listDeployRuns,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

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
