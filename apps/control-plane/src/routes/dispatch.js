"use strict";

const express = require("express");
const {
  buildCampaignAudience,
  buildDispatchList,
  getDispatchList,
  listDispatchLists,
  queueDispatchList,
  buildProspectBlast,
  planProspectBlast,
  loadProspectBlast,
  blastJobStore,
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

  // ── Predictive prospect blast (load a paced list into a CX dialer campaign) ──
  //
  // PREVIEW: resolve the list + chunk plan WITHOUT loading, so the operator can
  // pick the chunk size and see "N leads → M chunks of S" before committing.
  router.post("/blast/preview", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const plan = await planProspectBlast(req.body);
      return res.json({ ok: true, plan });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // START: kick off the paced load as a background job and return its id. The load
  // sleeps between chunks, so we DON'T await it in the request — the UI polls
  // /blast/job/:jobId for the chunk-completion progress bar.
  router.post("/blast/start", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    try {
      const dryRun = Boolean(req.body.dryRun);
      // LIVE-FIRE GUARD: a live blast must be explicitly confirmed. Omitting dryRun
      // is NOT enough — you must pass confirmLive:true (or dryRun:true to preview).
      if (!dryRun && req.body.confirmLive !== true) {
        return res.status(400).json({
          ok: false,
          error: "Live blast requires confirmLive:true (or set dryRun:true to preview)",
        });
      }

      const targets = await buildProspectBlast(req.body);
      if (!targets.length) {
        return res.status(400).json({ ok: false, error: "No targets resolved for blast" });
      }

      // Caps + minimum pace — a runaway-load guard. All env-tunable.
      const maxTargets = Math.max(1, Number(process.env.BLAST_MAX_TARGETS) || 5000);
      if (targets.length > maxTargets) {
        return res.status(400).json({
          ok: false,
          error: `Blast resolves ${targets.length} targets, over the ${maxTargets} cap — narrow the list`,
        });
      }
      const maxBatch = Math.max(1, Number(process.env.BLAST_MAX_BATCH) || 500);
      const minPaceMs = Math.max(0, Number(process.env.BLAST_MIN_PACE_MS) || 2000);
      const batchSize = Math.min(Math.max(1, Number(req.body.batchSize) || 100), maxBatch);
      const paceMs = dryRun ? 0 : Math.max(minPaceMs, Number(req.body.paceMs) || 0);

      const plan = await planProspectBlast({ upload: targets, batchSize, campaignId: req.body.campaignId });

      // One concurrent LIVE blast per campaign+domain.
      if (!dryRun && blastJobStore.hasActiveJob({ campaignId: plan.campaignId, domain: req.body.domain || null })) {
        return res.status(409).json({
          ok: false,
          error: `A live blast is already running for campaign ${plan.campaignId}`,
        });
      }

      const jobId = blastJobStore.newBlastJobId();
      blastJobStore.createBlastJob({
        jobId,
        domain: req.body.domain || null,
        campaignId: plan.campaignId,
        total: plan.total,
        batches: plan.batches,
        batchSize,
        paceMs,
        dryRun,
      });
      // Fire-and-forget the paced load; progress flows into the job store.
      loadProspectBlast(
        {
          targets,
          batchSize,
          paceMs,
          dryRun,
          campaignId: req.body.campaignId,
          domain: req.body.domain,
        },
        {
          onProgress: ({ batchesDone, loaded }) =>
            blastJobStore.recordBlastProgress(jobId, { batchesDone, loaded }),
        },
      )
        .then((result) => {
          // Swallow finish-store errors — a background metrics write must never
          // become an unhandled rejection that crashes the control-plane process.
          try {
            const failures = Array.isArray(result?.results)
              ? result.results.filter((row) => row && row.error).length
              : Number(result?.failed || 0);
            const status = failures > 0 ? (Number(result?.loaded || 0) > 0 ? "partial" : "failed") : "complete";
            const error = failures > 0
              ? `${failures} blast batch${failures === 1 ? "" : "es"} failed`
              : null;
            blastJobStore.finishBlastJob(jobId, { status, error });
          } catch (_) { /* noop */ }
        })
        .catch((error) => {
          try { blastJobStore.finishBlastJob(jobId, { status: "failed", error: error && error.message }); } catch (_) { /* noop */ }
        });

      return res.json({ ok: true, jobId, ...plan });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // PROGRESS: poll the chunk-completion progress bar.
  router.get("/blast/job/:jobId", auth.requireAuth, auth.requireAdmin, async (req, res) => {
    const job = blastJobStore.getBlastJob(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "Blast job not found" });
    return res.json({ ok: true, job });
  });

  return router;
}

module.exports = {
  createDispatchRouter,
};
