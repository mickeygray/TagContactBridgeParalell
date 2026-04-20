"use strict";

const express = require("express");
const { listLastMonthInboundCalls, lookupInboundCall } = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCallrailRouter(auth) {
  const router = express.Router();

  router.get("/lookup/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const phone = String(req.query.phone || "").trim();
      if (!phone) {
        return res.status(400).json({
          ok: false,
          error: "phone query parameter is required",
        });
      }

      const result = await lookupInboundCall(req.params.domain, phone);
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/last-month/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listLastMonthInboundCalls(req.params.domain, {
        perPage: req.query.perPage,
        maxPages: req.query.maxPages ? Number(req.query.maxPages) : undefined,
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createCallrailRouter,
};
