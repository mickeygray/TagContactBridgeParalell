"use strict";

const fs = require("fs");
const path = require("path");

// Empty-string env vars in the shell block dotenv from loading the
// .env value for that key (dotenv's default is non-override, and an
// empty string counts as "already set"). Delete empty entries so the
// file-level values win. Real non-empty shell vars still take
// precedence — that's the desired prod behavior where env is set
// by the deployment platform.
for (const [key, value] of Object.entries(process.env)) {
  if (value === "") delete process.env[key];
}
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
const { env, envBool, envInt, ensureConfigValue } = require("./env");

const ROOT_DIR = path.resolve(__dirname, "..", "..", "..");
const DEFAULT_PHONEBURNER_LEGACY_SCRIPT_PATH = path.resolve(
  ROOT_DIR,
  "..",
  "TagContactBridge",
  "scripts",
  "run-pb-morning-rotation.js",
);
const {
  DEFAULT_COMPANY,
  getCompanyConfig,
  getFbPageToken,
  getCompanyKeys,
  getIgPageToken,
  resolveCompanyFromFbPageId,
  resolveCompanyFromPayload,
} = require("./companyConfig");
const { getRingCentralConfig } = require("./ringCentralConfig");
const { getGithubConfig } = require("./githubConfig");

const PORTS = Object.freeze({
  webClient: 3001,
  controlPlane: 5001,
  inboundGateway: 4001,
  outboundGateway: 4002,
  ringcentralCx: 6101,
  brandSshGateway: envInt("BRAND_SSH_PORT", 3333),
});

const SERVICE_NAMES = Object.freeze({
  webClient: "web-client",
  controlPlane: "control-plane",
  inboundGateway: "inbound-gateway",
  outboundGateway: "outbound-gateway",
  ringcentralCx: "ringcentral-cx",
  brandSshGateway: "brand-ssh-gateway",
});

const DEFAULT_LEXIS_VENDOR_RECIPIENTS =
  "tax_advocate@wizbangsolutions.com,mike.ciletti@wizbangsolutions.com,james.wickstrom@wizbangsolutions.com";
const DEFAULT_LEXIS_ALERT_RECIPIENTS =
  "mgray@taxadvocategroup.com,manderson@taxadvocategroup.com,abanks@taxadvocategroup.com,jonathan13pineda@yahoo.com";
const DEFAULT_NIGHTLY_LEAD_DATA_RECIPIENTS =
  "mgray@taxadvocategroup.com,manderson@taxadvocategroup.com,liz@lizdev.com,beth@lizdev.com,james@beachmedia.io";
const DEFAULT_NIGHTLY_OPS_RECIPIENTS = "mgray@taxadvocategroup.com";

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseOriginList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildNonStrictFallbackOrigins() {
  const origins = new Set([`http://localhost:${PORTS.webClient}`]);
  const ngrokDomain = String(process.env.NGROK_DOMAIN || "tagcontactbridge.ngrok.app").trim();
  if (ngrokDomain) {
    origins.add(`https://${ngrokDomain}`);
    origins.add(`http://${ngrokDomain}`);
  }
  return Array.from(origins);
}

function isPrivateIpv4Host(hostname) {
  if (!hostname) return false;
  const parts = String(hostname)
    .trim()
    .split(".")
    .map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isPrivateDevOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(String(origin));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }

    const hostname = String(parsed.hostname || "").trim().toLowerCase();
    if (!hostname) return false;
    if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
      return true;
    }
    if (hostname.endsWith(".local")) {
      return true;
    }
    return isPrivateIpv4Host(hostname);
  } catch {
    return false;
  }
}

function readLooseJsonEnvValue(name) {
  const key = String(name || "").trim();
  if (!key) return "";
  try {
    const envPath = path.resolve(__dirname, "..", "..", "..", ".env");
    const content = fs.readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith(`${key}=`)) continue;
      const inline = line.slice(key.length + 1).trim();
      if (inline) return inline;
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const candidate = String(lines[inner] || "").trim();
        if (!candidate || candidate.startsWith("#")) continue;
        return candidate;
      }
    }
  } catch {
    return "";
  }
  return "";
}

function parseGoogleServiceAccountJson(raw, fallbackName = "GOOGLE_SERVICE_ACCOUNT_JSON") {
  const directText = String(raw || "").trim();
  const text = directText || readLooseJsonEnvValue(fallbackName);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Returns a CORS origin value suitable for `cors({ origin })`.
 *
 * - In development (NODE_ENV !== "production"), defaults to reflecting
 *   `http://localhost:3001` so `npm run dev` works out of the box.
 * - In production, requires `WEB_CLIENT_ORIGINS` (comma-separated) and
 *   rejects anything else.
 */
function getCorsOriginResolver() {
  // Strict CORS requires WEB_CLIENT_ORIGINS. Strict is ON when NODE_ENV is
  // production, unless STRICT_STARTUP_VALIDATION=false explicitly opts out.
  // This matches the rest of the service's startup-validation gates so a
  // single env lever turns dev-friendly mode on/off consistently.
  const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  const strictMode = boolFromEnv(process.env.STRICT_STARTUP_VALIDATION, isProduction);
  const allowed = parseOriginList(
    process.env.WEB_CLIENT_ORIGINS ||
      process.env.WEB_CLIENT_ORIGIN ||
      (strictMode ? "" : buildNonStrictFallbackOrigins().join(",")),
  );

  if (allowed.length === 0) {
    // Strict mode with no origins configured — refuse everything so it's
    // obvious immediately. Curl-style requests (no Origin header) still pass.
    return (origin, callback) => {
      if (!origin) return callback(null, true);
      return callback(new Error("CORS origin not allowed"), false);
    };
  }

  const allowedSet = new Set(allowed);
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedSet.has(origin)) return callback(null, true);
    if (!strictMode && isPrivateDevOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin ${origin} not allowed`), false);
  };
}

function getSharedConfig(overrides = {}) {
  const googleServiceAccount =
    parseGoogleServiceAccountJson(
      overrides.googleServiceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    ) || {};

  return {
    rootDir: ROOT_DIR,
    mongoUri:
      overrides.mongoUri ||
      process.env.MONGO_URI ||
      "mongodb://127.0.0.1:27017/tagcontactbridge_parallel",
    parallelDbName:
      overrides.parallelDbName ||
      process.env.PARALLEL_DB_NAME ||
      "tagcontactbridge_parallel",
    bindHost:
      overrides.bindHost ||
      process.env.SERVICE_BIND_HOST ||
      "127.0.0.1",
    jwtSecret: overrides.jwtSecret || process.env.JWT_SECRET || "change-me",
    jwtTtlHours: Number(overrides.jwtTtlHours || process.env.JWT_TTL_HOURS || 12),
    otpTtlMinutes: Number(overrides.otpTtlMinutes || process.env.AUTH_OTP_TTL_MINUTES || 10),
    otpMaxAttempts: Number(overrides.otpMaxAttempts || process.env.AUTH_OTP_MAX_ATTEMPTS || 5),
    // SECURITY: authOtpPreview surfaces the OTP code inline in the
    // /api/auth/send-code response. Useful in dev for skipping email
    // delivery; in prod it's a critical bypass — anyone who can hit
    // send-code with a valid email gets the code in the response body.
    // Default OFF; explicit opt-in required via AUTH_OTP_PREVIEW=true.
    // Strict-mode startup validation (see validateSharedConfig) refuses
    // to boot if this is true with NODE_ENV=production.
    authOtpPreview: boolFromEnv(
      overrides.authOtpPreview !== undefined ? overrides.authOtpPreview : process.env.AUTH_OTP_PREVIEW,
      false,
    ),
    authOtpDelivery: {
      fromEmail: env("AUTH_OTP_FROM_EMAIL", env("SENDGRID_FROM_EMAIL", "")),
      fromName: env("AUTH_OTP_FROM_NAME", env("SENDGRID_FROM_NAME", "TagContactBridge")),
      subject: env("AUTH_OTP_SUBJECT", "Your sign-in code"),
      defaultCompany: env("AUTH_OTP_COMPANY", DEFAULT_COMPANY),
    },
    logicsDncStatusIds: parseOriginList(env("LOGICS_DNC_STATUS_IDS", ""))
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
    logicsProspectStatusIds: parseOriginList(
      env("LOGICS_PROSPECT_STATUS_IDS", "1,2"),
    )
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value)),
    controlPlaneLogRingCentralSessionEvents: boolFromEnv(
      overrides.controlPlaneLogRingCentralSessionEvents !== undefined
        ? overrides.controlPlaneLogRingCentralSessionEvents
        : process.env.CONTROL_PLANE_LOG_RINGCENTRAL_SESSION_EVENTS,
      false,
    ),
    outboundCallfireDebug: boolFromEnv(
      overrides.outboundCallfireDebug !== undefined
        ? overrides.outboundCallfireDebug
        : process.env.OUTBOUND_CALLFIRE_DEBUG,
      true,
    ),
    prospectCleaner: {
      defaultLimit: envInt("PROSPECT_CLEANER_LIMIT", 500),
      delayMsBetweenCalls: envInt("PROSPECT_CLEANER_DELAY_MS", 150),
    },
    skipMongo: boolFromEnv(
      overrides.skipMongo !== undefined ? overrides.skipMongo : process.env.SKIP_MONGO,
      false,
    ),
    adminAccount: {
      email: env("ADMIN_EMAIL", "admin@example.com").toLowerCase(),
      name: env("ADMIN_NAME", "Parallel Admin"),
      role: "admin",
    },
    runtimeDefaults: {
      testEmail: env("PARALLEL_TEST_EMAIL", env("ADMIN_EMAIL", "admin@example.com")).toLowerCase(),
      testPhone: env("PARALLEL_TEST_PHONE", "3106665997"),
    },
    demoRingout: {
      enabled: boolFromEnv(
        overrides.demoRingoutEnabled !== undefined
          ? overrides.demoRingoutEnabled
          : process.env.DEMO_RINGOUT_ENABLED,
        false,
      ),
      dryRun: boolFromEnv(
        overrides.demoRingoutDryRun !== undefined
          ? overrides.demoRingoutDryRun
          : process.env.DEMO_RINGOUT_DRY_RUN,
        true,
      ),
      timezone: env("DEMO_RINGOUT_TIMEZONE", "America/Los_Angeles"),
      date: env("DEMO_RINGOUT_DATE", "2026-05-09"),
      startTime: env("DEMO_RINGOUT_START_TIME", "10:00"),
      endTime: env("DEMO_RINGOUT_END_TIME", "12:00"),
      intervalMinutes: envInt("DEMO_RINGOUT_INTERVAL_MINUTES", 10),
      tickMs: envInt("DEMO_RINGOUT_TICK_MS", 15_000),
      loopCount: envInt("DEMO_RINGOUT_LOOP_COUNT", 1),
      ringSeconds: envInt("DEMO_RINGOUT_RING_SECONDS", 120),
      pauseSeconds: envInt("DEMO_RINGOUT_PAUSE_SECONDS", 60),
      extensionId: env("DEMO_RINGOUT_EXTENSION_ID", "~"),
      fromPhone: env("DEMO_RINGOUT_FROM_PHONE", "+18182728593"),
      toPhone: env("DEMO_RINGOUT_TO_PHONE", "+13106165148"),
      callerIdPhone: env("DEMO_RINGOUT_CALLER_ID_PHONE", ""),
      label: env("DEMO_RINGOUT_LABEL", "Inbound prospect"),
      playPrompt: boolFromEnv(
        overrides.demoRingoutPlayPrompt !== undefined
          ? overrides.demoRingoutPlayPrompt
          : process.env.DEMO_RINGOUT_PLAY_PROMPT,
        false,
      ),
      externalNotifyPhone: env("DEMO_RINGOUT_EXTERNAL_NOTIFY_PHONE", ""),
      externalNotifyMode: env("DEMO_RINGOUT_EXTERNAL_NOTIFY_MODE", "off"),
      externalNotifyPollSeconds: envInt("DEMO_RINGOUT_EXTERNAL_NOTIFY_POLL_SECONDS", 60),
    },
    anthropic: {
      model: env("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
      maxTokens: envInt("ANTHROPIC_MAX_TOKENS", 1200),
      temperature: Number(env("ANTHROPIC_TEMPERATURE", "0")),
    },
    internalServiceSecret:
      overrides.internalServiceSecret ||
      process.env.INTERNAL_SERVICE_SECRET ||
      process.env.OUTBOUND_GATEWAY_SECRET ||
      "",
    controlPlaneBaseUrl:
      overrides.controlPlaneBaseUrl ||
      process.env.CONTROL_PLANE_BASE_URL ||
      `http://127.0.0.1:${PORTS.controlPlane}`,
    healthToken:
      overrides.healthToken ||
      process.env.HEALTH_TOKEN ||
      "",
    outboundRequireInternalAuth: boolFromEnv(
      overrides.outboundRequireInternalAuth !== undefined
        ? overrides.outboundRequireInternalAuth
        : process.env.OUTBOUND_REQUIRE_INTERNAL_AUTH,
      false,
    ),
    outboundWorker: {
      enabled: boolFromEnv(
        overrides.outboundWorkerEnabled !== undefined
          ? overrides.outboundWorkerEnabled
          : process.env.OUTBOUND_WORKER_ENABLED,
        true,
      ),
      intervalMs: envInt("OUTBOUND_WORKER_INTERVAL_MS", 5000),
      batchSize: envInt("OUTBOUND_WORKER_BATCH_SIZE", 25),
      idleSleepMs: envInt("OUTBOUND_WORKER_IDLE_SLEEP_MS", 2000),
      maxAttempts: envInt("OUTBOUND_WORKER_MAX_ATTEMPTS", 5),
      cadenceSweepEnabled: boolFromEnv(
        overrides.outboundCadenceSweepEnabled !== undefined
          ? overrides.outboundCadenceSweepEnabled
          : process.env.OUTBOUND_CADENCE_SWEEP_ENABLED,
        true,
      ),
    },
    scheduledBlasts: {
      enabled: boolFromEnv(
        overrides.scheduledBlastsEnabled !== undefined
          ? overrides.scheduledBlastsEnabled
          : process.env.OUTBOUND_SCHEDULED_BLASTS_ENABLED,
        false,
      ),
      timezone:
        overrides.scheduledBlastsTimezone ||
        process.env.OUTBOUND_SCHEDULED_BLASTS_TIMEZONE ||
        "America/Los_Angeles",
      hour: Math.max(0, Math.min(23, envInt("OUTBOUND_SCHEDULED_BLASTS_HOUR", 12))),
      minute: Math.max(0, Math.min(59, envInt("OUTBOUND_SCHEDULED_BLASTS_MINUTE", 0))),
      domains: parseOriginList(
        overrides.scheduledBlastsDomains ||
          process.env.OUTBOUND_SCHEDULED_BLASTS_DOMAINS ||
          getCompanyKeys().join(","),
      ).map((value) => String(value).toUpperCase()),
      maxAudience: Math.max(
        1,
        envInt("OUTBOUND_SCHEDULED_BLASTS_MAX_AUDIENCE", 20000),
      ),
      channels: {
        callfire: {
          templateKey:
            overrides.scheduledBlastsCallfireTemplateKey ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_CALLFIRE_TEMPLATE_KEY ||
            "",
          content:
            overrides.scheduledBlastsCallfireContent ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_CALLFIRE_CONTENT ||
            "",
          ratePerMinute: envInt("OUTBOUND_SCHEDULED_BLASTS_CALLFIRE_RATE_PER_MINUTE", 1),
          pulseSize: envInt("OUTBOUND_SCHEDULED_BLASTS_CALLFIRE_PULSE_SIZE", 0),
          pulseDelayMs: envInt("OUTBOUND_SCHEDULED_BLASTS_CALLFIRE_PULSE_DELAY_MS", 0),
        },
        sms: {
          content:
            overrides.scheduledBlastsSmsContent ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_SMS_CONTENT ||
            "",
          trackingNumber:
            overrides.scheduledBlastsSmsTrackingNumber ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_SMS_TRACKING_NUMBER ||
            "",
          pulseSize: envInt("OUTBOUND_SCHEDULED_BLASTS_SMS_PULSE_SIZE", 0),
          pulseDelayMs: envInt("OUTBOUND_SCHEDULED_BLASTS_SMS_PULSE_DELAY_MS", 0),
        },
        email: {
          subject:
            overrides.scheduledBlastsEmailSubject ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_EMAIL_SUBJECT ||
            "",
          content:
            overrides.scheduledBlastsEmailContent ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_EMAIL_CONTENT ||
            "",
          templateKey:
            overrides.scheduledBlastsEmailTemplateKey ||
            process.env.OUTBOUND_SCHEDULED_BLASTS_EMAIL_TEMPLATE_KEY ||
            "",
          pulseSize: envInt("OUTBOUND_SCHEDULED_BLASTS_EMAIL_PULSE_SIZE", 0),
          pulseDelayMs: envInt("OUTBOUND_SCHEDULED_BLASTS_EMAIL_PULSE_DELAY_MS", 0),
        },
      },
    },
    outboundRateShaper: {
      enabled: boolFromEnv(
        overrides.outboundRateShaperEnabled !== undefined
          ? overrides.outboundRateShaperEnabled
          : process.env.OUTBOUND_RATE_SHAPER_ENABLED,
        true,
      ),
      windowMinutes: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_WINDOW_MINUTES", 15)),
      channels: {
        rvm: {
          enabled: boolFromEnv(
            overrides.outboundRateShaperRvmEnabled !== undefined
              ? overrides.outboundRateShaperRvmEnabled
              : process.env.OUTBOUND_RATE_SHAPER_RVM_ENABLED,
            true,
          ),
          baseTokens: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_RVM_BASE_TOKENS", 20)),
          maxTokens: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_RVM_MAX_TOKENS", 40)),
          queueStep: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_RVM_QUEUE_STEP", 25)),
          tokensPerStep: Math.max(0, envInt("OUTBOUND_RATE_SHAPER_RVM_TOKENS_PER_STEP", 5)),
        },
        cx: {
          enabled: boolFromEnv(
            overrides.outboundRateShaperCxEnabled !== undefined
              ? overrides.outboundRateShaperCxEnabled
              : process.env.OUTBOUND_RATE_SHAPER_CX_ENABLED,
            true,
          ),
          baseTokens: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_CX_BASE_TOKENS", 12)),
          maxTokens: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_CX_MAX_TOKENS", 30)),
          queueStep: Math.max(1, envInt("OUTBOUND_RATE_SHAPER_CX_QUEUE_STEP", 15)),
          tokensPerStep: Math.max(0, envInt("OUTBOUND_RATE_SHAPER_CX_TOKENS_PER_STEP", 3)),
        },
      },
    },
    controlPlaneWorker: {
      enabled: boolFromEnv(
        overrides.controlPlaneWorkerEnabled !== undefined
          ? overrides.controlPlaneWorkerEnabled
          : process.env.CONTROL_PLANE_WORKER_ENABLED,
        true,
      ),
      intervalMs: envInt("CONTROL_PLANE_WORKER_INTERVAL_MS", 5000),
      batchSize: envInt("CONTROL_PLANE_WORKER_BATCH_SIZE", 25),
      maxAttempts: envInt("CONTROL_PLANE_WORKER_MAX_ATTEMPTS", 5),
    },
    hourlySweep: {
      spendSyncEnabled: boolFromEnv(
        overrides.hourlySpendSyncEnabled !== undefined
          ? overrides.hourlySpendSyncEnabled
          : process.env.HOURLY_SPEND_SYNC_ENABLED,
        true,
      ),
      metricsRefreshEnabled: boolFromEnv(
        overrides.hourlyMetricsRefreshEnabled !== undefined
          ? overrides.hourlyMetricsRefreshEnabled
          : process.env.HOURLY_METRICS_REFRESH_ENABLED,
        true,
      ),
      metricsRefreshPreferLegacyContactActivities: boolFromEnv(
        overrides.hourlyMetricsRefreshPreferLegacyContactActivities !== undefined
          ? overrides.hourlyMetricsRefreshPreferLegacyContactActivities
          : process.env.HOURLY_METRICS_REFRESH_PREFER_LEGACY_CONTACT_ACTIVITIES,
        false,
      ),
      paymentReconcileMaxCasesPerDomain: Math.max(
        1,
        envInt("HOURLY_PAYMENT_RECONCILE_MAX_CASES_PER_DOMAIN", 250),
      ),
      leadCadenceEnforcementEnabled: boolFromEnv(
        overrides.hourlyLeadCadenceEnforcementEnabled !== undefined
          ? overrides.hourlyLeadCadenceEnforcementEnabled
          : process.env.HOURLY_LEAD_CADENCE_ENFORCEMENT_ENABLED,
        false,
      ),
      leadCadenceEnforcementLimitPerDomain: Math.max(
        1,
        envInt("HOURLY_LEAD_CADENCE_ENFORCEMENT_LIMIT_PER_DOMAIN", 250),
      ),
      leadCadenceEnforcementMinStaleMs: Math.max(
        0,
        envInt("HOURLY_LEAD_CADENCE_ENFORCEMENT_MIN_STALE_MS", 55 * 60 * 1000),
      ),
      leadCadenceEnforcementDryRun: boolFromEnv(
        overrides.hourlyLeadCadenceEnforcementDryRun !== undefined
          ? overrides.hourlyLeadCadenceEnforcementDryRun
          : process.env.HOURLY_LEAD_CADENCE_ENFORCEMENT_DRY_RUN,
        false,
      ),
      callLogHygieneEnabled: boolFromEnv(
        overrides.hourlyCallLogHygieneEnabled !== undefined
          ? overrides.hourlyCallLogHygieneEnabled
          : process.env.HOURLY_CALL_LOG_HYGIENE_ENABLED,
        true,
      ),
      callLogHygieneSinceMs: Math.max(
        5 * 60 * 1000,
        envInt("HOURLY_CALL_LOG_HYGIENE_SINCE_MS", 65 * 60 * 1000),
      ),
      callLogHygieneLimitPerDomain: Math.max(
        1,
        envInt("HOURLY_CALL_LOG_HYGIENE_LIMIT_PER_DOMAIN", 200),
      ),
      callLogHygieneMirrorLegacyContactActivities: boolFromEnv(
        overrides.hourlyCallLogHygieneMirrorLegacyContactActivities !== undefined
          ? overrides.hourlyCallLogHygieneMirrorLegacyContactActivities
          : process.env.HOURLY_CALL_LOG_HYGIENE_MIRROR_LEGACY_CONTACT_ACTIVITIES,
        false,
      ),
      callLogHygieneNativeSweepEnabled: boolFromEnv(
        overrides.hourlyCallLogHygieneNativeSweepEnabled !== undefined
          ? overrides.hourlyCallLogHygieneNativeSweepEnabled
          : process.env.HOURLY_CALL_LOG_NATIVE_SWEEP_ENABLED,
        true,
      ),
      callLogHygieneNativeSweepLimit: Math.max(
        1,
        envInt("HOURLY_CALL_LOG_NATIVE_SWEEP_LIMIT", 1000),
      ),
      callLogHygieneNativeSweepMaxPages: Math.max(
        1,
        envInt("HOURLY_CALL_LOG_NATIVE_SWEEP_MAX_PAGES", 20),
      ),
      callLogHygieneNativeSweepDefaultDomain:
        overrides.hourlyCallLogHygieneNativeSweepDefaultDomain ||
        process.env.HOURLY_CALL_LOG_NATIVE_SWEEP_DEFAULT_DOMAIN ||
        DEFAULT_COMPANY,
      callLogHygieneMinDurationSec: Math.max(
        0,
        envInt("HOURLY_CALL_LOG_HYGIENE_MIN_DURATION_SEC", 180),
      ),
      callLogHygieneMaxCaseRefreshesPerDomain: Math.max(
        0,
        envInt("HOURLY_CALL_LOG_HYGIENE_MAX_CASE_REFRESHES_PER_DOMAIN", 20),
      ),
      callLogHygieneMaxScoringPerDomain: Math.max(
        0,
        envInt("HOURLY_CALL_LOG_HYGIENE_MAX_SCORING_PER_DOMAIN", 4),
      ),
      callLogHygieneMaxArchivePerDomain: Math.max(
        0,
        envInt("HOURLY_CALL_LOG_HYGIENE_MAX_ARCHIVE_PER_DOMAIN", 50),
      ),
      callLogHygieneScorePendingCalls: boolFromEnv(
        overrides.hourlyCallLogHygieneScorePendingCalls !== undefined
          ? overrides.hourlyCallLogHygieneScorePendingCalls
          : process.env.HOURLY_CALL_LOG_HYGIENE_SCORE_PENDING_CALLS,
        true,
      ),
      callLogHygieneArchiveRecordings: boolFromEnv(
        overrides.hourlyCallLogHygieneArchiveRecordings !== undefined
          ? overrides.hourlyCallLogHygieneArchiveRecordings
          : process.env.HOURLY_CALL_LOG_HYGIENE_ARCHIVE_RECORDINGS,
        true,
      ),
    },
    lexisNightly: {
      enabled: boolFromEnv(
        overrides.lexisNightlyEnabled !== undefined
          ? overrides.lexisNightlyEnabled
          : process.env.LEXIS_NIGHTLY_ENABLED,
        false,
      ),
      domain: String(
        overrides.lexisNightlyDomain ||
          process.env.LEXIS_NIGHTLY_DOMAIN ||
          DEFAULT_COMPANY,
      ).toUpperCase(),
      hour: Math.max(0, Math.min(23, envInt("LEXIS_NIGHTLY_HOUR", 2))),
      minute: Math.max(0, Math.min(59, envInt("LEXIS_NIGHTLY_MINUTE", 0))),
      intervalMs: Math.max(
        10000,
        envInt("LEXIS_NIGHTLY_INTERVAL_MS", 30000),
      ),
      activeWeekdays: parseOriginList(
        overrides.lexisNightlyActiveWeekdays ||
          process.env.LEXIS_NIGHTLY_ACTIVE_WEEKDAYS ||
          "1,2,3,4,5",
      )
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
      sendRegionalMail: boolFromEnv(
        overrides.lexisNightlySendRegionalMail !== undefined
          ? overrides.lexisNightlySendRegionalMail
          : process.env.LEXIS_NIGHTLY_SEND_REGIONAL,
        true,
      ),
      recipients:
        overrides.lexisNightlyRecipients ||
        process.env.LEXIS_NIGHTLY_RECIPIENTS ||
        process.env.MAILHOUSE_2_EMAIL ||
        DEFAULT_LEXIS_VENDOR_RECIPIENTS,
      subject:
        overrides.lexisNightlySubject ||
        process.env.LEXIS_NIGHTLY_SUBJECT ||
        "Maverick Daily Drop",
      text:
        overrides.lexisNightlyText ||
        process.env.LEXIS_NIGHTLY_TEXT ||
        "Please see the attached file.",
    },
    lexisDailyDrop: {
      enabled: boolFromEnv(
        overrides.lexisDailyDropEnabled !== undefined
          ? overrides.lexisDailyDropEnabled
          : process.env.LEXIS_DAILY_DROP_ENABLED,
        false,
      ),
      domain: String(
        overrides.lexisDailyDropDomain ||
          process.env.LEXIS_DAILY_DROP_DOMAIN ||
          DEFAULT_COMPANY,
      ).toUpperCase(),
      hour: Math.max(0, Math.min(23, envInt("LEXIS_DAILY_DROP_HOUR", 2))),
      minute: Math.max(0, Math.min(59, envInt("LEXIS_DAILY_DROP_MINUTE", 0))),
      intervalMs: Math.max(
        10000,
        envInt("LEXIS_DAILY_DROP_INTERVAL_MS", 30000),
      ),
      activeWeekdays: parseOriginList(
        overrides.lexisDailyDropActiveWeekdays ||
          process.env.LEXIS_DAILY_DROP_ACTIVE_WEEKDAYS ||
          "1,2,3,4,5",
      )
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
      timezone:
        overrides.lexisDailyDropTimezone ||
        process.env.LEXIS_DAILY_DROP_TIMEZONE ||
        "America/Los_Angeles",
      recipients:
        overrides.lexisDailyDropRecipients ||
        process.env.LEXIS_DAILY_DROP_RECIPIENTS ||
        process.env.MAILHOUSE_EMAIL ||
        DEFAULT_LEXIS_VENDOR_RECIPIENTS,
      alertRecipients:
        overrides.lexisDailyDropAlertRecipients ||
        process.env.LEXIS_DAILY_DROP_ALERT_RECIPIENTS ||
        DEFAULT_LEXIS_ALERT_RECIPIENTS,
      subject:
        overrides.lexisDailyDropSubject ||
        process.env.LEXIS_DAILY_DROP_SUBJECT ||
        "Daily Drop",
      text:
        overrides.lexisDailyDropText ||
        process.env.LEXIS_DAILY_DROP_TEXT ||
        "Please see the attached file.",
      alertSubject:
        overrides.lexisDailyDropAlertSubject ||
        process.env.LEXIS_DAILY_DROP_ALERT_SUBJECT ||
        "",
      alertText:
        overrides.lexisDailyDropAlertText ||
        process.env.LEXIS_DAILY_DROP_ALERT_TEXT ||
        "",
    },
    nightlyClose: {
      enabled: boolFromEnv(
        overrides.nightlyCloseEnabled !== undefined
          ? overrides.nightlyCloseEnabled
          : process.env.NIGHTLY_CLOSE_ENABLED,
        false,
      ),
      domains: parseOriginList(
        overrides.nightlyCloseDomains ||
          process.env.NIGHTLY_CLOSE_DOMAINS ||
          "TAG,WYNN",
      ).map((value) => String(value).toUpperCase()),
      hour: Math.max(0, Math.min(23, envInt("NIGHTLY_CLOSE_HOUR", 21))),
      minute: Math.max(0, Math.min(59, envInt("NIGHTLY_CLOSE_MINUTE", 30))),
      timezone:
        overrides.nightlyCloseTimezone ||
        process.env.NIGHTLY_CLOSE_TIMEZONE ||
        "America/Los_Angeles",
      intervalMs: Math.max(
        10000,
        envInt("NIGHTLY_CLOSE_INTERVAL_MS", 60000),
      ),
      activeWeekdays: parseOriginList(
        overrides.nightlyCloseActiveWeekdays ||
          process.env.NIGHTLY_CLOSE_ACTIVE_WEEKDAYS ||
          "1,2,3,4,5",
      )
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
      sendEmail: boolFromEnv(
        overrides.nightlyCloseSendEmail !== undefined
          ? overrides.nightlyCloseSendEmail
          : process.env.NIGHTLY_CLOSE_SEND_EMAIL,
        false,
      ),
      recipients: parseOriginList(
        overrides.nightlyCloseRecipients ||
          process.env.NIGHTLY_CLOSE_RECIPIENTS ||
          DEFAULT_LEXIS_ALERT_RECIPIENTS,
      ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean),
      financialRecipients: parseOriginList(
        overrides.nightlyCloseFinancialRecipients ||
          process.env.NIGHTLY_CLOSE_FINANCIAL_RECIPIENTS ||
          DEFAULT_LEXIS_ALERT_RECIPIENTS,
      ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean),
      leadDataRecipients: parseOriginList(
        overrides.nightlyCloseLeadDataRecipients ||
          process.env.NIGHTLY_CLOSE_LEAD_DATA_RECIPIENTS ||
          process.env.RB_REPORT_TO ||
          DEFAULT_NIGHTLY_LEAD_DATA_RECIPIENTS,
      ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean),
      opsRecipients: parseOriginList(
        overrides.nightlyCloseOpsRecipients ||
          process.env.NIGHTLY_CLOSE_OPS_RECIPIENTS ||
          env("ADMIN_EMAIL", DEFAULT_NIGHTLY_OPS_RECIPIENTS),
      ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean),
    },
    phoneburnerRotation: {
      // Bridge runtime — owns the 7am Mon–Fri PhoneBurner folder
      // rotation until PhoneBurner is fully deprecated by CX. Spawns
      // the legacy `scripts/run-pb-morning-rotation.js`. Defaults
      // OFF so we don't accidentally double-fire alongside legacy
      // webhook.js's own cron — flip on via env when ready, then
      // comment out the legacy cron.
      enabled: boolFromEnv(
        overrides.phoneburnerRotationEnabled !== undefined
          ? overrides.phoneburnerRotationEnabled
          : process.env.PHONEBURNER_ROTATION_ENABLED,
        false,
      ),
      hour: Math.max(0, Math.min(23, envInt("PHONEBURNER_ROTATION_HOUR", 7))),
      minute: Math.max(0, Math.min(59, envInt("PHONEBURNER_ROTATION_MINUTE", 0))),
      timezone:
        overrides.phoneburnerRotationTimezone ||
        process.env.PHONEBURNER_ROTATION_TIMEZONE ||
        "America/Los_Angeles",
      intervalMs: Math.max(
        10_000,
        envInt("PHONEBURNER_ROTATION_INTERVAL_MS", 60_000),
      ),
      domains: parseOriginList(
        overrides.phoneburnerRotationDomains ||
          process.env.PHONEBURNER_ROTATION_DOMAINS ||
          "WYNN",
      ).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean),
      legacyScriptPath:
        overrides.phoneburnerRotationLegacyScriptPath ||
        process.env.PHONEBURNER_ROTATION_LEGACY_SCRIPT_PATH ||
        DEFAULT_PHONEBURNER_LEGACY_SCRIPT_PATH,
    },
    spendSync: {
      enabled: boolFromEnv(
        overrides.spendSyncEnabled !== undefined
          ? overrides.spendSyncEnabled
          : process.env.SPEND_SYNC_ENABLED,
        true,
      ),
      hour: Math.max(0, Math.min(23, envInt("SPEND_SYNC_HOUR", 19))),
      minute: Math.max(0, Math.min(59, envInt("SPEND_SYNC_MINUTE", 45))),
      timezone:
        overrides.spendSyncTimezone ||
        process.env.SPEND_SYNC_TIMEZONE ||
        "America/Los_Angeles",
      intervalMs: Math.max(
        10000,
        envInt("SPEND_SYNC_INTERVAL_MS", 60000),
      ),
      activeWeekdays: parseOriginList(
        overrides.spendSyncActiveWeekdays ||
          process.env.SPEND_SYNC_ACTIVE_WEEKDAYS ||
          "1,2,3,4,5",
      )
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
      mailerTagUrl:
        overrides.spendSheetMailerTagUrl ||
        process.env.SPEND_SHEET_MAILER_TAG_URL ||
        process.env.MAILER_SPEND_SHEET ||
        "",
      metaTagUrl:
        overrides.spendSheetMetaTagUrl ||
        process.env.SPEND_SHEET_META_TAG_URL ||
        process.env.SOCIAL_SPEND_SHEET ||
        "",
      metaWynnUrl:
        overrides.spendSheetMetaWynnUrl ||
        process.env.SPEND_SHEET_META_WYNN_URL ||
        "",
    },
    recordingArchive: {
      enabled: boolFromEnv(
        overrides.recordingArchiveEnabled !== undefined
          ? overrides.recordingArchiveEnabled
          : process.env.RECORDING_ARCHIVE_ENABLED,
        false,
      ),
      minDurationSec: Math.max(
        60,
        envInt("RECORDING_ARCHIVE_MIN_DURATION_SEC", 360),
      ),
      initialDelayMs: Math.max(
        0,
        envInt("RECORDING_ARCHIVE_DELAY_MS", 180000),
      ),
      maxAttempts: Math.max(
        1,
        envInt("RECORDING_ARCHIVE_MAX_ATTEMPTS", 24),
      ),
      drive: {
        clientEmail:
          overrides.recordingArchiveGoogleClientEmail ||
          process.env.RECORDING_ARCHIVE_GOOGLE_CLIENT_EMAIL ||
          googleServiceAccount.client_email ||
          process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ||
          "",
        privateKey: (
          overrides.recordingArchiveGooglePrivateKey ||
          process.env.RECORDING_ARCHIVE_GOOGLE_PRIVATE_KEY ||
          googleServiceAccount.private_key ||
          process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY ||
          ""
        ).replace(/\\n/g, "\n"),
        tokenUri:
          overrides.recordingArchiveGoogleTokenUri ||
          process.env.RECORDING_ARCHIVE_GOOGLE_TOKEN_URI ||
          googleServiceAccount.token_uri ||
          "https://oauth2.googleapis.com/token",
        scope:
          overrides.recordingArchiveGoogleScope ||
          process.env.RECORDING_ARCHIVE_GOOGLE_SCOPE ||
          "https://www.googleapis.com/auth/drive",
        supportsAllDrives: boolFromEnv(
          overrides.recordingArchiveSupportsAllDrives !== undefined
            ? overrides.recordingArchiveSupportsAllDrives
            : process.env.RECORDING_ARCHIVE_SUPPORTS_ALL_DRIVES,
          true,
        ),
      },
      destinations: {
        og: {
          key:
            overrides.recordingArchiveOgKey ||
            process.env.RECORDING_ARCHIVE_OG_KEY ||
            "og",
          label:
            overrides.recordingArchiveOgLabel ||
            process.env.RECORDING_ARCHIVE_OG_LABEL ||
            "OG",
          folderId:
            overrides.recordingArchiveOgFolderId ||
            process.env.OG_RECORDING_DUMP_FOLDER_ID ||
            process.env.RECORDING_ARCHIVE_GROUP_A_FOLDER_ID ||
            "",
        },
        as: {
          key:
            overrides.recordingArchiveAsKey ||
            process.env.RECORDING_ARCHIVE_AS_KEY ||
            "as",
          label:
            overrides.recordingArchiveAsLabel ||
            process.env.RECORDING_ARCHIVE_AS_LABEL ||
            "AS",
          folderId:
            overrides.recordingArchiveAsFolderId ||
            process.env.AS_RECORDING_DUMP_FOLDER_ID ||
            process.env.RECORDING_ARCHIVE_GROUP_B_FOLDER_ID ||
            "",
        },
        cs: {
          key:
            overrides.recordingArchiveCsKey ||
            process.env.RECORDING_ARCHIVE_CS_KEY ||
            "cs",
          label:
            overrides.recordingArchiveCsLabel ||
            process.env.RECORDING_ARCHIVE_CS_LABEL ||
            "CS",
          folderId:
            overrides.recordingArchiveCsFolderId ||
            process.env.CS_RECORDING_DUMP_FOLDER_ID ||
            process.env.RECORDING_ARCHIVE_CSERV_FOLDER_ID ||
            "",
          queueExtensionNumbers: parseOriginList(
            overrides.recordingArchiveCsQueueExtensionNumbers ||
              process.env.RECORDING_ARCHIVE_CS_QUEUE_EXTENSION_NUMBERS ||
              process.env.RECORDING_ARCHIVE_CSERV_QUEUE_EXTENSION_NUMBERS ||
              "505,5051,5052",
          ),
        },
      },
      groups: [
        {
          key:
            overrides.recordingArchiveGroupAKey ||
            process.env.RECORDING_ARCHIVE_GROUP_A_KEY ||
            "origination",
          label:
            overrides.recordingArchiveGroupALabel ||
            process.env.RECORDING_ARCHIVE_GROUP_A_LABEL ||
            "Origination",
          folderId:
            overrides.recordingArchiveGroupAFolderId ||
            process.env.RECORDING_ARCHIVE_GROUP_A_FOLDER_ID ||
            "",
          extensionIds: parseOriginList(
            overrides.recordingArchiveGroupAExtensionIds ||
              process.env.RECORDING_ARCHIVE_GROUP_A_EXTENSION_IDS ||
              "",
          ),
          extensionNumbers: parseOriginList(
            overrides.recordingArchiveGroupAExtensionNumbers ||
              process.env.RECORDING_ARCHIVE_GROUP_A_EXTENSION_NUMBERS ||
              "319,209,966",
          ),
          agentNames: parseOriginList(
            overrides.recordingArchiveGroupAAgentNames ||
              process.env.RECORDING_ARCHIVE_GROUP_A_AGENT_NAMES ||
              "Phil Olson,Sean Lucas,Anthony Calloway,Bruce Allen",
          ),
        },
        {
          key:
            overrides.recordingArchiveGroupBKey ||
            process.env.RECORDING_ARCHIVE_GROUP_B_KEY ||
            "ad-serv",
          label:
            overrides.recordingArchiveGroupBLabel ||
            process.env.RECORDING_ARCHIVE_GROUP_B_LABEL ||
            "Ad Serv",
          folderId:
            overrides.recordingArchiveGroupBFolderId ||
            process.env.RECORDING_ARCHIVE_GROUP_B_FOLDER_ID ||
            "",
          extensionIds: parseOriginList(
            overrides.recordingArchiveGroupBExtensionIds ||
              process.env.RECORDING_ARCHIVE_GROUP_B_EXTENSION_IDS ||
              "",
          ),
          extensionNumbers: parseOriginList(
            overrides.recordingArchiveGroupBExtensionNumbers ||
              process.env.RECORDING_ARCHIVE_GROUP_B_EXTENSION_NUMBERS ||
              "140,1401,1402,731,7311,7312,525,5251,5252,320,43255,3202",
          ),
          agentNames: parseOriginList(
            overrides.recordingArchiveGroupBAgentNames ||
              process.env.RECORDING_ARCHIVE_GROUP_B_AGENT_NAMES ||
              "Jake Wallace,Jonathan Haro,Dani Pearson,Matt Anderson",
          ),
        },
      ],
      cserv: {
        key:
          overrides.recordingArchiveCservKey ||
          process.env.RECORDING_ARCHIVE_CSERV_KEY ||
          "customer-service",
        label:
          overrides.recordingArchiveCservLabel ||
          process.env.RECORDING_ARCHIVE_CSERV_LABEL ||
          "Customer Service",
        folderId:
          overrides.recordingArchiveCservFolderId ||
          process.env.RECORDING_ARCHIVE_CSERV_FOLDER_ID ||
          "",
        queueExtensionNumbers: parseOriginList(
          overrides.recordingArchiveCservQueueExtensionNumbers ||
            process.env.RECORDING_ARCHIVE_CSERV_QUEUE_EXTENSION_NUMBERS ||
            "505,5051,5052",
        ),
      },
      endOfDay: {
        enabled: boolFromEnv(
          overrides.recordingArchiveEndOfDayEnabled !== undefined
            ? overrides.recordingArchiveEndOfDayEnabled
            : process.env.RECORDING_ARCHIVE_EOD_ENABLED,
          boolFromEnv(
            overrides.recordingArchiveEnabled !== undefined
              ? overrides.recordingArchiveEnabled
              : process.env.RECORDING_ARCHIVE_ENABLED,
            false,
          ),
        ),
        // Default 20:30 PT — ~1.5 hour buffer past a 7 PM PT cutoff
        // for late callers + RC recording finalization. Override via
        // RECORDING_ARCHIVE_EOD_HOUR / _MINUTE if your team's hours
        // shift. The dedup makes it safe to re-run in the morning to
        // catch anything RC didn't have ready in time.
        hour: Math.max(
          0,
          Math.min(23, envInt("RECORDING_ARCHIVE_EOD_HOUR", 20)),
        ),
        minute: Math.max(
          0,
          Math.min(59, envInt("RECORDING_ARCHIVE_EOD_MINUTE", 30)),
        ),
        timezone:
          overrides.recordingArchiveEodTimezone ||
          process.env.RECORDING_ARCHIVE_EOD_TIMEZONE ||
          "America/Los_Angeles",
        intervalMs: Math.max(
          10000,
          envInt("RECORDING_ARCHIVE_EOD_INTERVAL_MS", 60000),
        ),
        activeWeekdays: parseOriginList(
          overrides.recordingArchiveEodActiveWeekdays ||
            process.env.RECORDING_ARCHIVE_EOD_ACTIVE_WEEKDAYS ||
            "1,2,3,4,5",
        )
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6),
        minDurationSec: Math.max(
          60,
          envInt("RECORDING_ARCHIVE_EOD_MIN_DURATION_SEC", 480),
        ),
        writeLocal: boolFromEnv(
          overrides.recordingArchiveEodWriteLocal !== undefined
            ? overrides.recordingArchiveEodWriteLocal
            : process.env.RECORDING_ARCHIVE_EOD_WRITE_LOCAL,
          true,
        ),
        emailCompanyKey:
          overrides.recordingArchiveEodEmailCompanyKey ||
          process.env.RECORDING_ARCHIVE_EOD_EMAIL_COMPANY ||
          "TAG",
        notifyRecipients: parseOriginList(
          overrides.recordingArchiveEodNotifyRecipients ||
            process.env.RECORDING_ARCHIVE_EOD_NOTIFY_RECIPIENTS ||
            "mgray@taxadvocategroup.com,manderson@taxadvocategroup.com,abanks@taxadvocategroup.com",
        ),
      },
      // ── Mobile-friendly playback proxy ───────────────────────────
      // The Apps Script player issues HMAC-signed URLs that point at
      // the control-plane's `/api/recordings/play/:fileId` endpoint.
      // The endpoint streams the audio bytes from Drive (via the
      // service account already configured for archive uploads),
      // forwards Range headers for seek/scrub, and returns 206
      // Partial Content. This solves mobile playback that the iframe
      // /preview path can't deliver (X-Frame-Options + redirect-loses-
      // token issues).
      playback: {
        signingSecret:
          overrides.recordingPlaybackSigningSecret ||
          process.env.RECORDING_PLAYBACK_SIGNING_SECRET ||
          "",
        // Defense-in-depth allowlist mirroring the Apps Script's
        // APPROVED_VIEWER_EMAILS. If empty, the HMAC signature alone
        // is the gate — fine since only Apps Script can mint URLs.
        allowedViewers: parseOriginList(
          overrides.recordingPlaybackAllowedViewers ||
            process.env.RECORDING_PLAYBACK_ALLOWED_VIEWERS ||
            "mgray@taxadvocategroup.com,manderson@taxadvocategroup.com,abanks@taxadvocategroup.com",
        ).map((value) => String(value || "").trim().toLowerCase()),
        // Max URL TTL — Apps Script picks ≤ this. 10 min is enough
        // for the operator to start playback; the audio element holds
        // the connection open after the first request via Range.
        maxTtlSeconds: Math.max(
          60,
          envInt("RECORDING_PLAYBACK_MAX_TTL_SECONDS", 600),
        ),
      },
    },
    authRateLimits: {
      otpRequestCooldownSeconds: envInt("AUTH_OTP_REQUEST_COOLDOWN_SECONDS", 60),
    },
    startupValidation: {
      strict: boolFromEnv(
        overrides.strictStartupValidation !== undefined
          ? overrides.strictStartupValidation
          : process.env.STRICT_STARTUP_VALIDATION,
        String(process.env.NODE_ENV || "").toLowerCase() === "production",
      ),
      requireHealthToken: boolFromEnv(
        overrides.requireHealthToken !== undefined
          ? overrides.requireHealthToken
          : process.env.REQUIRE_HEALTH_TOKEN,
        false,
      ),
    },
    ports: PORTS,
    serviceNames: SERVICE_NAMES,
  };
}

function validateSharedConfig(config = {}) {
  ensureConfigValue("mongoUri", config.mongoUri);
  ensureConfigValue("parallelDbName", config.parallelDbName);
  ensureConfigValue("serviceName", config.serviceName);

  if (config.startupValidation?.strict) {
    if (!config.jwtSecret || config.jwtSecret === "change-me") {
      throw new Error("JWT_SECRET must be configured when strict startup validation is enabled");
    }

    if (config.startupValidation?.requireHealthToken && !String(config.healthToken || "").trim()) {
      throw new Error("HEALTH_TOKEN must be configured when REQUIRE_HEALTH_TOKEN is enabled");
    }

    // SECURITY: refuse to boot if the OTP preview backdoor is enabled
    // in production. The preview surfaces the login code in the API
    // response body; in prod that's a complete auth bypass.
    if (config.authOtpPreview === true) {
      throw new Error(
        "AUTH_OTP_PREVIEW=true must NOT be enabled in production — it surfaces the login code inline in /auth/send-code responses. Unset or set to false.",
      );
    }

    // SECURITY: when preview is off, OTP delivery requires a sender.
    // No sender + no preview = users can't ever get a code.
    const fromEmail = String(config.authOtpDelivery?.fromEmail || "").trim();
    if (!fromEmail) {
      throw new Error(
        "AUTH_OTP_FROM_EMAIL (or SENDGRID_FROM_EMAIL) must be configured when AUTH_OTP_PREVIEW is disabled — without it, users can't receive login codes.",
      );
    }

    // Defense-in-depth: warn if a stale DEFAULT_LOGIN_CODE env var is
    // still set. Removed in this PR; throwing here flags any deploy
    // that still has it lying around.
    if (process.env.DEFAULT_LOGIN_CODE) {
      throw new Error(
        "DEFAULT_LOGIN_CODE env var is set but no longer supported (security cleanup). Remove it from your environment.",
      );
    }
  }

  return config;
}

module.exports = {
  DEFAULT_COMPANY,
  PORTS,
  ROOT_DIR,
  SERVICE_NAMES,
  getCompanyConfig,
  getFbPageToken,
  getCompanyKeys,
  getCorsOriginResolver,
  getGithubConfig,
  getIgPageToken,
  getRingCentralConfig,
  getSharedConfig,
  resolveCompanyFromFbPageId,
  validateSharedConfig,
  resolveCompanyFromPayload,
  env,
  envBool,
  envInt,
};
