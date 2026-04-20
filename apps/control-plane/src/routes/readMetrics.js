"use strict";

const express = require("express");
const {
  buildCallrailWorkspace,
  buildDailySummaryWorkspace,
  buildMailCostWorkspace,
  buildMetricsWorkspace,
  buildMetricSourcesWorkspace,
  buildRedlineWorkspace,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadMetricsRouter(auth) {
  const router = express.Router();

  router.get("/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildMetricsWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/sources/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildMetricSourcesWorkspace(req.params.domain, {
        from: req.query.from,
        to: req.query.to,
        channel: req.query.channel,
        paymentLimit: req.query.paymentLimit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/daily-summary/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildDailySummaryWorkspace(req.params.domain, {
        date: req.query.date,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/mail-costs/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildMailCostWorkspace(req.params.domain, {
        from: req.query.from,
        to: req.query.to,
        date: req.query.date,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/redlines/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildRedlineWorkspace(req.params.domain, {
        status: req.query.status,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/callrail/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildCallrailWorkspace({
        date: req.query.date,
        from: req.query.from,
        to: req.query.to,
        channel: req.query.channel,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadMetricsRouter,
};
