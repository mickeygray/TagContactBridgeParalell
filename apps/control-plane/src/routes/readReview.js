"use strict";

const express = require("express");
const {
  buildReviewWorkspace,
  listReviewWorkspaceItems,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadReviewRouter(auth) {
  const router = express.Router();

  router.get("/overview/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildReviewWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/queue/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listReviewWorkspaceItems(req.params.domain, {
        status: req.query.status,
        workflow: req.query.workflow,
        category: req.query.category,
        severity: req.query.severity,
        caseId: req.query.caseId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createReadReviewRouter,
};
