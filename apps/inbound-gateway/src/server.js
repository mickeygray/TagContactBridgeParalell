"use strict";

const express = require("express");
const cors = require("cors");
const {
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const {
  intakeAffiliateLead,
  intakeFacebookLead,
  intakeInstagramLead,
  intakeLdLead,
  intakeLexisBatch,
  intakeOrganicLandingLead,
  intakeTikTokLead,
  intakeVfLandingLead,
  intakeWebsiteLead,
  validateLeadWebhook,
} = require("../../../packages/shared-services/src");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");

async function startServer() {
  const config = {
    ...getSharedConfig(),
    port: PORTS.inboundGateway,
    serviceName: SERVICE_NAMES.inboundGateway,
  };

  const runtime = await initializeServiceRuntime(config);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json(buildServiceHealth(config, runtime.getMongoState()));
  });

  app.post("/api/inbound/demo", async (req, res) => {
    const result = await publishDemoEvent("inbound", config.serviceName, req.body || {});

    res.status(202).json({
      ok: true,
      accepted: true,
      deduped: result.deduped,
      eventId: String(result.event._id),
    });
  });

  app.post("/api/inbound/website/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeWebsiteLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("website lead intake failed", {
        message: error.message,
      });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/ld/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeLdLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("ld lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/affiliate/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeAffiliateLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("affiliate lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/vf/landing-page", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeVfLandingLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("vf landing intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/organic/:domain/landing-page", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeOrganicLandingLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
        organicDomain: req.params.domain,
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("organic landing intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/facebook/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeFacebookLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("facebook lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/instagram/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeInstagramLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("instagram lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/tiktok/lead", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const result = await intakeTikTokLead(req.body || {}, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("tiktok lead intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/inbound/lexis/mailer", async (req, res) => {
    if (!validateLeadWebhook(req)) {
      return res.status(401).json({ ok: false, error: "invalid_webhook_secret" });
    }

    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const result = await intakeLexisBatch(rows, {
        headers: req.headers,
        sourceService: config.serviceName,
        skipLogicsCreate: req.query.doCase === "false",
        importBatch: req.body?.importBatch || null,
      });
      return res.status(202).json({ ok: true, ...result });
    } catch (error) {
      runtime.logger.error("lexis batch intake failed", { message: error.message });
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  return app.listen(config.port, () => {
    runtime.logger.info("listening", { port: config.port });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[inbound-gateway] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
