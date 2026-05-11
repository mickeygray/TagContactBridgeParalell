"use strict";

const express = require("express");
const {
  buildScheduleHistoryWorkspace,
  buildScheduleWorkspace,
  listScheduleCadence,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function parseBoolean(value) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function createReadSchedulesRouter(auth) {
  const router = express.Router();

  router.get("/overview/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildScheduleWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/cadence/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listScheduleCadence(req.params.domain, {
        caseId: req.query.caseId,
        active: parseBoolean(req.query.active),
        intakeSource: req.query.intakeSource,
        intakeRoute: req.query.intakeRoute,
        limit: req.query.limit,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/history/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildScheduleHistoryWorkspace(req.params.domain, {
        family: req.query.family,
        subtype: req.query.subtype,
        stage: req.query.stage,
        caseId: req.query.caseId,
        aggregateType: req.query.aggregateType,
        aggregateId: req.query.aggregateId,
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
  createReadSchedulesRouter,
};
