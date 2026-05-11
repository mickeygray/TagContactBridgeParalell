"use strict";

// Per-provider failure classifiers. Each takes a failure shape (status
// + body for HTTP providers, error object for SDK providers) and
// returns `{ permanent, reason }`.
//
//   permanent === true  → don't retry; mark the channel DNC for this
//                          lead. Caller wires this into
//                          `leadCadenceRepository.markChannelDnc`.
//   permanent === false → transient; retry on next cadence tick.
//
// String matching is intentionally fuzzy. The legacy TCB cadence
// engine used the same approach (services/cadenceEngine.js
// classifySmsDncReason / classifyRvmDncReason) and it caught real
// production rejections reliably across CallRail / Drop wording
// changes over the years. If a provider tightens their error
// messages we can swap in code-based detection later.

function normalize(text) {
  return String(text || "").toLowerCase();
}

/**
 * CallRail SMS API rejections.
 *
 * Permanent reasons we know to look for:
 *   - "opted out"             → recipient replied STOP
 *   - "do not contact"        → CallRail's account-level DNC list
 *   - "phone number is invalid" / "invalid number" → bad data
 * Transient (retry):
 *   - 429, "rate limit"       → back off; CallRail allows 300/hr
 *   - 5xx, network errors     → server-side hiccup
 */
function classifyCallrailSmsFailure({ status, body, error } = {}) {
  const haystack = `${normalize(error)} ${normalize(body?.error)} ${normalize(body?.message)} ${normalize(typeof body === "string" ? body : "")}`;

  if (haystack.includes("opted out") || haystack.includes("opt out")) {
    return { permanent: true, reason: "opted-out", provider: "callrail" };
  }
  if (haystack.includes("do not contact") || haystack.includes("do not call")) {
    return { permanent: true, reason: "carrier-dnc", provider: "callrail" };
  }
  if (haystack.includes("blocked number") || haystack.includes("blocked numbers")) {
    return { permanent: true, reason: "blocked-number", provider: "callrail" };
  }
  if (haystack.includes("invalid") && haystack.includes("phone")) {
    return { permanent: true, reason: "invalid-phone", provider: "callrail" };
  }
  if (haystack.includes("not a mobile") || haystack.includes("landline")) {
    return { permanent: true, reason: "not-mobile", provider: "callrail" };
  }
  if (Number(status) === 429 || haystack.includes("rate limit")) {
    return { permanent: false, reason: "rate-limited", provider: "callrail" };
  }
  return { permanent: false, reason: "transient", provider: "callrail" };
}

/**
 * Drop.co (RVM) rejections. Drop returns plain-English error
 * messages; we string-match on common ones. The legacy engine handled
 * "national-dnc" and "invalid-area-code" — same buckets here.
 */
function classifyDropRvmFailure({ error, body } = {}) {
  const haystack = `${normalize(error)} ${normalize(body?.error)} ${normalize(body?.message)} ${normalize(typeof body === "string" ? body : "")}`;

  if (haystack.includes("national do not call") || haystack.includes("national dnc") || haystack.includes("dnc list") || haystack.includes(" dnc ") || haystack.endsWith(" dnc")) {
    return { permanent: true, reason: "national-dnc", provider: "drop" };
  }
  if (haystack.includes("opted out") || haystack.includes("unsubscribed")) {
    return { permanent: true, reason: "opted-out", provider: "drop" };
  }
  if (haystack.includes("invalid area code") || haystack.includes("area code")) {
    return { permanent: true, reason: "invalid-area-code", provider: "drop" };
  }
  if (haystack.includes("invalid") && haystack.includes("phone")) {
    return { permanent: true, reason: "invalid-phone", provider: "drop" };
  }
  return { permanent: false, reason: "transient", provider: "drop" };
}

/**
 * SendGrid permanent failures usually arrive as webhook events
 * (bounce, dropped, spamreport, unsubscribe), not response bodies.
 * Wire from the SendGrid event webhook when we add it. Synchronous
 * 4xx responses from the v3 mail/send endpoint are handled here too —
 * mostly malformed payloads, which we'd want to surface as a code
 * bug, not a per-lead DNC.
 */
function classifySendgridFailure({ status, body, eventType } = {}) {
  // Webhook-driven path
  if (eventType) {
    const evt = normalize(eventType);
    if (evt === "bounce") {
      return { permanent: true, reason: "hard-bounce", provider: "sendgrid" };
    }
    if (evt === "dropped") {
      return { permanent: true, reason: "suppressed", provider: "sendgrid" };
    }
    if (evt === "unsubscribe" || evt === "group_unsubscribe") {
      return { permanent: true, reason: "unsubscribed", provider: "sendgrid" };
    }
    if (evt === "spamreport") {
      return { permanent: true, reason: "spam-report", provider: "sendgrid" };
    }
    if (evt === "blocked") {
      return { permanent: true, reason: "blocked", provider: "sendgrid" };
    }
    return { permanent: false, reason: "transient", provider: "sendgrid" };
  }

  // Synchronous response path (typically v3 mail/send 4xx)
  const haystack = normalize(body?.errors?.[0]?.message || body?.error || body?.message || (typeof body === "string" ? body : ""));
  if (Number(status) === 401 || Number(status) === 403) {
    return { permanent: false, reason: "auth-error", provider: "sendgrid" };
  }
  if (haystack.includes("does not contain a valid address")) {
    return { permanent: true, reason: "invalid-email", provider: "sendgrid" };
  }
  return { permanent: false, reason: "transient", provider: "sendgrid" };
}

/**
 * Drop.co async-disposition classifier. Reads the VMDropStatus
 * response and decides whether we have a terminal answer yet, and if
 * so, whether it represents a permanent rejection (mark RVM channel
 * DNC) or a successful delivery.
 *
 * DropStatusCode semantics observed so far (refine as we collect
 * more terminal samples):
 *   -1            → still pending; keep polling
 *   0  / null     → ambiguous; usually means "no terminal yet"
 *   any other     → terminal of some kind; the message text tells us
 *                   whether it was a clean delivery or a rejection
 *
 * Drop's terminal codes aren't publicly documented, so the reject
 * detection is keyword-based on `DropStatusMessage`. Same fuzzy-
 * matching pattern legacy used (services/cadenceEngine.js) — if Drop
 * tightens their wording we widen the regex.
 */
function classifyDropDisposition(statusResponse) {
  const code = statusResponse?.DropStatusCode;
  const numericCode = code == null ? null : Number(code);
  const message = normalize(statusResponse?.DropStatusMessage);

  // -1 (and missing/null) means Drop hasn't finished processing. Keep
  // polling. Don't classify as terminal.
  if (numericCode === -1 || numericCode == null || Number.isNaN(numericCode)) {
    return { terminal: false, statusCode: numericCode, statusMessage: message || null };
  }

  // Permanent reject signals — mark the rvm channel DNC.
  if (
    message.includes("dnc") ||
    message.includes("do not call") ||
    message.includes("do not contact") ||
    message.includes("opted out") ||
    message.includes("blocked")
  ) {
    return {
      terminal: true,
      disposition: "rejected",
      permanent: true,
      reason: "dnc-or-blocked",
      statusCode: numericCode,
      statusMessage: message || null,
    };
  }
  if (message.includes("disconnected") || message.includes("invalid number") || message.includes("bad number")) {
    return {
      terminal: true,
      disposition: "rejected",
      permanent: true,
      reason: "invalid-number",
      statusCode: numericCode,
      statusMessage: message || null,
    };
  }

  // Common delivery confirmations.
  if (
    message.includes("delivered") ||
    message.includes("dropped") ||
    message.includes("complete") ||
    message.includes("success")
  ) {
    return {
      terminal: true,
      disposition: "delivered",
      permanent: false,
      reason: null,
      statusCode: numericCode,
      statusMessage: message || null,
    };
  }

  // Unknown terminal code — log it but don't auto-DNC. We'll learn
  // the meaning over time as terminal samples accumulate.
  return {
    terminal: true,
    disposition: "unknown",
    permanent: false,
    reason: "unknown-terminal-code",
    statusCode: numericCode,
    statusMessage: message || null,
  };
}

module.exports = {
  classifyCallrailSmsFailure,
  classifyDropDisposition,
  classifyDropRvmFailure,
  classifySendgridFailure,
};
