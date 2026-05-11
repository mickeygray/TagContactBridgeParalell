"use strict";

const express = require("express");
const {
  backfillLegacyMetricsRange,
  buildSpendSyncRead,
  buildVendorCallRows,
  ignoreMetricsAttributionReviewItem,
  buildVendorDailySummary,
  buildVendorLeadRows,
  buildVendorOutcomeRows,
  canonicalizeMirroredMetrics,
  getActiveMailers,
  getLegacyMetricsMirrorStatus,
  getMailerConfigState,
  reopenMetricsAttributionReviewItem,
  resolveMetricsAttributionReviewItem,
  runVendorNightlyEmail,
  syncLegacyAttributionMaps,
  syncLegacyMetricsMirror,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createMetricsRouter(auth, spendSyncRuntime) {
  const router = express.Router();

  router.get("/spend-sync/status", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    return res.json({
      ok: true,
      result: spendSyncRuntime ? spendSyncRuntime.getState() : null,
    });
  });

  router.post("/spend-sync/run", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      if (!spendSyncRuntime) {
        throw new Error("Spend sync runtime is not configured");
      }
      const result = await spendSyncRuntime.syncAll({
        domain: req.body?.domain,
        sheetId: req.body?.sheetId,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/spend-sync/read/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildSpendSyncRead(req.params.domain, {
        date: req.query.date,
      });
      return res.json({
        ok: true,
        result,
        runtime: spendSyncRuntime ? spendSyncRuntime.getState() : null,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/vendor-summary/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildVendorDailySummary(req.params.domain, {
        date: req.query.date,
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/vendor-nightly/preview/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await runVendorNightlyEmail(req.params.domain, {
        date: req.query.date,
        timezone: req.query.timezone,
        performClosePass: String(req.query.performClosePass || "false").toLowerCase() === "true",
        sendEmail: false,
      });
      return res.json({
        ok: true,
        result: {
          domain: result.domain,
          date: result.date,
          summary: result.summary,
          closePass: result.closePass,
          emailResult: result.emailResult,
          body: result.body,
          attachments: result.attachmentMeta,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/vendor-nightly/run/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await runVendorNightlyEmail(req.params.domain, {
        date: req.body?.date,
        timezone: req.body?.timezone,
        performClosePass: req.body?.performClosePass !== false,
        sendEmail: req.body?.sendEmail !== false,
        recipients: req.body?.recipients,
        callSinceMs: req.body?.callSinceMs,
        callLimitPerDomain: req.body?.callLimitPerDomain,
        minDurationSec: req.body?.minDurationSec,
        maxCaseRefreshesPerDomain: req.body?.maxCaseRefreshesPerDomain,
        maxScoringPerDomain: req.body?.maxScoringPerDomain,
        maxPaymentCases: req.body?.maxPaymentCases,
        callRowLimit: req.body?.callRowLimit,
        leadRowLimit: req.body?.leadRowLimit,
        outcomeRowLimit: req.body?.outcomeRowLimit,
      });
      return res.json({
        ok: true,
        result: {
          domain: result.domain,
          date: result.date,
          summary: result.summary,
          closePass: result.closePass,
          emailResult: result.emailResult,
          body: result.body,
          attachments: result.attachmentMeta,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/vendor-nightly/calls/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const date = String(req.query.date || "").trim();
      const result = await buildVendorCallRows(req.params.domain, date);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/vendor-nightly/leads/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const date = String(req.query.date || "").trim();
      const result = await buildVendorLeadRows(req.params.domain, date);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/vendor-nightly/outcomes/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const date = String(req.query.date || "").trim();
      const result = await buildVendorOutcomeRows(req.params.domain, date, {
        timezone: req.query.timezone,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/mailer-config/status", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    return res.json({
      ok: true,
      result: getMailerConfigState(),
    });
  });

  router.get("/legacy-mirror/status/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await getLegacyMetricsMirrorStatus(req.params.domain);
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/legacy-mirror/sync/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await syncLegacyMetricsMirror(req.params.domain || req.body?.domain);
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/legacy-attribution/sync/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const domain = req.params.domain || req.body?.domain;
      const maps = await syncLegacyAttributionMaps();
      const canonicalized = await canonicalizeMirroredMetrics(domain);
      return res.json({
        ok: true,
        result: {
          maps,
          canonicalized,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/backfill/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await backfillLegacyMetricsRange({
        domain: req.params.domain || req.body?.domain,
        from: req.body?.from,
        to: req.body?.to,
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/mailer-config/active", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    return res.json({
      ok: true,
      result: getActiveMailers(),
    });
  });

  router.post("/attribution-review/:id/resolve", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await resolveMetricsAttributionReviewItem(req.params.id, req.body || {}, {
        email: req.user?.email || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/attribution-review/:id/ignore", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await ignoreMetricsAttributionReviewItem(req.params.id, req.body || {}, {
        email: req.user?.email || null,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/attribution-review/:id/reopen", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await reopenMetricsAttributionReviewItem(req.params.id);
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createMetricsRouter,
};
