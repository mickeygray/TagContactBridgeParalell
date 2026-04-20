"use strict";

const express = require("express");
const {
  buildControlPlaneSummary,
  getControlPlaneDomain,
  listControlPlaneDomains,
} = require("../../../../packages/shared-services/src");

function createDomainsRouter(auth) {
  const router = express.Router();

  router.get("/", auth.requireAuth, auth.requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      domains: listControlPlaneDomains(),
    });
  });

  router.get("/summary", auth.requireAuth, auth.requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      summary: buildControlPlaneSummary(),
    });
  });

  router.get("/:domainKey", auth.requireAuth, auth.requireAdmin, (req, res) => {
    const domain = getControlPlaneDomain(req.params.domainKey);
    if (!domain) {
      return res.status(404).json({ ok: false, error: "Domain not found" });
    }

    return res.json({
      ok: true,
      domain,
    });
  });

  return router;
}

module.exports = {
  createDomainsRouter,
};
