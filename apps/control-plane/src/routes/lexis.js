"use strict";

const express = require("express");
const multer = require("multer");
const {
  parseNcoaCsv,
  fetchLatestLexisDrop,
  getNcoaUploadProgress,
  ingestLatestLexisDrop,
  sendLexisRegionalMail,
  uploadNcoaRows,
} = require("../../../../packages/shared-services/src");
const { toErrorResponse } = require("../../../../packages/shared-errors/src");

// Wall-clock budget for the synchronous NCOA upload loop. Each row
// takes ~1-3s end-to-end (Logics createCase + 3 Mongo upserts), so a
// 2,500-row batch can run 40-120 minutes. Node 22's default
// `server.requestTimeout` is 5 min — way too short. Bumping per
// request keeps this constraint local to the upload endpoint instead
// of relaxing the server-wide ceiling.
const NCOA_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function createLexisRouter(auth, lexisNightlyRuntime, lexisDailyDropRuntime) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  router.use(auth.requireAuth, auth.requireAdmin);

  router.get("/status", async (_req, res) => {
    return res.json({
      ok: true,
      result: {
        nightly: lexisNightlyRuntime ? lexisNightlyRuntime.getState() : null,
        dailyDrop: lexisDailyDropRuntime ? lexisDailyDropRuntime.getState() : null,
      },
    });
  });

  router.get("/daily-drop/status", async (_req, res) => {
    return res.json({
      ok: true,
      result: lexisDailyDropRuntime ? lexisDailyDropRuntime.getState() : null,
    });
  });

  router.get("/preview/:domain", async (req, res) => {
    try {
      const result = await fetchLatestLexisDrop({ domain: req.params.domain });
      return res.json({
        ok: true,
        result: {
          runId: result.runId,
          file: result.download,
          attachments: result.attachments,
          csvPath: result.csvPath,
          parsedRows: result.parsedRows.length,
          mailHouseStats: result.mailHouse.stats,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/ingest/:domain", async (req, res) => {
    try {
      const result = await ingestLatestLexisDrop({
        domain: req.params.domain,
        sourceService: "control-plane",
        importBatch: req.body?.importBatch,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/regional-mail/:domain", async (req, res) => {
    try {
      const result = await sendLexisRegionalMail({
        domain: req.params.domain,
        recipients: req.body?.recipients,
        subject: req.body?.subject,
        text: req.body?.text,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/run/:domain", async (req, res) => {
    try {
      if (!lexisNightlyRuntime) {
        throw new Error("Lexis nightly runtime is not configured");
      }
      const result = await lexisNightlyRuntime.runNightlyLexisFlow({
        domain: req.params.domain,
        sendRegionalMail: req.body?.sendRegionalMail,
        ingestEnabled: req.body?.ingestEnabled,
        recipients: req.body?.recipients,
        subject: req.body?.subject,
        text: req.body?.text,
        importBatch: req.body?.importBatch,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/daily-drop/run/:domain", async (req, res) => {
    try {
      if (!lexisDailyDropRuntime) {
        throw new Error("Lexis daily-drop runtime is not configured");
      }
      const result = await lexisDailyDropRuntime.runDailyDrop({
        domain: req.params.domain,
        recipients: req.body?.recipients,
        alertRecipients: req.body?.alertRecipients,
        subject: req.body?.subject,
        text: req.body?.text,
        alertSubject: req.body?.alertSubject,
        alertText: req.body?.alertText,
        force: req.body?.force,
        scheduled: false,
        emitRetryOnFailure: req.body?.emitRetryOnFailure,
        ignoreConfiguredRecipients: req.body?.ignoreConfiguredRecipients,
        ignoreConfiguredAlertRecipients: req.body?.ignoreConfiguredAlertRecipients,
        host: req.body?.host,
        port: req.body?.port,
        username: req.body?.username,
        password: req.body?.password,
        remoteDir: req.body?.remoteDir,
        zipPassword: req.body?.zipPassword,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/daily-drop/cron/:domain", async (req, res) => {
    try {
      if (!lexisDailyDropRuntime) {
        throw new Error("Lexis daily-drop runtime is not configured");
      }
      const result = await lexisDailyDropRuntime.runDailyDrop({
        domain: req.params.domain,
        recipients: req.body?.recipients,
        alertRecipients: req.body?.alertRecipients,
        subject: req.body?.subject,
        text: req.body?.text,
        alertSubject: req.body?.alertSubject,
        alertText: req.body?.alertText,
        force: req.body?.force,
        scheduled: true,
        emitRetryOnFailure:
          req.body?.emitRetryOnFailure !== undefined
            ? req.body.emitRetryOnFailure
            : true,
        ignoreConfiguredRecipients: req.body?.ignoreConfiguredRecipients,
        ignoreConfiguredAlertRecipients: req.body?.ignoreConfiguredAlertRecipients,
        host: req.body?.host,
        port: req.body?.port,
        username: req.body?.username,
        password: req.body?.password,
        remoteDir: req.body?.remoteDir,
        zipPassword: req.body?.zipPassword,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/ncoa/preview", upload.single("file"), async (req, res) => {
    try {
      const csvText = req.file
        ? req.file.buffer.toString("utf8")
        : String(req.body?.csvText || "");
      const rows = parseNcoaCsv(csvText);
      return res.json({
        ok: true,
        result: {
          total: rows.length,
          rows: rows.slice(0, 25),
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  router.post("/ncoa/upload", upload.single("file"), async (req, res) => {
    // Bump the per-request timeout so a long batch doesn't get killed
    // by Node's 5-min default. Applies to THIS request only — other
    // routes keep the server-wide ceiling.
    req.setTimeout(NCOA_UPLOAD_TIMEOUT_MS);
    res.setTimeout(NCOA_UPLOAD_TIMEOUT_MS);
    try {
      const csvText = req.file
        ? req.file.buffer.toString("utf8")
        : String(req.body?.csvText || "");
      const rows = parseNcoaCsv(csvText);
      const result = await uploadNcoaRows(rows, {
        sourceService: "control-plane",
        importBatch: req.body?.importBatch || req.file?.originalname,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  // Live progress probe — the frontend polls this while the long
  // upload POST is in flight (or after a partial-failure retry) to
  // surface "X of Y rows landed" without waiting for the final
  // result envelope. Reads aggregated workflow stages so it doesn't
  // touch any in-memory upload state and works across restarts.
  router.get("/ncoa/progress", async (req, res) => {
    try {
      const importBatch = String(req.query?.importBatch || "").trim();
      if (!importBatch) {
        return res.status(400).json({ ok: false, error: "importBatch is required" });
      }
      const result = await getNcoaUploadProgress(
        String(req.query?.domain || "").trim().toUpperCase() || null,
        importBatch,
      );
      return res.json({ ok: true, result });
    } catch (error) {
      return res.status(error.status || 500).json(toErrorResponse(error));
    }
  });

  return router;
}

module.exports = {
  createLexisRouter,
};
