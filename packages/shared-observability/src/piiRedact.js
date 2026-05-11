"use strict";

// Minimal PII-redaction helpers for structured logs. Goal: make it
// trivial to keep operational signal in logs (something happened,
// for which case, with what outcome) while not writing actual phone
// numbers / emails / message bodies to disk in plain text.
//
// Used by route handlers and services where structured-log payloads
// would otherwise carry recipient PII verbatim. Workflow stage
// records and event payloads — which are durable mongo documents,
// not log files — are out of scope; those rely on access control
// at the DB layer rather than log redaction.

/**
 * Mask a phone number to keep the last 4 digits visible. Accepts
 * any input (formatted "(310)666-5997", digits-only "3106665997",
 * E.164 "+13106665997") and returns "******5997".
 *
 * Returns null for empty/missing input so the redacted field is
 * obviously absent in the log rather than rendered as "******" with
 * no real data behind it.
 */
function redactPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  const last4 = digits.length >= 4 ? digits.slice(-4) : digits;
  return `******${last4}`;
}

/**
 * Mask an email so the local-part and domain are both partially
 * obscured but a human can still spot the "from where, to whom"
 * shape. "alice.smith@taxadvocategroup.com" → "al***@ta***group.com".
 */
function redactEmail(value) {
  const raw = String(value || "").trim();
  if (!raw || !raw.includes("@")) return null;
  const [local, ...domainParts] = raw.split("@");
  const domain = domainParts.join("@");
  const localMasked =
    local.length <= 2 ? local + "***" : `${local.slice(0, 2)}***`;
  // Preserve TLD; mask middle of host.
  const domainBits = domain.split(".");
  const domainMasked =
    domainBits.length >= 2
      ? `${domainBits[0].slice(0, 2)}***${domainBits.slice(-1)[0] ? "." + domainBits.slice(-1)[0] : ""}`
      : domain;
  return `${localMasked}@${domainMasked}`;
}

/**
 * Truncate free-text message content (SMS body, email subject) to a
 * short preview. Long bodies in logs are rarely useful but always
 * a leak vector. 40 chars is enough to spot "STOP" / "yes interested"
 * / "stop calling me please" without exporting full inbound text.
 */
function redactContent(value, max = 40) {
  const raw = String(value || "");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

/**
 * Convenience: redact a whole webhook-style payload at once. Keeps
 * structural fields (companyId, intakeRoute, etc) intact, masks
 * recognized PII slots. Useful for one-line `runtime.logger.info`
 * calls that want to capture "this payload arrived" without
 * surfacing every field.
 */
function redactWebhookPayload(payload = {}) {
  return {
    ...payload,
    source_number: payload.source_number ? redactPhone(payload.source_number) : payload.source_number,
    sourceNumber: payload.sourceNumber ? redactPhone(payload.sourceNumber) : payload.sourceNumber,
    destination_number: payload.destination_number ? redactPhone(payload.destination_number) : payload.destination_number,
    destinationNumber: payload.destinationNumber ? redactPhone(payload.destinationNumber) : payload.destinationNumber,
    primaryPhone: payload.primaryPhone ? redactPhone(payload.primaryPhone) : payload.primaryPhone,
    phone: payload.phone ? redactPhone(payload.phone) : payload.phone,
    email: payload.email ? redactEmail(payload.email) : payload.email,
    content: payload.content !== undefined ? redactContent(payload.content) : payload.content,
    message: payload.message !== undefined ? redactContent(payload.message) : payload.message,
  };
}

module.exports = {
  redactPhone,
  redactEmail,
  redactContent,
  redactWebhookPayload,
};
