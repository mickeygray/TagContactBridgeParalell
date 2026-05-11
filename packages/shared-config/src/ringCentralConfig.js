"use strict";

const { env, envBool, envInt } = require("./env");

function getRingCentralConfig() {
  const autoReinitTimezone = env("RC_AUTO_REINIT_TIMEZONE", "America/Los_Angeles");
  const autoReinitStartHour = envInt("RC_AUTO_REINIT_START_HOUR", 7);
  const autoReinitEndHour = envInt("RC_AUTO_REINIT_END_HOUR", 18);
  const autoReinitWeekdays = env("RC_AUTO_REINIT_WEEKDAYS", "1,2,3,4,5");

  return {
    serverUrl: env("RING_CENTRAL_SERVER_URL", env("RC_SERVER_URL", "https://platform.ringcentral.com")),
    clientId: env("RING_CENTRAL_CLIENT_ID", env("RC_CLIENT_ID", "")),
    clientSecret: env("RING_CENTRAL_CLIENT_SECRET", env("RC_CLIENT_SECRET", "")),
    jwtToken: env("RING_CENTRAL_JWT_TOKEN", env("RC_JWT_TOKEN", "")),
    webhookSecret: env("RINGBRIDGE_WEBHOOK_SECRET", env("RC_WEBHOOK_SECRET", "")),
    webhookBaseUrl: env(
      "RC_WEBHOOK_BASE_URL",
      env(
        "NGROK_DOMAIN",
        env("NGROK_STATIC_DOMAIN", "https://tag-webhook.ngrok.app"),
      ),
    ),
    // SAFETY RAIL: the subscription watchdog creates/renews RC push
    // subscriptions pointing at `${webhookBaseUrl}/webhook/ringcentral/
    // session-events`. Turning that on without intent would redirect
    // prod RC traffic to this app. Default OFF — operator must set
    // `RC_SUBSCRIPTION_WATCHDOG_ENABLED=true` once Parallel is ready to
    // be the live webhook target. Event-silence detection and the
    // liveness stamp still run regardless; only the create/renew path
    // gates on this flag.
    subscriptionWatchdogEnabled:
      String(env("RC_SUBSCRIPTION_WATCHDOG_ENABLED", "false")).toLowerCase() === "true",
    sessionBufferMs: Number(env("RC_SESSION_BUFFER_MS", "7000")),
    sessionRetryBaseMs: Number(env("RC_SESSION_RETRY_BASE_MS", "7000")),
    sessionMaxRetries: Number(env("RC_SESSION_MAX_RETRIES", "5")),
    refreshIntervalMs: Number(env("RC_REFRESH_INTERVAL_MS", String(45 * 60 * 1000))),
    autoReinitBusinessHoursOnly: envBool("RC_AUTO_REINIT_BUSINESS_HOURS_ONLY", true),
    autoReinitTimezone,
    autoReinitStartHour,
    autoReinitEndHour,
    autoReinitWeekdays,
    presencePollBusinessHoursOnly: envBool("RC_PRESENCE_POLL_BUSINESS_HOURS_ONLY", true),
    presencePollTimezone: env("RC_PRESENCE_POLL_TIMEZONE", autoReinitTimezone),
    presencePollStartHour: envInt("RC_PRESENCE_POLL_START_HOUR", autoReinitStartHour),
    presencePollEndHour: envInt("RC_PRESENCE_POLL_END_HOUR", autoReinitEndHour),
    presencePollWeekdays: env("RC_PRESENCE_POLL_WEEKDAYS", autoReinitWeekdays),
    presencePollIntervalMs: envInt("RC_PRESENCE_POLL_INTERVAL_MS", 30000),
    presenceFullPollIntervalMs: envInt("RC_PRESENCE_FULL_POLL_INTERVAL_MS", 120000),
    presenceStaleThresholdMs: envInt("RC_PRESENCE_STALE_THRESHOLD_MS", 120000),
    presencePollMinTokenTtlMs: envInt("RC_PRESENCE_POLL_MIN_TOKEN_TTL_MS", 5 * 60 * 1000),
    presencePollPaceMs: envInt("RC_PRESENCE_POLL_PACE_MS", 250),
    smsPipeEnabled: String(env("RC_SMS_PIPE_ENABLED", "false")).toLowerCase() === "true",
    smsPipeEmail: env("RC_SMS_PIPE_EMAIL", "mgray@taxadvocategroup.com"),
    smsPipeExtensionNumber: env("RC_SMS_PIPE_EXTENSION_NUMBER", "101"),
    smsPipePhone: env("RC_SMS_PIPE_PHONE", ""),
  };
}

module.exports = {
  getRingCentralConfig,
};
