"use strict";

const express = require("express");
const {
  confirmCxSlowSingleCurrent,
  getCxSlowSingleSession,
  killCxSlowSingleSession,
  startCxSlowSingleCall,
  submitCxSlowSingleOutcome,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createCxSlowSingleRouter(auth, options = {}) {
  const router = express.Router();
  const logger = options.logger || console;

  function success(res, result) {
    return res.json({ ok: true, result });
  }

  function failure(res, error) {
    return res.status(error.status || 500).json(toErrorResponse(error));
  }

  async function sendSlowCommand(req, res, command, source) {
    try {
      const result = await command(source(req), { user: req.user, logger });
      return success(res, result);
    } catch (error) {
      return failure(res, error);
    }
  }

  router.get("/session", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendSlowCommand(req, res, getCxSlowSingleSession, (request) => request.query || {});
  });

  router.post("/start", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendSlowCommand(req, res, startCxSlowSingleCall, (request) => request.body || {});
  });

  router.post("/watch", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendSlowCommand(req, res, confirmCxSlowSingleCurrent, (request) => request.body || {});
  });

  router.post("/outcome", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendSlowCommand(req, res, submitCxSlowSingleOutcome, (request) => request.body || {});
  });

  router.post("/kill", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendSlowCommand(req, res, killCxSlowSingleSession, (request) => request.body || {});
  });

  return router;
}

module.exports = {
  createCxSlowSingleRouter,
};
