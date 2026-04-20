"use strict";

const express = require("express");
const { createDropClient } = require("../../../../packages/shared-integrations/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createDropRouter(auth) {
  const router = express.Router();

  router.get("/balance/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const client = createDropClient(req.params.domain);
      const result = await client.checkBalance();
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/stats/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const client = createDropClient(req.params.domain);
      const result = await client.getCampaignStats(req.query.dateFrom, req.query.dateTo);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createDropRouter,
};
