"use strict";

require("../../../ops/nssm/node-dns-bootstrap.cjs");

const express = require("express");
const cors = require("cors");
const { requireAuth } = require("../../../packages/shared-auth/src");
const { ROLES } = require("../../../packages/shared-types/src");
const { createDropClient } = require("../../../packages/shared-integrations/src");
const { upsertLeadCadence } = require("../../../packages/shared-repositories/src");
const {
  getCorsOriginResolver,
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
} = require("../../../packages/shared-config/src");
const {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
} = require("../../../packages/shared-utils/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const {
  OUTBOUND_EVENT_TYPES,
  buildScheduledBlastRuntimeSnapshot,
  createCadenceSweepEvents,
  createOutboundEvent,
  pollCounterCadenceRvmDispositions,
  pollOutboundRvmDispositions,
  processNextOutboundEvent,
  processOutboundEventBatch,
  recordWorkflowStage,
  runCounterCadenceSweep,
  runScheduledBlastSweep,
  sendOutboundCallFireDial,
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

    if (configuredSecret && safeSecretEquals(providedSecret, configuredSecret)) {
      req.user = {
        id: "internal-service",
        role: "service",
        email: "internal@local",
      };
      return next();
    }

    return bearerAuth(req, res, (error) => {
      if (error) return next(error);
      if (req.user?.role === ROLES.ADMIN || req.user?.role === ROLES.SERVICE) {
        return next();
      }
      return res.status(403).json({ ok: false, error: "Forbidden" });
    });
  };
}

function validateDropWebhook(req) {
  const configured = String(
    process.env.DROP_WEBHOOK_SECRET ||
      process.env.DROP_WEBHOOK_KEY ||
      "",
  ).trim();
  if (!configured) return { ok: true, unsigned: true };

  const provided = String(
    req.headers["x-webhook-secret"] ||
      req.headers["x-webhook-key"] ||
      req.headers["x-drop-webhook-secret"] ||
      req.query.secret ||
      req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      "",
  ).trim();
  return safeSecretEquals(provided, configured)
    ? { ok: true }
    : { ok: false, reason: "invalid_drop_webhook_secret" };
}

function captureRawBody(req, _res, buf) {
  if (buf?.length) {
    req.rawBody = Buffer.from(buf);
  }
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
    scheduledBlasts: {
      lastCheckedAt: null,
      lastResult: null,
      lastError: null,
    },
    counterCadence: {
      lastCheckedAt: null,
      lastResult: null,
      lastError: null,
      lastRvmPollAt: null,
      lastRvmPollResult: null,
      lastRvmPollError: null,
    },
    rvmDisposition: {
      lastCheckedAt: null,
      lastResult: null,
      lastError: null,
    },
    timer: null,
  };
}

function intervalDue(lastCheckedAt, now, intervalMs) {
  if (!lastCheckedAt) return true;
  const previous = new Date(lastCheckedAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return true;
  return current - previous >= Math.max(Number(intervalMs) || 0, 1);
}

function isPacificBusinessDay(value = new Date()) {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(new Date(value));
  return weekday !== "Sat" && weekday !== "Sun";
}

function isRvmDispositionPollingEnabled({ env = process.env, config = {} } = {}) {
  return String(
    env.RVM_DISPOSITION_POLL_ENABLED ??
      config.outboundWorker?.rvmDispositionPollEnabled ??
      "false",
  ).trim().toLowerCase() === "true";
}

async function runRvmDispositionPollIfDue({
  workerState,
  now = new Date(),
  intervalMs = 5 * 60 * 1000,
  pollCounter = pollCounterCadenceRvmDispositions,
  pollScheduled = pollOutboundRvmDispositions,
  logger = null,
} = {}) {
  const state = workerState?.rvmDisposition;
  if (!state) throw new TypeError("workerState.rvmDisposition is required");
  if (!isPacificBusinessDay(now)) {
    return { status: "weekend-paused" };
  }
  if (!intervalDue(state.lastCheckedAt, now, intervalMs)) {
    return { status: "not-due" };
  }

  // Claim the interval before either async query. The outer worker has a
  // running guard, but this also makes the cadence explicit and testable.
  state.lastCheckedAt = now;
  const result = { status: "completed", counter: null, scheduled: null };
  const errors = [];
  try {
    result.counter = await pollCounter({ now, limit: 25 });
    workerState.counterCadence.lastRvmPollAt = now;
    workerState.counterCadence.lastRvmPollResult = result.counter;
    workerState.counterCadence.lastRvmPollError = null;
    if (result.counter?.polled > 0) {
      logger?.info?.("outbound.worker.counter_rvm_disposition_poll", {
        polled: result.counter.polled,
        terminal: result.counter.terminal,
        markedDnc: result.counter.markedDnc,
      });
    }
  } catch (error) {
    const message = String(error?.message || "counter-rvm-poll-failed").slice(0, 240);
    workerState.counterCadence.lastRvmPollError = message;
    errors.push({ lane: "counter", error: message });
    logger?.error?.("outbound.worker.counter_rvm_disposition_poll_failed", { error: message });
  }

  try {
    result.scheduled = await pollScheduled({ now, limit: 25 });
    if (result.scheduled?.polled > 0) {
      logger?.info?.("outbound.worker.drop_disposition_poll", {
        polled: result.scheduled.polled,
        terminal: result.scheduled.terminal,
        markedDnc: result.scheduled.markedDnc,
      });
    }
  } catch (error) {
    const message = String(error?.message || "scheduled-rvm-poll-failed").slice(0, 240);
    errors.push({ lane: "scheduled", error: message });
    logger?.error?.("outbound.worker.drop_disposition_poll_failed", { error: message });
  }

  if (errors.length) result.status = "partial";
  result.errors = errors;
  state.lastResult = result;
  state.lastError = errors.length ? errors.map((entry) => entry.lane).join(",") : null;
  return result;
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function compactBlastAudience(audience = {}) {
  const next = { ...audience };
  delete next.caseIds;
  return next;
}

function compactBlastResult(result) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result)) return result.map(compactBlastResult);

  const next = { ...result };
  if (next.audience) {
    next.audience = compactBlastAudience(next.audience);
  }
  if (next.preview) {
    next.preview = compactBlastResult(next.preview);
  }
  if (Array.isArray(next.results)) {
    next.results = next.results.map(compactBlastResult);
  }
  return next;
}

async function startOutboundWorker({ config, runtime, workerState }) {
  const intervalMs = Math.max(Number(config.outboundWorker?.intervalMs) || 5000, 1000);
  const batchSize = Math.max(Number(config.outboundWorker?.batchSize) || 25, 1);
  const maxAttempts = Math.max(Number(config.outboundWorker?.maxAttempts) || 5, 1);
  const counterCadenceEnabled = String(
    process.env.COUNTER_CADENCE_ENABLED ?? config.outboundWorker?.counterCadenceEnabled ?? "true",
  ).toLowerCase() !== "false";
  const counterCadenceIntervalMs = Math.max(
    Number(process.env.COUNTER_CADENCE_WORKER_INTERVAL_MS) ||
      Number(config.outboundWorker?.counterCadenceIntervalMs) ||
      60_000,
    5_000,
  );
  const counterCadenceBatchSize = Math.max(
    Number(process.env.COUNTER_CADENCE_BATCH_SIZE) ||
      Number(config.outboundWorker?.counterCadenceBatchSize) ||
      batchSize,
    1,
  );
  const counterCadenceScanLimit = Math.max(
    Number(process.env.COUNTER_CADENCE_SCAN_LIMIT) ||
      Number(config.outboundWorker?.counterCadenceScanLimit) ||
      2000,
    100,
  );
  const rvmDispositionPollIntervalMs = Math.max(
    Number(process.env.RVM_DISPOSITION_POLL_INTERVAL_MS) || 5 * 60 * 1000,
    60_000,
  );
  // Phase 9 compute boundary: legacy RVM follow-up is retired. Keep the old
  // implementation hard-gated for weed-whack proof, but do not touch the
  // embedded schedule arrays unless an operator explicitly re-enables it.
  const rvmDispositionPollEnabled = isRvmDispositionPollingEnabled({ config });

  workerState.enabled = true;
  workerState.intervalMs = intervalMs;

  const tick = async () => {
    if (workerState.running) return;
    workerState.running = true;
    workerState.lastStartedAt = new Date();

    try {
      const businessDay = isPacificBusinessDay(workerState.lastStartedAt);
      let counterCadenceResult = null;
      let counterRvmPollResult = null;
      if (businessDay && config.outboundWorker?.cadenceSweepEnabled) {
        const sweep = await createCadenceSweepEvents({
          sourceService: config.serviceName,
        });
        if (sweep.accepted.length > 0) {
          runtime.logger.info("outbound.worker.cadence_sweep", {
            accepted: sweep.accepted,
            bucket: sweep.bucket,
          });
        }
      }
      if (businessDay && counterCadenceEnabled) {
        const now = new Date();
        const lastCounterCheck = workerState.counterCadence.lastCheckedAt
          ? new Date(workerState.counterCadence.lastCheckedAt)
          : null;
        const counterDue = !lastCounterCheck ||
          (now.getTime() - lastCounterCheck.getTime()) >= counterCadenceIntervalMs;

        if (counterDue) {
          workerState.counterCadence.lastCheckedAt = now;
          try {
            counterCadenceResult = await runCounterCadenceSweep({
              sourceService: config.serviceName,
              maxDispatches: counterCadenceBatchSize,
              scanLimit: counterCadenceScanLimit,
              // THE DAILY CHAIN MOVES TO THE PASSES; THIS WORKER KEEPS REAL TIME.
              //
              // Mickey 2026-08-06: "the first round of communication still goes
              // out as the lead comes in." So this 5s worker keeps first-touch
              // and the age-relative SMS-2 — which is evaluated BEFORE the daily
              // gate and is therefore unaffected — while the morning and midday
              // passes own the daily batch.
              //
              // This flag was a NO-OP until the sweep stopped hardcoding it:
              // runCounterCadenceSweep overrode includeDaily to true inside
              // itself, so passing false here compiled, read correctly, and
              // changed nothing.
              //
              // DARK UNTIL A PASS IS ARMED. Turning the daily chain off here
              // before the morning pass owns it would simply stop the daily
              // batch, so it stays on until OUTBOUND_DAILY_CADENCE_TO_PASSES
              // says a pass has taken it.
              includeDaily: String(
                process.env.OUTBOUND_DAILY_CADENCE_TO_PASSES || "false",
              ).toLowerCase() !== "true",
              logger: runtime.logger,
            });
            workerState.counterCadence.lastResult = counterCadenceResult;
            workerState.counterCadence.lastError = null;
            if (counterCadenceResult.selected > 0 || counterCadenceResult.failed > 0) {
              runtime.logger.info("outbound.worker.counter_cadence", {
                selected: counterCadenceResult.selected,
                sent: counterCadenceResult.sent,
                failed: counterCadenceResult.failed,
                skipped: counterCadenceResult.skipped,
                dailyWindow: counterCadenceResult.dailyWindow,
              });
            }
          } catch (error) {
            workerState.counterCadence.lastError = error.message;
            runtime.logger.error("outbound.worker.counter_cadence_failed", {
              error: error.message,
            });
          }

        }
      }
      if (businessDay && config.scheduledBlasts?.enabled) {
        workerState.scheduledBlasts.lastCheckedAt = new Date();
        try {
          const blastResult = await runScheduledBlastSweep({
            config: config.scheduledBlasts,
            sourceService: config.serviceName,
            now: workerState.scheduledBlasts.lastCheckedAt,
          });
          workerState.scheduledBlasts.lastResult = compactBlastResult(blastResult);
          workerState.scheduledBlasts.lastError = null;
          if (blastResult?.queuedCount > 0) {
            runtime.logger.info("outbound.worker.scheduled_blasts", {
              rule: blastResult.rule,
              queuedCount: blastResult.queuedCount,
              skippedCount: blastResult.skippedCount,
            });
          }
        } catch (error) {
          workerState.scheduledBlasts.lastError = error.message;
          runtime.logger.error("outbound.worker.scheduled_blasts_failed", {
            error: error.message,
          });
        }
      }
      // Both RVM disposition stores share one five-minute scheduler. The old
      // five-second call only rate-limited returned tokens; an empty result
      // still performed a full cadence-collection scan on every worker tick.
      const rvmPoll = rvmDispositionPollEnabled
        ? await runRvmDispositionPollIfDue({
            workerState,
            now: new Date(),
            intervalMs: rvmDispositionPollIntervalMs,
            logger: runtime.logger,
          })
        : { status: "disabled" };
      counterRvmPollResult = rvmPoll?.counter || counterRvmPollResult;

      // The intake service dispatches welcome SMS/email and creates the first
      // call-queue row in-process. Pausing this general event drain on weekends
      // prevents older follow-up/RVM work from leaking through that narrow
      // exception; durable events remain queued for Monday.
      const result = businessDay
        ? await processOutboundEventBatch({
            workerName: `${config.serviceName}-worker`,
            maxAttempts,
            maxCount: batchSize,
          })
        : { processed: 0, handled: 0, weekendPaused: true };
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        ...result,
        counterCadence: counterCadenceResult,
        counterRvmPoll: counterRvmPollResult,
      };
      workerState.lastError = null;
      if (result.processed > 0) {
        runtime.logger.info("outbound.worker.batch", {
          processed: result.processed,
          handled: result.handled,
        });
        const failedRuns = (result.results || []).filter((entry) => entry?.claimed && !entry?.handled);
        for (const failedRun of failedRuns) {
          runtime.logger.error("outbound.worker.event_failed", {
            eventId: failedRun.eventId || null,
            error: failedRun.error || "unknown-error",
          });
        }
        const callfireRuns = (result.results || [])
          .map((entry) => entry?.handlerResult)
          .filter((entry) => entry?.channel === "callfire" && entry?.callfireSummary);
        for (const run of callfireRuns) {
          runtime.logger.info("outbound.callfire.summary", {
            mode: run.mode,
            selected: run.selected,
            sent: run.sent,
            failed: run.failed,
            skipped: run.skipped,
            ...run.callfireSummary,
          });
        }
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
  const leadDeliveryEnabled = String(process.env.LEAD_DELIVERY_ENABLED || "false")
    .trim().toLowerCase() === "true";
  const requireInternalAccess = buildInternalAccessMiddleware(config);
  const requireHealthAccess = buildHealthAccessMiddleware(config);
  runtime.installSignalHandlers();

  const app = express();
  app.set("trust proxy", "loopback");
  app.use(cors({ origin: getCorsOriginResolver(), credentials: true }));
  app.use(express.json({ limit: "1mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }));

  app.get("/health", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, runtime.getMongoState()));
    }
    res.json({
      ...buildServiceHealth(config, runtime.getMongoState()),
      worker: {
        enabled: workerState.enabled,
        running: workerState.running,
        intervalMs: workerState.intervalMs,
        lastStartedAt: workerState.lastStartedAt,
        lastCompletedAt: workerState.lastCompletedAt,
        lastError: workerState.lastError,
        scheduledBlasts: buildScheduledBlastRuntimeSnapshot(
          config.scheduledBlasts,
          workerState.scheduledBlasts,
        ),
        counterCadence: workerState.counterCadence,
      },
    });
  });

  app.get("/status", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json({
        ...buildPublicHealthPayload(config, runtime.getMongoState()),
        legacyRoute: true,
      });
    }
    res.json({
      ok: true,
      legacyRoute: true,
      service: config.serviceName,
      ...buildServiceHealth(config, runtime.getMongoState()),
      worker: {
        enabled: workerState.enabled,
        running: workerState.running,
        intervalMs: workerState.intervalMs,
        lastStartedAt: workerState.lastStartedAt,
        lastCompletedAt: workerState.lastCompletedAt,
        lastError: workerState.lastError,
        scheduledBlasts: buildScheduledBlastRuntimeSnapshot(
          config.scheduledBlasts,
          workerState.scheduledBlasts,
        ),
        counterCadence: workerState.counterCadence,
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
        scheduledBlasts: buildScheduledBlastRuntimeSnapshot(
          config.scheduledBlasts,
          workerState.scheduledBlasts,
        ),
        counterCadence: workerState.counterCadence,
      },
    });
  });

  app.get("/api/outbound/blasts/runtime", requireInternalAccess, (_req, res) => {
    res.json({
      ok: true,
      scheduledBlasts: buildScheduledBlastRuntimeSnapshot(
        config.scheduledBlasts,
        workerState.scheduledBlasts,
      ),
    });
  });

  app.post("/api/outbound/blasts/preview", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await runScheduledBlastSweep({
      config: config.scheduledBlasts,
      sourceService: config.serviceName,
      domains: req.body?.domains || req.body?.domain || null,
      forceChannel: req.body?.channel || req.body?.forceChannel || null,
      now: req.body?.now ? new Date(req.body.now) : new Date(),
      previewOnly: true,
      ignoreScheduleWindow: true,
      maxAudience: req.body?.maxAudience || null,
    });

    res.json({
      ok: true,
      ...compactBlastResult(result),
    });
  }));

  app.post("/api/outbound/blasts/run", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await runScheduledBlastSweep({
      config: config.scheduledBlasts,
      sourceService: config.serviceName,
      domains: req.body?.domains || req.body?.domain || null,
      forceChannel: req.body?.channel || req.body?.forceChannel || null,
      now: req.body?.now ? new Date(req.body.now) : new Date(),
      previewOnly: false,
      ignoreScheduleWindow: req.body?.respectScheduleWindow ? false : true,
      maxAudience: req.body?.maxAudience || null,
    });

    workerState.scheduledBlasts.lastCheckedAt = new Date();
    workerState.scheduledBlasts.lastResult = compactBlastResult(result);
    workerState.scheduledBlasts.lastError = null;

    res.status(result.queuedCount > 0 ? 202 : 200).json({
      ok: true,
      ...compactBlastResult(result),
    });
  }));

  app.post("/api/outbound/counter-cadence/run", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await runCounterCadenceSweep({
      domain: req.body?.domain || null,
      domains: Array.isArray(req.body?.domains) ? req.body.domains : null,
      now: req.body?.now ? new Date(req.body.now) : new Date(),
      maxDispatches: req.body?.maxDispatches || req.body?.limit || 25,
      scanLimit: req.body?.scanLimit || undefined,
      dryRun: Boolean(req.body?.dryRun),
      forceDaily: Boolean(req.body?.forceDaily),
      sourceService: `${config.serviceName}-manual`,
      logger: runtime.logger,
    });

    workerState.counterCadence.lastCheckedAt = result.checkedAt || new Date();
    workerState.counterCadence.lastResult = result;
    workerState.counterCadence.lastError = null;

    res.status(result.sent > 0 ? 202 : 200).json({
      ok: true,
      ...result,
    });
  }));

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

    await recordWorkflowStage({
      domain: payload?.domain || "TAG",
      family: "dispatch",
      subtype: eventType.replace(/^outbound\./, "").replace(/\.requested$/, ""),
      stage: "requested",
      aggregateType: payload?.dispatchListId ? "dispatch-list" : "outbound",
      aggregateId: String(payload?.dispatchListId || aggregateId),
      caseId: payload?.caseId != null ? Number(payload.caseId) : null,
      sourceService: config.serviceName,
      summary: `${eventType} accepted`,
      payload: {
        eventType,
        eventId: String(result.event._id),
        channel: payload?.channel || null,
        mode: payload?.mode || null,
        dispatchListId: payload?.dispatchListId || null,
      },
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

  app.post("/api/outbound/cadence/cx-round", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.CX_ROUND_REQUESTED,
      aggregateId: req.body?.domain || "outbound-cx-round",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/cadence/phoneburner-round", requireInternalAccess, asyncHandler(async (req, res) => {
    if (leadDeliveryEnabled) {
      return res.status(409).json({ ok: false, error: "lead-delivery-owns-phoneburner" });
    }
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
    if (leadDeliveryEnabled) {
      return res.status(409).json({ ok: false, error: "lead-delivery-owns-phoneburner" });
    }
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.PHONEBURNER_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-phoneburner-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/manual/callfire", requireInternalAccess, asyncHandler(async (req, res) => {
    return acceptOutboundEvent(res, {
      eventType: OUTBOUND_EVENT_TYPES.CALLFIRE_MANUAL_REQUESTED,
      aggregateId: req.body?.domain || "outbound-callfire-manual",
      dedupeKey: req.body?.dedupeKey || null,
      payload: req.body || {},
    });
  }));

  app.post("/api/outbound/test/callfire", requireInternalAccess, asyncHandler(async (req, res) => {
    const result = await sendOutboundCallFireDial({
      toPhone: req.body?.toPhone,
      name: req.body?.name || "Codex Test Dial",
      caseId: req.body?.caseId != null ? Number(req.body.caseId) : null,
      broadcastName: req.body?.broadcastName || null,
      messageText:
        req.body?.messageText ||
        "Hello, this is a test outbound dial from Tag Contact Bridge Parallel.",
    });

    await recordWorkflowStage({
      domain: req.body?.domain || "TAG",
      family: "dispatch",
      subtype: "callfire-test",
      stage: result.ok ? "completed" : "failed",
      aggregateType: "outbound",
      aggregateId: String(result.broadcastId || req.body?.toPhone || "callfire-test"),
      caseId: req.body?.caseId != null ? Number(req.body.caseId) : null,
      sourceService: config.serviceName,
      summary: result.ok
        ? `CallFire test dial sent to ${req.body?.toPhone || ""}`.trim()
        : "CallFire test dial failed",
      result,
    });

    res.status(result.ok ? 200 : 500).json({
      ok: result.ok,
      ...result,
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

  app.post("/drop-webhook", asyncHandler(async (req, res) => {
    const validation = validateDropWebhook(req);
    if (!validation.ok) {
      return res.status(401).json({ ok: false, error: validation.reason || "invalid_drop_webhook_secret" });
    }
    const payload = req.body || {};
    const caseId = Number(payload.C1 || payload.caseId);
    const statusCode = payload.DropStatusCode || payload.statusCode || null;
    const statusMessage = payload.DropStatusMessage || payload.statusMessage || null;
    const domain = String(
      payload.domain || payload.company || req.query.domain || "TAG",
    ).trim().toUpperCase();

    if (Number.isFinite(caseId) && caseId > 0) {
      const update = {
        lastRvmStatus: statusMessage,
        lastRvmStatusCode: statusCode,
        lastRvmStatusAt: new Date(),
      };

      if (String(statusMessage || "").toLowerCase().includes("callback")) {
        update.day0Connected = true;
        update.day0ConnectedAt = new Date();
      }

      await upsertLeadCadence(domain, caseId, update);
      await recordWorkflowStage({
        domain,
        family: "dispatch",
        subtype: "drop-webhook",
        stage: "observed",
        aggregateType: "lead-cadence",
        aggregateId: String(caseId),
        caseId,
        sourceService: config.serviceName,
        summary: `Drop webhook observed: ${statusMessage || statusCode || "unknown"}`,
        payload: {
          statusCode,
          statusMessage,
        },
      });
    } else {
      runtime.logger.warn("drop.webhook.missing_case", {
        statusCode,
        statusMessage,
      });
    }

    res.status(200).json({ ok: true, legacyRoute: true });
  }));

  app.get("/drop-balance", requireInternalAccess, asyncHandler(async (req, res) => {
    const domain = String(req.query.domain || "TAG").trim().toUpperCase();
    const client = createDropClient(domain);
    const result = await client.checkBalance();
    res.json({
      ok: true,
      legacyRoute: true,
      domain,
      ...result,
    });
  }));

  if (config.outboundWorker.enabled) {
    await startOutboundWorker({ config, runtime, workerState });
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

  const server = app.listen(config.port, config.bindHost, () => {
    runtime.logger.info("listening", { host: config.bindHost, port: config.port });
  });

  function stopWorker() {
    if (workerState.timer) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
  }

  // Block shutdown until any in-flight tick is done OR we hit the
  // hard ceiling. Without this, mongo disconnect (later in the
  // shutdown chain) lands while a tick is mid-write â€” partial state
  // results: an action flipped to `requested` but never to
  // `completed`/`failed`, channelDnc set without the corresponding
  // workflow stage, etc. The 25s ceiling is conservative against
  // NSSM's default 30s SIGKILL window â€” leaves ~5s for the rest of
  // the cleanup chain.
  async function waitForWorkerIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (workerState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (workerState.running) {
      runtime.logger.warn("outbound.worker.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }

  server.on("close", stopWorker);

  runtime.registerCleanup("outbound-server", () => new Promise((resolve) => server.close(() => resolve())));
  runtime.registerCleanup("outbound-worker", async () => {
    stopWorker();
    await waitForWorkerIdle();
  });

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[outbound-gateway] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  createWorkerState,
  intervalDue,
  isPacificBusinessDay,
  isRvmDispositionPollingEnabled,
  runRvmDispositionPollIfDue,
  startServer,
};
