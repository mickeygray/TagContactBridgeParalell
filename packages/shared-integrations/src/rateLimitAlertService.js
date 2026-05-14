"use strict";

const path = require("path");

try {
  require("dotenv").config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });
} catch {
  // dotenv is best-effort here; the caller may already provide process.env.
}

const DEFAULT_ALERT_COMPANY = "TAG";

const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|secret|token|jwt|assertion|password)/i;
const LAST_ALERT_BY_KEY = new Map();

function env(name, fallback = "") {
  const value = process.env[name];
  return value !== undefined && value !== null && value !== "" ? String(value) : fallback;
}

function envBool(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function envDurationMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseRecipients(raw) {
  return String(raw || "")
    .split(/[,\s;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function alertRecipients() {
  return parseRecipients(
    env(
      "RINGCENTRAL_RATE_LIMIT_ALERT_RECIPIENTS",
      env("RC_RATE_LIMIT_ALERT_RECIPIENTS", env("RATE_LIMIT_ALERT_RECIPIENTS", "")),
    ),
  );
}

function redact(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(child, depth + 1);
  }
  return out;
}

function safeJson(value) {
  if (value === undefined || value === null || value === "") return "";
  try {
    return JSON.stringify(redact(value), null, 2).slice(0, 2000);
  } catch {
    return String(value).slice(0, 2000);
  }
}

function formatAlertText(payload) {
  const details = payload.error?.details || {};
  const lines = [
    `${payload.platform || "RingCentral"} rate limit circuit opened.`,
    "",
    `Service: ${payload.service || "unknown"}`,
    `Scope: ${payload.scope || "unknown"}`,
    `Usage group: ${payload.usageGroup || details.rateLimitHeaders?.group || "unknown"}`,
    `Opened at: ${payload.openedAt || new Date().toISOString()}`,
    `Next attempt: ${payload.nextAttemptAt || "unknown"}`,
    `Status: ${details.responseStatus || payload.error?.status || "429"}`,
    `Retry-After: ${details.retryAfter || "not provided"}`,
  ];

  if (details.rateLimitHeaders) {
    lines.push(
      `Limit: ${details.rateLimitHeaders.limit || "unknown"}`,
      `Remaining: ${details.rateLimitHeaders.remaining || "unknown"}`,
      `Window: ${details.rateLimitHeaders.window || "unknown"}`,
      `Header group: ${details.rateLimitHeaders.group || "unknown"}`,
    );
  }

  if (details.method || payload.method) lines.push(`Method: ${details.method || payload.method}`);
  if (details.path || payload.path) lines.push(`Path: ${details.path || payload.path}`);
  if (payload.error?.message) lines.push(`Error: ${payload.error.message}`);

  const responseBody = safeJson(details.responseBody);
  if (responseBody) {
    lines.push("", "Response body:", responseBody);
  }

  return lines.join("\n");
}

function shouldSendAlert(payload, recipients) {
  if (!envBool("RINGCENTRAL_RATE_LIMIT_ALERTS_ENABLED", true)) return false;
  if (recipients.length === 0) return false;

  const key = [
    payload.service || "unknown",
    payload.scope || "unknown",
    payload.nextAttemptAt || "",
  ].join("|");
  const now = Date.now();
  const throttleMs = envDurationMs("RINGCENTRAL_RATE_LIMIT_ALERT_THROTTLE_MS", 60 * 1000);
  const last = LAST_ALERT_BY_KEY.get(key) || 0;
  if (last && now - last < throttleMs) return false;
  LAST_ALERT_BY_KEY.set(key, now);
  return true;
}

function queueRateLimitAlert(payload = {}) {
  const recipients = alertRecipients();
  if (!shouldSendAlert(payload, recipients)) return;

  const company = env("RINGCENTRAL_RATE_LIMIT_ALERT_COMPANY", DEFAULT_ALERT_COMPANY);
  const subjectPrefix = env("RINGCENTRAL_RATE_LIMIT_ALERT_SUBJECT_PREFIX", "[Parallel Alert]");
  const subject = `${subjectPrefix} ${payload.platform || "RingCentral"} 429 cooldown opened`;
  const text = formatAlertText(payload);

  Promise.resolve()
    .then(async () => {
      const { sendMail } = require("../../shared-services/src/mailerService");
      await sendMail(company, {
        to: recipients,
        subject,
        text,
      });
    })
    .catch((error) => {
      console.warn("[rate-limit-alert] email failed:", error.message);
    });
}

module.exports = {
  queueRateLimitAlert,
};
