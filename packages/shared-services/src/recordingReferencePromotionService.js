"use strict";

// PROMOTION of a retained provider recording reference.
//
// Capture is closed and already works: when a PhoneBurner callback carries a
// recording value that the strict HTTPS host policy rejects, the route keeps
// the first nonempty scalar as `safePayload.recordingReference` and marks the
// state `retained_unparsed`
// (apps/control-plane/src/routes/phoneBurnerLeadDelivery.js).
//
// Measured on the live floor 2026-08-03: every post-deploy Call End carried a
// recording value and none of them validated, because the provider sends a
// plain `http:` locator and the capture policy accepts `https:` only. So the
// links are arriving; nothing downstream ever sees them.
//
// This module is the ONE place that decides whether such a retained reference
// may stand in for a validated recording URL. It is deliberately:
//
//   * PURE — string and shape checks only. No fetch, no DNS, no redirect
//     following, no provider call, no IP resolution. The capture side is
//     closed and a delivered link was manually proved to work; nothing here
//     needs to touch the network to know that.
//   * FAIL CLOSED — anything not positively recognised is rejected, and the
//     host allowlist being blank rejects everything.
//   * EXACT ON HOST — `host === rule`, never endsWith/includes. A suffix test
//     would happily accept `evil-phoneburner.com` for the rule
//     `phoneburner.com`, since one really is a suffix of the other.
//   * RANKED — a validated https locator always outranks a promoted http
//     reference, so late weaker evidence can never displace stronger evidence.
//
// EVERY rejection has its own reason code so a failure is diagnosable from
// counts alone. No reason code, error, or return value ever contains the
// locator itself — callers log the reason, never the value.

const net = require("net");

const {
  MAX_RECORDING_URL_LENGTH,
  isForbiddenHostname,
  isPublicIp,
  parseAllowedRecordingHosts,
} = require("./recordingHostPolicyService");

const RETAINED_REFERENCE_STATUS = "retained_unparsed";
const PROMOTABLE_PROTOCOLS = new Set(["http:", "https:"]);

// none < promoted < validated. Rank, not recency, decides which locator wins.
const RECORDING_LOCATOR_RANK = Object.freeze({
  none: 0,
  promoted: 1,
  validated: 2,
});

// Every outcome this module can produce. Exported so a caller can enumerate
// them for count-only observability without inventing its own strings.
const RECORDING_PROMOTION_REASONS = Object.freeze([
  "promoted",
  "validated-url",
  "stored-url-invalid",
  "reference-absent",
  "reference-not-scalar",
  "reference-status-not-retained",
  "reference-too-long",
  "reference-not-absolute-url",
  "reference-protocol-not-http",
  "reference-embedded-credentials",
  "reference-normalized-too-long",
  "reference-host-forbidden",
  "reference-host-private-ip",
  "recording-host-allowlist-empty",
  "reference-host-not-allowed",
]);

function rejected(reason) {
  return { recordingUrl: null, reason };
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/**
 * Shape guard for a locator that is ALREADY stored as recording authority.
 *
 * Deliberately does not re-apply the host allowlist: host authority was
 * settled at capture, and re-deciding it here would silently drop evidence
 * captured under an earlier configuration. This only refuses a value that is
 * not a bounded, credential-free, absolute http(s) locator at all.
 */
function normalizeStoredRecordingUrl(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > MAX_RECORDING_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  if (!PROMOTABLE_PROTOCOLS.has(parsed.protocol)) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.href.length > MAX_RECORDING_URL_LENGTH) return null;
  return parsed.toString();
}

/**
 * Decide whether a retained `recordingReference` may become a listen link.
 *
 * Returns `{ recordingUrl, reason }`. `recordingUrl` is null on every
 * rejection and `reason` names exactly which check refused it.
 */
function promoteRetainedRecordingReference(safePayload = {}, { allowedHosts = [] } = {}) {
  const source = safePayload && typeof safePayload === "object" ? safePayload : {};
  const reference = source.recordingReference;
  if (reference == null || reference === "") return rejected("reference-absent");
  if (typeof reference !== "string" && typeof reference !== "number") {
    return rejected("reference-not-scalar");
  }
  // Only the state capture defines as "held back pending classification" is
  // promotable. An absent status is the pre-amendment shape and is tolerated;
  // any OTHER status means some later writer owns this field and we keep out.
  const status = source.recordingCandidateStatus == null
    ? RETAINED_REFERENCE_STATUS
    : String(source.recordingCandidateStatus).trim();
  if (status !== RETAINED_REFERENCE_STATUS) return rejected("reference-status-not-retained");

  const normalized = String(reference).trim();
  if (!normalized) return rejected("reference-absent");
  // Capture retains up to 4,096 characters; a listen link is bounded tighter.
  if (normalized.length > MAX_RECORDING_URL_LENGTH) return rejected("reference-too-long");

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return rejected("reference-not-absolute-url");
  }
  if (!PROMOTABLE_PROTOCOLS.has(parsed.protocol)) return rejected("reference-protocol-not-http");
  if (parsed.username || parsed.password) return rejected("reference-embedded-credentials");
  if (parsed.href.length > MAX_RECORDING_URL_LENGTH) return rejected("reference-normalized-too-long");

  const host = normalizeHost(parsed.hostname);
  if (isForbiddenHostname(host)) return rejected("reference-host-forbidden");
  if (net.isIP(host) && !isPublicIp(host)) return rejected("reference-host-private-ip");

  // EXACT match only. A leading-dot suffix rule is accepted by the shared
  // parser for the strict capture policy, but promotion refuses to widen a
  // reference onto a wildcard, so such rules are dropped here and a config
  // holding only wildcards promotes nothing.
  const rules = parseAllowedRecordingHosts(allowedHosts).filter((rule) => !rule.startsWith("."));
  if (!rules.length) return rejected("recording-host-allowlist-empty");
  if (!rules.includes(host)) return rejected("reference-host-not-allowed");

  return { recordingUrl: parsed.toString(), reason: "promoted" };
}

/**
 * The effective recording locator for one captured event's safePayload.
 *
 * A validated `recordingUrl` always wins; a retained reference is consulted
 * only when there is no validated URL at all. `rank` lets a caller refuse to
 * replace stronger evidence with weaker evidence.
 */
function resolveRecordingLocator(safePayload = {}, { allowedHosts = [] } = {}) {
  const source = safePayload && typeof safePayload === "object" ? safePayload : {};
  const stored = source.recordingUrl;
  if (stored != null && stored !== "") {
    const validated = normalizeStoredRecordingUrl(stored);
    // A stored value that is not a locator at all is a corruption signal, not
    // an invitation to fall back to weaker evidence.
    if (!validated) {
      return {
        recordingUrl: null, strength: "none", rank: RECORDING_LOCATOR_RANK.none, reason: "stored-url-invalid",
      };
    }
    return {
      recordingUrl: validated,
      strength: "validated",
      rank: RECORDING_LOCATOR_RANK.validated,
      reason: "validated-url",
    };
  }
  const promotion = promoteRetainedRecordingReference(source, { allowedHosts });
  if (promotion.recordingUrl) {
    return {
      recordingUrl: promotion.recordingUrl,
      strength: "promoted",
      rank: RECORDING_LOCATOR_RANK.promoted,
      reason: promotion.reason,
    };
  }
  return {
    recordingUrl: null, strength: "none", rank: RECORDING_LOCATOR_RANK.none, reason: promotion.reason,
  };
}

module.exports = {
  RECORDING_LOCATOR_RANK,
  RECORDING_PROMOTION_REASONS,
  RETAINED_REFERENCE_STATUS,
  normalizeStoredRecordingUrl,
  promoteRetainedRecordingReference,
  resolveRecordingLocator,
};
