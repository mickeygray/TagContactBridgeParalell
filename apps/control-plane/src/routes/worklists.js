"use strict";

const express = require("express");
const {
  buildWorkList,
  getWorkList,
  listWorkLists,
  queueWorkList,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createWorklistsRouter(auth) {
  const router = express.Router();

  router.get("/item/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const list = await getWorkList(req.params.id);
      if (!list) {
        return res.status(404).json({ ok: false, error: "Work list not found" });
      }
      return res.json({ ok: true, list });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const lists = await listWorkLists(req.params.domain, {
        family: req.query.family,
        subtype: req.query.subtype,
        channel: req.query.channel,
        mode: req.query.mode,
        status: req.query.status,
        limit: req.query.limit,
      });
      return res.json({ ok: true, lists });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/build", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const list = await buildWorkList({
        ...req.body,
        sourceService: req.user.email || "control-plane",
      });
      return res.json({ ok: true, list });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/queue", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await queueWorkList({
        ...req.body,
        sourceService: req.user.email || "control-plane",
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createWorklistsRouter,
};
