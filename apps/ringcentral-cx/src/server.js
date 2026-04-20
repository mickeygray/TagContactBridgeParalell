"use strict";

const express = require("express");
const cors = require("cors");
const {
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
  getRingCentralConfig,
} = require("../../../packages/shared-config/src");
const { createRingCentralClient } = require("../../../packages/shared-integrations/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");
const {
  extractAttributionCandidates,
  processPresenceEnvelope,
  getCxAgentStateByExtensionId,
  listCxAgentStates,
  mirrorAgentState,
  scheduleTelephonySessionEnvelope,
  seedPresenceForAgents,
  startPresencePoller,
} = require("../../../packages/shared-services/src");
const { createEvent } = require("../../../packages/event-core/src");

async function startServer() {
  const config = {
    ...getSharedConfig(),
    port: PORTS.ringcentralCx,
    serviceName: SERVICE_NAMES.ringcentralCx,
  };

  const runtime = await initializeServiceRuntime(config);
  const rc = createRingCentralClient();
  rc.setRefreshCallback(async (context = {}) => {
    runtime.logger.info("ringcentral.platform.reinitialized", {
      reason: context.reason || "refresh",
      authenticatedAt: context.authenticatedAt || null,
    });
    try {
      const seeded = await seedPresenceForAgents(runtime.logger);
      runtime.logger.info("ringcentral.presence.seeded_after_reinit", seeded);
    } catch (error) {
      runtime.logger.warn("ringcentral.presence.seed_after_reinit_failed", {
        error: error.message,
      });
    }
  });
  try {
    await rc.warmupPlatform();
    runtime.logger.info("ringcentral.platform.ready", rc.getAuthStatus());
    try {
      const seeded = await seedPresenceForAgents(runtime.logger);
      runtime.logger.info("ringcentral.presence.seeded_on_startup", seeded);
    } catch (error) {
      runtime.logger.warn("ringcentral.presence.seed_on_startup_failed", {
        error: error.message,
      });
    }
  } catch (error) {
    runtime.logger.warn("ringcentral.platform.warmup_failed", {
      error: error.message,
    });
  }
  let poller = null;
  try {
    poller = startPresencePoller(runtime.logger);
    runtime.logger.info("ringcentral.presence_poller.started", poller.getState());
  } catch (error) {
    runtime.logger.warn("ringcentral.presence_poller.start_failed", {
      error: error.message,
    });
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ...buildServiceHealth(config, runtime.getMongoState()),
      ringcentral: rc.getAuthStatus(),
      presencePoller: poller ? poller.getState() : { enabled: false },
    });
  });

  app.get("/api/ringcentral/runtime", (_req, res) => {
    res.json({
      ok: true,
      auth: rc.getAuthStatus(),
      presencePoller: poller ? poller.getState() : { enabled: false },
    });
  });

  app.post("/api/ringcentral/reinitialize", async (_req, res) => {
    try {
      const auth = await rc.reinitializePlatform({
        force: true,
        reason: "manual-6101",
      });
      return res.json({
        ok: true,
        auth,
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.post("/api/ringcentral/presence/seed", async (_req, res) => {
    try {
      const result = await seedPresenceForAgents(runtime.logger);
      return res.json({
        ok: true,
        ...result,
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.post("/api/ringcentral/presence/poll", async (_req, res) => {
    if (!poller) {
      return res.status(503).json({
        ok: false,
        error: "Presence poller not initialized",
      });
    }

    try {
      await poller.runNow();
      return res.json({
        ok: true,
        state: poller.getState(),
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.get("/api/agents", async (_req, res) => {
    const agents = await listCxAgentStates();
    res.json({
      ok: true,
      agents,
    });
  });

  app.get("/api/agents/:extensionId", async (req, res) => {
    const agent = await getCxAgentStateByExtensionId(req.params.extensionId);
    if (!agent) {
      return res.status(404).json({
        ok: false,
        error: "Agent not found",
      });
    }

    return res.json({
      ok: true,
      agent,
    });
  });

  app.post("/ringbridge/agent-state", async (req, res) => {
    try {
      const snapshot = req.body || {};
      const agent = await mirrorAgentState(snapshot);
      runtime.logger.info("ringcentral.agent_state.mirrored", {
        extensionId: agent.extensionId,
        name: agent.name,
        cxAvailability: agent.cxRouting?.desiredAvailability || null,
        reason: agent.cxRouting?.reason || null,
      });
      return res.status(202).json({
        ok: true,
        extensionId: agent.extensionId,
        cxRouting: agent.cxRouting,
      });
    } catch (error) {
      runtime.logger.error("ringcentral.agent_state.mirror_failed", {
        error: error.message,
      });
      return res.status(400).json({
        ok: false,
        error: error.message,
      });
    }
  });

  async function handlePresenceWebhook(req, res) {
    const validationToken = req.headers["validation-token"];
    if (validationToken) {
      res.setHeader("Validation-Token", validationToken);
      return res.status(200).send("OK");
    }

    const verificationToken = req.headers["verification-token"];
    const rcConfig = getRingCentralConfig();
    if (rcConfig.webhookSecret && verificationToken && verificationToken !== rcConfig.webhookSecret) {
      runtime.logger.warn("ringcentral.ex.invalid_token", {
        verificationToken,
      });
      return res.status(200).send("Invalid token");
    }

    res.status(200).send("OK");

    try {
      const result = await processPresenceEnvelope(req.body || {}, runtime.logger);
      runtime.logger.info("ringcentral.ex.webhook.accepted", {
        extensionId: result.current?.extensionId || null,
        previousStatus: result.previous?.status || null,
        newStatus: result.current?.status || null,
      });
    } catch (error) {
      runtime.logger.error("ringcentral.ex.webhook.failed", {
        error: error.message,
      });
    }
  }

  app.post("/webhook/ex", handlePresenceWebhook);
  app.post("/webhook/ringcentral/ex", handlePresenceWebhook);

  app.post("/webhook/ringcentral/session-events", async (req, res) => {
    const validationToken = req.headers["validation-token"];
    if (validationToken) {
      res.setHeader("Validation-Token", validationToken);
      return res.status(200).send("OK");
    }

    const verificationToken = req.headers["verification-token"];
    const rcConfig = getRingCentralConfig();
    if (rcConfig.webhookSecret && verificationToken && verificationToken !== rcConfig.webhookSecret) {
      runtime.logger.warn("ringcentral.webhook.invalid_token", {
        verificationToken,
      });
      return res.status(200).send("Invalid token");
    }

    res.status(200).send("OK");

    const envelope = req.body || {};
    const candidates = extractAttributionCandidates(envelope);

    try {
      await createEvent({
        eventType: "ringcentral.telephony.webhook",
        sourceService: config.serviceName,
        aggregateType: "telephony-session",
        aggregateId: String(envelope.body?.telephonySessionId || envelope.body?.sessionId || "unknown"),
        dedupeKey: [
          String(envelope.body?.telephonySessionId || ""),
          String(envelope.body?.sequence || ""),
          String(envelope.timestamp || ""),
        ].join(":"),
        payload: envelope,
      });
    } catch (error) {
      runtime.logger.warn("ringcentral.telephony.webhook.persist_failed", {
        error: error.message,
      });
    }

    try {
      const queued = await scheduleTelephonySessionEnvelope(envelope, runtime.logger);
      runtime.logger.info("ringcentral.telephony.webhook.accepted", {
        telephonySessionId: envelope.body?.telephonySessionId || null,
        queued: queued.queued,
        candidates,
      });
    } catch (error) {
      runtime.logger.error("ringcentral.telephony.webhook.schedule_failed", {
        error: error.message,
        telephonySessionId: envelope.body?.telephonySessionId || null,
      });
    }
  });

  app.post("/api/ring/events", async (req, res) => {
    const result = await publishDemoEvent("ring", config.serviceName, req.body || {});

    res.status(202).json({
      ok: true,
      accepted: true,
      deduped: result.deduped,
      eventId: String(result.event._id),
    });
  });

  const server = app.listen(config.port, () => {
    runtime.logger.info("listening", { port: config.port });
  });

  server.on("close", () => {
    if (poller) {
      poller.stop();
    }
    rc.stopWarmupTimer();
  });

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[ringcentral-cx] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
