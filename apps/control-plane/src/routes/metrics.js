"use strict";

const express = require("express");
const {
  backfillCallLogSourceFromLeadCadence,
  backfillLegacyMetricsRange,
  buildSpendSyncRead,
  buildVendorCallRows,
  computeCxRecordingHourlyWindow,
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
  runCxRecordingHourly,
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

  // On-demand source-name backfill — stamps CallLog rows that have a
  // caseId but no sourceName with the case's LeadCadence attribution.
  // Same routine the nightly close pass runs automatically; this is the
  // operator escape hatch (e.g. "I just placed CX calls to LD leads and
  // want them visible in the live metrics workspace now").
  router.post(
    "/vendor-nightly/source-backfill/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await backfillCallLogSourceFromLeadCadence({
          domain: req.params.domain,
          date: req.body?.date || req.query.date,
          timezone: req.body?.timezone || req.query.timezone,
          limit: req.body?.limit,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // CX recording hourly poller — on-demand. With no body, fires for
  // "now" (computes the previous :45-to-:45 window automatically).
  // With { windowStart, windowEnd } in the body, runs that explicit
  // window — used for historical backfill of a single hour slot.
  // Optional { domains: ["TAG"] } scopes which tenants to process.
  //
  // The hourly sweep already runs this automatically; this route is
  // the operator handle for "re-run the 14:00 window because the
  // first attempt 400'd" kind of situations.
  router.post(
    "/cx-recording/run",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await runCxRecordingHourly({
          fireTime: req.body?.fireTime ? new Date(req.body.fireTime) : new Date(),
          scheduleMinute: req.body?.scheduleMinute ?? req.query.scheduleMinute,
          windowStart: req.body?.windowStart ? new Date(req.body.windowStart) : null,
          windowEnd: req.body?.windowEnd ? new Date(req.body.windowEnd) : null,
          domains: Array.isArray(req.body?.domains) ? req.body.domains : undefined,
          maxRowsPerDomain: req.body?.maxRowsPerDomain,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // Read-only preview of the window the next CX-recording tick would
  // pull. Useful for "is the cron lining up the way I expect?"
  router.get(
    "/cx-recording/preview-window",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const fireTime = req.query.fireTime
          ? new Date(req.query.fireTime)
          : new Date();
        const window = computeCxRecordingHourlyWindow(fireTime, {
          scheduleMinute: req.query.scheduleMinute,
        });
        return res.json({
          ok: true,
          result: {
            fireTime: window.fireTime.toISOString(),
            hourBoundary: window.hourBoundary.toISOString(),
            windowStart: window.windowStart.toISOString(),
            windowEnd: window.windowEnd.toISOString(),
            windowDurationMinutes:
              (window.windowEnd - window.windowStart) / 60_000,
            youngestCallAgeMinutesAtFire:
              (window.fireTime - window.windowEnd) / 60_000,
          },
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

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
