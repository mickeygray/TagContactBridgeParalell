"use strict";

const TRUE_RE = /^(1|true|yes|on)$/i;
const SENSITIVE_KEY_RE = /(authorization|bearer|cookie|password|secret|token|api.?key|ssn|social|audio|recording|transcript|rawTranscript|phone|customerEmail|clientEmail|leadEmail|contactEmail|recipientEmail|senderEmail|emailBody|ani|dnis)/i;
const SAFE_KEY_RE = /(phoneLast4|last4|phoneHash|emailHash)$/i;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 25;

function str(value) {
  return String(value == null ? "" : value).trim();
}

function envEnabled(name) {
  return TRUE_RE.test(str(process.env[name]));
}

function alphaTraceEnabled() {
  return envEnabled("CX_ALPHA_TRACE_ENABLED");
}

function redactScalar(key, value) {
  if (value == null) return value;
  const keyText = str(key);
  if (SAFE_KEY_RE.test(keyText)) return value;
  if (!SENSITIVE_KEY_RE.test(keyText)) return value;
  const text = str(value);
  const digits = text.replace(/\D/g, "");
  if (/phone|ani|dnis/i.test(keyText) && digits.length >= 4) {
    return `[redacted:last4:${digits.slice(-4)}]`;
  }
  return "[redacted]";
}

function redactCxAlphaPayload(value, key = "", depth = 0) {
  if (depth > MAX_DEPTH) return "[redacted:depth]";
  if (value == null) return value;
  if (typeof value !== "object") return redactScalar(key, value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactCxAlphaPayload(item, key, depth + 1));
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    output[childKey] = redactCxAlphaPayload(childValue, childKey, depth + 1);
  }
  return output;
}

function readFilter(options = {}) {
  return str(options.agentFilter || process.env.CX_ALPHA_TRACE_AGENT).toLowerCase();
}

function traceMatchesFilter(payload = {}, options = {}) {
  const filter = readFilter(options);
  if (!filter) return true;
  const haystack = [
    payload.sessionId,
    payload.agentEmail,
    payload.agentExtensionId,
    payload.cxAgentId,
    payload.accountId,
    payload.domain,
    payload.queueItemId,
    payload.currentQueueItemId,
    payload.externId,
    payload.currentExternId,
    payload.uii,
    payload.currentUii,
  ].map(str).join(" ").toLowerCase();
  return haystack.includes(filter);
}

function logCxAlpha(event, payload = {}, options = {}) {
  try {
    if (!event) return false;
    if (!options.force && !alphaTraceEnabled()) return false;
    const safePayload = redactCxAlphaPayload({
      ...(payload && typeof payload === "object" ? payload : { value: payload }),
      event,
      at: payload && payload.at ? payload.at : new Date().toISOString(),
    });
    if (!traceMatchesFilter(safePayload, options)) return false;
    const logger = options.logger || console;
    const level = str(options.level || "info");
    const writer = typeof logger[level] === "function"
      ? logger[level].bind(logger)
      : typeof logger.info === "function"
        ? logger.info.bind(logger)
        : console.info.bind(console);
    writer(event, safePayload);
    return true;
  } catch (_err) {
    return false;
  }
}

module.exports = {
  alphaTraceEnabled,
  logCxAlpha,
  redactCxAlphaPayload,
  traceMatchesFilter,
};
