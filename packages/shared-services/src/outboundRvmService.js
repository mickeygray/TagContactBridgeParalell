"use strict";

const { createDropClient } = require("../../shared-integrations/src");
const { leadCadenceRepository } = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { classifyDropRvmFailure } = require("./outboundFailureClassifier");

async function sendOutboundRvm({ domain, toPhone, caseId, name, source, audioUrl, actionKey = null }) {
  if (!toPhone) {
    return { ok: false, skipped: true, reason: "missing-phone" };
  }

  const client = createDropClient(domain);
  try {
    const response = await client.dropVoicemail({
      phone: toPhone,
      caseId,
      name,
      source: source || "outbound-gateway",
      audioUrl,
    });

    return {
      ok: true,
      provider: "drop",
      response,
    };
  } catch (error) {
    // Classify the rejection. Drop returns plain-text errors for
    // national-DNC / invalid-area-code / opted-out — those are
    // permanent and should mark the lead's RVM channel DNC. Other
    // errors (network, 5xx) stay retryable.
    const classification = classifyDropRvmFailure({
      error: error?.message,
      body: error?.response?.data,
    });
    if (classification.permanent && caseId != null) {
      await leadCadenceRepository
        .markChannelDnc(domain, caseId, "rvm", classification.reason)
        .catch(() => null);
    }

    await emitHourlyJobEvent({
      lane: "hourly",
      domain,
      eventType: "outbound.drop.rvm.reconcile",
      targetService: "outbound-gateway",
      handlerKey: "cancelFailedOutboundRvm",
      aggregateType: "outbound-rvm",
      aggregateId: String(toPhone),
      caseId: caseId != null ? Number(caseId) : null,
        payload: {
          domain,
          actionKey,
          toPhone,
          caseId,
          name,
        source: source || "outbound-gateway",
        audioUrl,
        classification,
      },
      resolutionCheckKey: "outbound-delivery-state",
      resolutionContext: {
        provider: "drop",
        toPhone,
        caseId,
      },
      dedupeKey: `${String(domain || "").toUpperCase()}:outbound-rvm:${String(caseId || "na")}:${String(toPhone)}`,
      emittedBy: "outbound-gateway",
      priority: 45,
      severity: classification.permanent ? "error" : "warning",
      alertSummary: classification.permanent
        ? `Drop RVM rejected (${classification.reason}); RVM DNC marked on case ${caseId}`
        : "Drop voicemail send failed; hourly reconcile queued",
      immediateRetryAttempts: classification.permanent ? 0 : 1,
      immediateRetryDelayMs: 500,
      provideSummary: false,
      firstError: error.message,
      notify: false,
    }).catch(() => null);

    throw error;
  }
}

module.exports = {
  sendOutboundRvm,
};
