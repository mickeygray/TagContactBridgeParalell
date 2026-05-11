"use strict";

const express = require("express");
const {
  buildCampaignAudience,
  buildDispatchList,
  getDispatchList,
  listDispatchLists,
  queueDispatchList,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createDispatchRouter(auth) {
  const router = express.Router();

  router.get(
    "/audience/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await buildCampaignAudience(req.params.domain, {
          channel: req.query.channel,
          audienceSource: req.query.audienceSource,
          statusId: req.query.statusId,
          search: req.query.search,
          maxSize: req.query.maxSize,
          // Optional date-range scoping on LeadCadence.createdAt.
          // Strings (YYYY-MM-DD or full ISO) or empty/missing — the
          // service layer coerces and validates. Both bounds independent.
          createdAtAfter: req.query.createdAtAfter,
          createdAtBefore: req.query.createdAtBefore,
          includeRecentlyContacted: req.query.includeRecentlyContacted,
          timezone: req.query.timezone,
        });
        if (String(req.query.channel || "").trim().toLowerCase() === "callfire") {
          console.info(JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "info",
            scope: "control-plane",
            message: "dispatch.callfire.audience_counts",
            meta: {
              domain: req.params.domain,
              audienceSource: req.query.audienceSource || null,
              statusId: result.statusId ?? null,
              diagnostics: result.diagnostics || null,
            },
          }));
        }
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/item/:id", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const list = await getDispatchList(req.params.id);
      if (!list) {
        return res.status(404).json({ ok: false, error: "Dispatch list not found" });
      }
      return res.json({ ok: true, list });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const lists = await listDispatchLists(req.params.domain, {
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
      const list = await buildDispatchList({
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
      const result = await queueDispatchList({
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
  createDispatchRouter,
};
