"use strict";

const express = require("express");
const {
  getCxBulkLoadSession,
  killCxBulkLoadSession,
  pauseCxBulkLoadProgressiveDialing,
  resumeCxBulkLoadProgressiveDialing,
  skipCxBulkLoadCurrent,
  startCxBulkLoadGetLeads,
  startCxBulkLoadSession,
  startCxBulkLoadNextManualCall,
  submitCxBulkLoadDisposition,
  submitCxBulkLoadReviewOutcome,
  submitCxBulkLoadAppointmentWrap,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

// Bulk_load rail HTTP surface. Each handler does only: auth -> entry function
// (which applies the runtime gate) -> sanitized snapshot. The route layer never
// decides call state. Default-off: the runtime gate 403s every request unless the
// agent resolves to bulk_load.

function createCxBulkLoadRouter(auth, options = {}) {
  const router = express.Router();
  const logger = options.logger || console;

  function success(res, result) {
    return res.json({ ok: true, result });
  }

  function failure(res, error) {
    return res.status(error.status || 500).json(toErrorResponse(error));
  }

  async function sendBulkCommand(req, res, command, source) {
    try {
      const result = await command(source(req), { user: req.user, logger });
      return success(res, result);
    } catch (error) {
      return failure(res, error);
    }
  }

  router.get("/session", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, getCxBulkLoadSession, (request) => request.query || {});
  });

  router.post("/start", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, startCxBulkLoadSession, (request) => request.body || {});
  });

  router.post("/disposition", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, submitCxBulkLoadDisposition, (request) => request.body || {});
  });

  router.post(
    "/appointment-wrap",
    auth.requireAuth,
    auth.requireUser,
    auth.requirePermission("queue.dispose"),
    async (req, res) => {
      return sendBulkCommand(req, res, submitCxBulkLoadAppointmentWrap, (request) => request.body || {});
    },
  );

  router.post("/review-outcome", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, submitCxBulkLoadReviewOutcome, (request) => request.body || {});
  });

  router.post("/start-next", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, startCxBulkLoadNextManualCall, (request) => request.body || {});
  });

  router.post("/get-leads", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, startCxBulkLoadGetLeads, (request) => request.body || {});
  });

  router.post("/pause-progressive", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, pauseCxBulkLoadProgressiveDialing, (request) => request.body || {});
  });

  router.post("/resume-progressive", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, resumeCxBulkLoadProgressiveDialing, (request) => request.body || {});
  });

  router.post("/skip", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, skipCxBulkLoadCurrent, (request) => request.body || {});
  });

  router.post("/kill", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, killCxBulkLoadSession, (request) => request.body || {});
  });

  return router;
}

module.exports = {
  createCxBulkLoadRouter,
};
