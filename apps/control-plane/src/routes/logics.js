"use strict";

const express = require("express");
const {
  buildCapabilitySummary,
  buildDailyStatusScanWorkflow,
  buildDomainStatusScanPlan,
  buildLogicsScanSummary,
  buildRecommendedWorkflow,
  buildProspectStatusDiff,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");
const { createLogicsClient } = require("../../../../packages/shared-integrations/src");

function createLogicsRouter(auth) {
  const router = express.Router();

  router.get("/status-scan", auth.requireAuth, auth.requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      summary: buildLogicsScanSummary(),
    });
  });

  router.get("/capabilities", auth.requireAuth, auth.requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      capabilities: buildCapabilitySummary(),
    });
  });

  router.get("/capabilities/:domain", auth.requireAuth, auth.requireAdmin, (req, res) => {
    const capability = buildRecommendedWorkflow(req.params.domain);
    if (!capability) {
      return res.status(404).json({ ok: false, error: "Unknown domain" });
    }

    return res.json({
      ok: true,
      capability,
    });
  });

  router.get("/status-scan/workflow", auth.requireAuth, auth.requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      workflow: buildDailyStatusScanWorkflow(),
    });
  });

  router.get("/status-scan/:domain", auth.requireAuth, auth.requireAdmin, (req, res) => {
    const plan = buildDomainStatusScanPlan(req.params.domain);
    if (!plan) {
      return res.status(404).json({ ok: false, error: "Unknown domain" });
    }

    return res.json({
      ok: true,
      plan,
    });
  });

  router.get("/status-scan/:domain/diff", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const diff = await buildProspectStatusDiff(req.params.domain, {
        orderByCreatedDate: req.query.orderByCreatedDate === "true",
      });
      if (!diff) {
        return res.status(404).json({ ok: false, error: "Unknown domain" });
      }

      return res.json({
        ok: true,
        diff,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/probe/:domain/:caseId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const domain = String(req.params.domain || "").toUpperCase();
      const caseId = Number(req.params.caseId);
      if (!Number.isFinite(caseId)) {
        return res.status(400).json({ ok: false, error: "Invalid caseId" });
      }

      const client = createLogicsClient(domain);
      const checks = [
        ["caseInfo", () => client.getCaseInfo(caseId)],
        ["billingSummary", () => client.getCaseBillingSummary(caseId)],
        ["activities", () => client.getActivities(caseId)],
        ["payments", () => client.getCasePayments(caseId)],
        ["invoices", () => client.getCaseInvoices(caseId)],
      ];

      const results = {};
      for (const [name, fn] of checks) {
        try {
          const payload = await fn();
          const data =
            payload?.data !== undefined && payload?.data !== null
              ? payload.data
              : payload?.Data !== undefined && payload?.Data !== null
                ? payload.Data
                : payload;
          results[name] = {
            ok: true,
            kind: Array.isArray(data) ? "array" : typeof data,
            count: Array.isArray(data) ? data.length : null,
            sample: Array.isArray(data) ? data[0] || null : data,
          };
        } catch (error) {
          results[name] = {
            ok: false,
            error: error.message,
            details: error.details || null,
          };
        }
      }

      return res.json({
        ok: true,
        domain,
        caseId,
        results,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createLogicsRouter,
};
