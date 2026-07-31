"use strict";

require("../../../ops/nssm/node-dns-bootstrap.cjs");

const express = require("express");
const cors = require("cors");
const { requireAuth, requirePermission } = require("../../../packages/shared-auth/src");
const {
  getCorsOriginResolver,
  getSharedConfig,
  PORTS,
  SERVICE_NAMES,
  getRingCentralConfig,
} = require("../../../packages/shared-config/src");
const {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
} = require("../../../packages/shared-utils/src");
const { ROLES } = require("../../../packages/shared-types/src");
const {
  createRingCentralClient,
  getRingcxVoiceRateLimitState,
} = require("../../../packages/shared-integrations/src");
const { publishDemoEvent } = require("../../../packages/shared-services/src/demoEventService");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { buildServiceHealth } = require("../../../packages/shared-observability/src");
const { toErrorResponse } = require("../../../packages/shared-errors/src");
const {
  buildCxCadenceRuntimeSnapshot,
  buildCxQueuesForAgents,
  clearScheduledTelephonySessions,
  claimNextCxQueueItem,
  createCxCallPlacedEvent,
  executeCxDispatchIntent,
  executeCxHangupRequest,
  getScheduledTelephonySessionState,
  processPresenceEnvelope,
  processCxCadenceEventBatch,
  publishQueueItemToRingcx,
  exPresencePollMode,
  getFreshHotLaneSnapshot,
  getCxAgentStateByExtensionId,
  listCxAgentStates,
  mirrorAgentState,
  rebuildFreshHotLane,
  releaseCxQueueBatch,
  releaseManualUnavailableAgentQueues,
  relayRingcentralTelephonyForwarded,
  runFreshHotLaneAllocator,
  runRingcxAgentMonitor,
  scheduleTelephonySessionEnvelope,
  seedPresenceForAgents,
  startPresencePoller,
} = require("../../../packages/shared-services/src");
const {
  isCxMorningQueueBuilderEnabled,
  readCxMorningQueueBuilderOptionsFromEnv,
  runCxMorningQueueBuilder,
} = require("../../../packages/shared-services/src/cxMorningQueueBuilderService");
const {
  getCxRuntimeMode,
  isBulkLoadAlphaRuntime,
} = require("../../../packages/shared-services/src/cxRuntimeModeService");
const {
  assignCxQueueBatch,
  cancelCxQueueItem,
  completeCxQueueItem,
  previewCxAssignment,
  previewCxAssignmentBuild,
  reconcileRequestedCxCadence,
  releaseCxQueueItem,
  rescheduleCxQueueItem,
  stageCxDispatchIntent,
} = require("../../../packages/shared-services/src/cxCadenceService");
const {
  runSubscriptionWatchdog,
  checkEventSilence,
  recordRingcentralEvent,
  getWatchdogState,
} = require("../../../packages/shared-services/src/ringcentralSubscriptionWatchdogService");
const { createEvent } = require("../../../packages/event-core/src");

function isLeadDeliveryVoiceOwnerEnabled(env = process.env) {
  return String(env?.LEAD_DELIVERY_ENABLED || "").trim().toLowerCase() === "true";
}

function buildInternalAccessMiddleware(config) {
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
        role: ROLES.SERVICE,
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

// buildAuthenticatedAccessMiddleware — like requireInternalAccess but
// admits ANY authenticated user (admin / manager / internal-agent /
// widget-user) plus the service-secret header. Permission gating is
// done by chaining requirePermission() after this in the route chain.
//
// Used for queue / dial / dispose / availability endpoints that agents
// need to call. Service-secret short-circuit grants the service role
// (which has all permissions implicitly via admin-like treatment in the
// permissions catalog when used directly — but we model it explicitly:
// service identity gets a permissions claim for compat).
function buildAuthenticatedAccessMiddleware(config) {
  const bearerAuth = requireAuth(config);
  const configuredSecret = String(config.internalServiceSecret || "").trim();
  const { effectivePermissionsFor } = require("../../../packages/shared-auth/src");

  return (req, res, next) => {
    const providedSecret = String(
      req.headers["x-service-secret"] ||
      req.headers["x-internal-secret"] ||
      "",
    ).trim();

    if (configuredSecret && safeSecretEquals(providedSecret, configuredSecret)) {
      // Service identity bypasses bearer auth; mint a synthetic admin-
      // like user so downstream permission checks pass for test scripts
      // / cron callers using the secret. Real production traffic always
      // arrives via Bearer JWT.
      req.user = {
        id: "internal-service",
        role: "admin",                // service-secret = full access by convention
        email: "internal@local",
        permissions: effectivePermissionsFor({ role: "admin" }),
      };
      return next();
    }

    return bearerAuth(req, res, next);
  };
}

// selfOrPermission — for endpoints with :extensionId in the path. Allows
// the request if EITHER:
//   - the path's extensionId matches req.user.extensionId (acting on self), OR
//   - the user has the broader permission (e.g. "agents.read" to view others)
function buildSelfOrPermission(broadPermission, paramName = "extensionId") {
  const { hasPermission } = require("../../../packages/shared-auth/src");
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: "Authentication required" });
    }
    const target = String(req.params[paramName] || "").trim();
    const own = String(req.user.extensionId || "").trim();
    if (target && own && target === own) return next();
    if (hasPermission(req.user, broadPermission)) return next();
    return res.status(403).json({
      ok: false,
      error: "Forbidden",
      hint: `acting on another agent requires '${broadPermission}'`,
    });
  };
}

function isInternalServiceUser(user = {}) {
  return user?.id === "internal-service" || user?.email === "internal@local";
}

function resolveActingAgentId(req, bodyField = "agentId") {
  const tokenAgentId = String(req.user?.extensionId || "").trim();
  const bodyAgentId = String(req.body?.[bodyField] || req.body?.extensionId || "").trim();
  if (isInternalServiceUser(req.user)) {
    return bodyAgentId || tokenAgentId || null;
  }
  if (!tokenAgentId) {
    const error = new Error("Logged-in user is not paired to a RingCentral extension");
    error.status = 403;
    throw error;
  }
  if (bodyAgentId && bodyAgentId !== tokenAgentId) {
    const error = new Error("agentId does not match the logged-in user");
    error.status = 403;
    throw error;
  }
  return tokenAgentId;
}

function summarizeCxAssignedQueueItemForAgentView(item = {}) {
  const queueTicketId = item._id ? String(item._id) : null;
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  const leadBody = metadata.leadBody && typeof metadata.leadBody === "object" ? metadata.leadBody : {};
  const phoneNumber = String(item.phone || leadBody.phone || leadBody.phoneNumber || "").trim();
  const progressiveStageKey = String(
    item.progressiveStageKey || leadBody.progressiveStageKey || metadata.progressiveStageKey || "",
  ).trim();
  const ageBucket =
    progressiveStageKey ||
    item.progressiveStageLabel ||
    item.queueFamily ||
    item.queueTier ||
    "assigned";

  return {
    _id: queueTicketId,
    id: queueTicketId,
    queueTicketId,
    queueSource: "cx-dial-queue",
    leadId: item.caseId != null ? String(item.caseId) : null,
    sourceLogicsCaseId: item.caseId != null ? String(item.caseId) : null,
    caseId: item.caseId != null ? String(item.caseId) : null,
    domain: item.domain || null,
    phoneNumber,
    phone: phoneNumber,
    name: item.name || leadBody.name || null,
    sourceName: item.sourceName || leadBody.sourceName || null,
    intakeSource: item.intakeSource || leadBody.intakeSource || null,
    intakeRoute: item.intakeRoute || leadBody.intakeRoute || null,
    partition: item.queueFamily === "fresh-day1" ? "fresh" : "non_fresh",
    ageBucket,
    state: item.state || null,
    queueState: item.state || null,
    queueFamily: item.queueFamily || null,
    queueTier: item.queueTier || null,
    progressiveStageKey: progressiveStageKey || null,
    progressiveStageIndex: Number.isFinite(Number(item.progressiveStageIndex))
      ? Number(item.progressiveStageIndex)
      : null,
    progressiveStageLabel: item.progressiveStageLabel || null,
    assignedTo: item.assignment?.extensionId || null,
    assignedExtensionId: item.assignment?.extensionId || null,
    assignedAgentName: item.assignment?.agentName || null,
    assignedAt: item.assignment?.assignedAt || null,
    expiresAt: item.claimUntil || null,
    releaseAt: item.releaseAt || null,
    claimUntil: item.claimUntil || null,
    placedCalls: Number(item.placedCalls || 0),
    dailyPlacedCalls: Number(item.dailyPlacedCalls || 0),
    hourlyPlacedCalls: Number(item.hourlyPlacedCalls || 0),
    rcxAccountId: item.rcxAccountId || null,
    rcxDialGroupId: item.rcxDialGroupId || null,
    rcxCampaignId: item.rcxCampaignId || null,
  };
}

function markLegacyAssignedQueueItemForAgentView(item = {}) {
  return {
    ...item,
    queueSource: item.queueSource || "legacy-queue",
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

/**
 * Resolve the RC webhook secret. Required when strict startup validation is
 * on (prod) but optional in dev so the service can still run for testing the
 * HTTP surface / presence poller without a real RC subscription.
 *
 * Strict mode is controlled by `STRICT_STARTUP_VALIDATION` (defaults to
 * NODE_ENV=production). Set `STRICT_STARTUP_VALIDATION=false` to override.
 *
 * When not set in dev: returns null and the webhook handlers refuse traffic.
 */
function resolveWebhookSecret(rcConfig, config, logger) {
  const secret = String(rcConfig.webhookSecret || "").trim();
  if (secret) return secret;

  if (config.startupValidation?.strict) {
    throw new Error(
      "RINGBRIDGE_WEBHOOK_SECRET is required in production for ringcentral-cx",
    );
  }

  logger.warn("ringcentral.webhook.unsigned_mode", {
    reason:
      "RINGBRIDGE_WEBHOOK_SECRET not set; webhook endpoints will reject all traffic until configured",
  });
  return null;
}

function isRingCentralSuspended() {
  const raw = String(process.env.PARALLEL_RC_SUSPENDED || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function isStartupPresenceSeedEnabled() {
  return String(process.env.RC_PRESENCE_STARTUP_SEED_ENABLED || "true").toLowerCase() !== "false";
}

async function startServer() {
  const config = {
    ...getSharedConfig(),
    port: PORTS.ringcentralCx,
    serviceName: SERVICE_NAMES.ringcentralCx,
  };

  const runtime = await initializeServiceRuntime(config);
  // Provider-neutral lead delivery and the legacy RingCX queue builders must
  // never own voice inventory at the same time. This service can still serve
  // read-only RingCX diagnostics and non-voice infrastructure while the new
  // owner is active; only the queue-building/maintenance writers below go dark.
  const leadDeliveryOwnsVoice = isLeadDeliveryVoiceOwnerEnabled(process.env);
  const cadenceWorkerState = createWorkerState();
  const freshHotLaneState = createWorkerState();
  const freshHotLaneMorningState = createWorkerState();
  const morningQueueBuilderState = createWorkerState();
  let freshHotLaneTimer = null;
  let freshHotLaneMorningTimer = null;
  let morningQueueBuilderTimer = null;
  runtime.installSignalHandlers();
  const rc = createRingCentralClient();
  const rcConfig = getRingCentralConfig();
  const requiredWebhookSecret = resolveWebhookSecret(rcConfig, config, runtime.logger);
  const seedPresenceSnapshot = async (logMessage, failureMessage) => {
    if (isRingCentralSuspended()) {
      runtime.logger.info(logMessage, {
        skipped: true,
        reason: "parallel-rc-suspended",
      });
      return;
    }
    if (!isStartupPresenceSeedEnabled()) {
      runtime.logger.info(logMessage, {
        skipped: true,
        reason: "RC_PRESENCE_STARTUP_SEED_ENABLED=false",
      });
      return;
    }
    try {
      const seeded = await seedPresenceForAgents(runtime.logger);
      runtime.logger.info(logMessage, seeded);
    } catch (error) {
      runtime.logger.warn(failureMessage, {
        error: error.message,
      });
    }
  };
  rc.setRefreshCallback(async (context = {}) => {
    runtime.logger.info("ringcentral.platform.reinitialized", {
      reason: context.reason || "refresh",
      authenticatedAt: context.authenticatedAt || null,
    });
    await seedPresenceSnapshot(
      "ringcentral.presence.seeded_after_reinit",
      "ringcentral.presence.seed_after_reinit_failed",
    );
  });
  try {
    await rc.warmupPlatform();
    runtime.logger.info("ringcentral.platform.ready", rc.getAuthStatus());
    await seedPresenceSnapshot(
      "ringcentral.presence.seeded_on_startup",
      "ringcentral.presence.seed_on_startup_failed",
    );
  } catch (error) {
    runtime.logger.warn("ringcentral.platform.warmup_failed", {
      error: error.message,
    });
  }
  let poller = null;
  try {
    poller = startPresencePoller(runtime.logger);
    const exCxDecoupleEnabled =
      String(process.env.RC_CX_EX_DECOUPLE_ENABLED || "").trim().toLowerCase() === "true";
    runtime.logger.info("ringcentral.presence_poller.started", {
      ...poller.getState(),
      cxRuntimeMode: getCxRuntimeMode(),
      exPresencePollMode: exPresencePollMode(),
      exCxDecoupleEnabled,
      exCxPollWriteMode:
        String(process.env.RC_CX_EX_POLL_CX_WRITE_MODE || "").trim()
        || (getCxRuntimeMode() === "cx-only" ? "cx-owned" : exCxDecoupleEnabled ? "preserve" : "legacy"),
    });
  } catch (error) {
    runtime.logger.warn("ringcentral.presence_poller.start_failed", {
      error: error.message,
    });
  }

  // Subscription watchdog — runs every N minutes to renew/recreate the
  // RC push subscription before it silently expires, and checks event
  // silence so a blocked webhook path surfaces even when the RC API
  // reports the subscription as Active.
  //
  // GATED behind `RC_SUBSCRIPTION_WATCHDOG_ENABLED=true`. When off (the
  // default), this process does NOT create or renew RC subscriptions —
  // important during rollout so Parallel doesn't accidentally redirect
  // live prod RC webhooks to itself just because NGROK_DOMAIN is set.
  // Silence detection + event-liveness stamping still run: those are
  // passive and safe.
  const watchdogIntervalMs = Math.max(
    Number(config.ringcentralWatchdogIntervalMs) || 5 * 60 * 1000,
    60_000,
  );
  const watchdogMinRemainingMinutes = Math.max(
    Number(config.ringcentralWatchdogMinRemainingMinutes) || 15,
    5,
  );
  const watchdogWebhookAddress = `${String(rcConfig.webhookBaseUrl || "").replace(/\/+$/, "")}/webhook/ringcentral/session-events`;
  const watchdogEnabled = Boolean(rcConfig.subscriptionWatchdogEnabled);

  let watchdogTimer = null;
  if (watchdogEnabled) {
    runtime.logger.info("ringcentral.watchdog.enabled", {
      webhookAddress: watchdogWebhookAddress,
      intervalMs: watchdogIntervalMs,
      minRemainingMinutes: watchdogMinRemainingMinutes,
    });
    watchdogTimer = setInterval(async () => {
      try {
        await runSubscriptionWatchdog({
          webhookAddress: watchdogWebhookAddress,
          webhookSecret: requiredWebhookSecret,
          minRemainingMinutes: watchdogMinRemainingMinutes,
          logger: runtime.logger,
        });
      } catch (error) {
        runtime.logger.warn("ringcentral.watchdog.tick_failed", {
          error: error.message,
        });
      }
      try {
        await checkEventSilence({ logger: runtime.logger });
      } catch (error) {
        runtime.logger.warn("ringcentral.watchdog.silence_check_failed", {
          error: error.message,
        });
      }
    }, watchdogIntervalMs);
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();

    // First tick runs deferred so slow RC calls don't block server boot.
    setImmediate(() => {
      runSubscriptionWatchdog({
        webhookAddress: watchdogWebhookAddress,
        webhookSecret: requiredWebhookSecret,
        minRemainingMinutes: watchdogMinRemainingMinutes,
        logger: runtime.logger,
      }).catch((error) => {
        runtime.logger.warn("ringcentral.watchdog.first_tick_failed", {
          error: error.message,
        });
      });
    });
  } else {
    runtime.logger.warn("ringcentral.watchdog.disabled", {
      reason: "RC_SUBSCRIPTION_WATCHDOG_ENABLED=false (default). Set to true when Parallel is ready to own the webhook subscription.",
    });
    // Silence check still runs on its own lightweight schedule — it's
    // read-only and safe, and it keeps the ops dashboard honest even
    // while we're not managing the subscription lifecycle.
    watchdogTimer = setInterval(async () => {
      try {
        await checkEventSilence({ logger: runtime.logger });
      } catch (error) {
        runtime.logger.warn("ringcentral.watchdog.silence_check_failed", {
          error: error.message,
        });
      }
    }, watchdogIntervalMs);
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
  }

  const app = express();
  const requireHealthAccess = buildHealthAccessMiddleware(config);
  const requireInternalAccess = buildInternalAccessMiddleware(config);
  // Permission-aware access (admits agents): pair with requirePermission()
  // for fine-grained gating. Service-secret short-circuit still works for
  // test scripts + cron callers.
  const requireAuthenticatedAccess = buildAuthenticatedAccessMiddleware(config);
  app.use(cors({ origin: getCorsOriginResolver(), credentials: true }));
  app.use(express.json({ limit: "2mb" }));

  // Serve the pacing-queue test console + any other static assets
  // dropped in apps/ringcentral-cx/public/. Path matches the dev / prod
  // routing (this app is reachable at port 6101 directly OR via nginx).
  const path = require("path");
  app.use(express.static(path.resolve(__dirname, "..", "public")));

  async function startCxCadenceWorker() {
    if (leadDeliveryOwnsVoice) {
      cadenceWorkerState.enabled = false;
      runtime.logger.warn("ringcentral.cx_cadence.disabled", {
        reason: "lead-delivery-owns-voice",
      });
      return;
    }
    if (bulkLoadAlphaRuntime) {
      cadenceWorkerState.enabled = false;
      runtime.logger.warn("ringcentral.cx_cadence.disabled", {
        reason: "bulk-load-alpha-runtime",
      });
      return;
    }

    const cadenceWorkerEnabledRaw =
      process.env.RC_CX_CADENCE_WORKER_ENABLED
      ?? config.ringCentralCxCadenceWorker?.enabled
      ?? "true";
    const cadenceWorkerEnabled = String(cadenceWorkerEnabledRaw).toLowerCase() !== "false";
    cadenceWorkerState.enabled = cadenceWorkerEnabled;
    if (!cadenceWorkerEnabled) {
      runtime.logger.warn("ringcentral.cx_cadence.disabled", {
        reason: "RC_CX_CADENCE_WORKER_ENABLED=false",
      });
      return;
    }

    // Cadence is the queue-sweep + assignment + cadence-event drain. It
    // does NOT power live click-to-dial (that's webhook-driven via
    // /cx-serving/dispatch-intent). Five-minute cadence is the rule:
    // anything tighter just multiplies Mongo touches without changing
    // operator-visible behavior. Floor stays at 60s for ops safety —
    // never run faster than once a minute even if env says otherwise.
    const intervalMs = Math.max(
      Number(process.env.RC_CX_CADENCE_INTERVAL_MS)
        || Number(config.ringCentralCxCadenceWorker?.intervalMs)
        || 300_000,
      60_000,
    );
    const batchSize = Math.max(Number(config.ringCentralCxCadenceWorker?.batchSize) || 25, 1);
    const maxAttempts = Math.max(Number(config.ringCentralCxCadenceWorker?.maxAttempts) || 5, 1);

    cadenceWorkerState.intervalMs = intervalMs;

    const tick = async () => {
      if (cadenceWorkerState.running) return;
      cadenceWorkerState.running = true;
      cadenceWorkerState.lastStartedAt = new Date();

      try {
        const queueSweep = await releaseCxQueueBatch({ limit: batchSize });
        const assignmentBatch = await assignCxQueueBatch({
          maxCount: batchSize,
          claimMinutes: Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
          queueFamilies: ["fresh-day1"],
          maxOpenAssignments: Math.max(Number(process.env.RC_CX_FRESH_OPEN_ASSIGNMENTS) || 10, 1),
          maxOpenAssignmentsScope: "queue-family",
        });
        const day2To15AssignmentBatch = await assignCxQueueBatch({
          maxCount: Math.max(Number(process.env.RC_CX_DAY2TO15_BATCH_SIZE) || Number(process.env.RC_CX_NONFRESH_BATCH_SIZE) || 25, 1),
          claimMinutes: Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
          queueFamilies: ["fresh-day2to10"],
          randomize: false,
          maxOpenAssignments: Math.max(Number(process.env.RC_CX_DAY2TO15_OPEN_ASSIGNMENTS) || 25, 1),
          maxOpenAssignmentsScope: "queue-family",
        });
        const day16To30AssignmentBatch = await assignCxQueueBatch({
          maxCount: Math.max(Number(process.env.RC_CX_DAY16TO30_BATCH_SIZE) || Number(process.env.RC_CX_NONFRESH_BATCH_SIZE) || 20, 1),
          claimMinutes: Number(process.env.RC_CX_YELLOW_CLAIM_MINUTES) || Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
          queueFamilies: ["fresh-day16to30"],
          randomize: false,
          maxOpenAssignments: Math.max(Number(process.env.RC_CX_DAY16TO30_OPEN_ASSIGNMENTS) || 10, 1),
          maxOpenAssignmentsScope: "queue-family",
        });
        const agedAssignmentBatch = await assignCxQueueBatch({
          maxCount: Math.max(Number(process.env.RC_CX_AGED_BATCH_SIZE) || Number(process.env.RC_CX_NONFRESH_BATCH_SIZE) || 20, 1),
          claimMinutes: Number(process.env.RC_CX_AGED_CLAIM_MINUTES) || Number(process.env.RC_CX_NONFRESH_CLAIM_MINUTES) || 30,
          queueFamilies: ["aged"],
          randomize: false,
          maxOpenAssignments: Math.max(Number(process.env.RC_CX_AGED_OPEN_ASSIGNMENTS) || 5, 1),
          maxOpenAssignmentsScope: "queue-family",
        });
        const nonFreshAssignmentBatch = {
          ok: true,
          requested: Number(day2To15AssignmentBatch.requested || 0) + Number(day16To30AssignmentBatch.requested || 0) + Number(agedAssignmentBatch.requested || 0),
          assigned: Number(day2To15AssignmentBatch.assigned || 0) + Number(day16To30AssignmentBatch.assigned || 0) + Number(agedAssignmentBatch.assigned || 0),
          skipped: Number(day2To15AssignmentBatch.skipped || 0) + Number(day16To30AssignmentBatch.skipped || 0) + Number(agedAssignmentBatch.skipped || 0),
          day2To15AssignmentBatch,
          day16To30AssignmentBatch,
          agedAssignmentBatch,
        };
        const eventBatch = await processCxCadenceEventBatch({
          workerName: `${config.serviceName}-cx-cadence-worker`,
          maxAttempts,
          maxCount: batchSize,
        });
        const requestedCadenceSweep = await reconcileRequestedCxCadence({
          limit: batchSize,
        });
        const queueSnapshot = await buildCxCadenceRuntimeSnapshot();
        cadenceWorkerState.lastCompletedAt = new Date();
        cadenceWorkerState.lastResult = {
          queueSweep,
          assignmentBatch,
          day2To15AssignmentBatch,
          day16To30AssignmentBatch,
          agedAssignmentBatch,
          nonFreshAssignmentBatch,
          eventBatch,
          requestedCadenceSweep,
          queueSnapshot,
        };
        cadenceWorkerState.lastError = null;
        if (
          queueSweep.releasedCount > 0
          || queueSweep.requeuedCount > 0
          || queueSweep.staleServingRequeuedCount > 0
        ) {
          runtime.logger.info("ringcentral.cx_queue.swept", {
            released: queueSweep.releasedCount,
            requeued: queueSweep.requeuedCount,
            staleServingRequeued: queueSweep.staleServingRequeuedCount,
          });
        }
        if (eventBatch.processed > 0) {
          runtime.logger.info("ringcentral.cx_cadence.batch", {
            processed: eventBatch.processed,
            handled: eventBatch.handled,
          });
        }
        if (assignmentBatch.assigned > 0 || assignmentBatch.skipped > 0) {
          runtime.logger.info("ringcentral.cx_queue.assigned", {
            requested: assignmentBatch.requested,
            assigned: assignmentBatch.assigned,
            skipped: assignmentBatch.skipped,
          });
        }
        if (nonFreshAssignmentBatch.assigned > 0 || nonFreshAssignmentBatch.skipped > 0) {
          runtime.logger.info("ringcentral.cx_queue.assigned_nonfresh", {
            requested: nonFreshAssignmentBatch.requested,
            assigned: nonFreshAssignmentBatch.assigned,
            skipped: nonFreshAssignmentBatch.skipped,
            day2To15Assigned: day2To15AssignmentBatch.assigned,
            day16To30Assigned: day16To30AssignmentBatch.assigned,
            agedAssigned: agedAssignmentBatch.assigned,
          });
        }
        if (
          requestedCadenceSweep.requeued > 0
          || requestedCadenceSweep.completed > 0
          || requestedCadenceSweep.cancelled > 0
        ) {
          runtime.logger.info("ringcentral.cx_cadence.reconciled", {
            scanned: requestedCadenceSweep.scanned,
            preserved: requestedCadenceSweep.preserved,
            requeued: requestedCadenceSweep.requeued,
            completed: requestedCadenceSweep.completed,
            cancelled: requestedCadenceSweep.cancelled,
            errors: requestedCadenceSweep.errors,
          });
        }
      } catch (error) {
        cadenceWorkerState.lastCompletedAt = new Date();
        cadenceWorkerState.lastError = error.message;
        runtime.logger.error("ringcentral.cx_cadence.failed", {
          error: error.message,
        });
      } finally {
        cadenceWorkerState.running = false;
      }
    };

    cadenceWorkerState.timer = setInterval(tick, intervalMs);
    if (typeof cadenceWorkerState.timer.unref === "function") {
      cadenceWorkerState.timer.unref();
    }

    await tick();
  }

  function findNextPacificWeekdayTime(hour = 7, minute = 0) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    });
    const now = new Date();
    const probe = new Date(now);
    for (let i = 0; i < 7 * 24 * 60; i += 1) {
      probe.setTime(now.getTime() + (i + 1) * 60 * 1000);
      const parts = fmt.formatToParts(probe);
      const lookup = (type) => parts.find((part) => part.type === type)?.value;
      const weekday = lookup("weekday");
      const zonedHour = Number(lookup("hour"));
      const zonedMinute = Number(lookup("minute"));
      if (
        ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)
        && zonedHour === hour
        && zonedMinute === minute
      ) {
        return new Date(probe);
      }
    }
    return null;
  }

  async function runFreshHotLaneWorkerTick(state, mode) {
    if (state.running) return;
    state.running = true;
    state.lastStartedAt = new Date();
    try {
      const result = await runFreshHotLaneAllocator({
        mode,
        maxCount: Number(process.env.RC_CX_FRESH_HOT_LANE_BATCH_SIZE) || 50,
        claimMinutes: Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
      });
      state.lastResult = {
        mode,
        assigned: result.assigned || 0,
        before: result.before || null,
        after: result.after || null,
        windowStart: result.windowStart || null,
        windowEnd: result.windowEnd || null,
      };
      state.lastError = null;
      if (result.assigned > 0 || result.sweep?.requeuedCount > 0) {
        runtime.logger?.info?.("ringcentral.cx_fresh_hot_lane.completed", {
          mode,
          assigned: result.assigned,
          requeued: result.sweep?.requeuedCount || 0,
          windowStart: result.windowStart,
          windowEnd: result.windowEnd,
        });
      }
    } catch (error) {
      state.lastError = error.message;
      runtime.logger?.warn?.("ringcentral.cx_fresh_hot_lane.failed", {
        mode,
        error: error.message,
      });
    } finally {
      state.lastCompletedAt = new Date();
      state.running = false;
    }
  }

  function startFreshHotLaneWorker() {
    if (leadDeliveryOwnsVoice) {
      freshHotLaneState.enabled = false;
      freshHotLaneMorningState.enabled = false;
      runtime.logger?.warn?.("ringcentral.cx_fresh_hot_lane.disabled", {
        reason: "lead-delivery-owns-voice",
      });
      return;
    }
    if (bulkLoadAlphaRuntime) {
      freshHotLaneState.enabled = false;
      freshHotLaneMorningState.enabled = false;
      runtime.logger?.warn?.("ringcentral.cx_fresh_hot_lane.disabled", {
        reason: "bulk-load-alpha-runtime",
      });
      return;
    }

    const enabled = String(process.env.RC_CX_FRESH_HOT_LANE_ENABLED || "true").toLowerCase() !== "false";
    freshHotLaneState.enabled = enabled;
    freshHotLaneMorningState.enabled = enabled;
    if (!enabled) {
      runtime.logger?.warn?.("ringcentral.cx_fresh_hot_lane.disabled", {
        reason: "RC_CX_FRESH_HOT_LANE_ENABLED=false",
      });
      return;
    }

    const intervalMs = Math.max(
      Number(process.env.RC_CX_FRESH_HOT_LANE_INTERVAL_MS) || 5 * 60 * 1000,
      60_000,
    );
    freshHotLaneState.intervalMs = intervalMs;
    freshHotLaneTimer = setInterval(() => {
      void runFreshHotLaneWorkerTick(freshHotLaneState, "tick");
    }, intervalMs);
    if (typeof freshHotLaneTimer.unref === "function") freshHotLaneTimer.unref();

    setImmediate(() => {
      rebuildFreshHotLane({ mode: "boot" })
        .then((result) => {
          freshHotLaneState.lastResult = {
            mode: "boot-rebuild",
            before: { count: result.count, byState: result.byState },
            windowStart: result.windowStart,
            windowEnd: result.windowEnd,
          };
          return runFreshHotLaneWorkerTick(freshHotLaneState, "boot");
        })
        .catch((error) => {
          freshHotLaneState.lastError = error.message;
        });
    });

    const scheduleNextMorningHotLane = () => {
      if (freshHotLaneMorningTimer) {
        clearTimeout(freshHotLaneMorningTimer);
        freshHotLaneMorningTimer = null;
      }
      const target = findNextPacificWeekdayTime(
        Number(process.env.RC_CX_FRESH_HOT_LANE_MORNING_HOUR) || 7,
        Number(process.env.RC_CX_FRESH_HOT_LANE_MORNING_MINUTE) || 0,
      );
      if (!target) {
        freshHotLaneMorningTimer = setTimeout(scheduleNextMorningHotLane, 60 * 60 * 1000);
        if (typeof freshHotLaneMorningTimer.unref === "function") freshHotLaneMorningTimer.unref();
        return;
      }
      freshHotLaneMorningState.intervalMs = target.getTime() - Date.now();
      freshHotLaneMorningTimer = setTimeout(async () => {
        await runFreshHotLaneWorkerTick(freshHotLaneMorningState, "morning-7am");
        scheduleNextMorningHotLane();
      }, Math.max(target.getTime() - Date.now(), 1000));
      if (typeof freshHotLaneMorningTimer.unref === "function") freshHotLaneMorningTimer.unref();
    };

    scheduleNextMorningHotLane();
    runtime.logger?.info?.("ringcentral.cx_fresh_hot_lane.registered", {
      intervalMs,
      morningHour: Number(process.env.RC_CX_FRESH_HOT_LANE_MORNING_HOUR) || 7,
    });
  }

  // ── Pacing queue workers ──────────────────────────────────────────
  //
  // Three timers wire up the Universal Call Queue:
  //   1. Hourly orchestrator   — fires at the top of each hour. Generates
  //      the prior-hour PacingReport, rolls counters, releases prior
  //      slices, refills pool, issues fresh slices to eligible agents,
  //      drains pending fresh-lead lane.
  //   2. 60s tick              — runs the fresh-lead expiry sweep + idle
  //      reaper + pool emptiness watcher. Cheap, just keeps things flowing.
  //   3. Morning prep (7am M-F) — pre-warms the pool before 8am rollover.
  //
  // All three short-circuit when:
  //   - PACING_QUEUE_ENABLED env flag is false (default)
  //   - PacingConfig.enabled is false
  //   - It's outside the configured business window (per-cron, with
  //     morning-prep being the explicit off-hours exception)
  function startMorningQueueBuilderWorker() {
    const enabled = !leadDeliveryOwnsVoice && isCxMorningQueueBuilderEnabled(process.env);
    morningQueueBuilderState.enabled = enabled;
    if (!enabled) {
      runtime.logger?.info?.("ringcentral.cx_morning_queue_builder.disabled", {
        reason: leadDeliveryOwnsVoice
          ? "lead-delivery-owns-voice"
          : "CX_MORNING_QUEUE_BUILDER_ENABLED=false or bulk-load runtime disabled",
      });
      return;
    }

    const hour = Math.max(0, Math.min(23, Number(process.env.CX_MORNING_QUEUE_BUILDER_HOUR) || 7));
    const minute = Math.max(0, Math.min(59, Number(process.env.CX_MORNING_QUEUE_BUILDER_MINUTE) || 0));

    const scheduleNextMorningQueueBuilder = () => {
      if (morningQueueBuilderTimer) {
        clearTimeout(morningQueueBuilderTimer);
        morningQueueBuilderTimer = null;
      }

      const target = findNextPacificWeekdayTime(hour, minute);
      if (!target) {
        morningQueueBuilderTimer = setTimeout(scheduleNextMorningQueueBuilder, 60 * 60 * 1000);
        if (typeof morningQueueBuilderTimer.unref === "function") {
          morningQueueBuilderTimer.unref();
        }
        return;
      }

      const delayMs = Math.max(target.getTime() - Date.now(), 1000);
      morningQueueBuilderState.intervalMs = delayMs;
      morningQueueBuilderTimer = setTimeout(async () => {
        if (morningQueueBuilderState.running) {
          scheduleNextMorningQueueBuilder();
          return;
        }
        morningQueueBuilderState.running = true;
        morningQueueBuilderState.lastStartedAt = new Date();
        try {
          const result = await runCxMorningQueueBuilder(
            readCxMorningQueueBuilderOptionsFromEnv(process.env, runtime.logger),
          );
          morningQueueBuilderState.lastResult = {
            ok: result.ok,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            totals: result.totals,
            agents: result.agents.map((row) => ({
              email: row.agent?.email || null,
              extensionId: row.agent?.extensionId || null,
              domain: row.agent?.domain || null,
              drain: row.drain && {
                candidates: row.drain.candidates,
                cancelled: row.drain.cancelled,
                errors: row.drain.errors?.length || 0,
              },
              build: row.build && {
                ok: row.build.ok,
                built: row.build.built,
                before: row.build.before,
                after: row.build.after,
                targetOpen: row.build.targetOpen,
              },
              mirror: row.mirror && {
                attempted: row.mirror.attempted,
                published: row.mirror.published,
                reused: row.mirror.reused,
                deferred: row.mirror.deferred,
                errored: row.mirror.errored,
                skipped: row.mirror.skipped,
              },
              elapsedMs: row.elapsedMs,
              error: row.error,
            })),
          };
          morningQueueBuilderState.lastError = null;
          runtime.logger?.info?.("ringcentral.cx_morning_queue_builder.completed", {
            totals: morningQueueBuilderState.lastResult.totals,
          });
        } catch (error) {
          morningQueueBuilderState.lastError = error.message;
          runtime.logger?.warn?.("ringcentral.cx_morning_queue_builder.failed", {
            error: error.message,
          });
        } finally {
          morningQueueBuilderState.lastCompletedAt = new Date();
          morningQueueBuilderState.running = false;
          scheduleNextMorningQueueBuilder();
        }
      }, delayMs);
      if (typeof morningQueueBuilderTimer.unref === "function") {
        morningQueueBuilderTimer.unref();
      }
    };

    scheduleNextMorningQueueBuilder();
    runtime.logger?.info?.("ringcentral.cx_morning_queue_builder.registered", {
      hour,
      minute,
      enabledBy: process.env.CX_MORNING_QUEUE_BUILDER_ENABLED
        ? "CX_MORNING_QUEUE_BUILDER_ENABLED"
        : "CX_DIAL_RUNTIME_BULK_LOAD_ENABLED",
      limit: Number(process.env.CX_MORNING_QUEUE_BUILDER_LIMIT) || 30,
    });
  }

  const pacingQueueEnabled = !leadDeliveryOwnsVoice
    && String(process.env.PACING_QUEUE_ENABLED || "").toLowerCase() === "true";
  const pacingHourlyState = createWorkerState();
  const pacingTickState = createWorkerState();
  const pacingMorningPrepState = createWorkerState();
  const staleDialSweepState = createWorkerState();
  const ringcxAgentMonitorState = createWorkerState();
  let pacingHourlyTimer = null;
  let pacingTickTimer = null;
  let pacingMorningPrepTimer = null;
  let staleDialSweepTimer = null;
  let ringcxAgentMonitorTimer = null;

  if (pacingQueueEnabled) {
    const {
      runHourlyPacing,
      runMorningPacingPrep,
      freshLeadExpirySweep,
      idleReaperTick,
      emptinessWatcherTick,
    } = require("../../../packages/shared-services/src");
    const { sweepStaleStates } = require("../../../packages/shared-services/src/dialService");

    // ── 1. Hourly orchestrator ─────────────────────────────────────
    const scheduleNextHourly = () => {
      // Clear any pending timer (re-arm is single-shot; this guards
      // against double-arming if scheduleNextHourly is called twice).
      if (pacingHourlyTimer) {
        clearTimeout(pacingHourlyTimer);
        pacingHourlyTimer = null;
      }
      const now = new Date();
      const next = new Date(now);
      next.setMinutes(0, 0, 0);
      next.setHours(now.getHours() + 1);
      const delayMs = Math.max(next.getTime() - now.getTime(), 1000);
      pacingHourlyTimer = setTimeout(async () => {
        if (pacingHourlyState.running) {
          scheduleNextHourly();
          return;
        }
        pacingHourlyState.running = true;
        pacingHourlyState.lastStartedAt = new Date();
        try {
          const result = await runHourlyPacing({ asOf: new Date() });
          pacingHourlyState.lastResult = {
            skipped: result.skipped || false,
            reason: result.reason || null,
            slicesIssued: result.slicesIssued || 0,
            newHourBucket: result.newHourBucket || null,
          };
          pacingHourlyState.lastError = null;
          runtime.logger?.info?.("pacing.hourly.completed", pacingHourlyState.lastResult);
        } catch (error) {
          pacingHourlyState.lastError = error.message;
          runtime.logger?.warn?.("pacing.hourly.failed", { error: error.message });
        } finally {
          pacingHourlyState.lastCompletedAt = new Date();
          pacingHourlyState.running = false;
          scheduleNextHourly();
        }
      }, delayMs);
      if (typeof pacingHourlyTimer.unref === "function") pacingHourlyTimer.unref();
    };
    pacingHourlyState.enabled = true;
    scheduleNextHourly();

    // ── 2. 60s tick: fresh expiry + idle reaper + emptiness watcher ─
    const tickIntervalMs = 60_000;
    pacingTickState.enabled = true;
    pacingTickState.intervalMs = tickIntervalMs;
    pacingTickTimer = setInterval(async () => {
      if (pacingTickState.running) return;
      pacingTickState.running = true;
      pacingTickState.lastStartedAt = new Date();
      try {
        const [expiry, reaped, emptiness, stale] = await Promise.all([
          freshLeadExpirySweep().catch((e) => ({ error: e.message })),
          idleReaperTick().catch((e) => ({ error: e.message })),
          emptinessWatcherTick().catch((e) => ({ error: e.message })),
          sweepStaleStates({ logger: runtime.logger }).catch((e) => ({ error: e.message })),
        ]);
        pacingTickState.lastResult = { expiry, reaped, emptiness, stale };
        pacingTickState.lastError = null;
      } catch (error) {
        pacingTickState.lastError = error.message;
      } finally {
        pacingTickState.lastCompletedAt = new Date();
        pacingTickState.running = false;
      }
    }, tickIntervalMs);
    if (typeof pacingTickTimer.unref === "function") pacingTickTimer.unref();

    // ── 3. Morning prep (7am PT M-F) ───────────────────────────────
    //
    // Single-shot scheduler that re-arms after firing. Computes time
    // until next 7am PT, fires runMorningPacingPrep, reschedules.
    const scheduleNextMorningPrep = () => {
      if (pacingMorningPrepTimer) {
        clearTimeout(pacingMorningPrepTimer);
        pacingMorningPrepTimer = null;
      }
      // 7am Pacific in UTC: PDT (Mar-Nov) = 14:00 UTC; PST (Nov-Mar) = 15:00 UTC.
      // Compute via Intl to avoid DST math.
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
      });
      const now = new Date();
      const probe = new Date(now);
      // Walk forward in 30-min increments until we hit 7:00 Pacific
      // on a business day. Bounded loop, max 48 hours.
      let target = null;
      for (let i = 0; i < 96; i += 1) {
        probe.setTime(now.getTime() + (i + 1) * 30 * 60 * 1000);
        const parts = fmt.formatToParts(probe);
        const lookup = (t) => parts.find((p) => p.type === t)?.value;
        const weekday = lookup("weekday");
        const hour = parseInt(lookup("hour"), 10);
        const minute = parseInt(lookup("minute"), 10);
        if (
          ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday)
          && hour === 7 && minute === 0
        ) {
          target = new Date(probe);
          break;
        }
      }
      if (!target) {
        // Fallback: re-check in 1 hour
        pacingMorningPrepTimer = setTimeout(scheduleNextMorningPrep, 60 * 60 * 1000);
        if (typeof pacingMorningPrepTimer.unref === "function") pacingMorningPrepTimer.unref();
        return;
      }
      const delayMs = Math.max(target.getTime() - now.getTime(), 1000);
      pacingMorningPrepTimer = setTimeout(async () => {
        if (pacingMorningPrepState.running) {
          scheduleNextMorningPrep();
          return;
        }
        pacingMorningPrepState.running = true;
        pacingMorningPrepState.lastStartedAt = new Date();
        try {
          const result = await runMorningPacingPrep({ asOf: new Date() });
          pacingMorningPrepState.lastResult = {
            skipped: result.skipped || false,
            reason: result.reason || null,
            addedCount: result.refillResult?.addedCount || 0,
          };
          pacingMorningPrepState.lastError = null;
          runtime.logger?.info?.("pacing.morningPrep.completed", pacingMorningPrepState.lastResult);
        } catch (error) {
          pacingMorningPrepState.lastError = error.message;
          runtime.logger?.warn?.("pacing.morningPrep.failed", { error: error.message });
        } finally {
          pacingMorningPrepState.lastCompletedAt = new Date();
          pacingMorningPrepState.running = false;
          scheduleNextMorningPrep();
        }
      }, delayMs);
      if (typeof pacingMorningPrepTimer.unref === "function") pacingMorningPrepTimer.unref();
    };
    pacingMorningPrepState.enabled = true;
    scheduleNextMorningPrep();

    runtime.logger?.info?.("pacing.queue.workers.registered", {
      hourly: true,
      tickIntervalMs,
      morningPrep: true,
    });
  }

  const bulkLoadAlphaRuntime = isBulkLoadAlphaRuntime();
  const staleDialSweepEnabled =
    !leadDeliveryOwnsVoice
    && !bulkLoadAlphaRuntime
    && String(process.env.RCX_STALE_DIAL_SWEEP_ENABLED || "true").toLowerCase() !== "false";
  const staleDialSweepIntervalMs = Math.max(
    Number(process.env.RCX_STALE_DIAL_SWEEP_INTERVAL_MS) || 30_000,
    10_000,
  );
  staleDialSweepState.enabled = staleDialSweepEnabled;
  staleDialSweepState.intervalMs = staleDialSweepIntervalMs;
  if (staleDialSweepEnabled) {
    staleDialSweepTimer = setInterval(async () => {
      if (staleDialSweepState.running) return;
      staleDialSweepState.running = true;
      staleDialSweepState.lastStartedAt = new Date();
      try {
        const { sweepStaleStates } = require("../../../packages/shared-services/src/dialService");
        const [stale] = await Promise.all([
          sweepStaleStates({ logger: runtime.logger }),
        ]);
        staleDialSweepState.lastResult = {
          stale,
        };
        staleDialSweepState.lastError = null;
      } catch (error) {
        staleDialSweepState.lastError = error.message;
        runtime.logger?.warn?.("dial.staleSweep.failed", { error: error.message });
      } finally {
        staleDialSweepState.lastCompletedAt = new Date();
        staleDialSweepState.running = false;
      }
    }, staleDialSweepIntervalMs);
    if (typeof staleDialSweepTimer.unref === "function") staleDialSweepTimer.unref();
    runtime.logger?.info?.("dial.staleSweep.registered", {
      intervalMs: staleDialSweepIntervalMs,
    });
  } else {
    runtime.logger?.info?.("dial.staleSweep.disabled", {
      reason: bulkLoadAlphaRuntime ? "bulk-load-alpha-runtime" : "env-disabled",
    });
  }

  const ringcxAgentMonitorEnabled =
    !leadDeliveryOwnsVoice
    && !bulkLoadAlphaRuntime
    && String(process.env.RINGCX_AGENT_MONITOR_ENABLED || "true").toLowerCase() !== "false";
  const ringcxAgentMonitorIntervalMs = Math.max(
    Number(process.env.RINGCX_AGENT_MONITOR_INTERVAL_MS) || 30_000,
    10_000,
  );
  ringcxAgentMonitorState.enabled = ringcxAgentMonitorEnabled;
  ringcxAgentMonitorState.intervalMs = ringcxAgentMonitorIntervalMs;
  if (ringcxAgentMonitorEnabled) {
    ringcxAgentMonitorTimer = setInterval(async () => {
      if (ringcxAgentMonitorState.running) return;
      ringcxAgentMonitorState.running = true;
      ringcxAgentMonitorState.lastStartedAt = new Date();
      try {
        const now = new Date();
        const [ringcxAgentMonitor, pauseRelease] = await Promise.all([
          runRingcxAgentMonitor({ logger: runtime.logger, now }),
          releaseManualUnavailableAgentQueues({ now }),
        ]);
        ringcxAgentMonitorState.lastResult = {
          ringcxAgentMonitor,
          pauseRelease,
        };
        ringcxAgentMonitorState.lastError = null;
      } catch (error) {
        ringcxAgentMonitorState.lastError = error.message;
        runtime.logger?.warn?.("ringcx.agentMonitor.failed", { error: error.message });
      } finally {
        ringcxAgentMonitorState.lastCompletedAt = new Date();
        ringcxAgentMonitorState.running = false;
      }
    }, ringcxAgentMonitorIntervalMs);
    if (typeof ringcxAgentMonitorTimer.unref === "function") ringcxAgentMonitorTimer.unref();
    runtime.logger?.info?.("ringcx.agentMonitor.registered", {
      intervalMs: ringcxAgentMonitorIntervalMs,
    });
  } else {
    runtime.logger?.info?.("ringcx.agentMonitor.disabled", {
      reason: bulkLoadAlphaRuntime ? "bulk-load-alpha-runtime" : "env-disabled",
    });
  }

  app.get("/health", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, runtime.getMongoState()));
    }
    res.json({
      ...buildServiceHealth(config, runtime.getMongoState()),
      ringcentral: rc.getAuthStatus(),
      ringcxVoice: {
        rateLimits: getRingcxVoiceRateLimitState(),
      },
      subscriptionWatchdog: {
        enabled: watchdogEnabled,
        ...getWatchdogState(),
      },
      presencePoller: poller ? poller.getState() : { enabled: false },
      telephonyQueue: getScheduledTelephonySessionState(),
      cxCadenceWorker: {
        enabled: cadenceWorkerState.enabled,
        running: cadenceWorkerState.running,
        intervalMs: cadenceWorkerState.intervalMs,
        lastStartedAt: cadenceWorkerState.lastStartedAt,
        lastCompletedAt: cadenceWorkerState.lastCompletedAt,
        lastError: cadenceWorkerState.lastError,
      },
      freshHotLane: {
        enabled: freshHotLaneState.enabled,
        running: freshHotLaneState.running,
        intervalMs: freshHotLaneState.intervalMs,
        lastStartedAt: freshHotLaneState.lastStartedAt,
        lastCompletedAt: freshHotLaneState.lastCompletedAt,
        lastError: freshHotLaneState.lastError,
        snapshot: getFreshHotLaneSnapshot(),
      },
      morningQueueBuilder: {
        enabled: morningQueueBuilderState.enabled,
        running: morningQueueBuilderState.running,
        intervalMs: morningQueueBuilderState.intervalMs,
        lastStartedAt: morningQueueBuilderState.lastStartedAt,
        lastCompletedAt: morningQueueBuilderState.lastCompletedAt,
        lastError: morningQueueBuilderState.lastError,
      },
      staleDialSweep: {
        enabled: staleDialSweepState.enabled,
        running: staleDialSweepState.running,
        intervalMs: staleDialSweepState.intervalMs,
        lastStartedAt: staleDialSweepState.lastStartedAt,
        lastCompletedAt: staleDialSweepState.lastCompletedAt,
        lastError: staleDialSweepState.lastError,
      },
      ringcxAgentMonitor: {
        enabled: ringcxAgentMonitorState.enabled,
        running: ringcxAgentMonitorState.running,
        intervalMs: ringcxAgentMonitorState.intervalMs,
        lastStartedAt: ringcxAgentMonitorState.lastStartedAt,
        lastCompletedAt: ringcxAgentMonitorState.lastCompletedAt,
        lastError: ringcxAgentMonitorState.lastError,
      },
    });
  });

  app.get("/api/ringcentral/runtime", requireInternalAccess, (_req, res) => {
    res.json({
      ok: true,
      auth: rc.getAuthStatus(),
      subscriptionWatchdog: {
        enabled: watchdogEnabled,
        ...getWatchdogState(),
      },
      presencePoller: poller ? poller.getState() : { enabled: false },
      telephonyQueue: getScheduledTelephonySessionState(),
      cxCadenceWorker: {
        enabled: cadenceWorkerState.enabled,
        running: cadenceWorkerState.running,
        intervalMs: cadenceWorkerState.intervalMs,
        lastStartedAt: cadenceWorkerState.lastStartedAt,
        lastCompletedAt: cadenceWorkerState.lastCompletedAt,
        lastResult: cadenceWorkerState.lastResult,
        lastError: cadenceWorkerState.lastError,
      },
      freshHotLane: {
        worker: {
          enabled: freshHotLaneState.enabled,
          running: freshHotLaneState.running,
          intervalMs: freshHotLaneState.intervalMs,
          lastStartedAt: freshHotLaneState.lastStartedAt,
          lastCompletedAt: freshHotLaneState.lastCompletedAt,
          lastResult: freshHotLaneState.lastResult,
          lastError: freshHotLaneState.lastError,
        },
        morning: {
          enabled: freshHotLaneMorningState.enabled,
          running: freshHotLaneMorningState.running,
          intervalMs: freshHotLaneMorningState.intervalMs,
          lastStartedAt: freshHotLaneMorningState.lastStartedAt,
          lastCompletedAt: freshHotLaneMorningState.lastCompletedAt,
          lastResult: freshHotLaneMorningState.lastResult,
          lastError: freshHotLaneMorningState.lastError,
        },
        snapshot: getFreshHotLaneSnapshot(),
      },
      morningQueueBuilder: {
        enabled: morningQueueBuilderState.enabled,
        running: morningQueueBuilderState.running,
        intervalMs: morningQueueBuilderState.intervalMs,
        lastStartedAt: morningQueueBuilderState.lastStartedAt,
        lastCompletedAt: morningQueueBuilderState.lastCompletedAt,
        lastResult: morningQueueBuilderState.lastResult,
        lastError: morningQueueBuilderState.lastError,
      },
      staleDialSweep: {
        enabled: staleDialSweepState.enabled,
        running: staleDialSweepState.running,
        intervalMs: staleDialSweepState.intervalMs,
        lastStartedAt: staleDialSweepState.lastStartedAt,
        lastCompletedAt: staleDialSweepState.lastCompletedAt,
        lastResult: staleDialSweepState.lastResult,
        lastError: staleDialSweepState.lastError,
      },
      ringcxAgentMonitor: {
        enabled: ringcxAgentMonitorState.enabled,
        running: ringcxAgentMonitorState.running,
        intervalMs: ringcxAgentMonitorState.intervalMs,
        lastStartedAt: ringcxAgentMonitorState.lastStartedAt,
        lastCompletedAt: ringcxAgentMonitorState.lastCompletedAt,
        lastResult: ringcxAgentMonitorState.lastResult,
        lastError: ringcxAgentMonitorState.lastError,
      },
    });
  });

  app.get("/api/ringcentral/cx-queue/runtime", requireInternalAccess, async (req, res) => {
    const snapshot = await buildCxCadenceRuntimeSnapshot(req.query?.domain || null);
    return res.json({
      ok: true,
      queue: snapshot,
      worker: {
        enabled: cadenceWorkerState.enabled,
        running: cadenceWorkerState.running,
        intervalMs: cadenceWorkerState.intervalMs,
        lastStartedAt: cadenceWorkerState.lastStartedAt,
        lastCompletedAt: cadenceWorkerState.lastCompletedAt,
        lastResult: cadenceWorkerState.lastResult,
        lastError: cadenceWorkerState.lastError,
      },
    });
  });

  app.get("/api/ringcentral/cx-fresh-hot-lane/runtime", requireInternalAccess, (_req, res) => {
    return res.json({
      ok: true,
      worker: {
        enabled: freshHotLaneState.enabled,
        running: freshHotLaneState.running,
        intervalMs: freshHotLaneState.intervalMs,
        lastStartedAt: freshHotLaneState.lastStartedAt,
        lastCompletedAt: freshHotLaneState.lastCompletedAt,
        lastResult: freshHotLaneState.lastResult,
        lastError: freshHotLaneState.lastError,
      },
      morning: {
        enabled: freshHotLaneMorningState.enabled,
        running: freshHotLaneMorningState.running,
        intervalMs: freshHotLaneMorningState.intervalMs,
        lastStartedAt: freshHotLaneMorningState.lastStartedAt,
        lastCompletedAt: freshHotLaneMorningState.lastCompletedAt,
        lastResult: freshHotLaneMorningState.lastResult,
        lastError: freshHotLaneMorningState.lastError,
      },
      snapshot: getFreshHotLaneSnapshot(),
    });
  });

  app.post("/api/ringcentral/cx-fresh-hot-lane/rebuild", requireInternalAccess, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const domains = Array.isArray(body.domains)
        ? body.domains
        : body.domain
          ? [body.domain]
          : body.domains || null;
      const result = await rebuildFreshHotLane({
        mode: body.mode || "manual-rebuild",
        domains,
        asOf: body.asOf || null,
        windowStart: body.windowStart || null,
        windowEnd: body.windowEnd || null,
        limit: body.limit || undefined,
      });
      freshHotLaneState.lastResult = {
        mode: "manual-rebuild",
        before: { count: result.count, byState: result.byState },
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
      };
      freshHotLaneState.lastError = null;
      return res.json({ ok: true, result, snapshot: getFreshHotLaneSnapshot() });
    } catch (error) {
      freshHotLaneState.lastError = error.message;
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-fresh-hot-lane/run", requireInternalAccess, async (req, res) => {
    if (freshHotLaneState.running) {
      return res.status(409).json({
        ok: false,
        error: "fresh-hot-lane-already-running",
        worker: freshHotLaneState,
      });
    }

    freshHotLaneState.running = true;
    freshHotLaneState.lastStartedAt = new Date();
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const domains = Array.isArray(body.domains)
        ? body.domains
        : body.domain
          ? [body.domain]
          : body.domains || null;
      const result = await runFreshHotLaneAllocator({
        mode: body.mode || "manual",
        domains,
        asOf: body.asOf || null,
        maxCount: body.maxCount || Number(process.env.RC_CX_FRESH_HOT_LANE_BATCH_SIZE) || 50,
        claimMinutes: body.claimMinutes || Number(process.env.RC_CX_FRESH_CLAIM_MINUTES) || 15,
        maxOpenAssignments: body.maxOpenAssignments || null,
        candidateExtensionIds: Array.isArray(body.candidateExtensionIds) ? body.candidateExtensionIds : [],
        requestKeyPrefix: body.requestKeyPrefix || `fresh-hot-lane:manual:${Date.now()}`,
      });
      freshHotLaneState.lastResult = {
        mode: result.mode,
        assigned: result.assigned || 0,
        before: result.before || null,
        after: result.after || null,
        windowStart: result.windowStart || null,
        windowEnd: result.windowEnd || null,
      };
      freshHotLaneState.lastError = null;
      return res.json({ ok: true, result, snapshot: getFreshHotLaneSnapshot() });
    } catch (error) {
      freshHotLaneState.lastError = error.message;
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    } finally {
      freshHotLaneState.lastCompletedAt = new Date();
      freshHotLaneState.running = false;
    }
  });

  app.get("/api/ringcentral/cx-serving/runtime", requireInternalAccess, async (req, res) => {
    try {
      const snapshot = await buildCxCadenceRuntimeSnapshot(req.query?.domain || null);
      return res.json({
        ok: true,
        serving: snapshot,
        worker: {
          enabled: cadenceWorkerState.enabled,
          running: cadenceWorkerState.running,
          intervalMs: cadenceWorkerState.intervalMs,
          lastStartedAt: cadenceWorkerState.lastStartedAt,
          lastCompletedAt: cadenceWorkerState.lastCompletedAt,
          lastResult: cadenceWorkerState.lastResult,
          lastError: cadenceWorkerState.lastError,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/preview-assign", requireInternalAccess, async (req, res) => {
    try {
      const result = await previewCxAssignment({
        domain: req.body?.domain || null,
        queueItemId: req.body?.queueItemId || null,
        caseId: req.body?.caseId != null ? Number(req.body.caseId) : null,
        item: req.body?.item && typeof req.body.item === "object" ? req.body.item : null,
        extensionId: req.body?.extensionId || null,
        candidateExtensionIds: Array.isArray(req.body?.candidateExtensionIds)
          ? req.body.candidateExtensionIds
          : [],
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/preview-build", requireInternalAccess, async (req, res) => {
    try {
      const result = await previewCxAssignmentBuild({
        domain: req.body?.domain || null,
        maxCount: req.body?.maxCount || 10,
        extensionId: req.body?.extensionId || null,
        candidateExtensionIds: Array.isArray(req.body?.candidateExtensionIds)
          ? req.body.candidateExtensionIds
          : [],
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/assign-batch", requireInternalAccess, async (req, res) => {
    try {
      const result = await assignCxQueueBatch({
        domain: req.body?.domain || null,
        maxCount: req.body?.maxCount || 10,
        claimMinutes: req.body?.claimMinutes || 5,
        queueFamily: req.body?.queueFamily || null,
        queueFamilies: Array.isArray(req.body?.queueFamilies) ? req.body.queueFamilies : [],
        randomize: Boolean(req.body?.randomize),
        preferQueueFamilyOrder: req.body?.preferQueueFamilyOrder !== false,
        maxOpenAssignments: req.body?.maxOpenAssignments || null,
        maxOpenAssignmentsScope: req.body?.maxOpenAssignmentsScope || null,
        extensionId: req.body?.extensionId || null,
        candidateExtensionIds: Array.isArray(req.body?.candidateExtensionIds)
          ? req.body.candidateExtensionIds
          : [],
        requestKeyPrefix: req.body?.requestKeyPrefix || null,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/dispatch-intent", requireInternalAccess, async (req, res) => {
    const startedAt = Date.now();
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const staged = await stageCxDispatchIntent({
        queueItemId: body.queueItemId || body.queueTicketId || null,
        domain: body.domain || null,
        caseId: body.caseId != null ? Number(body.caseId) : null,
        dispatchIntent: body,
        source: req.user?.email || body.requestedBy || "ringcentral-cx",
        status: "staged",
      });
      const stagedAt = Date.now();
      const execution = await executeCxDispatchIntent({
        queueItemId: staged?.queueItemId || body.queueItemId || body.queueTicketId || null,
        domain: body.domain || null,
        caseId: body.caseId != null ? Number(body.caseId) : null,
        dispatchIntent: body,
        source: req.user?.email || body.requestedBy || "ringcentral-cx",
        logger: runtime.logger,
      });
      runtime.logger.info("ringcentral.cx_dispatch_intent.completed", {
        queueItemId: staged?.queueItemId || body.queueItemId || body.queueTicketId || null,
        domain: body.domain || null,
        caseId: body.caseId != null ? Number(body.caseId) : null,
        executionMode: body.executionMode || execution?.mode || null,
        ok: execution?.ok !== false,
        queued: Boolean(execution?.queued),
        uii: execution?.uii || null,
        callSessionId: execution?.callSessionId || null,
        activeCallCaptureReason: execution?.activeCallCapture?.reason || null,
        activeCallCaptureOk: execution?.activeCallCapture?.ok ?? null,
        stagedMs: stagedAt - startedAt,
        executionMs: Date.now() - stagedAt,
        totalMs: Date.now() - startedAt,
      });
      if (execution?.ok === false) {
        return res.status(execution.retryable === false ? 409 : 502).json({
          ok: false,
          accepted: false,
          error: execution.reason || execution.error || "cx-dispatch-execution-failed",
          result: {
            staged,
            execution,
          },
        });
      }
      return res.status(202).json({
        ok: true,
        accepted: true,
        result: {
          staged,
          execution,
        },
      });
    } catch (error) {
      runtime.logger.warn("ringcentral.cx_dispatch_intent.failed", {
        queueItemId: req.body?.queueItemId || req.body?.queueTicketId || null,
        domain: req.body?.domain || null,
        caseId: req.body?.caseId != null ? Number(req.body.caseId) : null,
        executionMode: req.body?.executionMode || null,
        error: error.message,
        totalMs: Date.now() - startedAt,
      });
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/end-call", requireInternalAccess, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const execution = await executeCxHangupRequest({
        queueItemId: body.queueItemId || body.queueTicketId || null,
        domain: body.domain || null,
        caseId: body.caseId != null ? Number(body.caseId) : null,
        uii: body.uii || null,
        phone: body.phone || null,
        assignedExtensionId: body.assignedExtensionId || null,
        requestedByUserEmail: body.requestedByUserEmail || null,
        dispatchIntent: body,
        source: req.user?.email || body.requestedBy || "ringcentral-cx",
      });
      if (execution?.ok === false) {
        return res.status(execution.retryable === false ? 409 : 502).json({
          ok: false,
          accepted: false,
          error: execution.reason || execution.error || "cx-hangup-execution-failed",
          result: {
            execution,
          },
        });
      }
      return res.status(202).json({
        ok: true,
        accepted: true,
        result: {
          execution,
        },
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/:queueItemId/publish", requireInternalAccess, async (req, res) => {
    try {
      const result = await publishQueueItemToRingcx({
        queueItemId: req.params.queueItemId,
        force: String(req.body?.force || "").trim().toLowerCase() === "true" || req.body?.force === true,
      });
      return res.status(result?.published ? 200 : 202).json({
        ok: Boolean(result?.ok),
        result,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/:queueItemId/release", requireInternalAccess, async (req, res) => {
    try {
      const result = await releaseCxQueueItem({
        queueItemId: req.params.queueItemId,
        reason: req.body?.reason || "manual-release",
        releaseAt: req.body?.releaseAt || null,
        actorEmail: req.user?.email || null,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/:queueItemId/reschedule", requireInternalAccess, async (req, res) => {
    try {
      const result = await rescheduleCxQueueItem({
        queueItemId: req.params.queueItemId,
        reason: req.body?.reason || "rescheduled",
        releaseAt: req.body?.releaseAt || null,
        actorEmail: req.user?.email || null,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/:queueItemId/complete", requireInternalAccess, async (req, res) => {
    try {
      const result = await completeCxQueueItem({
        queueItemId: req.params.queueItemId,
        queueOutcome: req.body?.queueOutcome || "completed",
        disposition: req.body?.disposition || null,
        statusId: req.body?.statusId != null ? Number(req.body.statusId) : null,
        statusCategory: req.body?.statusCategory || null,
        statusLabel: req.body?.statusLabel || null,
        workflowId: req.body?.workflowId || null,
        actorEmail: req.user?.email || null,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-serving/:queueItemId/cancel", requireInternalAccess, async (req, res) => {
    try {
      const result = await cancelCxQueueItem({
        queueItemId: req.params.queueItemId,
        reason: req.body?.reason || "cancelled",
        queueOutcome: req.body?.queueOutcome || "cancelled",
        disposition: req.body?.disposition || null,
        statusId: req.body?.statusId != null ? Number(req.body.statusId) : null,
        statusCategory: req.body?.statusCategory || null,
        statusLabel: req.body?.statusLabel || null,
        workflowId: req.body?.workflowId || null,
        actorEmail: req.user?.email || null,
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-queue/process-batch", requireInternalAccess, async (req, res) => {
    try {
      const queueSweep = await releaseCxQueueBatch({ limit: req.body?.maxCount || 25 });
      const eventBatch = await processCxCadenceEventBatch({
        workerName: `${config.serviceName}-cx-cadence-manual`,
        maxAttempts: config.ringCentralCxCadenceWorker?.maxAttempts || 5,
        maxCount: req.body?.maxCount || config.ringCentralCxCadenceWorker?.batchSize || 25,
      });
      const snapshot = await buildCxCadenceRuntimeSnapshot();
      return res.json({
        ok: true,
        queueSweep,
        eventBatch,
        snapshot,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-queue/build-agents", requireInternalAccess, async (req, res) => {
    try {
      const body = req.body || {};
      const extensionIds = Array.isArray(body.extensionIds)
        ? body.extensionIds
        : String(body.extensionIds || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
      const result = await buildCxQueuesForAgents({
        domain: body.domain || null,
        extensionIds,
        limit: body.limit || 50,
        previewLimit: body.previewLimit || 8,
        maxAgents: body.maxAgents || null,
      });
      return res.status(result.ok ? 200 : 207).json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-queue/claim-next", requireInternalAccess, async (req, res) => {
    try {
      const result = await claimNextCxQueueItem({
        domain: req.body?.domain || null,
        claimMinutes: req.body?.claimMinutes || 5,
        requestKey: req.body?.requestKey || null,
        extensionId: req.body?.extensionId || null,
        candidateExtensionIds: Array.isArray(req.body?.candidateExtensionIds)
          ? req.body.candidateExtensionIds
          : [],
      });
      return res.json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/cx-queue/:queueItemId/call-placed", requireInternalAccess, async (req, res) => {
    try {
      const payload = {
        queueItemId: req.params.queueItemId,
        caseId: req.body?.caseId != null ? Number(req.body.caseId) : null,
        placedAt: req.body?.placedAt || new Date().toISOString(),
        uii: req.body?.uii || req.body?.telephonySessionId || null,
        callSessionId: req.body?.callSessionId || req.body?.sessionId || null,
        phone: req.body?.phone || null,
        actionKey: req.body?.actionKey || null,
        agentEmail: req.body?.agentEmail || null,
        assignedExtensionId: req.body?.assignedExtensionId || req.body?.extensionId || null,
        confirmedCall: true,
        countAsAttempt: true,
        sourceService: config.serviceName,
      };
      const result = await createCxCallPlacedEvent({
        sourceService: config.serviceName,
        dedupeKey: `cx-call-placed:${req.params.queueItemId}:${payload.placedAt}`,
        processImmediately: true,
        payload,
      });
      return res.status(202).json({
        ok: true,
        accepted: true,
        eventId: String(result.event?._id || result._id || ""),
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/ringcentral/reinitialize", requireInternalAccess, async (_req, res) => {
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

  app.post("/api/ringcentral/subscription/check", requireInternalAccess, async (_req, res) => {
    // Manual trigger shares the gate — even explicit ops calls can't
    // create/renew unless the env flag is on. Reading current state is
    // still fine (returns null subscriptionId + lastCheckError note).
    if (!watchdogEnabled) {
      return res.status(409).json({
        ok: false,
        error:
          "Subscription watchdog disabled. Set RC_SUBSCRIPTION_WATCHDOG_ENABLED=true to manage the RC subscription from this process.",
        state: getWatchdogState(),
      });
    }
    try {
      const result = await runSubscriptionWatchdog({
        webhookAddress: watchdogWebhookAddress,
        webhookSecret: requiredWebhookSecret,
        minRemainingMinutes: watchdogMinRemainingMinutes,
        logger: runtime.logger,
      });
      return res.json({ ok: true, result, state: getWatchdogState() });
    } catch (error) {
      return res.status(error.status || 500).json({
        ok: false,
        error: error.message,
      });
    }
  });

  app.post("/api/ringcentral/presence/seed", requireInternalAccess, async (_req, res) => {
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

  app.post("/api/ringcentral/presence/poll", requireInternalAccess, async (_req, res) => {
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

  // List all agents — broad view: requires agents.read (manager+).
  app.get("/api/agents", requireAuthenticatedAccess, requirePermission("agents.read"), async (_req, res) => {
    const agents = await listCxAgentStates();
    res.json({
      ok: true,
      agents,
    });
  });

  // Read one agent — agents.read for others, agents.read-self for own.
  app.get(
    "/api/agents/:extensionId",
    requireAuthenticatedAccess,
    requirePermission("agents.read-self"),
    buildSelfOrPermission("agents.read"),
    async (req, res) => {
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
    },
  );

  // ── Pacing queue admin endpoints ──────────────────────────────
  //
  // Singleton config (the two primary numbers + business hours +
  // timer values), audit history, and hourly pacing reports.
  // All require internal access. The endpoints exist regardless of
  // PACING_QUEUE_ENABLED; they just return empty/zero data when the
  // workers haven't run yet.
  app.get("/api/admin/pacing", requireAuthenticatedAccess, requirePermission("pacing.read"), async (_req, res) => {
    try {
      const {
        getPacingConfig,
        listRecentPacingReports,
      } = require("../../../packages/shared-services/src");
      const [config, recentReports] = await Promise.all([
        getPacingConfig({ force: true }),
        listRecentPacingReports({ limit: 24 }),
      ]);
      res.json({
        ok: true,
        config,
        recentReports,
        workers: {
          hourly: pacingHourlyState,
          tick: pacingTickState,
          morningPrep: pacingMorningPrepState,
          enabled: pacingQueueEnabled,
        },
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.put("/api/admin/pacing", requireAuthenticatedAccess, requirePermission("pacing.write"), async (req, res) => {
    try {
      const {
        validatePacingPatch,
        updatePacingConfig,
      } = require("../../../packages/shared-services/src");
      const patch = req.body?.patch || req.body || {};
      const validation = validatePacingPatch(patch);
      if (!validation.ok) {
        return res.status(400).json({ ok: false, errors: validation.errors });
      }
      const updatedBy = req.user?.email || req.user?.id || "internal-service";
      const updated = await updatePacingConfig(patch, { updatedBy });
      runtime.logger.info("pacing.config.updated", {
        updatedBy,
        fields: Object.keys(patch),
      });
      return res.json({ ok: true, config: updated });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/admin/pacing/history", requireAuthenticatedAccess, requirePermission("pacing.read"), async (req, res) => {
    try {
      const { getPacingConfigHistory } = require("../../../packages/shared-services/src");
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
      const history = await getPacingConfigHistory({ limit });
      res.json({ ok: true, history });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/admin/pacing/reports", requireAuthenticatedAccess, requirePermission("pacing.read"), async (req, res) => {
    try {
      const { listRecentPacingReports } = require("../../../packages/shared-services/src");
      const limit = Math.min(Math.max(Number(req.query.limit) || 24, 1), 720);
      const reports = await listRecentPacingReports({ limit });
      res.json({ ok: true, reports });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/admin/pacing/reports/:hourBucket", requireAuthenticatedAccess, requirePermission("pacing.read"), async (req, res) => {
    try {
      const { getPacingReport, formatPacingReportText } = require("../../../packages/shared-services/src");
      const report = await getPacingReport(req.params.hourBucket);
      if (!report) return res.status(404).json({ ok: false, error: "report-not-found" });
      res.json({ ok: true, report, formatted: formatPacingReportText(report) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Manual trigger — useful for testing without waiting for the next
  // hour rollover. Idempotent if a hourly run is already in flight.
  app.post("/api/admin/pacing/run-hourly", requireAuthenticatedAccess, requirePermission("pacing.run"), async (_req, res) => {
    try {
      if (pacingHourlyState.running) {
        return res.status(409).json({ ok: false, error: "hourly-already-running" });
      }
      const { runHourlyPacing } = require("../../../packages/shared-services/src");
      pacingHourlyState.running = true;
      pacingHourlyState.lastStartedAt = new Date();
      const result = await runHourlyPacing({ asOf: new Date() });
      pacingHourlyState.lastCompletedAt = new Date();
      pacingHourlyState.lastResult = {
        skipped: result.skipped || false,
        reason: result.reason || null,
        slicesIssued: result.slicesIssued || 0,
      };
      pacingHourlyState.running = false;
      res.json({ ok: true, result });
    } catch (error) {
      pacingHourlyState.lastError = error.message;
      pacingHourlyState.running = false;
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/api/admin/pacing/refill", requireAuthenticatedAccess, requirePermission("pacing.run"), async (req, res) => {
    try {
      const { refillPool } = require("../../../packages/shared-services/src");
      const floor = Number(req.body?.floor) || null;
      const result = await refillPool({ floor, force: Boolean(req.body?.force) });
      res.json({ ok: true, result });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // ── Test seeding: enqueue synthetic items into the UCQ ─────────
  // POST body: { items: [{ leadId, phoneNumber, partition, ageBucket, ... }] }
  // OR { count: 3, phoneNumber, partition, ageBucket } for quick batch.
  app.post("/api/admin/pacing/seed-test-items", requireAuthenticatedAccess, requirePermission("queue.seed-test"), async (req, res) => {
    try {
      const { enqueueLead } = require("../../../packages/shared-services/src");
      const items = Array.isArray(req.body?.items) ? req.body.items : null;
      if (items?.length) {
        const results = [];
        for (const item of items) {
          results.push(await enqueueLead(item));
        }
        return res.json({ ok: true, count: items.length, results });
      }
      const count = Math.min(Math.max(Number(req.body?.count) || 1, 1), 100);
      const phoneNumber = req.body?.phoneNumber || "+13106665997";
      const partition = req.body?.partition || "non_fresh";
      const ageBucket = req.body?.ageBucket || "day2_10";
      const domain = req.body?.domain || "TAG";
      const baseLeadId = req.body?.leadIdPrefix || `test-${Date.now()}`;
      const results = [];
      for (let i = 0; i < count; i += 1) {
        results.push(await enqueueLead({
          leadId: `${baseLeadId}-${i}`,
          phoneNumber,
          partition,
          ageBucket,
          domain,
        }));
      }
      return res.json({ ok: true, count, results });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // ── Per-agent queue view ─────────────────────────────────────────
  // Returns the agent's slice (non-fresh), assigned fresh leads, and
  // any active CallSession.
  // Agent's own queue: requires `queue.read`. Viewing another agent's
  // queue requires `agents.read` (managers + admins). Self-check is via
  // selfOrPermission helper.
  app.get(
    "/api/agents/:extensionId/queue",
    requireAuthenticatedAccess,
    requirePermission("queue.read"),
    buildSelfOrPermission("agents.read"),
    async (req, res) => {
    try {
      const {
        agentSliceRepository,
        queueItemRepository,
        callSessionRepository,
        agentStateRepository,
        cxDialQueueRepository,
      }
        = require("../../../packages/shared-repositories/src");
      const agentId = String(req.params.extensionId);
      const agent = await agentStateRepository.findAgentStateByExtensionId(agentId);
      if (!agent) return res.status(404).json({ ok: false, error: "agent-not-found" });

      const [slice, sliceItems, freshAssigned, activeCall, cxAssignedRaw] = await Promise.all([
        agentSliceRepository.findActiveByAgent(agentId),
        // Resolve slice items if there is a slice; otherwise empty
        (async () => {
          const s = await agentSliceRepository.findActiveByAgent(agentId);
          if (!s) return [];
          return queueItemRepository.listBySlice(s.sliceId);
        })(),
        queueItemRepository.listByAgent(agentId, { states: ["fresh_assigned"] }),
        callSessionRepository.findActiveByAgent(agentId),
        cxDialQueueRepository.listQueueItems({
          assignedExtensionId: agentId,
          states: ["queued", "ready", "claimed", "serving", "paused"],
          limitAll: true,
        }),
      ]);
      const cxAssigned = cxAssignedRaw.map(summarizeCxAssignedQueueItemForAgentView);
      const legacyAssigned = freshAssigned.map(markLegacyAssignedQueueItemForAgentView);

      return res.json({
        ok: true,
        agent: {
          extensionId: agent.extensionId,
          name: agent.name,
          activityState: agent.activityState || "offline",
          cxRouting: agent.cxRouting || null,
          lastActivityAt: agent.lastActivityAt,
        },
        slice,
        sliceItems,
        freshAssigned,
        cxAssigned,
        cxQueueItems: cxAssigned,
        assignedQueueItems: [
          ...cxAssigned,
          ...legacyAssigned,
        ],
        activeCall,
      });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // ── Click-to-dial ────────────────────────────────────────────────
  // Click-to-dial: requires queue.dial. The dial service itself
  // verifies the queue item is assigned to the calling agent.
  app.post(
    "/api/queue/:itemId/dial",
    requireAuthenticatedAccess,
    requirePermission("queue.dial"),
    async (req, res) => {
    try {
      const { dialPlaceCall } = require("../../../packages/shared-services/src");
      const itemId = req.params.itemId;
      const agentId = resolveActingAgentId(req);
      if (!agentId) return res.status(400).json({ ok: false, error: "agentId required" });
      const result = await dialPlaceCall(agentId, itemId, { logger: runtime.logger });
      const status = result.ok ? 200 : 400;
      return res.status(status).json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // ── Dispose (terminate + record outcome) ─────────────────────────
  // Body shape:
  //   { agentId, dispositionKey, payload?, callSessionId? }
  // SPA can pass either a callSessionId (most precise) or rely on
  // server-side lookup by itemId.
  // Dispose: requires queue.dispose. The dial service verifies the
  // call session belongs to the calling agent.
  app.post(
    "/api/queue/:itemId/dispose",
    requireAuthenticatedAccess,
    requirePermission("queue.dispose"),
    async (req, res) => {
    try {
      const { dialTerminateAndDispose }
        = require("../../../packages/shared-services/src");
      const repos = require("../../../packages/shared-repositories/src");
      const { CallSession } = require("../../../packages/shared-models/src");

      const itemId = req.params.itemId;
      const dispositionKey = String(req.body?.dispositionKey || "").trim();
      const agentId = resolveActingAgentId(req);
      const payload = req.body?.payload || {};
      const explicitCallSessionId = req.body?.callSessionId || null;
      if (!dispositionKey) return res.status(400).json({ ok: false, error: "dispositionKey required" });

      // Find the CallSession to dispose against. Lookup precedence:
      //   1. explicit callSessionId from caller
      //   2. active session for this queue item
      //   3. most recent (any-state) session for this queue item
      let target = null;
      if (explicitCallSessionId) {
        target = await repos.callSessionRepository.findById(explicitCallSessionId);
      }
      if (!target) {
        target = await repos.callSessionRepository.findActiveByQueueItem(itemId);
      }
      if (!target) {
        // Fallback: any-state session for this queue item, sorted by recency.
        target = await CallSession.findOne({ queueItemId: itemId })
          .sort({ startedAt: -1 })
          .lean();
      }
      if (!target) {
        return res.status(404).json({ ok: false, error: "no-call-session-for-item" });
      }
      if (target.queueItemId && String(target.queueItemId) !== String(itemId)) {
        return res.status(409).json({ ok: false, error: "call-session-item-mismatch" });
      }

      const result = await dialTerminateAndDispose(target._id, dispositionKey, {
        payload, agentId, logger: runtime.logger,
      });
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // ── Disposition map (for SPA to render buttons + validate) ──────
  // Disposition catalog: any agent can read so the SPA renders buttons.
  app.get("/api/queue/dispositions", requireAuthenticatedAccess, requirePermission("queue.read"), (_req, res) => {
    const { listDispositions } = require("../../../packages/shared-services/src");
    res.json({ ok: true, dispositions: listDispositions() });
  });

  // ── Agent availability toggles (manual unavail) ─────────────────
  // Toggle unavailable: agent can toggle SELF (agents.toggle-availability)
  // OR a manager toggling another agent (agents.toggle-others).
  app.post(
    "/api/agents/:extensionId/unavailable",
    requireAuthenticatedAccess,
    requirePermission("agents.toggle-availability"),
    buildSelfOrPermission("agents.toggle-others"),
    async (req, res) => {
    try {
      const { setActivityState } = require("../../../packages/shared-services/src");
      const updated = await setActivityState(req.params.extensionId, "unavailable", {
        source: "cx-workspace",
        breakType: req.body?.breakType || "short-break",
      });
      if (!updated) return res.status(404).json({ ok: false, error: "agent-not-found" });
      return res.json({ ok: true, agent: updated });
    } catch (error) {
      return res.status(error.status || 500).json({ ok: false, error: error.message });
    }
  });

  // Toggle available: same self/other semantics as unavailable.
  app.post(
    "/api/agents/:extensionId/available",
    requireAuthenticatedAccess,
    requirePermission("agents.toggle-availability"),
    buildSelfOrPermission("agents.toggle-others"),
    async (req, res) => {
    try {
      const { setActivityState, onAgentBecomesEligible }
        = require("../../../packages/shared-services/src");
      const updated = await setActivityState(req.params.extensionId, "idle", {
        source: "cx-workspace",
      });
      if (!updated) return res.status(404).json({ ok: false, error: "agent-not-found" });
      // Also kick the eligibility hook so any pending fresh leads land on this agent
      if (
        updated.activityState === "idle"
        && updated.cxRouting?.desiredAvailability === "available"
      ) {
        await onAgentBecomesEligible(req.params.extensionId).catch(() => null);
      }
      return res.json({ ok: true, agent: updated });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post("/ringbridge/agent-state", requireInternalAccess, async (req, res) => {
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

    const verificationToken = String(req.headers["verification-token"] || "").trim();
    if (!verificationToken || verificationToken !== requiredWebhookSecret) {
      runtime.logger.warn("ringcentral.ex.invalid_token", {
        verificationToken,
      });
      return res.status(401).send("Invalid token");
    }

    res.status(200).send("OK");

    runtime.logger.info("ringcentral.ex.webhook.ack_only", {
      reason: "cx-bulk-alpha-test-disable-ex-presence-side-effects",
    });

    /*
    // Presence webhooks share the same RC subscription as session
    // events, so a delivery here also counts as proof-of-life.
    recordRingcentralEvent("ringcentral.ex.presence");

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
    */
  }

  app.post("/webhook/ex", handlePresenceWebhook);
  app.post("/webhook/ringcentral/ex", handlePresenceWebhook);

  app.post("/webhook/ringcentral/session-events", async (req, res) => {
    const validationToken = req.headers["validation-token"];
    if (validationToken) {
      res.setHeader("Validation-Token", validationToken);
      return res.status(200).send("OK");
    }

    const verificationToken = String(req.headers["verification-token"] || "").trim();
    if (!verificationToken || verificationToken !== requiredWebhookSecret) {
      runtime.logger.warn("ringcentral.webhook.invalid_token", {
        verificationToken,
      });
      return res.status(401).send("Invalid token");
    }

    res.status(200).send("OK");

    const envelope = req.body || {};
    // Stamp liveness BEFORE any downstream work — if persistence errors
    // follow, we still know the webhook pipe is alive.
    recordRingcentralEvent("ringcentral.telephony.webhook");
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
      try {
        await relayRingcentralTelephonyForwarded({
          domain: envelope.body?.company || envelope.body?.domain || "TAG",
          envelope,
          candidates: queued?.candidates || [],
        });
      } catch (error) {
        runtime.logger.warn("ringcentral.telephony.control_plane_relay_failed", {
          error: error.message,
          telephonySessionId: envelope.body?.telephonySessionId || null,
        });
      }
      runtime.logger.info("ringcentral.telephony.webhook.accepted", {
        telephonySessionId: envelope.body?.telephonySessionId || null,
        queued: queued.queued,
        candidatesCount: queued.queued,
      });
    } catch (error) {
      runtime.logger.error("ringcentral.telephony.webhook.schedule_failed", {
        error: error.message,
        telephonySessionId: envelope.body?.telephonySessionId || null,
      });
    }
  });

  app.post("/api/ring/events", requireInternalAccess, async (req, res) => {
    const result = await publishDemoEvent("ring", config.serviceName, req.body || {});

    res.status(202).json({
      ok: true,
      accepted: true,
      deduped: result.deduped,
      eventId: String(result.event._id),
    });
  });

  app.post("/api/inbound/cx-first-contact-forward", requireInternalAccess, async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const event = String(payload.event || "").trim() || "unknown";
    const dedupeKey = String(payload.dedupeKey || req.headers["x-forward-id"] || "").trim() || null;
    const domain = String(payload.domain || "").trim().toUpperCase() || null;
    const caseId = payload.caseId == null ? null : String(payload.caseId).trim();

    runtime.logger.info("ringcentral.cx_first_contact_forward.received", {
      event,
      domain,
      caseId,
      leadCadenceId: payload.leadCadenceId || null,
      queueItemId: payload.queueItemId || null,
      queueFamily: payload.queueFamily || null,
      state: payload.state || null,
      dedupeKey,
      sourceService: payload.sourceService || null,
    });

    return res.status(202).json({
      ok: true,
      accepted: true,
      event,
      dedupeKey,
    });
  });

  app.use((error, _req, res, _next) => {
    runtime.logger.error("ringcentral.request.failed", {
      error: error.message,
      status: error.status || 500,
    });
    res.status(error.status || 500).json(toErrorResponse(error));
  });

  const server = app.listen(config.port, config.bindHost, () => {
    runtime.logger.info("listening", { host: config.bindHost, port: config.port });
  });

  server.on("close", () => {
    if (poller) {
      poller.stop();
    }
    if (cadenceWorkerState.timer) {
      clearInterval(cadenceWorkerState.timer);
      cadenceWorkerState.timer = null;
    }
    if (staleDialSweepTimer) {
      clearInterval(staleDialSweepTimer);
      staleDialSweepTimer = null;
    }
    if (ringcxAgentMonitorTimer) {
      clearInterval(ringcxAgentMonitorTimer);
      ringcxAgentMonitorTimer = null;
    }
    if (morningQueueBuilderTimer) {
      clearTimeout(morningQueueBuilderTimer);
      morningQueueBuilderTimer = null;
    }
    clearInterval(watchdogTimer);
    rc.stopWarmupTimer();
  });

  runtime.registerCleanup("ringcentral-server", () => new Promise((resolve) => server.close(() => resolve())));
  runtime.registerCleanup("ringcentral-presence-poller", async () => {
    if (poller) {
      poller.stop();
    }
  });
  runtime.registerCleanup("ringcentral-cx-cadence-worker", async () => {
    if (cadenceWorkerState.timer) {
      clearInterval(cadenceWorkerState.timer);
      cadenceWorkerState.timer = null;
    }
  });
  runtime.registerCleanup("ringcentral-fresh-hot-lane", async () => {
    if (freshHotLaneTimer) {
      clearInterval(freshHotLaneTimer);
      freshHotLaneTimer = null;
    }
    if (freshHotLaneMorningTimer) {
      clearTimeout(freshHotLaneMorningTimer);
      freshHotLaneMorningTimer = null;
    }
  });
  runtime.registerCleanup("ringcentral-morning-queue-builder", async () => {
    if (morningQueueBuilderTimer) {
      clearTimeout(morningQueueBuilderTimer);
      morningQueueBuilderTimer = null;
    }
  });
  runtime.registerCleanup("ringcentral-stale-dial-sweep", async () => {
    if (staleDialSweepTimer) {
      clearInterval(staleDialSweepTimer);
      staleDialSweepTimer = null;
    }
  });
  runtime.registerCleanup("ringcentral-agent-monitor", async () => {
    if (ringcxAgentMonitorTimer) {
      clearInterval(ringcxAgentMonitorTimer);
      ringcxAgentMonitorTimer = null;
    }
  });
  runtime.registerCleanup("ringcentral-subscription-watchdog", async () => {
    clearInterval(watchdogTimer);
  });
  runtime.registerCleanup("ringcentral-refresh-timer", async () => {
    rc.stopWarmupTimer();
  });
  runtime.registerCleanup("ringcentral-telephony-queue", async () => {
    clearScheduledTelephonySessions();
  });

  await startCxCadenceWorker();
  startFreshHotLaneWorker();
  startMorningQueueBuilderWorker();

  return server;
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("[ringcentral-cx] failed to start", error);
    process.exit(1);
  });
}

module.exports = {
  isLeadDeliveryVoiceOwnerEnabled,
  startServer,
};
