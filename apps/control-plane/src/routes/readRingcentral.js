"use strict";

const express = require("express");
const { buildRingCentralWorkspace } = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadRingcentralRouter(auth) {
  const router = express.Router();

  router.get("/presence/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildRingCentralWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadRingcentralRouter,
};
