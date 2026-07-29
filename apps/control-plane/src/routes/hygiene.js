"use strict";

const express = require("express");
const {
  buildDataHygieneOverview,
  buildDailyDeepCutDashboard,
  buildDailyDeepCutPlan,
  getDailyDeepCutRun,
  buildHourlyHygienePlan,
  listDailyDeepCutRuns,
  listHourlyReviewFeed,
  processCallLogRecording,
  pushHourlyReviewItem,
  runHourlyCallLogHygiene,
  reconcileUnattributedSessions,
  recordDailyDeepCutRun,
  reviewCaseActivities,
  runHourlyLeadCadenceEnforcement,
  runHourlySweep,
  runDataHygieneSmoke,
  runProspectSweep,
  runGroupedNightlyClose,
  seedRingcentralExtensionsFromCsv,
  startDailyDeepCutRun,
  startDailyDeepCutVerification,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createHygieneRouter(auth, options = {}) {
  const router = express.Router();
  const hourlySweepConfig = options.hourlySweepConfig || {};
  const spendSyncRuntime = options.spendSyncRuntime || null;
  const logger = options.logger || null;

  function parseRecipientList(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean);
    }

    return String(value || "")
      .split(",")
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean);
  }

  function parseBooleanFlag(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
  }

  router.get("/overview", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const result = await buildDataHygieneOverview();
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/hourly-plan", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const result = await buildHourlyHygienePlan();
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/daily-plan", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
    try {
      const result = await buildDailyDeepCutPlan();
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/daily-dashboard/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await buildDailyDeepCutDashboard(req.params.domain);
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/daily-runs/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listDailyDeepCutRuns(req.params.domain, {
        status: req.query.status,
        limit: req.query.limit,
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/daily-run/:runId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await getDailyDeepCutRun(req.params.runId);
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/daily-runs", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await recordDailyDeepCutRun(req.body || {});
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/daily-runs/start", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await startDailyDeepCutRun(req.body.domain, {
        notes: req.body.notes || [],
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/daily-runs/verify", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await startDailyDeepCutVerification(req.body.domain, {
        parentRunId: req.body.parentRunId || null,
        notes: req.body.notes || [],
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.get("/smoke/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await runDataHygieneSmoke(req.params.domain, {
        caseId: req.query.caseId,
        phone: req.query.phone,
        extensionId: req.query.extensionId,
        trackingNumber: req.query.trackingNumber,
        sourceName: req.query.sourceName,
        sourceId: req.query.sourceId,
      });

      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/activity-ai-review/:domain/:caseId",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await reviewCaseActivities(req.params.domain, req.params.caseId);
        return res.json({
          ok: true,
          result,
        });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Manually trigger the Whisper + Claude transcription/scoring
   * pipeline for one CallLog row. Useful for on-demand QC runs before
   * the sweeper consumer is wired. The service itself is idempotent;
   * re-running replaces prior transcription/score on the same row.
   */
  router.post(
    "/transcribe-call/:domain/:telephonySessionId",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await processCallLogRecording({
          domain: req.params.domain,
          telephonySessionId: req.params.telephonySessionId,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.get("/review-feed/:domain", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await listHourlyReviewFeed(req.params.domain, {
        status: req.query.status,
        workflow: req.query.workflow,
        category: req.query.category,
        caseId: req.query.caseId,
        limit: req.query.limit,
      });
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/review-feed", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const result = await pushHourlyReviewItem(req.body || {});
      return res.json({
        ok: true,
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post(
    "/hourly-sweep/run",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const scheduledPhase =
          req.body?.scheduledPhase !== undefined
            ? Boolean(req.body.scheduledPhase)
            : req.query.scheduledPhase !== "false";
        const lane =
          String(req.body?.lane || req.query.lane || "hourly").toLowerCase() === "nightly"
            ? "nightly"
            : "hourly";
        const result = await runHourlySweep({
          workerName: "control-plane-hourly-manual",
          lane,
          scheduledPhase,
          metricsRefreshEnabled:
            req.body?.metricsRefreshEnabled !== undefined
              ? Boolean(req.body.metricsRefreshEnabled)
              : hourlySweepConfig.metricsRefreshEnabled !== false,
          metricsRefreshPreferLegacyContactActivities:
            req.body?.metricsRefreshPreferLegacyContactActivities !== undefined
              ? Boolean(req.body.metricsRefreshPreferLegacyContactActivities)
              : parseBooleanFlag(
                  req.query.metricsRefreshPreferLegacyContactActivities,
                  hourlySweepConfig.metricsRefreshPreferLegacyContactActivities === true,
                ),
          maxCasesPerDomain:
            req.body?.maxCasesPerDomain ??
            req.query.maxCasesPerDomain ??
            hourlySweepConfig.paymentReconcileMaxCasesPerDomain,
          leadCadenceEnforcementEnabled:
            req.body?.leadCadenceEnforcementEnabled !== undefined
              ? Boolean(req.body.leadCadenceEnforcementEnabled)
              : Boolean(hourlySweepConfig.leadCadenceEnforcementEnabled),
          leadCadenceEnforcementLimitPerDomain:
            req.body?.leadCadenceEnforcementLimitPerDomain ??
            req.query.leadCadenceEnforcementLimitPerDomain ??
            hourlySweepConfig.leadCadenceEnforcementLimitPerDomain,
          leadCadenceEnforcementMinStaleMs:
            req.body?.leadCadenceEnforcementMinStaleMs ??
            req.query.leadCadenceEnforcementMinStaleMs ??
            hourlySweepConfig.leadCadenceEnforcementMinStaleMs,
          leadCadenceEnforcementDryRun:
            req.body?.leadCadenceEnforcementDryRun !== undefined
              ? Boolean(req.body.leadCadenceEnforcementDryRun)
              : req.query.leadCadenceEnforcementDryRun === "true"
                ? true
                : Boolean(hourlySweepConfig.leadCadenceEnforcementDryRun),
          callLogHygieneEnabled:
            req.body?.callLogHygieneEnabled !== undefined
              ? Boolean(req.body.callLogHygieneEnabled)
              : Boolean(hourlySweepConfig.callLogHygieneEnabled),
          callLogHygieneSinceMs:
            req.body?.callLogHygieneSinceMs ??
            req.query.callLogHygieneSinceMs ??
            hourlySweepConfig.callLogHygieneSinceMs,
          callLogHygieneLimitPerDomain:
            req.body?.callLogHygieneLimitPerDomain ??
            req.query.callLogHygieneLimitPerDomain ??
            hourlySweepConfig.callLogHygieneLimitPerDomain,
          callLogHygieneMirrorLegacyContactActivities:
            req.body?.callLogHygieneMirrorLegacyContactActivities !== undefined
              ? Boolean(req.body.callLogHygieneMirrorLegacyContactActivities)
              : parseBooleanFlag(
                  req.query.callLogHygieneMirrorLegacyContactActivities,
                  hourlySweepConfig.callLogHygieneMirrorLegacyContactActivities === true,
                ),
          callLogHygieneNativeSweepEnabled:
            req.body?.callLogHygieneNativeSweepEnabled !== undefined
              ? Boolean(req.body.callLogHygieneNativeSweepEnabled)
              : req.query.callLogHygieneNativeSweepEnabled === "false"
                ? false
                : hourlySweepConfig.callLogHygieneNativeSweepEnabled !== false,
          callLogHygieneNativeSweepLimit:
            req.body?.callLogHygieneNativeSweepLimit ??
            req.query.callLogHygieneNativeSweepLimit ??
            hourlySweepConfig.callLogHygieneNativeSweepLimit,
          callLogHygieneNativeSweepMaxPages:
            req.body?.callLogHygieneNativeSweepMaxPages ??
            req.query.callLogHygieneNativeSweepMaxPages ??
            hourlySweepConfig.callLogHygieneNativeSweepMaxPages,
          callLogHygieneNativeSweepDefaultDomain:
            req.body?.callLogHygieneNativeSweepDefaultDomain ??
            req.query.callLogHygieneNativeSweepDefaultDomain ??
            hourlySweepConfig.callLogHygieneNativeSweepDefaultDomain,
          callLogHygieneMinDurationSec:
            req.body?.callLogHygieneMinDurationSec ??
            req.query.callLogHygieneMinDurationSec ??
            hourlySweepConfig.callLogHygieneMinDurationSec,
          callLogHygieneMaxCaseRefreshesPerDomain:
            req.body?.callLogHygieneMaxCaseRefreshesPerDomain ??
            req.query.callLogHygieneMaxCaseRefreshesPerDomain ??
            hourlySweepConfig.callLogHygieneMaxCaseRefreshesPerDomain,
          callLogHygieneMaxScoringPerDomain:
            req.body?.callLogHygieneMaxScoringPerDomain ??
            req.query.callLogHygieneMaxScoringPerDomain ??
            hourlySweepConfig.callLogHygieneMaxScoringPerDomain,
          callLogHygieneMaxArchivePerDomain:
            req.body?.callLogHygieneMaxArchivePerDomain ??
            req.query.callLogHygieneMaxArchivePerDomain ??
            hourlySweepConfig.callLogHygieneMaxArchivePerDomain,
          callLogHygieneScorePendingCalls:
            req.body?.callLogHygieneScorePendingCalls !== undefined
              ? Boolean(req.body.callLogHygieneScorePendingCalls)
              : req.query.callLogHygieneScorePendingCalls === "false"
                ? false
                : hourlySweepConfig.callLogHygieneScorePendingCalls !== false,
          callLogHygieneArchiveRecordings:
            req.body?.callLogHygieneArchiveRecordings !== undefined
              ? Boolean(req.body.callLogHygieneArchiveRecordings)
              : req.query.callLogHygieneArchiveRecordings === "false"
                ? false
                : hourlySweepConfig.callLogHygieneArchiveRecordings !== false,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  // POST /hourly-metrics-refresh RETIRED 2026-07-27 with the legacy
  // metrics recompute (web client never called it).

  router.post(
    "/hourly-call-log/run",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const lane =
          String(req.body?.lane || req.query.lane || "hourly").toLowerCase() === "nightly"
            ? "nightly"
            : "hourly";
        const result = await runHourlyCallLogHygiene({
          domain: req.body?.domain ?? req.query.domain,
          domains: req.body?.domains,
          lane,
          sinceMs:
            req.body?.sinceMs ??
            req.query.sinceMs ??
            hourlySweepConfig.callLogHygieneSinceMs,
          limitPerDomain:
            req.body?.limitPerDomain ??
            req.query.limitPerDomain ??
            hourlySweepConfig.callLogHygieneLimitPerDomain,
          mirrorLegacyContactActivities:
            req.body?.mirrorLegacyContactActivities !== undefined
              ? Boolean(req.body.mirrorLegacyContactActivities)
              : parseBooleanFlag(
                  req.query.mirrorLegacyContactActivities,
                  hourlySweepConfig.callLogHygieneMirrorLegacyContactActivities === true,
                ),
          nativeSweepEnabled:
            req.body?.nativeSweepEnabled !== undefined
              ? Boolean(req.body.nativeSweepEnabled)
              : req.query.nativeSweepEnabled === "false"
                ? false
                : hourlySweepConfig.callLogHygieneNativeSweepEnabled !== false,
          nativeSweepLimit:
            req.body?.nativeSweepLimit ??
            req.query.nativeSweepLimit ??
            hourlySweepConfig.callLogHygieneNativeSweepLimit,
          nativeSweepMaxPages:
            req.body?.nativeSweepMaxPages ??
            req.query.nativeSweepMaxPages ??
            hourlySweepConfig.callLogHygieneNativeSweepMaxPages,
          nativeSweepDefaultDomain:
            req.body?.nativeSweepDefaultDomain ??
            req.query.nativeSweepDefaultDomain ??
            hourlySweepConfig.callLogHygieneNativeSweepDefaultDomain,
          minDurationSec:
            req.body?.minDurationSec ??
            req.query.minDurationSec ??
            hourlySweepConfig.callLogHygieneMinDurationSec,
          maxCaseRefreshesPerDomain:
            req.body?.maxCaseRefreshesPerDomain ??
            req.query.maxCaseRefreshesPerDomain ??
            hourlySweepConfig.callLogHygieneMaxCaseRefreshesPerDomain,
          maxScoringPerDomain:
            req.body?.maxScoringPerDomain ??
            req.query.maxScoringPerDomain ??
            hourlySweepConfig.callLogHygieneMaxScoringPerDomain,
          maxArchivePerDomain:
            req.body?.maxArchivePerDomain ??
            req.query.maxArchivePerDomain ??
            hourlySweepConfig.callLogHygieneMaxArchivePerDomain,
          scorePendingCalls:
            req.body?.scorePendingCalls !== undefined
              ? Boolean(req.body.scorePendingCalls)
              : req.query.scorePendingCalls === "false"
                ? false
                : hourlySweepConfig.callLogHygieneScorePendingCalls !== false,
          archiveRecordings:
            req.body?.archiveRecordings !== undefined
              ? Boolean(req.body.archiveRecordings)
              : req.query.archiveRecordings === "false"
                ? false
                : hourlySweepConfig.callLogHygieneArchiveRecordings !== false,
          syncMetricsDates:
            req.body?.syncMetricsDates !== undefined
              ? Boolean(req.body.syncMetricsDates)
              : req.query.syncMetricsDates === "false"
                ? false
                : true,
          preferLegacyContactActivities:
            req.body?.preferLegacyContactActivities !== undefined
              ? Boolean(req.body.preferLegacyContactActivities)
              : parseBooleanFlag(
                  req.query.preferLegacyContactActivities,
                  hourlySweepConfig.metricsRefreshPreferLegacyContactActivities === true,
                ),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/hourly-contact-enforcement/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await runHourlyLeadCadenceEnforcement({
          domain: req.params.domain,
          limitPerDomain: req.body?.limitPerDomain ?? req.query.limitPerDomain,
          minStaleMs: req.body?.minStaleMs ?? req.query.minStaleMs,
          dryRun: Boolean(req.body?.dryRun ?? req.query.dryRun === "true"),
          sourceService: "control-plane",
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  router.post(
    "/nightly-close/start/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const explicitDomains = []
          .concat(req.body?.domains || [])
          .concat(req.query.domains || [])
          .concat(req.params.domain || [])
          .flatMap((value) => String(value || "").split(","))
          .map((value) => String(value || "").trim().toUpperCase())
          .filter((value) => value && !["ALL", "GROUPED", "PARALLEL"].includes(value));

        const result = await runGroupedNightlyClose(explicitDomains, {
          date: req.body?.date || req.query.date,
          timezone: req.body?.timezone || req.query.timezone,
          spendSyncRuntime,
          logger,
          sendEmail:
            req.body?.sendEmail !== undefined
              ? parseBooleanFlag(req.body.sendEmail)
              : parseBooleanFlag(req.query.sendEmail),
          maxCases: req.body?.maxCases ?? req.query.maxCases,
          skipFinalClosePass:
            req.body?.skipFinalClosePass !== undefined
              ? parseBooleanFlag(req.body.skipFinalClosePass)
              : parseBooleanFlag(req.query.skipFinalClosePass),
          email: {
            recipients: parseRecipientList(
              req.body?.emailRecipients ??
                req.body?.recipients ??
                req.query.emailRecipients ??
                req.query.recipients,
            ),
          },
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Nightly prospect sweep — for each MasterProspect at a prospect status
   * that's missing cellPhone or email, call Logics/CaseInfo:
   *   - DNC status → delete MasterProspect + LeadCadence
   *   - Still prospect → patch missing contact fields
   *   - Converted → mark needsStatusRefresh (future caseprofile upgrade)
   *
   * Body: { domain: "TAG", limit?: 500, dryRun?: false,
   *         dncStatusIds?: [60,61], prospectStatusIds?: [2] }
   */
  router.post(
    "/prospect-sweep/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await runProspectSweep({
          domain: req.params.domain,
          limit: req.body?.limit ?? req.query.limit,
          dryRun: Boolean(req.body?.dryRun ?? req.query.dryRun === "true"),
          dncStatusIds: req.body?.dncStatusIds,
          prospectStatusIds: req.body?.prospectStatusIds,
          delayMsBetweenCalls: req.body?.delayMsBetweenCalls,
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Rebuild SourceCanonical.ringCentralExtensions from the RC queues CSV
   * at `ops/ringcentral-reference/rc-queues.csv`. Each queue whose tracking
   * toll-free matches an existing canonical gets its RC_ID + short ext
   * pushed to the canonical's ringCentralExtensions array. Idempotent.
   */
  router.post(
    "/rc-extension-seed",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await seedRingcentralExtensionsFromCsv({
          dryRun: Boolean(req.body?.dryRun ?? req.query.dryRun === "true"),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  /**
   * Hourly safety net: find completed telephony sessions within the window
   * that lack a `ringcentral.attribution.resolved` event, re-fetch their
   * RC call-log record, and resolve via legs[0] → legs[1] → DID.
   *
   * Body: { sinceMs?: 3600000, limit?: 100, dryRun?: false }
   */
  router.post(
    "/rc-attribution-reconcile/:domain",
    auth.requireAuth,
    auth.requireAdmin,
    async (req, res) => {
      try {
        const result = await reconcileUnattributedSessions({
          domain: req.params.domain,
          sinceMs: req.body?.sinceMs ?? req.query.sinceMs,
          limit: req.body?.limit ?? req.query.limit,
          dryRun: Boolean(req.body?.dryRun ?? req.query.dryRun === "true"),
        });
        return res.json({ ok: true, result });
      } catch (error) {
        return res.status(error.status || 500).json(toErrorResponse(error));
      }
    },
  );

  return router;
}

module.exports = {
  createHygieneRouter,
};
