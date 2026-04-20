"use strict";

const express = require("express");
const {
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

  router.get("/overview/:domain", auth.requireAuth, async (req, res) => {
    try {
      const result = await buildScheduleWorkspace(req.params.domain);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/cadence/:domain", auth.requireAuth, async (req, res) => {
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

  return router;
}

module.exports = {
  createReadSchedulesRouter,
};
