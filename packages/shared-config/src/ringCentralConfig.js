"use strict";

const { env } = require("./env");

function getRingCentralConfig() {
  return {
    serverUrl: env("RING_CENTRAL_SERVER_URL", "https://platform.ringcentral.com"),
    clientId: env("RING_CENTRAL_CLIENT_ID", ""),
    clientSecret: env("RING_CENTRAL_CLIENT_SECRET", ""),
    jwtToken: env("RING_CENTRAL_JWT_TOKEN", ""),
    webhookSecret: env("RINGBRIDGE_WEBHOOK_SECRET", "ringbridge-verify-token"),
    webhookBaseUrl: env(
      "NGROK_DOMAIN",
      env("NGROK_STATIC_DOMAIN", "https://tag-webhook.ngrok.app"),
    ),
    sessionBufferMs: Number(env("RC_SESSION_BUFFER_MS", "7000")),
    sessionRetryBaseMs: Number(env("RC_SESSION_RETRY_BASE_MS", "7000")),
    sessionMaxRetries: Number(env("RC_SESSION_MAX_RETRIES", "5")),
    refreshIntervalMs: Number(env("RC_REFRESH_INTERVAL_MS", String(45 * 60 * 1000))),
    presencePollIntervalMs: Number(env("RC_PRESENCE_POLL_INTERVAL_MS", "30000")),
    presenceStaleThresholdMs: Number(env("RC_PRESENCE_STALE_THRESHOLD_MS", "120000")),
  };
}

module.exports = {
  getRingCentralConfig,
};
