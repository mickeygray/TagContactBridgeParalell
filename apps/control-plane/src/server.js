"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { getCorsOriginResolver, PORTS } = require("../../../packages/shared-config/src");
const {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
} = require("../../../packages/shared-utils/src");
const {
  buildServiceHealth,
  buildTopologyHealth,
  redactContent,
  redactPhone,
} = require("../../../packages/shared-observability/src");
const { buildAuthMiddleware } = require("./middleware/auth");
const { createAdminAccountsRouter } = require("./routes/adminAccounts");
const { createAdminCallReviewRouter } = require("./routes/adminCallReview");
const { createAdminCadenceToolsRouter } = require("./routes/adminCadenceTools");
const { createAdminConsentRouter } = require("./routes/adminConsent");
const { createAuthRouter } = require("./routes/auth");
const { createCallrailRouter } = require("./routes/callrail");
const { createCommandsClientsRouter } = require("./routes/commandsClients");
const { createCommandsCxRouter } = require("./routes/commandsCx");
const { createCxSimpleLoopRouter } = require("./routes/cxSimpleLoop");
const { createCxSlowSingleRouter } = require("./routes/cxSlowSingle");
const { createCxBulkLoadRouter } = require("./routes/cxBulkLoad");
const { createCommandsDeployRouter } = require("./routes/commandsDeploy");
const { createCommandsInboxRouter } = require("./routes/commandsInbox");
const { createCommandsSocialRouter } = require("./routes/commandsSocial");
const { createDispatchRouter } = require("./routes/dispatch");
const { createDomainsRouter } = require("./routes/domains");
const { createDropRouter } = require("./routes/drop");
const { createEventsRouter } = require("./routes/events");
const { createHealthRouter } = require("./routes/health");
const { createHygieneRouter } = require("./routes/hygiene");
const { createLiveCoachProxyRouter } = require("./routes/liveCoachProxy");
const { createLogicsRouter } = require("./routes/logics");
const { createLexisRouter } = require("./routes/lexis");
const { createResolutionIntelligenceRouter } = require("./routes/resolutionIntelligence");
const { createMetricsRouter } = require("./routes/metrics");
const { createReadClientsRouter } = require("./routes/readClients");
const { createReadCxRouter } = require("./routes/readCx");
const {
  createRecordingPlaybackRouter,
} = require("./routes/recordingPlayback");
const { createReadDeployRouter } = require("./routes/readDeploy");
const { createReadInboxRouter } = require("./routes/readInbox");
const { createReadLibraryRouter } = require("./routes/readLibrary");
const { createReadMetricsRouter } = require("./routes/readMetrics");
const { createReadRouter } = require("./routes/read");
const { createReadReviewRouter } = require("./routes/readReview");
const { createRuntimeRouter } = require("./routes/runtime");
const { createReadRingcentralRouter } = require("./routes/readRingcentral");
const { createReadSocialRouter } = require("./routes/readSocial");
const { createReadWorkspaceRouter } = require("./routes/readWorkspace");
const { createRingCentralRouter } = require("./routes/ringcentral");
const { createSalesTrainerRouter } = require("./routes/salesTrainer");
const { createSendgridRouter } = require("./routes/sendgrid");
const { createWorkflowsRouter } = require("./routes/workflows");
const { createWorklistsRouter } = require("./routes/worklists");
const { getControlPlaneConfig } = require("./services/appConfig");
const { createLexisNightlyRuntime } = require("./services/lexisNightlyService");
const { createLexisDailyDropRuntime } = require("./services/lexisDailyDropRuntime");
const { createLogicsActivityReviewRuntime } = require("./services/logicsActivityReviewRuntime");
const { createNightlyCloseRuntime } = require("./services/nightlyCloseRuntime");
const { createCxNightlyCallGradeRuntime } = require("./services/cxNightlyCallGradeRuntime");
const { createEodRecordingArchiveRuntime } = require("./services/eodRecordingArchiveRuntime");
const { createPhoneburnerRotationRuntime } = require("./services/phoneburnerRotationRuntime");
const { createDemoRingoutRuntime } = require("./services/demoRingoutRuntime");
const { createBloggerRuntime } = require("./services/bloggerRuntime");
const { initializeServiceRuntime } = require("../../../packages/shared-runtime/src");
const { createEvent } = require("../../../packages/event-core/src");
const { toErrorResponse } = require("../../../packages/shared-errors/src");
const {
  leadCadenceRepository,
  caseProfileRepository,
  cxAgentCallNoteRepository,
  cxBulkLoadSessionRepository,
  cxDialQueueRepository,
  cxTerminalOutboxRepository,
  cxCallWrapCardRepository,
} = require("../../../packages/shared-repositories/src");
const {
  LiveCoachSession,
} = require("../../../packages/shared-models/src");

const CLIENT_RUNTIME_STARTED_AT = new Date();
const CLIENT_RUNTIME_ID = `${CLIENT_RUNTIME_STARTED_AT.toISOString()}-${crypto
  .randomBytes(6)
  .toString("hex")}`;

// Hard-stop SMS keywords. Match the legacy TCB list for parity. Per
// the per-channel-DNC design, a HARD STOP marks the lead's `sms`
// channel DNC but leaves email/RVM/CX channels and `active: true`
// untouched. Distinct from full lead deactivation (`stopCaseContact`)
// which is reserved for Logics-status / payment / explicit conversion-
// AI signals.
const HARD_STOP_KEYWORDS = ["stop", "unsubscribe", "cancel", "quit"];

function isHardStopKeyword(text) {
  const clean = String(text || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return HARD_STOP_KEYWORDS.includes(clean);
}
const {
  createSpendSyncRuntime,
  extractAttributionCandidates,
  loadMailerConfigCache,
  processControlPlaneEventBatch,
  getPacingConfig,
  isOperatingNow,
  runHourlySweep,
  runDueCxAppointments,
  runCxRecordingHourly,
  summarizeHourlySweepResult,
  completeCxQueueItem,
  createCxQueueReservationService,
  createCxReservationReconcilerService,
  createCxTerminalOutboxDrain,
  enrichTerminalPacketWithCoachSummary,
  handleCxTerminalCallOutcome,
  recordMinimalTerminalResolution,
  createCxCallWrapCardService,
  createCxFirstTouchDispatcher,
  createCxAppointmentDispatcher,
  createCxAppointment,
  buildCxReviewCorrectionRow,
  requestCxLeadStatusUpdate,
  buildTerminalEvidenceKeys,
  writeAgentCallNoteFromTerminal,
  writeCxCallWrapSummary,
  watchCxBulkLoadAccountActiveCalls,
} = require("../../../packages/shared-services/src");
const { bootstrapSeedAccounts } = require("../../../packages/shared-auth/src");
const {
  createRingcxVoiceClient,
  createLogicsClient,
  validateCompanyTrackingNumbers,
} = require("../../../packages/shared-integrations/src");

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

function summarizeWorkerState(workerState) {
  return {
    enabled: workerState.enabled,
    running: workerState.running,
    intervalMs: workerState.intervalMs,
    scheduleMinute: workerState.scheduleMinute ?? null,
    lastScheduledSlot: workerState.lastScheduledSlot || null,
    lastStartedAt: workerState.lastStartedAt,
    lastCompletedAt: workerState.lastCompletedAt,
    lastResult: workerState.lastResult,
    lastError: workerState.lastError,
  };
}

function getMongoReadyState(runtime) {
  try {
    const state = runtime?.getMongoState?.();
    return {
      connected: Boolean(state?.connected),
      readyState: state?.readyState ?? null,
      host: state?.host || null,
      name: state?.name || null,
    };
  } catch (_error) {
    return {
      connected: false,
      readyState: null,
      host: null,
      name: null,
    };
  }
}

// Delegate to the outcome adapter's read-side key builder so the reconciler's terminal-evidence
// lookup mirrors EVERY idemKey shape the single writer (makeOutcomeIdemKey) can emit — including
// the no-UII terminal shapes that skip / kill-manual-reset writes produce. Hand-rolling only
// `queueItemId:uii` (and short-circuiting on a missing queueItemId) silently re-dialed a
// terminally dispositioned lead. (#12 — see cxBulkLoadOutcomeAdapter.buildTerminalEvidenceKeys)
function cxBulkTerminalEvidenceKeys(row = {}) {
  return buildTerminalEvidenceKeys(row);
}

async function hasCxBulkTerminalEvidence(row = {}) {
  const keys = cxBulkTerminalEvidenceKeys(row);
  if (!keys.length) return false;
  const rows = await cxTerminalOutboxRepository.findByIdemKeys(keys);
  return Array.isArray(rows) && rows.length > 0;
}

async function runStartupCxReservationReconciliation({ runtime }) {
  const enabled = String(process.env.CX_RESERVATION_RECONCILER_STARTUP_ENABLED || "true").toLowerCase() !== "false";
  if (!enabled) {
    runtime.logger.warn("control-plane.cx_reservation_reconciler.startup.disabled");
    return { skipped: true, reason: "disabled" };
  }
  const mongoState = getMongoReadyState(runtime);
  if (!mongoState.connected) {
    runtime.logger.warn("control-plane.cx_reservation_reconciler.startup.skipped", {
      reason: "mongo-not-connected",
      mongo: mongoState,
    });
    return { skipped: true, reason: "mongo-not-connected", mongo: mongoState };
  }

  const activeSessions = await cxBulkLoadSessionRepository.listActiveBulkLoadSessions({});
  const activeSessionIds = [...new Set(
    (Array.isArray(activeSessions) ? activeSessions : [])
      .map((session) => String(session?.sessionId || "").trim())
      .filter(Boolean),
  )];
  const reconciler = createCxReservationReconcilerService({
    cxDialQueueRepository,
    cxCadenceService: { completeCxQueueItem },
    cxQueueReservationService: createCxQueueReservationService({ cxDialQueueRepository }),
    terminalEvidence: hasCxBulkTerminalEvidence,
    logger: runtime.logger,
  });
  const result = await reconciler.reconcileDanglingReservations({ activeSessionIds });
  runtime.logger.info("control-plane.cx_reservation_reconciler.startup", {
    activeSessionCount: activeSessionIds.length,
    scanned: Number(result.scanned || 0),
    adopted: Number(result.adopted || 0),
    completed: Number(result.completed || 0),
    released: Number(result.released || 0),
    skipped: Number(result.skipped || 0),
  });
  return result;
}

const BUSINESS_HOURS_LITE_HOURLY_HANDLER_KEYS = Object.freeze([
  "retryCxLogicsAction",
  "cancelFailedOutboundText",
  "scheduleRecontactAttempt",
  "recontactAttempt",
  "refireContactAttempt",
  "cancelFailedOutboundRvm",
  "cancelFailedOutboundCallfireDial",
  "cancelFailedAutoResponderText",
  "retrySocialReply",
  "retryNcoaCreateCase",
  "retryInboundLogicsCreate",
  "renewRingcentralSubscription",
  "investigateRingcentralSilence",
  "retryLexisDailyDrop",
]);

function summarizeHourlySweepConfig(config = {}) {
  return {
    spendSyncEnabled: config.spendSyncEnabled !== false,
    metricsRefreshEnabled: config.metricsRefreshEnabled !== false,
    metricsRefreshPreferLegacyContactActivities:
      config.metricsRefreshPreferLegacyContactActivities !== false,
    leadCadenceEnforcementEnabled: Boolean(config.leadCadenceEnforcementEnabled),
    leadCadenceEnforcementDryRun: Boolean(config.leadCadenceEnforcementDryRun),
    callLogHygieneEnabled: Boolean(config.callLogHygieneEnabled),
    callLogHygieneMirrorLegacyContactActivities:
      config.callLogHygieneMirrorLegacyContactActivities !== false,
    callLogHygieneNativeSweepEnabled:
      config.callLogHygieneNativeSweepEnabled !== false,
    callLogHygieneScorePendingCalls: config.callLogHygieneScorePendingCalls !== false,
    callLogHygieneArchiveRecordings:
      config.callLogHygieneArchiveRecordings !== false,
    cxTerminalRectificationEnabled: Boolean(config.cxTerminalRectificationEnabled),
    cxTerminalRectificationDryRun: config.cxTerminalRectificationDryRun !== false,
  };
}

function summarizeHourlySweepWorkerState(workerState, config = {}) {
  const summary = summarizeWorkerState(workerState);
  return {
    ...summary,
    features: summarizeHourlySweepConfig(config),
    lastResult: summarizeHourlySweepResult(workerState.lastResult),
  };
}

function captureRawBody(req, _res, buf) {
  if (buf?.length) {
    req.rawBody = Buffer.from(buf);
  }
}

function getRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return Buffer.from(req.body);
  }
  return Buffer.from(JSON.stringify(req.body || {}));
}

function safeTimingCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCallrailWebhookSecret() {
  return String(
    process.env.CALLRAIL_WEBHOOK_SECRET ||
      process.env.CALL_RAIL_WEBHOOK_SECRET ||
      process.env.CALLRAIL_WEBHOOK_SIGNING_KEY ||
      process.env.CALL_RAIL_WEBHOOK_SIGNING_KEY ||
      "",
  ).trim();
}

function parseWebhookTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function buildWebhookVerifier(config, runtime) {
  // Secrets in priority order: a dedicated external webhook secret wins, else
  // we reuse the internal service secret (which 6101 already uses for relays).
  // In strict startup mode (prod), require at least one. In dev, log and allow.
  const secrets = [
    process.env.EXTERNAL_WEBHOOK_SECRET,
    config.internalServiceSecret,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const strict = config.startupValidation?.strict;
  if (secrets.length === 0) {
    if (strict) {
      throw new Error(
        "EXTERNAL_WEBHOOK_SECRET or INTERNAL_SERVICE_SECRET must be configured in production",
      );
    }
    runtime.logger.warn("control-plane.webhook.unsigned_mode", {
      reason: "no webhook secret configured; accepting all webhook POSTs",
    });
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    // Echo validation-token challenges (RingCentral + some SMS providers use
    // this during webhook registration) without requiring a secret.
    const challenge = req.headers["validation-token"];
    if (challenge) {
      res.setHeader("Validation-Token", String(challenge));
      return res.status(200).send("OK");
    }

    const provided = String(
      req.headers["x-webhook-secret"] ||
        req.headers["verification-token"] ||
        req.headers["x-service-secret"] ||
        "",
    ).trim();
    if (secrets.some((secret) => safeSecretEquals(provided, secret))) {
      return next();
    }
    runtime.logger.warn("control-plane.webhook.rejected", {
      path: req.path,
      hasHeader: Boolean(provided),
    });
    return res.status(401).json({ ok: false, error: "Invalid webhook secret" });
  };
}

function buildCallrailWebhookVerifier(config, runtime) {
  const fallbackVerifier = buildWebhookVerifier(config, runtime);
  const signingSecret = getCallrailWebhookSecret();
  if (!signingSecret) {
    return fallbackVerifier;
  }

  return (req, res, next) => {
    const providedSignature = String(req.get("Signature") || "").trim();
    const providedToken = String(
      req.headers["x-callrail-webhook-secret"] ||
        req.headers["x-webhook-secret"] ||
        req.headers["verification-token"] ||
        req.headers["x-service-secret"] ||
        "",
    ).trim();
    if (providedToken && safeTimingCompare(providedToken, signingSecret)) {
      return next();
    }

    if (!providedSignature) {
      return fallbackVerifier(req, res, next);
    }

    const expectedSignature = crypto
      .createHmac("sha1", signingSecret)
      .update(getRawBodyBuffer(req))
      .digest("base64");

    if (!safeTimingCompare(providedSignature, expectedSignature)) {
      runtime.logger.warn("control-plane.callrail.webhook.rejected", {
        path: req.path,
        reason: "signature_mismatch",
      });
      return res.status(401).json({ ok: false, error: "Invalid webhook signature" });
    }

    const timestampMs = parseWebhookTimestamp(
      req.body?.timestamp ||
        req.body?.created_at ||
        req.body?.sent_at ||
        req.body?.event_timestamp,
    );
    if (timestampMs && Math.abs(Date.now() - timestampMs) > 15 * 60 * 1000) {
      runtime.logger.warn("control-plane.callrail.webhook.rejected", {
        path: req.path,
        reason: "stale_timestamp",
      });
      return res.status(401).json({ ok: false, error: "Stale webhook timestamp" });
    }

    return next();
  };
}

function buildServiceProxy({ port, runtime, serviceName, config, injectServiceSecret = true }) {
  const baseUrl = `http://127.0.0.1:${port}`;

  return async (req, res, next) => {
    try {
      const targetUrl = new URL(req.originalUrl, baseUrl);
      const headers = new Headers();

      for (const [key, value] of Object.entries(req.headers || {})) {
        if (value === undefined || value === null) continue;
        const normalized = String(key || "").toLowerCase();
        if (["host", "connection", "content-length"].includes(normalized)) continue;
        if (Array.isArray(value)) {
          headers.set(key, value.join(", "));
        } else {
          headers.set(key, String(value));
        }
      }

      if (injectServiceSecret && config.internalServiceSecret) {
        headers.set("x-service-secret", String(config.internalServiceSecret));
      }

      const requestInit = {
        method: req.method,
        headers,
        redirect: "manual",
      };

      if (!["GET", "HEAD"].includes(String(req.method || "").toUpperCase())) {
        if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 0) {
          requestInit.body = req.rawBody;
        } else if (req.body !== undefined) {
          if (Buffer.isBuffer(req.body)) {
            requestInit.body = req.body;
          } else if (typeof req.body === "string") {
            requestInit.body = Buffer.from(req.body);
          } else {
            headers.set("content-type", headers.get("content-type") || "application/json");
            requestInit.body = Buffer.from(JSON.stringify(req.body));
          }
        }
      }

      const response = await fetch(targetUrl, requestInit);
      const payload = Buffer.from(await response.arrayBuffer());

      for (const [key, value] of response.headers.entries()) {
        if (["connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
          continue;
        }
        res.setHeader(key, value);
      }

      return res.status(response.status).send(payload);
    } catch (error) {
      runtime.logger.error("control-plane.proxy.failed", {
        service: serviceName,
        path: req.originalUrl,
        method: req.method,
        error: error.message,
      });
      return next(error);
    }
  };
}

function attachWebClientBuild(app, runtime) {
  const buildDir = path.resolve(__dirname, "..", "..", "web-client", "build");
  const indexPath = path.join(buildDir, "index.html");

  if (!fs.existsSync(buildDir) || !fs.existsSync(indexPath)) {
    runtime.logger.warn("control-plane.web_client_build.missing", {
      buildDir,
    });
    return;
  }

  app.use(
    express.static(buildDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  const serveIndex = (_req, res) => res.sendFile(indexPath);
  app.get("/", serveIndex);
  app.get("/login", serveIndex);
  app.get(/^\/admin(?:\/.*)?$/, serveIndex);
  app.get(/^\/cx(?:\/.*)?$/, serveIndex);
  app.get(/^\/trainer(?:\/.*)?$/, serveIndex);

  runtime.logger.info("control-plane.web_client_build.serving", {
    buildDir,
  });
}

/**
 * Hourly sweeper worker. Two separate cadences on one state object:
 *  - Every 60s: run `drainHourlyJobQueue` via Phase B only. Keeps the
 *    retry backlog moving without waiting for the top of the hour.
 *  - At the top of every hour: also run Phase A (session reconcile +
 *    payment reconcile + close-the-loop emails). We detect the hourly
 *    window by comparing the last-scheduled hour on state.
 *
 * Uses the same `running` guard pattern as the main worker so a long
 * tick doesn't overlap itself.
 */
async function startHourlySweepWorker({ config, runtime, workerState, spendSyncRuntime = null }) {
  const drainIntervalMs = 60_000;
  workerState.enabled = true;
  workerState.intervalMs = drainIntervalMs;
  workerState.lastScheduledHour = null;

  const tick = async () => {
    if (workerState.running) return;
    workerState.running = true;
    workerState.lastStartedAt = new Date();

    const currentHourKey = `${workerState.lastStartedAt.getUTCFullYear()}-${workerState.lastStartedAt.getUTCMonth()}-${workerState.lastStartedAt.getUTCDate()}-${workerState.lastStartedAt.getUTCHours()}`;
    let runScheduledPhase =
      workerState.lastScheduledHour !== currentHourKey;
    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      workerState.running = false;
      return;
    }

    let businessHoursLiteMode = null;
    try {
      const pacingConfig = await getPacingConfig();
      if (isOperatingNow(pacingConfig, workerState.lastStartedAt)) {
        businessHoursLiteMode = {
          mode: "business-hours-lite",
          timezone: pacingConfig.businessHoursTimezone || "America/Los_Angeles",
          businessHoursStart: pacingConfig.businessHoursStart,
          businessHoursEnd: pacingConfig.businessHoursEnd,
          businessDays: pacingConfig.businessDays,
        };
      }
    } catch (error) {
      businessHoursLiteMode = {
        mode: "business-hours-lite",
        reason: "business-hours-check-failed",
        error: error.message,
      };
    }
    const scheduledPhaseMode = runScheduledPhase ? businessHoursLiteMode : null;

    try {
      // Claim the hour before running Phase A. If a dependency fails
      // mid-sweep, we still do not retry external hourly work every
      // 60 seconds for the rest of the hour.
      if (runScheduledPhase) {
        workerState.lastScheduledHour = currentHourKey;
      }
      const scheduledPhaseLite = businessHoursLiteMode?.mode === "business-hours-lite";
      if (scheduledPhaseMode) {
        runtime.logger.info("control-plane.hourly.scheduled_phase_mode", scheduledPhaseMode);
      }
      // Keep the hourly worker alive during floor hours, but run a
      // lighter Phase A so long Logics/payment/media jobs do not compete
      // with queue serving. Phase B still drains the hourly job queue.
      const result = await runHourlySweep({
        workerName: `${config.serviceName}-hourly-sweep`,
        lane: "hourly",
        scheduledPhase: runScheduledPhase,
        batchCap: scheduledPhaseLite ? 10 : undefined,
        handlerKeys: scheduledPhaseLite ? BUSINESS_HOURS_LITE_HOURLY_HANDLER_KEYS : null,
        sessionReconcileEnabled: !scheduledPhaseLite,
        paymentReconcileEnabled: !scheduledPhaseLite,
        paymentFieldsSyncEnabled: !scheduledPhaseLite,
        metricsRefreshEnabled:
          !scheduledPhaseLite && config.hourlySweep?.metricsRefreshEnabled !== false,
        metricsRefreshPreferLegacyContactActivities:
          config.hourlySweep?.metricsRefreshPreferLegacyContactActivities !== false,
        maxCasesPerDomain:
          config.hourlySweep?.paymentReconcileMaxCasesPerDomain,
        leadCadenceEnforcementEnabled:
          Boolean(config.hourlySweep?.leadCadenceEnforcementEnabled),
        leadCadenceEnforcementLimitPerDomain:
          config.hourlySweep?.leadCadenceEnforcementLimitPerDomain,
        leadCadenceEnforcementMinStaleMs:
          config.hourlySweep?.leadCadenceEnforcementMinStaleMs,
        leadCadenceEnforcementDryRun:
          Boolean(config.hourlySweep?.leadCadenceEnforcementDryRun),
        callLogHygieneEnabled:
          !scheduledPhaseLite && Boolean(config.hourlySweep?.callLogHygieneEnabled),
        callLogHygieneSinceMs:
          config.hourlySweep?.callLogHygieneSinceMs,
        callLogHygieneLimitPerDomain:
          config.hourlySweep?.callLogHygieneLimitPerDomain,
        callLogHygieneMirrorLegacyContactActivities:
          config.hourlySweep?.callLogHygieneMirrorLegacyContactActivities !== false,
        callLogHygieneNativeSweepEnabled:
          config.hourlySweep?.callLogHygieneNativeSweepEnabled !== false,
        callLogHygieneNativeSweepLimit:
          config.hourlySweep?.callLogHygieneNativeSweepLimit,
        callLogHygieneNativeSweepMaxPages:
          config.hourlySweep?.callLogHygieneNativeSweepMaxPages,
        callLogHygieneNativeSweepDefaultDomain:
          config.hourlySweep?.callLogHygieneNativeSweepDefaultDomain,
        callLogHygieneMinDurationSec:
          config.hourlySweep?.callLogHygieneMinDurationSec,
        callLogHygieneMaxCaseRefreshesPerDomain:
          config.hourlySweep?.callLogHygieneMaxCaseRefreshesPerDomain,
        callLogHygieneMaxScoringPerDomain:
          config.hourlySweep?.callLogHygieneMaxScoringPerDomain,
        callLogHygieneMaxArchivePerDomain:
          config.hourlySweep?.callLogHygieneMaxArchivePerDomain,
        callLogHygieneScorePendingCalls:
          config.hourlySweep?.callLogHygieneScorePendingCalls !== false,
        callLogHygieneArchiveRecordings:
          config.hourlySweep?.callLogHygieneArchiveRecordings !== false,
        cxCallActivityBackfillEnabled: !scheduledPhaseLite,
        cxTerminalRectificationEnabled:
          !scheduledPhaseLite && Boolean(config.hourlySweep?.cxTerminalRectificationEnabled),
        cxTerminalRectificationDryRun:
          config.hourlySweep?.cxTerminalRectificationDryRun !== false,
        cxTerminalRectificationSinceMs:
          config.hourlySweep?.cxTerminalRectificationSinceMs,
        cxTerminalRectificationMinAgeMs:
          config.hourlySweep?.cxTerminalRectificationMinAgeMs,
        cxTerminalRectificationLimit:
          config.hourlySweep?.cxTerminalRectificationLimit,
        cxRecordingHourlyEnabled: !scheduledPhaseLite,
        calllogBridgeEnabled: !scheduledPhaseLite,
        staleCadenceSweepEnabled: !scheduledPhaseLite,
        staleNcoaSweepEnabled: !scheduledPhaseLite,
        dncRecheckEnabled: !scheduledPhaseLite,
        fillerPoolRefreshEnabled: !scheduledPhaseLite,
        agedRollingRefreshEnabled: !scheduledPhaseLite,
        resolutionEmailsEnabled: !scheduledPhaseLite,
        logger: runtime.logger,
      });
      if (scheduledPhaseMode) {
        result.scheduledPhaseMode = scheduledPhaseMode;
      }
      if (
        runScheduledPhase &&
        !scheduledPhaseLite &&
        config.hourlySweep?.spendSyncEnabled !== false &&
        spendSyncRuntime?.syncAll
      ) {
        const startedAt = new Date();
        try {
          const spendSync = await spendSyncRuntime.syncAll({ scheduled: true });
          result.phaseA = result.phaseA || {};
          result.phaseA.spendSync = {
            ok: true,
            startedAt,
            completedAt: new Date(),
            totalUpserted: Number(spendSync?.totalUpserted || 0),
            totalSkipped: Number(spendSync?.totalSkipped || 0),
            sheets: Array.isArray(spendSync?.sheets)
              ? spendSync.sheets.map((row) => ({
                  sheet: row.sheet,
                  upserted: Number(row.upserted || 0),
                  skipped: Number(row.skipped || 0),
                }))
              : [],
          };
        } catch (error) {
          result.phaseA = result.phaseA || {};
          result.phaseA.spendSync = {
            ok: false,
            startedAt,
            completedAt: new Date(),
            error: error.message,
          };
          runtime.logger.warn("control-plane.hourly.spend_sync_failed", {
            error: error.message,
          });
        }
      }
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      const resultSummary = summarizeHourlySweepResult(result);
      if (result.phaseB?.claimed > 0 || runScheduledPhase) {
        runtime.logger.info("control-plane.hourly.tick", {
          features: summarizeHourlySweepConfig(config.hourlySweep || {}),
          summary: resultSummary,
        });
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.hourly.tick_failed", {
        error: error.message,
      });
    } finally {
      workerState.running = false;
    }
  };

  workerState.timer = setInterval(tick, drainIntervalMs);
  if (typeof workerState.timer.unref === "function") {
    workerState.timer.unref();
  }

  // First tick runs async after boot so we don't block startup on a
  // slow Logics call during payment reconcile.
  setImmediate(() => {
    tick().catch((error) => {
      runtime.logger.error("control-plane.hourly.first_tick_failed", {
        error: error.message,
      });
    });
  });
}

/**
 * RingCX/WEM recording downloader. Runs once per hour on a separate
 * minute mark from the RingCentral call-log hygiene sweep so the two
 * heavy RC surfaces do not stack on the same tick.
 */
async function startCxRecordingWorker({ config, runtime, workerState }) {
  const intervalMs = 60_000;
  const scheduleMinute = Math.max(
    0,
    Math.min(59, Number(config.hourlySweep?.cxRecordingMinute ?? 30) || 30),
  );
  workerState.enabled = true;
  workerState.intervalMs = intervalMs;
  workerState.scheduleMinute = scheduleMinute;
  workerState.lastScheduledSlot = null;

  const slotKeyFor = (date) => {
    const slot = new Date(date);
    slot.setUTCMinutes(scheduleMinute, 0, 0);
    return `${slot.getUTCFullYear()}-${slot.getUTCMonth()}-${slot.getUTCDate()}-${slot.getUTCHours()}-${scheduleMinute}`;
  };

  const tick = async () => {
    const now = new Date();
    if (now.getUTCMinutes() < scheduleMinute) return;
    const slotKey = slotKeyFor(now);
    if (workerState.running || workerState.lastScheduledSlot === slotKey) return;

    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      return;
    }

    workerState.running = true;
    workerState.lastStartedAt = now;
    workerState.lastScheduledSlot = slotKey;
    try {
      const result = await runCxRecordingHourly({
        fireTime: now,
        scheduleMinute,
        logger: runtime.logger,
      });
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      runtime.logger.info("control-plane.cx_recording.tick", {
        scheduleMinute,
        windowStart: result.windowStart,
        windowEnd: result.windowEnd,
        minDurationSec: result.minDurationSec,
        metadata: result.metadata,
        domains: Object.fromEntries(
          Object.entries(result.domains || {}).map(([domain, value]) => [
            domain,
            {
              candidateRows: value.candidateRows,
              processedCompleted: value.processedCompleted,
              processedNoRecording: value.processedNoRecording,
              processedErrors: value.processedErrors,
            },
          ]),
        ),
      });
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.cx_recording.tick_failed", {
        scheduleMinute,
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

  setImmediate(() => {
    tick().catch((error) => {
      runtime.logger.error("control-plane.cx_recording.first_tick_failed", {
        error: error.message,
      });
    });
  });
}

async function startCxAppointmentWorker({ config, runtime, workerState }) {
  const intervalMs = Math.max(
    Number(config.cxAppointmentWorker?.intervalMs || process.env.CX_APPOINTMENT_WORKER_INTERVAL_MS) || 60_000,
    15_000,
  );
  const limit = Math.max(
    1,
    Math.min(
      200,
      Number(config.cxAppointmentWorker?.limit || process.env.CX_APPOINTMENT_WORKER_LIMIT) || 50,
    ),
  );
  workerState.enabled = String(process.env.CX_APPOINTMENT_WORKER_ENABLED || "true").toLowerCase() !== "false";
  workerState.intervalMs = intervalMs;
  if (!workerState.enabled) {
    runtime.logger.warn("control-plane.cx_appointments.disabled");
    return;
  }

  const tick = async () => {
    if (workerState.running) return;
    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      return;
    }

    workerState.running = true;
    workerState.lastStartedAt = new Date();
    try {
      const result = await runDueCxAppointments({ limit });
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      if (result.checked > 0 || result.fired > 0 || result.blocked > 0) {
        runtime.logger.info("control-plane.cx_appointments.tick", {
          checked: result.checked,
          fired: result.fired,
          due: result.due,
          deferred: result.deferred,
          blocked: result.blocked,
          autoFireEnabled: result.autoFireEnabled,
        });
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.cx_appointments.tick_failed", {
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

  setImmediate(() => {
    tick().catch((error) => {
      runtime.logger.error("control-plane.cx_appointments.first_tick_failed", {
        error: error.message,
      });
    });
  });
}

async function enqueueCxCallWrapFromTerminal({ payload = {}, row = {}, terminalResult = null, logger = console } = {}) {
  const hasWrapMaterial = Boolean(
    payload.coachSessionId ||
      payload.callSummary ||
      payload.summary ||
      payload.rollingSummary ||
      payload.codexRollingSummary ||
      payload.interviewSnapshot ||
      payload.interviewSnapshotWorkflowId ||
      payload.transcriptArtifactPath,
  );
  if (!hasWrapMaterial) {
    return { skipped: true, reason: "no-call-wrap-material" };
  }

  const result = await writeCxCallWrapSummary(
    {
      domain: payload.domain,
      caseId: payload.caseId,
      queueItemId: payload.queueItemId,
      uii: payload.uii,
      externId: payload.externId,
      terminalOutcome: payload.outcome || payload.terminalOutcome,
      happenedAt: payload.at || payload.outcomeAt || new Date().toISOString(),
      durationSec: payload.durationSec || payload.durationSeconds,
      phone: payload.phone || payload.prospectPhone,
      subject: payload.subject || "CX call summary",
      source: payload.source || "cx-terminal-outbox-drain",
      provider: "cx-terminal-outbox",
      summary: payload.callSummary || payload.summary || payload.activityNote || payload.note || "",
      nextStep: payload.nextStep || payload.nextAction || "",
      coachSessionId: payload.coachSessionId,
      interviewSnapshotWorkflowId: payload.interviewSnapshotWorkflowId,
      transcriptArtifactPath: payload.transcriptArtifactPath,
      contextKeys: Array.isArray(payload.contextKeys) ? payload.contextKeys : [],
      facts: Array.isArray(payload.facts) ? payload.facts : [],
      // Terminal drain persists call evidence only; nightly grading owns grade output.
      grade: null,
      rollingSummary: payload.rollingSummary || payload.codexRollingSummary || null,
      interviewSnapshot: payload.interviewSnapshot || null,
      actor: {
        actorEmail: payload.agentEmail || null,
        actorName: payload.agentName || payload.agentEmail || null,
      },
      metadata: {
        idemKey: row.idemKey || payload.idemKey || null,
        terminalStatus: terminalResult?.status || terminalResult?.outcome || null,
      },
    },
    {
      caseProfileRepository,
      writeLogicsActivity: async (domain, _actor, activity) => {
        const client = createLogicsClient(domain);
        const response = await client.createActivity({
          CaseID: Number(activity.caseId),
          ActivityType: activity.activityType || "General",
          Subject: activity.subject || "CX call summary",
          Comment: activity.note,
          Popup: false,
          Pin: false,
        });
        return { skipped: false, result: response };
      },
      logger,
    },
    {
      allowSparse: false,
      writeCaseProfileCommunication: true,
      writeLogicsActivity: true,
    },
  );

  logger.info?.("control-plane.cx_terminal_outbox.call_wrap_ready", {
    idemKey: row.idemKey || payload.idemKey || null,
    domain: payload.domain || null,
    caseId: payload.caseId || null,
    queueItemId: payload.queueItemId || null,
    uii: payload.uii || null,
    coachSessionId: payload.coachSessionId || null,
    hasCallSummary: Boolean(payload.callSummary || payload.summary),
    hasInterviewSnapshot: Boolean(payload.interviewSnapshotWorkflowId),
    terminalStatus: terminalResult?.status || terminalResult?.outcome || null,
    skipped: result.skipped === true,
    reason: result.reason || null,
    threadKey: result.packet?.threadKey || null,
  });
  return result;
}

function createControlPlaneCxCallWrapCards({ runtime }) {
  return createCxCallWrapCardService({
    cardRepository: cxCallWrapCardRepository,
    outboxRepository: cxTerminalOutboxRepository,
    buildCorrectionRow: buildCxReviewCorrectionRow,
    // Interview activity = the existing wrap-summary pipeline, fired at resolution time.
    writeInterview: (card) =>
      enqueueCxCallWrapFromTerminal({
        payload: { ...(card.payload || {}), callSummary: card.coachSummary || (card.payload || {}).callSummary },
        row: { idemKey: card.idemKey },
        terminalResult: null,
        logger: runtime.logger,
      }),
    updateLogicsDncStatus: (card) =>
      requestCxLeadStatusUpdate(card.domain, { email: card.agentEmail }, {
        caseId: card.caseId,
        status: "dnc",
        notes: "DNC set from call wrap card",
      }),
    createAppointment: ({ card, appointmentAt, user }) => {
      const payload = card?.payload && typeof card.payload === "object" ? card.payload : {};
      const phone = payload.phone || payload.prospectPhone || payload.leadPhone || null;
      return createCxAppointment(card.domain, user, {
        caseId: card.caseId,
        appointmentAt,
        queueItemId: card.queueItemId,
        prospectName: card.name || payload.name || payload.prospectName || payload.contactName || null,
        phone,
        searchPhone: phone,
        sourceName: payload.sourceName || payload.intakeSource || null,
        source: "cx-wrap-card",
      });
    },
    logger: runtime.logger,
  });
}

async function startCxTerminalOutboxWorker({
  runtime,
  workerState,
  wrapQueueEnabled = false,
  wrapCards = null,
}) {
  const intervalMs = Math.max(
    Number(process.env.CX_TERMINAL_OUTBOX_DRAIN_INTERVAL_MS) || 15_000,
    5_000,
  );
  const limit = Math.max(
    1,
    Math.min(Number(process.env.CX_TERMINAL_OUTBOX_DRAIN_LIMIT) || 50, 200),
  );
  workerState.enabled = String(process.env.CX_TERMINAL_OUTBOX_DRAIN_ENABLED || "true").toLowerCase() !== "false";
  workerState.intervalMs = intervalMs;
  workerState.limit = limit;
  if (!workerState.enabled) {
    workerState.lastResult = { skipped: true, reason: "disabled" };
    runtime.logger.warn("control-plane.cx_terminal_outbox.disabled");
    return;
  }

  const drain = createCxTerminalOutboxDrain({
    outboxRepository: cxTerminalOutboxRepository,
    logger: runtime.logger,
    // Minimal resolution (Mickey's ruling 2026-07-06): after repeated replay failures the
    // drain stamps the bare outcome string back onto the queue row and clears the row.
    resolveMinimal: ({ payload }) => recordMinimalTerminalResolution(payload),
    enrichTerminalPacket: (packet) =>
      enrichTerminalPacketWithCoachSummary(packet, {
        LiveCoachSession,
        logger: runtime.logger,
      }),
    recordCadenceEvent: async (event = {}) => {
      if (event.systemDisposition) {
        runtime.logger.info?.("control-plane.cx_terminal_outbox.system_disposition.forwarded", {
          idemKey: event.idemKey || null,
          sessionId: event.sessionId || null,
          queueItemId: event.queueItemId || null,
          uii: event.uii || null,
          outcome: event.outcome || null,
          source: event.source || "cx-bulk-load",
          systemDisposition: event.systemDisposition,
        });
      }
      return handleCxTerminalCallOutcome({
        queueItemId: event.queueItemId,
        domain: event.domain,
        caseId: event.caseId,
        uii: event.uii,
        externId: event.externId,
        outcome: event.outcome,
        disposition: event.outcome,
        source: event.source || "cx-bulk-load",
        sourceService: "cx-bulk-load",
        actorEmail: event.agentEmail,
        outcomeAt: event.at || new Date().toISOString(),
        // RingCX's own verdict (CONGESTION/BUSY/INTERCEPT/...) - evidence, not routing.
        // The watcher stamped it; the drain forwards it unchanged so cadence/call-log
        // can store it (lead health: INTERCEPT=dead number, BUSY=timing, CONGESTION=route).
        systemDisposition: event.systemDisposition || null,
      });
    },
    writeCallNote: (packet) =>
      writeAgentCallNoteFromTerminal(packet, {
        agentCallNoteRepository: cxAgentCallNoteRepository,
      }),
    enqueueCallWrap: (packet) =>
      wrapQueueEnabled && wrapCards
        ? wrapCards.createFromDrain(packet)
        : enqueueCxCallWrapFromTerminal({
          ...packet,
          logger: runtime.logger,
        }),
  });

  // SEPARATE CONCERNS, SEPARATE ROUTES (Mickey, 2026-07-07: "drain can wait if it's
  // safer — appointments should run as soon as all the data is gathered"). The wrap card
  // is the HUMAN'S queue: it mints the moment the terminal row lands, on its own route,
  // with the same enrich + the same idemKey exactly-once. The drain's heartbeat is
  // untouched and its enqueueCallWrap above stays as the BACKSTOP — rows inserted
  // out-of-process (scripts, replays) get carded on the next tick; duplicates no-op.
  if (wrapQueueEnabled && wrapCards) {
    cxTerminalOutboxRepository.onCxTerminalRowEnqueued((row) => {
      (async () => {
        const packet = await enrichTerminalPacketWithCoachSummary(
          { row, payload: row.payload || {} },
          { LiveCoachSession, logger: runtime.logger },
        ).catch(() => ({ row, payload: row.payload || {}, coachSummary: null }));
        const result = await wrapCards.createFromDrain({
          row: packet.row || row,
          payload: packet.payload || row.payload || {},
          coachSummary: packet.coachSummary || null,
        });
        if (result?.created) {
          runtime.logger.info("control-plane.cx_wrap_cards.fast_minted", {
            idemKey: row.idemKey,
            agentEmail: row.agentEmail || null,
            outcome: row.outcome || null,
          });
        }
      })().catch((error) => {
        runtime.logger.warn("control-plane.cx_wrap_cards.fast_mint_failed", {
          idemKey: row.idemKey,
          error: error?.message,
        });
      });
    });
  }

  const tick = async () => {
    if (workerState.running) return;
    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      return;
    }

    workerState.running = true;
    workerState.lastStartedAt = new Date();
    try {
      const result = await drain.drainOnce({ limit });
      if (wrapQueueEnabled && wrapCards) {
        // The wrap janitor rides the drain tick (the auto-opt-out ruling): passive expiry
        // resolves through the same pipeline as a button press.
        const janitor = await wrapCards.expireDue().catch(() => null);
        if (janitor && janitor.expired > 0) {
          runtime.logger.info("control-plane.cx_wrap_cards.expired", janitor);
        }
      }
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = result;
      workerState.lastError = null;
      if (result.scanned > 0 || result.failed > 0) {
        runtime.logger.info("control-plane.cx_terminal_outbox.tick", result);
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.cx_terminal_outbox.failed", {
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

  setImmediate(() => {
    tick().catch((error) => {
      runtime.logger.error("control-plane.cx_terminal_outbox.first_tick_failed", {
        error: error.message,
      });
    });
  });
}

function summarizeCxAccountActiveCallWatcherResult(result = {}) {
  const applied = result.applied || {};
  return {
    checkedAt: result.checkedAt || null,
    summary: result.summary || {},
    accounts: (Array.isArray(result.accounts) ? result.accounts : []).map((account) => ({
      accountId: account.accountId || null,
      sessionCount: Number(account.sessionCount || 0),
      activeCallCount: Number(account.activeCallCount || 0),
      error: account.error || null,
    })),
    applied: {
      writeCount: Number(applied.writeCount || 0),
      terminalWriteCount: Number(applied.terminalWriteCount || 0),
      skippedCount: Number(applied.skippedCount || 0),
      writes: (Array.isArray(applied.writes) ? applied.writes : []).slice(0, 20),
      terminalWrites: (Array.isArray(applied.terminalWrites) ? applied.terminalWrites : []).slice(0, 20),
      skipped: (Array.isArray(applied.skipped) ? applied.skipped : []).slice(0, 20),
    },
  };
}

async function startCxAccountActiveCallWatcherWorker({ runtime, workerState }) {
  const intervalMs = Math.max(
    Number(process.env.CX_ACCOUNT_ACTIVE_CALL_WATCHER_INTERVAL_MS) || 1_000,
    500,
  );
  workerState.enabled = String(process.env.CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED || "true").toLowerCase() !== "false";
  workerState.intervalMs = intervalMs;
  if (!workerState.enabled) {
    workerState.lastResult = { skipped: true, reason: "disabled" };
    runtime.logger.warn("control-plane.cx_account_active_call_watcher.disabled");
    return;
  }

  const tick = async () => {
    if (workerState.running) return;
    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      return;
    }

    workerState.running = true;
    workerState.lastStartedAt = new Date();
    try {
      const result = await watchCxBulkLoadAccountActiveCalls();
      const summary = summarizeCxAccountActiveCallWatcherResult(result);
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = summary;
      workerState.lastError = null;
      const applied = summary.applied || {};
      const overview = summary.summary || {};
      if (
        Number(overview.sessionCount || 0) > 0 ||
        Number(applied.writeCount || 0) > 0 ||
        Number(applied.terminalWriteCount || 0) > 0 ||
        Number(applied.skippedCount || 0) > 0 ||
        Number(overview.errorCount || 0) > 0
      ) {
        runtime.logger.info("control-plane.cx_account_active_call_watcher.tick", {
          summary: overview,
          applied: {
            writeCount: applied.writeCount,
            terminalWriteCount: applied.terminalWriteCount,
            skippedCount: applied.skippedCount,
          },
          accounts: summary.accounts,
        });
      }
    } catch (error) {
      workerState.lastCompletedAt = new Date();
      workerState.lastError = error.message;
      runtime.logger.error("control-plane.cx_account_active_call_watcher.failed", {
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

  setImmediate(() => {
    tick().catch((error) => {
      runtime.logger.error("control-plane.cx_account_active_call_watcher.first_tick_failed", {
        error: error.message,
      });
    });
  });
}

async function startControlPlaneWorker({ config, runtime, workerState }) {
  const intervalMs = Math.max(Number(config.controlPlaneWorker?.intervalMs) || 5000, 1000);
  const batchSize = Math.max(Number(config.controlPlaneWorker?.batchSize) || 25, 1);
  const maxAttempts = Math.max(Number(config.controlPlaneWorker?.maxAttempts) || 5, 1);

  workerState.enabled = true;
  workerState.intervalMs = intervalMs;

  const tick = async () => {
    if (workerState.running) return;
    workerState.running = true;
    workerState.lastStartedAt = new Date();
    const mongoState = getMongoReadyState(runtime);
    if (!mongoState.connected) {
      workerState.lastCompletedAt = new Date();
      workerState.lastResult = {
        skipped: true,
        reason: "mongo-not-connected",
        mongo: mongoState,
      };
      workerState.lastError = "mongo-not-connected";
      workerState.running = false;
      return;
    }

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

  await tick();
}

async function startServer() {
  const config = getControlPlaneConfig();
  const runtime = await initializeServiceRuntime(config);

  // CallRail tracking-number sanity check. Two companies sharing the
  // same DID would make inbound-SMS â†’ company routing ambiguous (we'd
  // silently mis-stamp every inbound to whichever company the resolver
  // happens to iterate first), so refuse to boot. Empty configs are
  // only a warning â€” dev environments can run without CallRail wired.
  {
    const { conflicts, unconfigured } = validateCompanyTrackingNumbers();
    if (conflicts.length > 0) {
      runtime.logger.error("control-plane.callrail.tracking_conflicts", {
        conflicts,
      });
      throw new Error(
        `CallRail tracking number conflict: ${conflicts
          .map((c) => `${c.number} claimed by ${c.companies.join(" + ")}`)
          .join("; ")}. Set distinct *_CALL_RAIL_TRACKING_NUMBER env vars per company.`,
      );
    }
    if (unconfigured.length > 0) {
      runtime.logger.warn("control-plane.callrail.tracking_unconfigured", {
        companies: unconfigured,
      });
    }
  }

  // Ensure hardcoded admin seeds exist in the UserAccount collection. Safe to
  // re-run on every boot â€” upserts by email.
  try {
    await bootstrapSeedAccounts({ logger: runtime.logger });
  } catch (error) {
    runtime.logger.error("control-plane.accounts.bootstrap.failed", {
      error: error.message,
    });
  }

  try {
    await loadMailerConfigCache();
  } catch (error) {
    runtime.logger.warn("control-plane.mailer-config.bootstrap_failed", {
      error: error.message,
    });
  }

  const app = express();
  app.set("trust proxy", "loopback");
  const auth = buildAuthMiddleware(config);
  const workerState = createWorkerState();
  const wrapQueueEnabled = String(process.env.CX_CALL_WRAP_QUEUE_ENABLED || "false").trim().toLowerCase() === "true";
  const wrapCards = wrapQueueEnabled ? createControlPlaneCxCallWrapCards({ runtime }) : null;
  const lexisNightlyRuntime = createLexisNightlyRuntime({
    config: config.lexisNightly || {},
    runtime,
  });
  const lexisDailyDropRuntime = createLexisDailyDropRuntime({
    config: config.lexisDailyDrop || {},
    runtime,
  });
  const logicsActivityReviewRuntime = createLogicsActivityReviewRuntime({
    config: config.logicsActivityReview || {},
    runtime,
  });
  const spendSyncRuntime = createSpendSyncRuntime({
    config: config.spendSync || {},
    runtime,
  });
  const nightlyCloseRuntime = createNightlyCloseRuntime({
    config: config.nightlyClose || {},
    runtime,
    // Inject the spend-sync runtime so nightly-close can re-trigger
    // syncAll() during its final-reconcile step. Order matters here:
    // spendSyncRuntime must be constructed before nightlyCloseRuntime.
    spendSyncRuntime,
  });
  const cxNightlyCallGradeRuntime = createCxNightlyCallGradeRuntime({
    config: config.nightlyCallGrade || {},
    runtime,
  });
  const eodRecordingArchiveRuntime = createEodRecordingArchiveRuntime({
    config: config.recordingArchive?.endOfDay || {},
    runtime,
  });
  // Bridge runtime — drives the legacy PhoneBurner morning rotation
  // until PB is fully deprecated by CX. Defaults disabled; flip on
  // via PHONEBURNER_ROTATION_ENABLED=true once you've commented out
  // the equivalent cron in legacy webhook.js (avoids double-fire).
  const phoneburnerRotationRuntime = createPhoneburnerRotationRuntime({
    config: config.phoneburnerRotation || {},
    runtime,
  });
  const demoRingoutRuntime = createDemoRingoutRuntime({
    config: config.demoRingout || {},
    runtime,
  });
  const bloggerRuntime = createBloggerRuntime({
    config: config.blogger || {},
    runtime,
  });
  const requireHealthAccess = buildHealthAccessMiddleware(config);
  const requireWebhookSecret = buildWebhookVerifier(config, runtime);
  const requireSmsWebhookSignature = buildCallrailWebhookVerifier(config, runtime);
  runtime.installSignalHandlers();
  const hourlySweepState = createWorkerState();
  const cxRecordingState = createWorkerState();
  const cxAppointmentState = createWorkerState();
  const cxTerminalOutboxState = createWorkerState();
  const cxAccountActiveCallWatcherState = createWorkerState();
  const inboundProxy = buildServiceProxy({
    port: PORTS.inboundGateway,
    runtime,
    serviceName: "inbound-gateway",
    config,
  });
  const outboundProxy = buildServiceProxy({
    port: PORTS.outboundGateway,
    runtime,
    serviceName: "outbound-gateway",
    config,
  });
  const ringcentralProxy = buildServiceProxy({
    port: PORTS.ringcentralCx,
    runtime,
    serviceName: "ringcentral-cx",
    config,
  });
  const ringcentralUserProxy = buildServiceProxy({
    port: PORTS.ringcentralCx,
    runtime,
    serviceName: "ringcentral-cx",
    config,
    injectServiceSecret: false,
  });

  const getRuntimeState = () => ({
    workers: {
      controlPlane: summarizeWorkerState(workerState),
      hourlySweep: summarizeHourlySweepWorkerState(
        hourlySweepState,
        config.hourlySweep || {},
      ),
      cxRecording: summarizeWorkerState(cxRecordingState),
      cxAppointments: summarizeWorkerState(cxAppointmentState),
      cxTerminalOutbox: summarizeWorkerState(cxTerminalOutboxState),
      cxAccountActiveCallWatcher: summarizeWorkerState(cxAccountActiveCallWatcherState),
    },
    runtimes: {
      lexisNightly: lexisNightlyRuntime.getState(),
      lexisDailyDrop: lexisDailyDropRuntime.getState(),
      logicsActivityReview: logicsActivityReviewRuntime.getState(),
      nightlyClose: nightlyCloseRuntime.getState(),
      cxNightlyCallGrade: cxNightlyCallGradeRuntime.getState(),
      spendSync: spendSyncRuntime.getState(),
      eodRecordingArchive: eodRecordingArchiveRuntime.getState(),
      demoRingout: demoRingoutRuntime.getState(),
      blogger: bloggerRuntime.getState(),
    },
  });

  app.use(cors({ origin: getCorsOriginResolver(), credentials: true }));
  app.use(express.json({ limit: "1mb", verify: captureRawBody }));
  app.use(express.urlencoded({ extended: true, limit: "1mb", verify: captureRawBody }));

  app.get("/health", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, runtime.getMongoState()));
    }
    res.json({
      ...buildServiceHealth(config, runtime.getMongoState()),
      ...getRuntimeState(),
    });
  });

  app.get("/api/client/runtime", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      runtime: {
        service: "control-plane",
        runtimeId: CLIENT_RUNTIME_ID,
        startedAt: CLIENT_RUNTIME_STARTED_AT.toISOString(),
      },
    });
  });

  app.post("/sms/inbound", requireSmsWebhookSignature, async (req, res) => {
    // Ack to CallRail fast â€” they retry on slow responses.
    res.sendStatus(200);

    const payload = req.body || {};
    const sourceNumber = String(payload.source_number || "").replace(/\D/g, "");
    const content = String(payload.content || payload.message || "");

    runtime.logger.info("sms.inbound.forwarded", {
      sourceNumber: redactPhone(payload.source_number),
      destinationNumber: redactPhone(payload.destination_number),
      content: redactContent(content),
      companyId: payload.company_id || null,
    });

    // STOP detection. Hard-stop keywords (STOP/UNSUBSCRIBE/CANCEL/QUIT)
    // â†’ mark the SMS channel DNC for every Parallel cadence holding
    // this phone number. Lead remains active; email/RVM/CX continue
    // per their schedules. AI-driven soft-decline detection is a
    // separate, later concern.
    if (sourceNumber && isHardStopKeyword(content)) {
      try {
        const matches = await leadCadenceRepository
          .findActiveControlPlaneLeadCadencesByPhone(sourceNumber);
        for (const lead of matches) {
          await leadCadenceRepository
            .markChannelDnc(lead.domain, lead.caseId, "sms", "opted-out-stop-keyword")
            .catch((error) => {
              runtime.logger.warn("sms.inbound.stop.mark_failed", {
                domain: lead.domain,
                caseId: lead.caseId,
                error: error.message,
              });
            });
        }
        runtime.logger.info("sms.inbound.stop", {
          sourceNumber: redactPhone(sourceNumber),
          content: redactContent(content),
          marked: matches.map((lead) => `${lead.domain}/${lead.caseId}`),
        });
      } catch (error) {
        runtime.logger.warn("sms.inbound.stop.lookup_failed", {
          sourceNumber: redactPhone(sourceNumber),
          error: error.message,
        });
      }
    }

    try {
      await createEvent({
        eventType: "sms.inbound.forwarded",
        sourceService: config.serviceName,
        aggregateType: "sms-conversation",
        aggregateId: sourceNumber || "unknown",
        dedupeKey: [
          sourceNumber,
          String(payload.destination_number || "").replace(/\D/g, ""),
          content.trim(),
        ].join(":"),
        payload,
      });
    } catch (error) {
      runtime.logger.warn("sms.inbound.forwarded.persist_failed", {
        error: error.message,
      });
    }
  });

  app.post("/ringcentral/session-events", requireWebhookSecret, async (req, res) => {
    res.sendStatus(200);

    // Audit-only logging. We previously persisted every envelope to
    // `eventrecords` + `controlplanereviewqueueitems` + a
    // `telephony.ringcentral.observed` workflow row — pure firehose
    // (~69K rows, ~150MB) with zero signal. Real telephony processing
    // runs on the RC subscription native sweep and
    // `processTelephonySessionCandidate`, both independent of this
    // endpoint. Failure modes (RC 429s, CX-down, subscription stalled)
    // surface via `recordServiceAlert` / the subscription watchdog.
    if (config.controlPlaneLogRingCentralSessionEvents) {
      const payload = req.body || {};
      const telephonySessionId =
        String(payload.body?.telephonySessionId || payload.body?.sessionId || "").trim() ||
        "unknown-session";
      runtime.logger.info("ringcentral.session_event.forwarded", {
        telephonySessionId,
        sequence: String(payload.body?.sequence || "").trim() || null,
        timestamp: String(payload.timestamp || payload.body?.eventTime || "").trim() || null,
        candidatesCount: extractAttributionCandidates(payload).length,
      });
    }
  });

  // Internal token broker: lets the barge/voicemail service borrow THIS app's RC
  // platform token instead of authenticating itself. The control-plane already
  // maintains the token on a cached, backoff-aware refresh loop; serving it here
  // keeps the barge entirely off RingCentral's per-app Auth rate-limit group (so a
  // barge boot can never contribute to locking the floor out), and the barge's
  // token refreshes in lockstep with ours. Secret-gated, internal-only.
  app.get("/api/internal/rc/access-token", async (req, res) => {
    const secret = String(process.env.INTERNAL_SERVICE_SECRET || "").trim();
    const provided = String(req.headers["x-internal-secret"] || "").trim();
    if (!secret || provided !== secret) return res.status(403).json({ ok: false, error: "forbidden" });
    try {
      const { createRingCentralClient } = require("../../../packages/shared-integrations/src");
      const rc = createRingCentralClient();
      const accessToken = await rc.authenticate(); // cached / refreshed-if-due / backoff-aware
      const status = rc.getAuthStatus();
      return res.json({ ok: true, accessToken, expiresAt: status.expiresAt || null });
    } catch (error) {
      return res.status(error.status === 429 ? 429 : 502).json({ ok: false, error: error.message });
    }
  });

  // Edge passthroughs so a single 5001/ngrok origin can accept public
  // traffic while the specialized workers keep running on their internal
  // ports.
  app.use("/api/inbound", inboundProxy);
  app.all("/fb/webhook", inboundProxy);
  app.all("/tt/webhook", inboundProxy);
  app.all("/lead-contact", inboundProxy);
  app.all("/lead-contact/pre-ping", inboundProxy);
  app.all("/test-lead", inboundProxy);
  app.use("/api/outbound", auth.requireAdmin, outboundProxy);
  app.all("/drop-webhook", outboundProxy);
  app.get("/drop-balance", auth.requireAdmin, outboundProxy);
  app.use("/api/ringcentral/cx-queue", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ringcentral/cx-serving", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ringcentral/runtime", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ringcentral/reinitialize", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ringcentral/subscription", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ringcentral/presence", auth.requireAdmin, ringcentralProxy);
  app.use("/api/agents", auth.requireAuth, ringcentralUserProxy);
  app.all("/ringbridge/agent-state", auth.requireAdmin, ringcentralProxy);
  app.use("/api/ring/events", auth.requireAdmin, ringcentralProxy);
  app.all("/webhook/ex", ringcentralProxy);
  app.all("/webhook/ringcentral/ex", ringcentralProxy);
  app.all("/webhook/ringcentral/session-events", ringcentralProxy);

  app.use("/api/admin/accounts", createAdminAccountsRouter(auth));
  // Per-agent and per-lead call review (Calls Today, who-dialed-who).
  app.use("/api/admin/call-review", createAdminCallReviewRouter(auth));
  // Surgical lead-cadence adjustments (per-lead test bypass flags).
  app.use("/api/admin/cadence", createAdminCadenceToolsRouter(auth));
  app.use("/api/admin", createAdminConsentRouter(auth));
  // Central runtime observability â€” single endpoint surfacing intake
  // health, recent failures, channel-DNC counts, last STOP, hourly
  // job status. Used during canary cutover to watch for trouble.
  app.use("/api/admin/runtime", createRuntimeRouter(auth));
  app.use("/api/auth", createAuthRouter(config, { logger: runtime.logger }));
  app.use("/api/callrail", createCallrailRouter(auth));
  app.use("/api/commands/clients", createCommandsClientsRouter(auth));
  app.use("/api/commands/cx", createCommandsCxRouter(auth, { logger: runtime.logger }));
  app.use("/api/cx/simple-loop", createCxSimpleLoopRouter(auth, { logger: runtime.logger }));
  app.use("/api/cx/slow-single", createCxSlowSingleRouter(auth, { logger: runtime.logger }));
  app.use("/api/cx/bulk-load", createCxBulkLoadRouter(auth, { logger: runtime.logger, wrapCards: wrapQueueEnabled ? wrapCards : null }));
  app.use("/api/commands/deploy", createCommandsDeployRouter(auth, { bloggerRuntime }));
  app.use("/api/commands/inbox", createCommandsInboxRouter(auth));
  app.use("/api/commands/social", createCommandsSocialRouter(auth));
  app.use("/api/control-plane", createDomainsRouter(auth));
  app.use("/api/dispatch", createDispatchRouter(auth));
  app.use("/api/drop", createDropRouter(auth));
  app.use("/api/events", createEventsRouter(auth));
  app.use("/api/health", createHealthRouter(auth, { getRuntimeState }));
  app.use(
    "/api/hygiene",
    createHygieneRouter(auth, {
      hourlySweepConfig: config.hourlySweep || {},
      spendSyncRuntime,
      logger: runtime.logger,
    }),
  );
  app.use("/api/ai/live-coach", createLiveCoachProxyRouter(auth, { config, logger: runtime.logger }));
  app.use("/api/logics", createLogicsRouter(auth));
  app.use("/api/lexis", createLexisRouter(auth, lexisNightlyRuntime, lexisDailyDropRuntime));
  // Resolution intelligence (secondary-sales panel) — per-user permission
  // grants (resolution.read/write/agent), no role defaults.
  app.use("/api/resolution", createResolutionIntelligenceRouter(auth, config));
  app.use("/api/metrics", createMetricsRouter(auth, spendSyncRuntime));
  app.use("/api/read/clients", createReadClientsRouter(auth));
  app.use("/api/read/cx", createReadCxRouter(auth));
  app.use("/api/read/deploy", createReadDeployRouter(auth, { bloggerRuntime }));
  app.use("/api/read/inbox", createReadInboxRouter(auth));
  app.use("/api/read/library", createReadLibraryRouter(auth));
  app.use("/api/read/metrics", createReadMetricsRouter(auth));
  app.use("/api/read", createReadRouter(auth));
  app.use("/api/read/review", createReadReviewRouter(auth));
  app.use("/api/read/ringcentral", createReadRingcentralRouter(auth));
  app.use("/api/read/social", createReadSocialRouter(auth));
  app.use("/api/read/workspace", createReadWorkspaceRouter(auth));
  // Public-but-signed: streaming proxy for the Apps Script audio
  // player. Auth is via HMAC-signed URL minted by Apps Script (NOT
  // session JWT) so the player can render on a phone without our
  // login flow. See packages/shared-config recordingArchive.playback.
  app.use("/api/recordings", createRecordingPlaybackRouter());
  app.use("/api/ringcentral", createRingCentralRouter(auth));
  app.use("/api/sales-trainer", createSalesTrainerRouter(auth, config));
  app.use("/api/sendgrid", createSendgridRouter(auth));
  app.use("/api/workflows", createWorkflowsRouter(auth));
  app.use("/api/worklists", createWorklistsRouter(auth));

  app.get("/api/health/services", requireHealthAccess, (req, res) => {
    if (!isDetailedHealthRequest(req)) {
      return res.json(buildPublicHealthPayload(config, runtime.getMongoState()));
    }
    res.json(buildTopologyHealth(config));
  });

  attachWebClientBuild(app, runtime);

  app.use((error, req, res, _next) => {
    runtime.logger.error("control-plane.request.failed", {
      error: error.message,
      status: error.status || 500,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip || null,
      forwardedFor: req.get("x-forwarded-for") || null,
      origin: req.get("origin") || null,
      referer: req.get("referer") || null,
      userAgent: req.get("user-agent") || null,
    });
    res.status(error.status || 500).json(toErrorResponse(error));
  });

  if (config.controlPlaneWorker?.enabled !== false) {
    await runStartupCxReservationReconciliation({ runtime }).catch((error) => {
      runtime.logger.error("control-plane.cx_reservation_reconciler.startup.failed", {
        error: error.message || String(error),
      });
    });
  }

  if (config.controlPlaneWorker?.enabled) {
    await startControlPlaneWorker({ config, runtime, workerState });
  } else {
    workerState.enabled = false;
    runtime.logger.warn("control-plane.worker.disabled");
  }

  // Hourly sweeper runs on its own state object so its cadence and
  // health are independent from the primary event-drain worker.
  if (config.controlPlaneWorker?.enabled !== false) {
    await startHourlySweepWorker({
      config,
      runtime,
      workerState: hourlySweepState,
      spendSyncRuntime,
    });
  } else {
    hourlySweepState.enabled = false;
    runtime.logger.warn("control-plane.hourly.disabled");
  }

  if (config.controlPlaneWorker?.enabled !== false) {
    await startCxRecordingWorker({
      config,
      runtime,
      workerState: cxRecordingState,
    });
  } else {
    cxRecordingState.enabled = false;
    runtime.logger.warn("control-plane.cx_recording.disabled");
  }

  if (config.controlPlaneWorker?.enabled !== false) {
    await startCxAppointmentWorker({
      config,
      runtime,
      workerState: cxAppointmentState,
    });
  } else {
    cxAppointmentState.enabled = false;
    runtime.logger.warn("control-plane.cx_appointments.disabled");
  }

  if (config.controlPlaneWorker?.enabled !== false) {
    await startCxTerminalOutboxWorker({
      runtime,
      workerState: cxTerminalOutboxState,
      wrapQueueEnabled,
      wrapCards,
    });
  } else {
    cxTerminalOutboxState.enabled = false;
    runtime.logger.warn("control-plane.cx_terminal_outbox.disabled");
  }

  if (config.controlPlaneWorker?.enabled !== false) {
    // CX LANE DISPATCHERS (2026-07-07, serving boundary): first-touch drip + appointment
    // clock. Both flag-gated INSIDE tickOnce (CX_FIRST_TOUCH_ENABLED / CX_APPT_LANE_ENABLED,
    // default off) — with the flags off these ticks are two no-op env reads. Fail-soft:
    // a tick error is logged, never thrown into the interval.
    const laneDispatchClient = createRingcxVoiceClient();
    const firstTouchDispatcher = createCxFirstTouchDispatcher({
      client: laneDispatchClient,
      logger: runtime.logger,
    });
    const appointmentDispatcher = createCxAppointmentDispatcher({
      client: laneDispatchClient,
      logger: runtime.logger,
    });
    const firstTouchTimer = setInterval(() => {
      firstTouchDispatcher.tickOnce().then((result) => {
        if (result && !result.skipped && (result.dispatched || result.failed)) {
          runtime.logger.info("control-plane.cx_first_touch.dispatch.tick", result);
        }
      }).catch((error) => {
        runtime.logger.warn("control-plane.cx_first_touch.dispatch.failed", { error: error?.message });
      });
    }, 15_000);
    if (typeof firstTouchTimer.unref === "function") firstTouchTimer.unref();
    const appointmentTimer = setInterval(() => {
      appointmentDispatcher.tickOnce().then((result) => {
        if (result && !result.skipped && (result.dispatched || result.failed)) {
          runtime.logger.info("control-plane.cx_appt_lane.dispatch.tick", result);
        }
      }).catch((error) => {
        runtime.logger.warn("control-plane.cx_appt_lane.dispatch.failed", { error: error?.message });
      });
    }, 30_000);
    if (typeof appointmentTimer.unref === "function") appointmentTimer.unref();
  }

  if (config.controlPlaneWorker?.enabled !== false) {
    await startCxAccountActiveCallWatcherWorker({
      runtime,
      workerState: cxAccountActiveCallWatcherState,
    });
  } else {
    cxAccountActiveCallWatcherState.enabled = false;
    runtime.logger.warn("control-plane.cx_account_active_call_watcher.disabled");
  }

  await lexisNightlyRuntime.start();
  await lexisDailyDropRuntime.start();
  await logicsActivityReviewRuntime.start();
  await nightlyCloseRuntime.start();
  await cxNightlyCallGradeRuntime.start();
  await spendSyncRuntime.start();
  await eodRecordingArchiveRuntime.start();
  await phoneburnerRotationRuntime.start();
  await demoRingoutRuntime.start();
  await bloggerRuntime.start();

  const server = app.listen(config.port, config.bindHost, () => {
    runtime.logger.info("listening", { host: config.bindHost, port: config.port });
  });

  server.on("close", () => {
    if (workerState.timer) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
    if (hourlySweepState.timer) {
      clearInterval(hourlySweepState.timer);
      hourlySweepState.timer = null;
    }
    if (cxRecordingState.timer) {
      clearInterval(cxRecordingState.timer);
      cxRecordingState.timer = null;
    }
    if (cxAppointmentState.timer) {
      clearInterval(cxAppointmentState.timer);
      cxAppointmentState.timer = null;
    }
    if (cxTerminalOutboxState.timer) {
      clearInterval(cxTerminalOutboxState.timer);
      cxTerminalOutboxState.timer = null;
    }
    if (cxAccountActiveCallWatcherState.timer) {
      clearInterval(cxAccountActiveCallWatcherState.timer);
      cxAccountActiveCallWatcherState.timer = null;
    }
  });

  // Block shutdown until any in-flight tick is done OR we hit the
  // hard ceiling. Same rationale as outbound-gateway's worker: mongo
  // disconnect mid-tick produces partial state writes. NSSM's default
  // SIGKILL window is 30s; we wait up to 25s here and 25s in the
  // hourly cleanup so the two together stay under the ceiling.
  async function waitForControlPlaneWorkerIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (workerState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (workerState.running) {
      runtime.logger.warn("control-plane.worker.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }
  async function waitForHourlySweepIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (hourlySweepState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (hourlySweepState.running) {
      runtime.logger.warn("control-plane.hourly_sweep.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }
  async function waitForCxRecordingIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (cxRecordingState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (cxRecordingState.running) {
      runtime.logger.warn("control-plane.cx_recording.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }
  async function waitForCxAppointmentsIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (cxAppointmentState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (cxAppointmentState.running) {
      runtime.logger.warn("control-plane.cx_appointments.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }
  async function waitForCxTerminalOutboxIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (cxTerminalOutboxState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (cxTerminalOutboxState.running) {
      runtime.logger.warn("control-plane.cx_terminal_outbox.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }
  async function waitForCxAccountActiveCallWatcherIdle(maxWaitMs = 25_000) {
    const deadline = Date.now() + maxWaitMs;
    while (cxAccountActiveCallWatcherState.running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (cxAccountActiveCallWatcherState.running) {
      runtime.logger.warn("control-plane.cx_account_active_call_watcher.shutdown.tick_timeout", {
        waitedMs: maxWaitMs,
      });
    }
  }

  runtime.registerCleanup("control-plane-server", () => new Promise((resolve) => server.close(() => resolve())));
  runtime.registerCleanup("control-plane-worker", async () => {
    if (workerState.timer) {
      clearInterval(workerState.timer);
      workerState.timer = null;
    }
    await waitForControlPlaneWorkerIdle();
  });
  runtime.registerCleanup("control-plane-hourly-sweep", async () => {
    if (hourlySweepState.timer) {
      clearInterval(hourlySweepState.timer);
      hourlySweepState.timer = null;
    }
    await waitForHourlySweepIdle();
  });
  runtime.registerCleanup("control-plane-cx-recording", async () => {
    if (cxRecordingState.timer) {
      clearInterval(cxRecordingState.timer);
      cxRecordingState.timer = null;
    }
    await waitForCxRecordingIdle();
  });
  runtime.registerCleanup("control-plane-cx-appointments", async () => {
    if (cxAppointmentState.timer) {
      clearInterval(cxAppointmentState.timer);
      cxAppointmentState.timer = null;
    }
    await waitForCxAppointmentsIdle();
  });
  runtime.registerCleanup("control-plane-cx-terminal-outbox", async () => {
    if (cxTerminalOutboxState.timer) {
      clearInterval(cxTerminalOutboxState.timer);
      cxTerminalOutboxState.timer = null;
    }
    await waitForCxTerminalOutboxIdle();
  });
  runtime.registerCleanup("control-plane-cx-account-active-call-watcher", async () => {
    if (cxAccountActiveCallWatcherState.timer) {
      clearInterval(cxAccountActiveCallWatcherState.timer);
      cxAccountActiveCallWatcherState.timer = null;
    }
    await waitForCxAccountActiveCallWatcherIdle();
  });
  runtime.registerCleanup("control-plane-lexis-nightly", async () => {
    await lexisNightlyRuntime.stop();
  });
  runtime.registerCleanup("control-plane-lexis-daily-drop", async () => {
    await lexisDailyDropRuntime.stop();
  });
  runtime.registerCleanup("control-plane-logics-activity-review", async () => {
    await logicsActivityReviewRuntime.stop();
  });
  runtime.registerCleanup("control-plane-nightly-close", async () => {
    await nightlyCloseRuntime.stop();
  });
  runtime.registerCleanup("control-plane-cx-nightly-call-grade", async () => {
    await cxNightlyCallGradeRuntime.stop();
  });
  runtime.registerCleanup("control-plane-spend-sync", async () => {
    await spendSyncRuntime.stop();
  });
  runtime.registerCleanup("control-plane-eod-recording-archive", async () => {
    await eodRecordingArchiveRuntime.stop();
  });
  runtime.registerCleanup("control-plane-phoneburner-rotation", async () => {
    await phoneburnerRotationRuntime.stop();
  });
  runtime.registerCleanup("control-plane-demo-ringout", async () => {
    await demoRingoutRuntime.stop();
  });
  runtime.registerCleanup("control-plane-blogger", async () => {
    await bloggerRuntime.stop();
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
