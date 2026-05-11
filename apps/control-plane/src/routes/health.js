"use strict";

const express = require("express");
const {
  buildControlPlaneHealthReport,
  buildProviderHealth,
  recordServiceAlert,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createHealthRouter(auth, options = {}) {
  const router = express.Router();
  const getRuntimeState =
    typeof options.getRuntimeState === "function" ? options.getRuntimeState : null;

  router.get("/control-plane", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const result = await buildControlPlaneHealthReport();
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/providers/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildProviderHealth(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/alerts", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await recordServiceAlert(req.body || {});
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/runtime", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const result = getRuntimeState ? await getRuntimeState() : {};
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createHealthRouter,
};
