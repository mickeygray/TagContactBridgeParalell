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
  const wrapCards = options.wrapCards || null; // null = CX_CALL_WRAP_QUEUE_ENABLED off

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

  // CALL WRAP CARDS (design: docs/CX_CALL_WRAP_QUEUE_DESIGN_2026-07-06.md). Cards exist
  // only when CX_CALL_WRAP_QUEUE_ENABLED=true; with the flag off both routes answer
  // wrap-queue-disabled so the client renders nothing (zero UI disturbance by default).
  router.get("/wrap-cards", auth.requireAuth, auth.requireUser, async (req, res) => {
    if (!wrapCards) return res.json({ ok: true, result: { enabled: false, cards: [] } });
    try {
      const email = String(req.user?.email || "").trim().toLowerCase();
      const cards = await wrapCards.listPending(email);
      return res.json({
        ok: true,
        result: {
          enabled: true,
          cards: cards.map((card) => ({
            idemKey: card.idemKey,
            name: card.name || null,
            caseId: card.caseId || null,
            queueItemId: card.queueItemId || null,
            uii: card.uii || null,
            calledAt: card.calledAt || null,
            expiresAt: card.expiresAt || null,
            systemDisposition: card.systemDisposition || null,
            coachSummary: typeof card.coachSummary === "string"
              ? card.coachSummary.slice(0, 600)
              : card.coachSummary || null,
          })),
        },
      });
    } catch (error) {
      logger.warn("[cx.bulk.http] rejected", { path: req.path, status: 500, message: error.message });
      return failure(res, error);
    }
  });

  router.post("/wrap-cards/resolve", auth.requireAuth, auth.requireUser, async (req, res) => {
    if (!wrapCards) return res.status(409).json({ ok: false, code: "wrap-queue-disabled" });
    try {
      const { idemKey, action, appointmentAt } = req.body || {};
      const requester = String(req.user?.email || "").trim().toLowerCase();
      const card = await wrapCards.getCard(idemKey);
      if (!card) return res.status(404).json({ ok: false, code: "wrap-card-not-found" });
      const isAdmin = String(req.user?.role || "").toLowerCase() === "admin";
      if (!isAdmin && String(card.agentEmail || "").toLowerCase() !== requester) {
        logger.warn("[cx.bulk.http] rejected", { path: req.path, status: 403, code: "wrap-card-forbidden", user: requester });
        return res.status(403).json({ ok: false, code: "wrap-card-forbidden" });
      }
      // ✕ from the client arrives as "dismiss" — the rules table speaks "dismissed".
      const normalized = String(action || "").trim().toLowerCase();
      const result = await wrapCards.resolve({
        idemKey,
        action: normalized === "dismiss" ? "dismissed" : normalized,
        appointmentAt: appointmentAt || null,
        user: req.user,
        resolvedBy: requester,
      });
      if (!result.ok) return res.status(400).json({ ok: false, code: result.reason || "wrap-resolve-failed" });
      return res.json({ ok: true, result: { resolution: result.resolution || null, noop: Boolean(result.noop) } });
    } catch (error) {
      logger.warn("[cx.bulk.http] rejected", { path: req.path, status: 500, message: error.message });
      return failure(res, error);
    }
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
