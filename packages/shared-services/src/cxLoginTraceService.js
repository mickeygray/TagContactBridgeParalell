"use strict";

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function isCxLoginTraceEnabled() {
  return parseBooleanFlag(process.env.CX_LOGIN_TRACE_ENABLED, false)
    || parseBooleanFlag(process.env.CX_CALL_TRACE_ENABLED, false);
}

function clean(value, max = 180) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : null;
}

function maskEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  const [local, domain] = email.split("@");
  const prefix = local ? local.slice(0, 2) : "";
  return `${prefix}${local.length > 2 ? "***" : "*"}@${domain}`;
}

function summarizeAccount(account = {}) {
  if (!account || typeof account !== "object") return null;
  return {
    id: clean(account.id || account._id, 80),
    email: maskEmail(account.email),
    role: clean(account.role, 60),
    audience: clean(account.audience, 60),
    workspace: clean(account.workspace, 60),
    status: clean(account.status, 60),
    extensionId: clean(account.extensionId, 80),
    extensionNumber: clean(account.extensionNumber, 40),
    cxAgentId: clean(account.cxAgentId, 80),
    cxOAuthValidated: account.cxAuth
      ? Boolean(account.cxAuth.isOAuthValidated || account.cxAuth.refreshTokenEncrypted || account.cxAuth.bearerEncrypted)
      : null,
    cxScopesCount: Array.isArray(account.cxAuth?.scopes) ? account.cxAuth.scopes.length : null,
  };
}

function summarizeResult(result = {}) {
  if (!result || typeof result !== "object") return null;
  return {
    ok: result.ok == null ? null : Boolean(result.ok),
    skipped: result.skipped == null ? null : Boolean(result.skipped),
    reason: clean(result.reason || result.error, 160),
    method: clean(result.method, 80),
    patched: result.patched == null ? null : Boolean(result.patched),
    status: result.status == null ? null : Number(result.status) || null,
    rcxBearerActive: result.rcxBearerActive == null ? null : Boolean(result.rcxBearerActive),
    finalRedirectTo: clean(result.finalRedirectTo, 160),
  };
}

function traceCxLoginTiming(logger, step, payload = {}) {
  if (!isCxLoginTraceEnabled()) return;
  const log = logger && typeof logger.info === "function" ? logger.info.bind(logger) : null;
  if (!log) return;
  log("cx.login.trace", {
    flow: clean(payload.flow, 80),
    step: clean(step, 120),
    elapsedMs: Number.isFinite(payload.elapsedMs) ? Math.max(0, Math.round(payload.elapsedMs)) : null,
    deltaMs: Number.isFinite(payload.deltaMs) ? Math.max(0, Math.round(payload.deltaMs)) : null,
    stepMs: Number.isFinite(payload.stepMs) ? Math.max(0, Math.round(payload.stepMs)) : null,
    statusCode: payload.statusCode == null ? null : Number(payload.statusCode) || null,
    email: maskEmail(payload.email || payload.account?.email),
    account: summarizeAccount(payload.account),
    result: summarizeResult(payload.result),
    error: clean(payload.error, 220),
    reason: clean(payload.reason, 160),
    configured: payload.configured == null ? null : Boolean(payload.configured),
    loginThinEnabled: payload.loginThinEnabled == null ? null : Boolean(payload.loginThinEnabled),
    asyncOffhookSelfHeal: payload.asyncOffhookSelfHeal == null ? null : Boolean(payload.asyncOffhookSelfHeal),
    offhookScheduled: payload.offhookScheduled == null ? null : Boolean(payload.offhookScheduled),
    prepRedirect: payload.prepRedirect == null ? null : Boolean(payload.prepRedirect),
    rcxBearerActive: payload.rcxBearerActive == null ? null : Boolean(payload.rcxBearerActive),
  });
}

function createCxLoginTrace(logger, flow, basePayload = {}) {
  if (!isCxLoginTraceEnabled()) {
    return () => {};
  }
  const startedAt = Date.now();
  let lastAt = startedAt;
  return (step, payload = {}) => {
    const now = Date.now();
    const merged = {
      ...basePayload,
      ...payload,
      flow,
      elapsedMs: now - startedAt,
      deltaMs: now - lastAt,
    };
    lastAt = now;
    traceCxLoginTiming(logger, step, merged);
  };
}

module.exports = {
  createCxLoginTrace,
  isCxLoginTraceEnabled,
  traceCxLoginTiming,
};
