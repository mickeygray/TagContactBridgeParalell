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
    const input = source(req);
    try {
      const result = await command(input, { user: req.user, logger });
      // A mutating command that resolves null means "no active session matched" —
      // the entry function returns null instead of throwing. Without this line the
      // client sees HTTP 200 and the server records nothing (field lesson 2026-07-02:
      // a disposition click can vanish with zero evidence on either side).
      if (result === null && req.method === "POST") {
        logger.warn("[cx.bulk.http] null-result", {
          path: req.path,
          sessionId: input?.sessionId || null,
          disposition: input?.disposition || null,
          user: req.user?.email || null,
        });
      }
      return success(res, result);
    } catch (error) {
      // Guard rejections (auth context, runtime gate, session ownership) throw from
      // the entry function BEFORE any cx.alpha trace fires — unlogged, they are
      // indistinguishable from a request that never arrived.
      logger.warn("[cx.bulk.http] rejected", {
        path: req.path,
        status: error.status || 500,
        code: error.code || null,
        message: error.message || String(error),
        sessionId: input?.sessionId || null,
        disposition: input?.disposition || null,
        user: req.user?.email || null,
      });
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


  router.post("/get-leads", auth.requireAuth, auth.requireUser, async (req, res) => {
    return sendBulkCommand(req, res, startCxBulkLoadGetLeads, (request) => request.body || {});
  });

  // WO-3 tripwire: manual dial is retired — see attic/manual-dial-lane.attic.md
  router.post("/start-next", auth.requireAuth, auth.requireUser, (req, res) => {
    return res.status(410).json({ ok: false, code: "manual-dial-disabled", use: "/api/cx/bulk-load/get-leads" });
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
