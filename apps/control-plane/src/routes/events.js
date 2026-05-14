"use strict";

const express = require("express");
const { listEvents, replayEvent } = require("../../../../packages/event-core/src");
const {
  CONTROL_PLANE_EVENT_TYPES,
  createControlPlaneEvent,
  processControlPlaneEventBatch,
  processNextControlPlaneEvent,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { safeSecretEquals } = require("../../../../packages/shared-utils/src");

function createEventsRouter(auth) {
  const router = express.Router();
  const internalSecret = String(process.env.INTERNAL_SERVICE_SECRET || process.env.OUTBOUND_GATEWAY_SECRET || "").trim();

  function hasInternalAccess(req) {
    const provided = String(
      req.headers["x-service-secret"] ||
      req.headers["x-internal-secret"] ||
      "",
    ).trim();
    return safeSecretEquals(provided, internalSecret);
  }

  router.get("/", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const events = await listEvents({
      status: req.query.status,
      sourceService: req.query.sourceService,
      eventType: req.query.eventType,
      limit: Number(req.query.limit) || 100,
    });

    return res.json({ ok: true, events });
  });

  router.post("/:id/replay", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const event = await replayEvent(req.params.id, req.user.email);
    if (!event) {
      return res.status(404).json({ ok: false, error: "Event not found" });
    }

    return res.json({ ok: true, event });
  });

  router.post("/intake", async (req, res) => {
    try {
      if (!hasInternalAccess(req)) {
        let authRejected = false;
        await new Promise((resolve) => {
          auth.requireAuth(req, res, (error) => {
            if (error || !req.user) {
              authRejected = true;
              return resolve();
            }
            return resolve();
          });
        });

        if (authRejected || !req.user) {
          return;
        }

        if (!["admin", "service"].includes(req.user?.role)) {
          return res.status(403).json({ ok: false, error: "Forbidden" });
        }
      }

      const result = await createControlPlaneEvent({
        eventType: req.body?.eventType,
        sourceService: req.body?.sourceService || req.user.email,
        aggregateType: req.body?.aggregateType,
        aggregateId: req.body?.aggregateId,
        dedupeKey: req.body?.dedupeKey,
        payload: req.body?.payload || {},
      });

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/process-next", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await processNextControlPlaneEvent({
        workerName: req.body?.workerName || "control-plane-worker",
        maxAttempts: req.body?.maxAttempts,
      });

      return res.json({
        ok: true,
        supportedEventTypes: Object.values(CONTROL_PLANE_EVENT_TYPES),
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/process-batch", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await processControlPlaneEventBatch({
        workerName: req.body?.workerName || "control-plane-worker",
        maxAttempts: req.body?.maxAttempts,
        maxCount: req.body?.maxCount,
      });

      return res.json({
        ok: true,
        supportedEventTypes: Object.values(CONTROL_PLANE_EVENT_TYPES),
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createEventsRouter,
};
