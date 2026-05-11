"use strict";

const express = require("express");
const { buildWorkspaceShell } = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadWorkspaceRouter(auth) {
  const router = express.Router();

  router.get("/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildWorkspaceShell(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadWorkspaceRouter,
};
