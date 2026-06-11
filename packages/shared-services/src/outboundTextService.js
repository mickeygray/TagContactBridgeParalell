"use strict";

const { requestJson } = require("../../shared-integrations/src/httpClient");
const { resolveCompanyByTrackingNumber } = require("../../shared-integrations/src/callrailClient");
const { getCompanyConfig } = require("../../shared-config/src");
const { leadCadenceRepository } = require("../../shared-repositories/src");
const { emitHourlyJobEvent } = require("./hourlyJobEventService");
const { classifyCallrailSmsFailure } = require("./outboundFailureClassifier");

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function stripLeadingBrandPrefix(content) {
  return String(content || "")
    .replace(/^\s*\[(?:TAG|WYNN)\]\s*/i, "")
    .trimStart();
}

function resolveTrackingForDomain(domain, requestedTrackingNumber, defaultTrackingNumber) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const requested = normalizePhone(requestedTrackingNumber);
  if (requested && requested.length === 10) {
    const owner = resolveCompanyByTrackingNumber(requested);
    if (owner && String(owner).toUpperCase() === normalizedDomain) {
      return { tracking: requested, source: "requested" };
    }
  }

  const fallback = normalizePhone(defaultTrackingNumber);
  if (fallback && fallback.length === 10) {
    const owner = resolveCompanyByTrackingNumber(fallback);
    if (owner && String(owner).toUpperCase() === normalizedDomain) {
      return { tracking: fallback, source: "company-default" };
    }
  }

  return {
    tracking: "",
    source: null,
    reason: requested
      ? "tracking-number-domain-mismatch"
      : "missing-tracking-number",
  };
}

async function sendOutboundText({ domain, toPhone, trackingNumber, content, actionKey = null, caseId = null }) {
  const company = getCompanyConfig(domain);
  const digits = normalizePhone(toPhone);
  const trackingResolution = resolveTrackingForDomain(
    domain,
    trackingNumber,
    company.integrations?.callrail?.trackingNumber,
  );
  const tracking = trackingResolution.tracking;
  const cleanedContent = stripLeadingBrandPrefix(content);

  if (!company.integrations.callrail.accountId || !company.integrations.callrail.apiKey || !company.integrations.callrail.companyId) {
    return { ok: false, skipped: true, reason: "callrail-not-configured" };
  }

  if (!digits || digits.length !== 10) {
    return { ok: false, skipped: true, reason: "invalid-phone" };
  }

  if (!tracking || tracking.length !== 10) {
    return {
      ok: false,
      skipped: true,
      reason: trackingResolution.reason || "missing-tracking-number",
    };
  }

  const url = `https://api.callrail.com/v3/a/${company.integrations.callrail.accountId}/text-messages.json`;
  const response = await requestJson(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Token token=${company.integrations.callrail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer_phone_number: digits,
        tracking_number: tracking,
        content: cleanedContent,
        company_id: company.integrations.callrail.companyId,
      }),
    },
    {
      timeoutMs: 15000,
      retries: 1,
    },
  );

  if (!response.ok) {
    // Classify the rejection. Permanent reasons (opted-out, carrier
    // DNC, invalid number) trigger a per-channel DNC mark on the
    // lead's cadence — the lead stays active, only SMS is shut off
    // for it. Transient failures fall through to the hourly reconcile
    // path (rate limit, server error) and stay retryable.
    const classification = classifyCallrailSmsFailure({
      status: response.status,
      body: response.data,
    });
    if (classification.permanent && caseId != null) {
      await leadCadenceRepository
        .markChannelDnc(domain, caseId, "sms", classification.reason)
        .catch(() => null);
    }

    await emitHourlyJobEvent({
      lane: "hourly",
      domain,
      eventType: "outbound.callrail.text.reconcile",
      targetService: "outbound-gateway",
      handlerKey: "cancelFailedOutboundText",
      aggregateType: "outbound-text",
      aggregateId: `${tracking}:${digits}`,
      caseId: caseId != null ? Number(caseId) : null,
        payload: {
          domain,
          actionKey,
          toPhone: digits,
          trackingNumber: tracking,
          content: cleanedContent,
        responseStatus: response.status,
        responseData: response.data || null,
        classification,
      },
      resolutionCheckKey: "outbound-delivery-state",
      resolutionContext: {
        provider: "callrail",
        toPhone: digits,
        trackingNumber: tracking,
      },
      dedupeKey: `${String(domain || "").toUpperCase()}:outbound-text:${tracking}:${digits}`,
      emittedBy: "outbound-gateway",
      priority: 45,
      severity: classification.permanent ? "error" : "warning",
      alertSummary: classification.permanent
        ? `CallRail text rejected (${classification.reason}); SMS DNC marked on case ${caseId}`
        : `CallRail text failed with ${response.status}; hourly reconcile queued`,
      immediateRetryAttempts: classification.permanent ? 0 : 1,
      immediateRetryDelayMs: 500,
      provideSummary: false,
      firstError: `CallRail text failed: ${response.status}`,
      notify: false,
    }).catch(() => null);

    return {
      ok: false,
      error: `CallRail text failed: ${response.status}`,
      details: response.data,
      classification,
    };
  }

  return {
    ok: true,
    provider: "callrail",
    trackingNumber: tracking,
    trackingSource: trackingResolution.source,
    response: response.data,
  };
}

module.exports = {
  normalizePhone,
  resolveTrackingForDomain,
  stripLeadingBrandPrefix,
  sendOutboundText,
};
