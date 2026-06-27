"use strict";

const express = require("express");
const {
  advanceCxSimpleLoopSession,
  getCxSimpleLoopSession,
  killCxSimpleLoopSession,
  skipCxSimpleLoopCurrent,
  startCxSimpleLoopSession,
  submitCxSimpleLoopDisposition,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function extractSimpleSessionId(req) {
  return String(req.body?.sessionId || req.query?.sessionId || "").trim();
}

function success(res, result) {
  return res.json({ ok: true, result });
}

function failure(res, error) {
  return res.status(error.status || 500).json(toErrorResponse(error));
}

function createCxSimpleLoopRouter(auth, options = {}) {
  const router = express.Router();
  const logger = options.logger || console;

  async function sendSimpleCommand(req, res, command) {
    try {
      const body = req.method === "GET" ? req.query || {} : req.body || {};
      const payload = { ...body };
      const sessionId = extractSimpleSessionId(req);
      if (sessionId) payload.sessionId = sessionId;
      const result = await command(payload, { user: req.user, logger });
      return success(res, result);
    } catch (error) {
      return failure(res, error);
    }
  }

  router.get("/session", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, getCxSimpleLoopSession),
  );
  router.post("/start", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, startCxSimpleLoopSession),
  );
  router.post("/advance", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, advanceCxSimpleLoopSession),
  );
  router.post("/disposition", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, submitCxSimpleLoopDisposition),
  );
  router.post("/skip", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, skipCxSimpleLoopCurrent),
  );
  router.post("/kill", auth.requireAuth, auth.requireUser, (req, res) =>
    sendSimpleCommand(req, res, killCxSimpleLoopSession),
  );

  return router;
}

module.exports = {
  createCxSimpleLoopRouter,
};
