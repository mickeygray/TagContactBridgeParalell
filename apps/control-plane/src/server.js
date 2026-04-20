"use strict";

const express = require("express");
const cors = require("cors");
const { buildServiceHealth, buildTopologyHealth } = require("../../../packages/shared-observability/src");
const { buildAuthMiddleware } = require("./middleware/auth");
const { createAuthRouter } = require("./routes/auth");
const { createCallrailRouter } = require("./routes/callrail");
const { createDispatchRouter } = require("./routes/dispatch");
const { createDomainsRouter } = require("./routes/domains");
const { createDropRouter } = require("./routes/drop");
const { createEventsRouter } = require("./routes/events");
const { createHealthRouter } = require("./routes/health");
const { createHygieneRouter } = require("./routes/hygiene");
const { createLogicsRouter } = require("./routes/logics");
const { createReadClientsRouter } = require("./routes/readClients");
const { createReadMetricsRouter } = require("./routes/readMetrics");
const { createReadRouter } = require("./routes/read");
const { createReadReviewRouter } = require("./routes/readReview");
const { createReadRingcentralRouter } = require("./routes/readRingcentral");
const { createReadSchedulesRouter } = require("./routes/readSchedules");
const { createRingCentralRouter } = require("./routes/ringcentral");
const { createSendgridRouter } = require("./routes/sendgrid");
const { createWorkflowsRouter } = require("./routes/workflows");
const { createWorklistsRouter } = require("./routes/worklists");
const { getControlPlaneConfig } = require("./services/appConfig");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { createEvent } = require("../../../packages/event-core/src");
const {
  extractAttributionCandidates,
  processControlPlaneEventBatch,
} = require("../../../packages/shared-services/src");

function createWorkerState() {
  return {
    running: false,
    enabled: true,
    intervalMs: 0,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
    timer: null,
  };
}

function startControlPlaneWorker({ config, runtime, workerState }) {
  const intervalMs = Math.max(Number(config.controlPlaneWorker?.intervalMs) || 5000, 1000);
  const batchSize = Math.max(Number(config.controlPlaneWorker?.batchSize) || 25, 1);
  const maxAttempts = Math.max(Number(config.controlPlaneWorker?.maxAttempts) || 5, 1);

  workerState.enabled = true;
  workerState.intervalMs = intervalMs;

  const tick = async () => {
    if (workerState.running) return;
    workerState.running = true;
    workerState.lastStartedAt = new Date();

    try {
      const result = await processControlPlaneEventBatch({
        workerName: `${config.serviceName}-worker`,
        maxAttempts,
        maxCount: batchSize,
      });
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      if (result.processed > 0) {
        runtime.logger.info("control-plane.worker.batch", {
          processed: result.processed,
          handled: result.handled,
        });
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.worker.failed", {
        error: error.message,
      });
    } finally {
      workerState.running = false;
    }
  };

  workerState.timer = setInterval(tick, intervalMs);
  if (typeof workerState.timer.unref === "function") {
    workerState.timer.unref();
  }

  void tick();
}

async function startServer() {
  const config = getControlPlaneConfig();
  const runtime = await initializeServiceRuntime(config);

  const app = express();
  const auth = buildAuthMiddleware(config);
  const workerState = createWorkerState();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ...buildServiceHealth(config, runtime.getMongoState()),
      worker: {
        enabled: workerState.enabled,
        running: workerState.running,
        intervalMs: workerState.intervalMs,
        lastStartedAt: workerState.lastStartedAt,
        lastCompletedAt: workerState.lastCompletedAt,
        lastError: workerState.lastError,
      },
    });
  });

  app.post("/sms/inbound", async (req, res) => {
    res.sendStatus(200);

    const payload = req.body || {};
    runtime.logger.info("sms.inbound.forwarded", {
      sourceNumber: payload.source_number || null,
      destinationNumber: payload.destination_number || null,
      content: payload.content || payload.message || null,
      companyId: payload.company_id || null,
    });

    try {
      await createEvent({
        eventType: "sms.inbound.forwarded",
        sourceService: config.serviceName,
        aggregateType: "sms-conversation",
        aggregateId:
          String(payload.source_number || "").replace(/\D/g, "") || "unknown",
        dedupeKey: [
          String(payload.source_number || "").replace(/\D/g, ""),
          String(payload.destination_number || "").replace(/\D/g, ""),
          String(payload.content || payload.message || "").trim(),
        ].join(":"),
        payload,
      });
    } catch (error) {
      runtime.logger.warn("sms.inbound.forwarded.persist_failed", {
        error: error.message,
      });
    }
  });

  app.post("/ringcentral/session-events", async (req, res) => {
    res.sendStatus(200);

    const payload = req.body || {};
    const telephonySessionId =
      String(payload.body?.telephonySessionId || payload.body?.sessionId || "").trim() ||
      "unknown-session";
    const sequence = String(payload.body?.sequence || "").trim();
    const timestamp = String(payload.timestamp || payload.body?.eventTime || "").trim();
    const candidates = extractAttributionCandidates(payload);

    runtime.logger.info("ringcentral.session_event.forwarded", {
      telephonySessionId,
      sequence: sequence || null,
      timestamp: timestamp || null,
      candidatesCount: candidates.length,
    });

    try {
      await createEvent({
        eventType: "ringcentral.telephony.forwarded",
        sourceService: config.serviceName,
        aggregateType: "telephony-session",
        aggregateId: telephonySessionId,
        dedupeKey: [telephonySessionId, sequence, timestamp].join(":"),
        payload: {
          envelope: payload,
          candidates,
        },
      });
    } catch (error) {
      runtime.logger.warn("ringcentral.session_event.persist_failed", {
        error: error.message,
        telephonySessionId,
      });
    }
  });

  app.use("/api/auth", createAuthRouter(config));
  app.use("/api/callrail", createCallrailRouter(auth));
  app.use("/api/control-plane", createDomainsRouter(auth));
  app.use("/api/dispatch", createDispatchRouter(auth));
  app.use("/api/drop", createDropRouter(auth));
  app.use("/api/events", createEventsRouter(auth));
  app.use("/api/health", createHealthRouter(auth));
  app.use("/api/hygiene", createHygieneRouter(auth));
  app.use("/api/logics", createLogicsRouter(auth));
  app.use("/api/read/clients", createReadClientsRouter(auth));
  app.use("/api/read/metrics", createReadMetricsRouter(auth));
  app.use("/api/read", createReadRouter(auth));
  app.use("/api/read/review", createReadReviewRouter(auth));
  app.use("/api/read/ringcentral", createReadRingcentralRouter(auth));
  app.use("/api/read/schedules", createReadSchedulesRouter(auth));
  app.use("/api/ringcentral", createRingCentralRouter(auth));
  app.use("/api/sendgrid", createSendgridRouter(auth));
  app.use("/api/workflows", createWorkflowsRouter(auth));
  app.use("/api/worklists", createWorklistsRouter(auth));

  app.get("/api/health/services", (_req, res) => {
    res.json(buildTopologyHealth(config));
  });

  if (config.controlPlaneWorker?.enabled) {
    startControlPlaneWorker({ config, runtime, workerState });
  } else {
    workerState.enabled = false;
    runtime.logger.warn("control-plane.worker.disabled");
  }

  const server = app.listen(config.port, () => {
    runtime.logger.info("listening", { port: config.port });
  });

  server.on("close", () => {
    if (workerState.timer) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
  });

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[control-plane] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
