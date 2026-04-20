"use strict";

const express = require("express");
const { listWorkflowStages } = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createWorkflowsRouter(auth) {
  const router = express.Router();

  router.get("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const records = await listWorkflowStages({
        domain: req.query.domain,
        family: req.query.family,
        subtype: req.query.subtype,
        stage: req.query.stage,
        aggregateType: req.query.aggregateType,
        aggregateId: req.query.aggregateId,
        caseId: req.query.caseId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, records });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createWorkflowsRouter,
};
