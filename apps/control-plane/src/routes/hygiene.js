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
  pushHourlyReviewItem,
  recordDailyDeepCutRun,
  reviewCaseActivities,
  runDataHygieneSmoke,
  startDailyDeepCutRun,
  startDailyDeepCutVerification,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

function createHygieneRouter(auth) {
  const router = express.Router();

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

  return router;
}

module.exports = {
  createHygieneRouter,
};
