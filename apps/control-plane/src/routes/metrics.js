"use strict";

const express = require("express");
const multer = require("multer");
const {
  backfillCallLogSourceFromLeadCadence,
  importLogicsPaymentsCsv,
  buildSpendSyncRead,
  computeCxRecordingHourlyWindow,
  ignoreMetricsAttributionReviewItem,
  getActiveMailers,
  getMailerConfigState,
  reopenMetricsAttributionReviewItem,
  resolveMetricsAttributionReviewItem,
  resolveMetricsPaymentReviewItem,
  runCxRecordingHourly,
} = require("../../../../packages/shared-services/src");
const {
  describePaymentsCsv,
  hashBuffer,
  readPaymentsSheetStatus,
  recordPaymentsSheetImport,
  verifyPaymentsCsvDomain,
} = require("../../../../packages/shared-services/src/paymentsSheetGateService");
const {
  reconcileSheetCases,
} = require("../../../../packages/shared-services/src/paymentsSheetReconcileService");
const {
  triggerActivitiesAsync,
} = require("../../../../packages/shared-services/src/dailyLoopService");
const {
  currentPacificDateKey,
} = require("../../../../packages/shared-services/src/simpleMarketingReadService");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createMetricsRouter(auth, spendSyncRuntime) {
  const router = express.Router();

  // Logics PaymentsReport CSV — kept in memory, parsed, discarded. 8 MB is
  // generous for a month of settlement-officer rows.
  const paymentsCsvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
  });

  // Daily payments truth-up: Mickey exports the Logics PaymentsReport and
  // drops it here. CSV rows correct/insert PaymentLedger rows (see
  // logicsPaymentsCsvImportService). ?dryRun=true previews without writes.
  router.post(
    "/payments-csv/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    paymentsCsvUpload.single("file"),
    async (req, res) => {
      try {
        if (String(process.env.LOGICS_PAYMENTS_CSV_IMPORT_ENABLED || "false").toLowerCase() !== "true") {
          return res.status(404).json({ ok: false, error: "Payments CSV import is disabled" });
        }
        if (!req.file?.buffer) {
          return res.status(400).json({ ok: false, error: "CSV file is required (field name: file)" });
        }
        const dryRun = String(req.query.dryRun || "") === "true";
        const domain = String(req.params.domain || "").trim().toUpperCase();
        const shape = describePaymentsCsv(req.file.buffer);

        // The export does not name its own company, so the picker is the
        // only thing asserting which it is. A mis-pick would write a whole
        // company's payments under the wrong domain, so fingerprint the
        // case ids against the ledger before touching anything.
        const fingerprint = await verifyPaymentsCsvDomain({
          domain,
          caseIds: shape.caseIds,
        });
        if (!fingerprint.ok) {
          return res.status(409).json({
            ok: false,
            error:
              `This export looks like ${fingerprint.detected}, not ${domain} `
              + `(${fingerprint.matched} of ${fingerprint.total} case ids match ${fingerprint.detected}). `
              + "Pick the matching company, or re-export.",
            fingerprint,
          });
        }

        const result = await importLogicsPaymentsCsv({
          domain,
          buffer: req.file.buffer,
          dryRun,
        });

        // Reconcile pass — the same sheet corrects case/client profiles:
        // creates the legacy paying clients that never came through the
        // lead flow, fills missing names/sources (never overwrites a real
        // profile source), and recomputes payment rollups from the ledger.
        let reconcile = null;
        try {
          reconcile = await reconcileSheetCases({
            domain,
            rows: shape.rows,
            dryRun,
          });
        } catch (error) {
          // Money import already landed; a reconcile failure is reported,
          // not allowed to fail the upload.
          reconcile = { error: String(error.message).slice(0, 200) };
        }

        // Receipt: the nightly money pass refuses to publish until the day's
        // authority has landed for every required company.
        const dateKey = String(req.query.dateKey || "").trim()
          || shape.coversThrough
          || currentPacificDateKey();
        const receipt = await recordPaymentsSheetImport({
          domain,
          dateKey,
          summary: result,
          coversFrom: shape.coversFrom,
          coversThrough: shape.coversThrough,
          fileName: req.file.originalname || null,
          fileHash: hashBuffer(req.file.buffer),
          importedBy: req.user?.email || req.user?.username || null,
          dryRun,
        });

        const gate = dryRun ? null : await readPaymentsSheetStatus({ dateKey });

        // SHEET-TRIGGERED LOOP (F1.1): the moment every required company's
        // sheet is in, pull the day's Logics activities. Fire-and-forget —
        // the upload response must never wait on it, and a failure there
        // must never fail the import. A per-day claim in DailyLoopRun makes
        // this exactly-once across re-uploads AND process restarts; the
        // 20:00 scheduled review claims the same guard as a fallback.
        let activitiesTriggered = { scheduled: false, reason: "dry-run" };
        if (!dryRun && gate?.ready) {
          activitiesTriggered = triggerActivitiesAsync({
            dateKey,
            triggeredBy: domain,
            logger: req.log || null,
          });
        } else if (!dryRun) {
          activitiesTriggered = {
            scheduled: false,
            reason: "gate-not-ready",
            missing: gate?.missing || [],
          };
        }

        return res.json({
          ok: true,
          result,
          coverage: {
            from: shape.coversFrom,
            through: shape.coversThrough,
            dateKey,
            rows: shape.rowCount,
          },
          fingerprint,
          reconcile,
          gate,
          activitiesTriggered,
          recorded: receipt.recorded === true,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

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

  // Vendor routes RETIRED 2026-07-27 with the vendor/lead-data email:
  // /vendor-summary, /vendor-nightly/{preview,run,calls,leads,outcomes}.
  // The web client never called them; reported money is the payment sheet.


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

  // Legacy-mirror / legacy-backfill admin routes removed 2026-07-27: the
  // migration they served is over (FRONTEND_LEGACY_METRICS_FALLBACK_ENABLED
  // and METRICS_DEDUP_LEGACY_READS_ENABLED are off, web-client never called
  // them), and the simple board reads only marker-stamped rows the legacy
  // backfill could never produce.

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

  router.post(
    "/attribution-review/:id/resolve-payment",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await resolveMetricsPaymentReviewItem(req.params.id, req.body || {}, {
          email: req.user?.email || null,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

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
