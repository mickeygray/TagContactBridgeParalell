"use strict";

const { getSharedConfig, PORTS } = require("../../shared-config/src");

function getControlPlaneBaseUrl() {
  const config = getSharedConfig();
  return String(
    config.controlPlaneBaseUrl || `http://127.0.0.1:${PORTS.controlPlane}`,
  ).replace(/\/+$/, "");
}

async function relayControlPlaneEvent(input = {}) {
  const config = getSharedConfig();
  const secret = String(config.internalServiceSecret || "").trim();
  if (!secret) {
    throw new Error("INTERNAL_SERVICE_SECRET is required for control-plane relay");
  }

  const response = await fetch(`${getControlPlaneBaseUrl()}/api/events/intake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-service-secret": secret,
    },
    body: JSON.stringify({
      eventType: input.eventType,
      sourceService: input.sourceService || "ringcentral-cx",
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      dedupeKey: input.dedupeKey || null,
      payload: input.payload || {},
    }),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`Control-plane relay failed: ${response.status}`);
    error.status = response.status;
    error.details = data;
    throw error;
  }

  return data;
}

async function relayReviewItemObserved({
  domain,
  category,
  title,
  summary,
  severity = "info",
  caseId = null,
  payload = null,
  tags = [],
  dedupeKey = null,
}) {
  return relayControlPlaneEvent({
    eventType: "control-plane.review-item.observed",
    aggregateType: "review-item",
    aggregateId: dedupeKey || `${domain}:${category}:${title}`,
    dedupeKey,
    payload: {
      domain,
      caseId,
      workflow: "ringcentral-live",
      category,
      severity,
      title,
      summary,
      payload: payload || {},
      tags,
    },
  });
}

async function relayMetricObserved({
  domain,
  metricName,
  sourceKey = null,
  amount = 1,
  caseId = null,
  title = null,
  happenedAt = null,
}) {
  return relayControlPlaneEvent({
    eventType: "control-plane.metric.observed",
    aggregateType: "metric",
    aggregateId: metricName,
    payload: {
      domain,
      metricName,
      sourceKey,
      amount,
      caseId,
      title,
      happenedAt,
    },
  });
}

async function relayRingcentralTelephonyForwarded({ domain, envelope, candidates = [] }) {
  const telephonySessionId = String(
    envelope?.body?.telephonySessionId || envelope?.body?.sessionId || "unknown-session",
  ).trim();
  const sequence = String(envelope?.body?.sequence || "").trim();
  const timestamp = String(envelope?.timestamp || envelope?.body?.eventTime || "").trim();

  return relayControlPlaneEvent({
    eventType: "ringcentral.telephony.forwarded",
    aggregateType: "telephony-session",
    aggregateId: telephonySessionId,
    dedupeKey: [telephonySessionId, sequence, timestamp].join(":"),
    payload: {
      domain,
      envelope,
      candidates,
    },
  });
}

module.exports = {
  relayControlPlaneEvent,
  relayMetricObserved,
  relayReviewItemObserved,
  relayRingcentralTelephonyForwarded,
};
