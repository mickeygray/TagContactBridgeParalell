"use strict";

const express = require("express");
const cors = require("cors");
const { requireAuth } = require("../../../packages/shared-auth/src");
const {
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const {
  OUTBOUND_EVENT_TYPES,
  createOutboundEvent,
  processNextOutboundEvent,
  processOutboundEventBatch,
} = require("../../../packages/shared-services/src");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");

function buildInternalAccessMiddleware(config) {
  if (!config.outboundRequireInternalAuth) {
    return (_req, _res, next) => next();
  }

  const bearerAuth = requireAuth(config);
  const configuredSecret = String(config.internalServiceSecret || "").trim();

  return (req, res, next) => {
    const providedSecret = String(
      req.headers["x-service-secret"] ||
      req.headers["x-internal-secret"] ||
      "",
    ).trim();

    if (configuredSecret && providedSecret && providedSecret === configuredSecret) {
      req.user = {
        id: "internal-service",
        role: "service",
        email: "internal@local",
      };
      return next();
    }

    return bearerAuth(req, res, next);
  };
}

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

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function startOutboundWorker({ config, runtime, workerState }) {
  const intervalMs = Math.max(Number(config.outboundWorker?.intervalMs) || 5000, 1000);
  const batchSize = Math.max(Number(config.outboundWorker?.batchSize) || 25, 1);
  const maxAttempts = Math.max(Number(config.outboundWorker?.maxAttempts) || 5, 1);

  workerState.enabled = true;
  workerState.intervalMs = intervalMs;

  const tick = async () => {
    if (workerState.running) return;
    workerState.running = true;
    workerState.lastStartedAt = new Date();

    try {
      const result = await processOutboundEventBatch({
        workerName: `${config.serviceName}-worker`,
        maxAttempts,
        maxCount: batchSize,
      });
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      if (result.processed > 0) {
        runtime.logger.info("outbound.worker.batch", {
          processed: result.processed,
          handled: result.handled,
        });
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("outbound.worker.failed", {
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
  const config = {
    ...getSharedConfig(),
    port: PORTS.outboundGateway,
    serviceName: SERVICE_NAMES.outboundGateway,
  };

  const runtime = await initializeServiceRuntime(config);
  const workerState = createWorkerState();
  const requireInternalAccess = buildInternalAccessMiddleware(config);

  const app = express();
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

  app.get("/api/outbound/runtime", requireInternalAccess, (_req, res) => {
    res.json({
      ok: true,
      worker: {
        enabled: workerState.enabled,
        running: workerState.running,
        intervalMs: workerState.intervalMs,
        lastStartedAt: workerState.lastStartedAt,
        lastCompletedAt: workerState.lastCompletedAt,
        lastResult: workerState.lastResult,
        lastError: workerState.lastError,
      },
    });
  });

  app.post("/api/outbound/demo", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await publishDemoEvent("outbound", config.serviceName, req.body || {});

    res.status(202).json({
      ok: true,
      accepted: true,
      deduped: result.deduped,
      eventId: String(result.event._id),
    });
  }));

  async function acceptOutboundEvent(res, {
    eventType,
    aggregateId,
    dedupeKey,
    payload,
  }) {
    const result = await createOutboundEvent({
      eventType,
      sourceService: config.serviceName,
      aggregateType: "outbound",
      aggregateId,
      dedupeKey,
      payload,
    });

    return res.status(202).json({
      ok: true,
      accepted: true,
      deduped: result.deduped,
      eventId: String(result.event._id),
    });
  }

  app.post("/api/outbound/cadence/text-round", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.TEXT_ROUND_REQUESTED,
      aggregateId: req.body?.domain || "outbound-text-round",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/cadence/email-round", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.EMAIL_ROUND_REQUESTED,
      aggregateId: req.body?.domain || "outbound-email-round",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/cadence/rvm-round", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.RVM_ROUND_REQUESTED,
      aggregateId: req.body?.domain || "outbound-rvm-round",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/cadence/phoneburner-round", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.PHONEBURNER_ROUND_REQUESTED,
      aggregateId: req.body?.domain || "outbound-phoneburner-round",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/manual/text", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.TEXT_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-text-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/manual/email", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.EMAIL_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-email-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/manual/rvm", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.RVM_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-rvm-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/manual/phoneburner", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-phoneburner-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/process-next", requireInternalAccess, asyncHandler(async (_req, res) => {
    const result = await processNextOutboundEvent({
      workerName: `${config.serviceName}-manual`,
      maxAttempts: config.outboundWorker.maxAttempts,
    });
    res.json({ ok: true, ...result });
  }));

  app.post("/api/outbound/process-batch", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await processOutboundEventBatch({
      workerName: `${config.serviceName}-manual`,
      maxAttempts: config.outboundWorker.maxAttempts,
      maxCount: req.body?.maxCount || config.outboundWorker.batchSize,
    });
    res.json({ ok: true, ...result });
  }));

  if (config.outboundWorker.enabled) {
    startOutboundWorker({ config, runtime, workerState });
  } else {
    workerState.enabled = false;
    runtime.logger.warn("outbound.worker.disabled");
  }

  app.use((error, _req, res, _next) => {
    runtime.logger.error("outbound.request.failed", {
      error: error.message,
    });
    res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Outbound request failed",
    });
  });

  const server = app.listen(config.port, () => {
    runtime.logger.info("listening", { port: config.port });
  });

  function stopWorker() {
    if (workerState.timer) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
  }

  server.on("close", stopWorker);

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[outbound-gateway] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  startServer,
};
