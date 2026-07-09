"use strict";

const { getInternalFromEmail } = require("../../shared-config/src");

const DEFAULT_BAD_NUMBER_ALERT_TO = "mgray@taxadvocategroup.com";

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeToken(value) {
  return str(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function isBadNumberOutcome(payload = {}) {
  if (payload.badNumber === true) return true;
  const candidates = [
    payload.outcome,
    payload.disposition,
    payload.result,
    payload.callOutcome,
    payload.badNumberReason,
  ];
  return candidates.some((value) => {
    const token = normalizeToken(value);
    return (
      token === "bad_number" ||
      token === "wrong_number" ||
      token === "disconnected" ||
      token === "out_of_service" ||
      token === "invalid_number"
    );
  });
}

function displayDomain(domain) {
  const key = str(domain).toUpperCase();
  if (key === "WYNN") return "Wynn";
  if (key === "TAG") return "TAG";
  return key || "Unknown";
}

function buildBadNumberAlertEmail({ domain = null, caseId = null } = {}) {
  const label = displayDomain(domain);
  const caseText = Number.isFinite(Number(caseId)) ? String(Number(caseId)) : "unknown";
  const sentence = `${label} Case ID ${caseText} was a disconnected or out of service number.`;
  return {
    subject: `[CX Bad Number] ${label} Case ${caseText}`,
    text: [
      sentence,
      "",
      "The CX Bad Number button was pressed.",
      "The drain is marking the lead DNC in Logics and cadence.",
    ].join("\n"),
  };
}

function markerPatch(fields = {}) {
  const patch = {};
  for (const [key, value] of Object.entries(fields)) {
    patch[`metadata.badNumberOutcome.${key}`] = value;
  }
  return patch;
}

function queueObject(value) {
  if (!value) return null;
  if (typeof value.toObject === "function") return value.toObject();
  return value;
}

function createCxBadNumberOutcomeHandler({
  findQueueItemById = null,
  updateQueueItem = null,
  updateLogicsDncStatus = null,
  sendMail = null,
  alertRecipient = process.env.CX_BAD_NUMBER_ALERT_TO || DEFAULT_BAD_NUMBER_ALERT_TO,
  now = () => new Date(),
  logger = console,
} = {}) {
  async function mark(queueItemId, fields) {
    if (!queueItemId || typeof updateQueueItem !== "function") return null;
    return updateQueueItem(queueItemId, markerPatch(fields)).catch((error) => {
      logger?.warn?.("cx.bad_number.marker_failed", {
        queueItemId,
        error: error?.message || String(error),
      });
      return null;
    });
  }

  async function handle({ row = {}, payload = {} } = {}) {
    if (!isBadNumberOutcome(payload)) {
      return { ok: true, skipped: true, reason: "not-bad-number" };
    }

    const queueItemId = str(payload.queueItemId || row.queueItemId);
    if (!queueItemId) {
      return { ok: true, skipped: true, reason: "missing-queue-item" };
    }

    const queueItem = queueObject(
      typeof findQueueItemById === "function"
        ? await findQueueItemById(queueItemId).catch(() => null)
        : null,
    );
    const metadata = queueItem?.metadata || {};
    const prior = metadata.badNumberOutcome || {};
    const domain = str(payload.domain || row.domain || queueItem?.domain).toUpperCase();
    const caseId = Number(payload.caseId ?? row.caseId ?? queueItem?.caseId);
    const detectedAt = now().toISOString();
    const actorEmail = str(payload.agentEmail || payload.actorEmail || row.agentEmail) || null;

    await mark(queueItemId, {
      detectedAt: prior.detectedAt || detectedAt,
      reason: payload.badNumberReason || "disconnected-or-out-of-service",
      sourceOutcome: payload.outcome || null,
      alertRecipient,
      domain,
      caseId: Number.isFinite(caseId) ? caseId : null,
      actorEmail,
    });

    if (!domain || !Number.isFinite(caseId) || caseId <= 0) {
      await mark(queueItemId, {
        skippedAt: now().toISOString(),
        skippedReason: "missing-case-context",
      });
      logger?.warn?.("cx.bad_number.missing_case_context", {
        queueItemId,
        hasDomain: Boolean(domain),
        hasCaseId: Number.isFinite(caseId) && caseId > 0,
      });
      return {
        ok: true,
        skipped: true,
        reason: "missing-case-context",
        queueItemId,
        domain: domain || null,
        caseId: Number.isFinite(caseId) ? caseId : null,
      };
    }

    let logicsResult = prior.logicsDncAt ? { ok: true, skipped: true, reason: "already-marked" } : null;
    if (!prior.logicsDncAt) {
      if (typeof updateLogicsDncStatus !== "function") {
        throw new Error("bad-number Logics DNC handler is not configured");
      }
      logicsResult = await updateLogicsDncStatus({
        domain,
        caseId,
        actorEmail,
        notes: "DNC set from CX Bad Number button: disconnected or out of service number.",
      });
      if (logicsResult && logicsResult.ok === false) {
        throw new Error(logicsResult.error || logicsResult.reason || "bad-number Logics DNC failed");
      }
      await mark(queueItemId, {
        logicsDncAt: now().toISOString(),
        logicsWorkflowId: logicsResult?.completionWorkflowId || logicsResult?.workflowId || null,
      });
    }

    let emailResult = prior.emailSentAt ? { ok: true, skipped: true, reason: "already-sent" } : null;
    if (!prior.emailSentAt) {
      if (typeof sendMail !== "function") {
        throw new Error("bad-number alert mailer is not configured");
      }
      const email = buildBadNumberAlertEmail({ domain, caseId });
      const fromEmail = getInternalFromEmail();
      emailResult = await sendMail("TAG", {
        to: alertRecipient,
        subject: email.subject,
        text: email.text,
        from: `CX Bad Number <${fromEmail}>`,
        replyTo: `CX Bad Number <${fromEmail}>`,
        transportDomain: "TAG",
      });
      await mark(queueItemId, {
        emailSentAt: now().toISOString(),
        emailMessageId: emailResult?.messageId || null,
      });
    }

    logger?.info?.("cx.bad_number.completed", {
      queueItemId,
      domain,
      caseId: Number.isFinite(caseId) ? caseId : null,
      logicsDncOk: logicsResult ? logicsResult.ok !== false : null,
      emailOk: emailResult ? emailResult.ok !== false : null,
    });

    return {
      ok: true,
      queueItemId,
      domain,
      caseId: Number.isFinite(caseId) ? caseId : null,
      logicsResult,
      emailResult,
    };
  }

  return { handle };
}

module.exports = {
  DEFAULT_BAD_NUMBER_ALERT_TO,
  buildBadNumberAlertEmail,
  createCxBadNumberOutcomeHandler,
  isBadNumberOutcome,
};
