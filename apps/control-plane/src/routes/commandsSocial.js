"use strict";

const express = require("express");
const { saveSocialResponderConfig } = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCommandsSocialRouter(auth) {
  const router = express.Router();

  router.use(auth.requireAuth, auth.requireAdmin);

  router.put("/:domain/:platform", async (req, res) => {
    try {
      const result = await saveSocialResponderConfig(
        req.params.domain,
        req.params.platform,
        req.body || {},
        req.user,
      );
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createCommandsSocialRouter,
};
