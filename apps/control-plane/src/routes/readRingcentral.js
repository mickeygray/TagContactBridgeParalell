"use strict";

const express = require("express");
const {
  buildCallLog,
  buildRingBridgeWorkspace,
  buildRingCentralWorkspace,
  buildRingcentralPollingRuntime,
  listRingCentralEvents,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createReadRingcentralRouter(auth) {
  const router = express.Router();

  router.get("/workspace/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildRingBridgeWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/presence/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildRingCentralWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/diagnostics/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildRingCentralWorkspace(req.params.domain);
      return res.json({ ok: true, result: result.diagnostics });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/events/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listRingCentralEvents(req.params.domain, {
        subtype: req.query.subtype,
        stage: req.query.stage,
        aggregateType: req.query.aggregateType,
        aggregateId: req.query.aggregateId,
        caseId: req.query.caseId,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/call-log/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildCallLog(req.params.domain, {
        limit: req.query.limit,
        direction: req.query.direction,
        outcome: req.query.outcome,
        extensionId: req.query.extensionId,
        source: req.query.source,
        sinceMs: req.query.sinceMs,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/runtime/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildRingcentralPollingRuntime(req.params.domain);
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
