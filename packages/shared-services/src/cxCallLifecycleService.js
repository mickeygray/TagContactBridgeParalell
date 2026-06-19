"use strict";

function parseBooleanEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveIntegerEnv(name, fallback = null) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeDate(value, fallback = null) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeCaseId(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return Number.isInteger(numeric) ? numeric : String(value || "").trim() || null;
  }
  return String(value || "").trim() || null;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

const CX_CALL_EMPTY_UII_SENTINELS = new Set([
  "null",
  "undefined",
  "none",
  "unknown",
  "n/a",
  "na",
  "[object object]",
]);

function normalizeCxCallUii(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (CX_CALL_EMPTY_UII_SENTINELS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function buildCxCallTransitionId(writer = "cx-call") {
  const safeWriter = String(writer || "cx-call")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 16) || "cx-call";
  return `${Date.now().toString(36)}-${safeWriter}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCxCanonicalCallWriteEnabled() {
  return parseBooleanEnv("CX_CANONICAL_CALL_WRITE_ENABLED", false);
}

function isCxCanonicalCallReadEnabled() {
  return parseBooleanEnv("CX_CANONICAL_CALL_READ_ENABLED", false);
}

function isCxCanonicalCallVerboseLoggingEnabled() {
  return parseBooleanEnv("CX_CANONICAL_CALL_VERBOSE_LOGS", true);
}

function isCxCanonicalCallStrictGateEnabled() {
  return parseBooleanEnv("CX_CANONICAL_CALL_STRICT_GATE", false);
}

const CX_CALL_BLOCKING_PHASES = new Set(["publishing", "confirming", "active", "dispositioning"]);

function buildCxCallLifecyclePatch({
  writer,
  queueItemId = null,
  caseId = null,
  phone = null,
  uii = null,
  phase = null,
  expiresAt = null,
  transitionId = null,
  lastObservedAt = new Date(),
  lastWriter,
} = {}) {
  if (!isCxCanonicalCallWriteEnabled()) return null;
  const safeQueueItemId = String(queueItemId || "").trim() || null;
  const safePhone = normalizePhone(phone);
  const safeUii = normalizeCxCallUii(uii);
  const safePhase = String(phase || "").trim().toLowerCase() || null;
  const safeTransitionId = transitionId || buildCxCallTransitionId(writer || "cx-call");
  const safeLastWriter = String(lastWriter || writer || "cx-call").trim() || "cx-call";
  const safeObservedAt = normalizeDate(lastObservedAt, new Date());
  let safeExpiresAt = normalizeDate(expiresAt, null);
  if (!safeExpiresAt && !safeUii && CX_CALL_BLOCKING_PHASES.has(safePhase)) {
    safeExpiresAt = buildCanonicalNoUiiExpiry(safeObservedAt);
  }

  return {
    phase: safePhase,
    queueItemId: safeQueueItemId,
    caseId: normalizeCaseId(caseId),
    phone: safePhone,
    uii: safeUii,
    transitionId: safeTransitionId,
    expiresAt: safeExpiresAt,
    lastWriter: safeLastWriter,
    lastObservedAt: safeObservedAt,
  };
}

function describeCxCallGate(cxCall = {}, requestedQueueItemId = "", options = {}) {
  const canonical = cxCall && typeof cxCall === "object" ? cxCall : {};
  const requestedId = String(requestedQueueItemId || "").trim();
  const phase = String(canonical.phase || "").trim().toLowerCase();
  const canonicalQueueItemId = String(canonical.queueItemId || "").trim();
  const canonicalUii = normalizeCxCallUii(canonical.uii);
  const hasRequestedQueueItemId = Boolean(requestedId);
  const hasCanonicalQueueItemId = Boolean(canonicalQueueItemId);
  const expiresAt = normalizeDate(canonical.expiresAt, null);
  const now = normalizeDate(options.now, new Date());
  const expiredShell = Boolean(
    !canonicalUii
      && expiresAt
      && expiresAt.getTime() <= now.getTime()
      && CX_CALL_BLOCKING_PHASES.has(phase),
  );
  const queueMismatch = hasRequestedQueueItemId
    && hasCanonicalQueueItemId
    && canonicalQueueItemId !== requestedId;
  const missingCanonicalQueueItem = hasRequestedQueueItemId && !hasCanonicalQueueItemId;
  const queueBlocked = queueMismatch || missingCanonicalQueueItem;
  const blocked = !expiredShell && CX_CALL_BLOCKING_PHASES.has(phase) && queueBlocked;
  return {
    blocked: Boolean(blocked),
    decision: blocked ? "block" : "allow",
    phase: phase || null,
    queueItemId: canonicalQueueItemId || null,
    caseId: canonical.caseId != null ? canonical.caseId : null,
    phone: canonical.phone || null,
    uii: canonicalUii,
    uiiPresent: Boolean(canonicalUii),
    transitionId: canonical.transitionId || null,
    lastWriter: canonical.lastWriter || null,
    expiresAt: expiresAt || null,
    expiredShell,
    reason: blocked ? options.blockReason || "active-cx-call-in-canonical-state" : null,
  };
}

function canonicalNoUiiShellTtlMs() {
  return parsePositiveIntegerEnv("CX_CANONICAL_NO_UII_SHELL_TTL_MS", 30_000);
}

function buildCanonicalNoUiiExpiry(now = new Date()) {
  const base = normalizeDate(now, new Date());
  const ttl = canonicalNoUiiShellTtlMs();
  return new Date(base.getTime() + Math.max(ttl, 0));
}

function isExpiredNoUiiCxCallShell(cxCall = {}, now = new Date()) {
  const canonical = cxCall && typeof cxCall === "object" ? cxCall : {};
  const phase = String(canonical.phase || "").trim().toLowerCase();
  if (!CX_CALL_BLOCKING_PHASES.has(phase)) return false;
  if (normalizeCxCallUii(canonical.uii)) return false;
  const expiresAt = normalizeDate(canonical.expiresAt, null);
  if (!expiresAt) return false;
  const nowDate = normalizeDate(now, new Date());
  return expiresAt.getTime() <= nowDate.getTime();
}

function buildCxCallTransitionLogPayload({
  agentExtensionId = null,
  previousCxCall = null,
  nextCxCall = null,
  writer = null,
  reason = null,
  event = null,
} = {}) {
  const previous = previousCxCall && typeof previousCxCall === "object" ? previousCxCall : {};
  const next = nextCxCall && typeof nextCxCall === "object" ? nextCxCall : {};
  return {
    agentExtensionId: String(agentExtensionId || "").trim() || null,
    oldPhase: previous.phase || null,
    newPhase: next.phase || null,
    oldUii: normalizeCxCallUii(previous.uii),
    newUii: normalizeCxCallUii(next.uii),
    oldQueueItemId: previous.queueItemId || null,
    newQueueItemId: next.queueItemId || null,
    writer: writer || next.lastWriter || null,
    reason: reason || null,
    event: event || null,
    oldTransitionId: previous.transitionId || null,
    newTransitionId: next.transitionId || null,
    expiresAt: next.expiresAt || null,
    expiredShell: isExpiredNoUiiCxCallShell(next),
  };
}

async function writeCxCallLifecycleShadowState({
  agentStateRepository,
  extensionId,
  patch,
  logger = null,
  reason = null,
  event = null,
} = {}) {
  if (!isCxCanonicalCallWriteEnabled()) return null;
  const normalizedExtensionId = String(extensionId || "").trim();
  if (!agentStateRepository || !normalizedExtensionId || !patch) return null;
  const shouldLogTransition = isCxCanonicalCallVerboseLoggingEnabled()
    && typeof logger?.info === "function";
  const previous = shouldLogTransition
    ? await agentStateRepository
      .findAgentStateByExtensionId(normalizedExtensionId)
      .catch(() => null)
    : null;
  const updated = await agentStateRepository
    .updateAgentState(normalizedExtensionId, { cxCall: patch })
    .catch((error) => {
      logger?.warn?.("cx-call-lifecycle.write.failed", {
        agentExtensionId: normalizedExtensionId,
        phase: patch.phase || null,
        writer: patch.lastWriter || null,
        reason,
        error: error.message,
      });
      return null;
    });
  if (updated && shouldLogTransition) {
    logger.info(
      "cx-call-lifecycle.transition",
      buildCxCallTransitionLogPayload({
        agentExtensionId: normalizedExtensionId,
        previousCxCall: previous?.cxCall || null,
        nextCxCall: patch,
        writer: patch.lastWriter || patch.writer || null,
        reason,
        event,
      }),
    );
  }
  return updated;
}

module.exports = {
  CX_CALL_BLOCKING_PHASES,
  buildCanonicalNoUiiExpiry,
  buildCxCallTransitionLogPayload,
  buildCxCallLifecyclePatch,
  buildCxCallTransitionId,
  describeCxCallGate,
  canonicalNoUiiShellTtlMs,
  isExpiredNoUiiCxCallShell,
  normalizeCxCallUii,
  isCxCanonicalCallReadEnabled,
  isCxCanonicalCallStrictGateEnabled,
  isCxCanonicalCallVerboseLoggingEnabled,
  isCxCanonicalCallWriteEnabled,
  writeCxCallLifecycleShadowState,
};
