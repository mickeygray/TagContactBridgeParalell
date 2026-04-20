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

function createEventsRouter(auth) {
  const router = express.Router();

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

  router.post("/intake", auth.requireAuth, async (req, res) => {
    try {
      if (!["admin", "service"].includes(req.user?.role)) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
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
