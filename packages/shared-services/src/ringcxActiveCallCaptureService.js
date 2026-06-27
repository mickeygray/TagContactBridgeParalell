"use strict";

const {
  createRingcxVoiceClient,
} = require("../../shared-integrations/src");

function normalizeExternalId(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function coerceActiveCallList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.activeCalls)) return payload.activeCalls;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function extractActiveCallUii(call = null) {
  if (!call || typeof call !== "object") return null;
  const candidates = [
    call.uii,
    call.UII,
    call.callId,
    call.callID,
    call.activeCallId,
    call.id,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return null;
}

function collectScalarStrings(value, output = [], depth = 0) {
  if (output.length >= 160 || depth > 5 || value === null || value === undefined) {
    return output;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) collectScalarStrings(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value).slice(0, 80)) {
      output.push(String(key));
      collectScalarStrings(child, output, depth + 1);
      if (output.length >= 160) break;
    }
  }
  return output;
}

function activeCallContainsText(call, value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return false;
  return collectScalarStrings(call)
    .some((candidate) => String(candidate || "").toLowerCase().includes(needle));
}

function cloneActiveCallForAudit(value, depth = 0) {
  if (value == null) return value;
  if (depth > 5) return "[depth-limit]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => cloneActiveCallForAudit(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 120)) {
      out[key] = cloneActiveCallForAudit(child, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  }
  return value;
}

function summarizeActiveCall(call = null) {
  if (!call || typeof call !== "object") return null;
  const summary = {};
  const keys = [
    "uii",
    "UII",
    "callId",
    "callID",
    "activeCallId",
    "id",
    "state",
    "status",
    "callState",
    "ani",
    "dnis",
    "callerId",
    "sourcePhone",
    "destination",
    "destinationPhone",
    "leadPhone",
    "phone",
    "campaignId",
    "dialGroupId",
    "agentId",
    "username",
    "agentEmail",
    "externId",
    "externalId",
    "interactionId",
    "dialogId",
    "segmentId",
    "sessionId",
    "callSessionId",
  ];
  for (const key of keys) {
    const value = call[key];
    if (value !== undefined && value !== null && value !== "") summary[key] = value;
  }
  summary.uii = summary.uii || summary.UII || summary.callId || summary.callID || summary.activeCallId || summary.id || null;
  summary.rawKeys = Object.keys(call).slice(0, 120);
  summary.raw = cloneActiveCallForAudit(call);
  return summary;
}

function scoreActiveCallMatch(call, {
  campaignId = null,
  externId = null,
  agentEmail = null,
} = {}) {
  if (!call || typeof call !== "object") {
    return { score: 0, reasons: [] };
  }
  const reasons = [];
  let score = 0;
  const hasExternIdMatch = externId && activeCallContainsText(call, externId);
  const hasCampaignMatch = campaignId && activeCallContainsText(call, campaignId);
  const hasAgentMatch = agentEmail && activeCallContainsText(call, agentEmail);

  if (hasExternIdMatch) {
    score += 100;
    reasons.push("externId");
  }
  if (hasCampaignMatch) {
    score += 4;
    reasons.push("campaignId");
  }
  if (hasAgentMatch) {
    score += 4;
    reasons.push("agentEmail");
  }

  if (!hasExternIdMatch && !(hasCampaignMatch && hasAgentMatch)) {
    return { score: 0, reasons: [] };
  }

  const state = String(call.state || call.callState || call.status || "").toLowerCase();
  if (state && /(outdial|dial|ring|call|connected|preview)/.test(state)) {
    score += 1;
    reasons.push("activeState");
  }

  return { score, reasons };
}

function findMatchingActiveCall(activeCallsPayload, criteria = {}) {
  const scored = coerceActiveCallList(activeCallsPayload)
    .map((call) => ({
      call,
      ...scoreActiveCallMatch(call, criteria),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  const top = scored[0];
  if (!top) return null;
  const next = scored[1];
  const hasExactQueueIdentity = top.reasons.includes("externId");
  if (hasExactQueueIdentity) return top;
  if (next && next.score === top.score) return null;
  if (top.reasons.length < 2 || top.score < 9) return null;
  return top;
}

function buildActiveCallQuerySpecs({
  client = null,
  externId = null,
  agentCxAgentId = null,
} = {}) {
  const specs = [];
  if (externId) {
    specs.push({
      product: null,
      productId: null,
      externalId: externId,
      queryScope: "EXTERNAL_ID",
      scopedToAgent: false,
    });
  } else if (agentCxAgentId) {
    specs.push({
      product: "AGENT",
      productId: agentCxAgentId,
      externalId: null,
      queryScope: "AGENT",
      scopedToAgent: true,
    });
  }
  specs.push({
    product: "ACCOUNT",
    productId: client?.config?.accountId,
    externalId: externId || null,
    queryScope: "ACCOUNT",
    scopedToAgent: false,
  });
  return specs;
}

async function waitForRingcxCampaignCall(client, {
  campaignId = null,
  externId = null,
  agentEmail = null,
  agentCxAgentId = null,
  timeoutMs = Number(process.env.RINGCX_CAMPAIGN_CALL_CAPTURE_MS) || 8000,
  intervalMs = Number(process.env.RINGCX_CAMPAIGN_CALL_CAPTURE_INTERVAL_MS) || 250,
  logger = null,
  includeDiagnostics = false,
} = {}) {
  if (!client || typeof client.listActiveCalls !== "function") {
    return { ok: false, reason: "active-call-list-unavailable" };
  }

  const querySpecs = buildActiveCallQuerySpecs({ client, externId, agentCxAgentId });
  const startedAt = Date.now();
  const diagnostics = [];
  let lastError = null;
  let lastCallCount = 0;
  let lastSample = null;
  let firstPollMs = null;
  let uiiFoundAt = null;

  do {
    for (const spec of querySpecs) {
      try {
        if (firstPollMs === null) firstPollMs = Date.now() - startedAt;
        const activeCalls = await client.listActiveCalls({
          product: spec.product,
          productId: spec.productId,
          externalId: spec.externalId,
        });
        const calls = coerceActiveCallList(activeCalls);
        lastCallCount = calls.length;
        lastSample = calls[0] ? summarizeActiveCall(calls[0]) : null;
        if (includeDiagnostics) {
          diagnostics.push({
            atMs: Date.now() - startedAt,
            queryScope: spec.queryScope,
            callCount: calls.length,
            sample: lastSample,
          });
        }

        const match = findMatchingActiveCall(activeCalls, {
          campaignId,
          externId,
          agentEmail,
        });
        if (match) {
          if (uiiFoundAt === null) uiiFoundAt = Date.now();
          return {
            ok: true,
            uii: extractActiveCallUii(match.call),
            activeCallSummary: summarizeActiveCall(match.call),
            matchReasons: match.reasons,
            queryScope: spec.queryScope || spec.product,
            firstPollMs,
            uiiFoundAt,
            uiiFoundMs: uiiFoundAt - startedAt,
            diagnostics: includeDiagnostics ? diagnostics : undefined,
          };
        }

        if (spec.scopedToAgent && calls.length === 1) {
          logger?.warn?.("ringcx.campaignCallCapture.singleAgentCall.unconfirmed", {
            product: spec.product,
            productId: spec.productId,
            reason: "missing-queue-identity",
            sample: summarizeActiveCall(calls[0]),
          });
        }
      } catch (error) {
        lastError = error;
        logger?.warn?.("ringcx.campaignCallCapture.listActiveCalls.failed", {
          product: spec.queryScope || spec.product,
          productId: spec.externalId ? "externalId" : spec.productId,
          error: error.message,
        });
      }
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await sleep(intervalMs);
  } while (Date.now() - startedAt < timeoutMs);

  return {
    ok: false,
    reason: lastError ? "active-call-list-error" : "active-call-not-found",
    error: lastError ? lastError.message : null,
    callCount: lastCallCount,
    sample: lastSample,
    firstPollMs,
    uiiFoundAt: null,
    diagnostics: includeDiagnostics ? diagnostics : undefined,
  };
}

async function captureRingcxActiveCallForPublishedLead(input = {}, options = {}) {
  const logger = options.logger || input.logger || null;
  const client = options.client || createRingcxVoiceClient();
  const startedAt = Date.now();
  const result = await waitForRingcxCampaignCall(client, {
    campaignId: input.campaignId || null,
    externId: input.externId || null,
    agentEmail: input.agentEmail || null,
    agentCxAgentId: input.agentCxAgentId || input.cxAgentId || null,
    timeoutMs: input.timeoutMs,
    intervalMs: input.intervalMs,
    includeDiagnostics: Boolean(input.includeDiagnostics),
    logger,
  });
  logger?.info?.("ringcx.active_call_capture.result", {
    ok: Boolean(result.ok),
    reason: result.reason || null,
    elapsedMs: Date.now() - startedAt,
    uii: result.uii || null,
    queryScope: result.queryScope || null,
    matchReasons: result.matchReasons || [],
    firstPollMs: result.firstPollMs ?? null,
    uiiFoundMs: result.uiiFoundMs ?? null,
    callCount: result.callCount ?? null,
  });
  return result;
}

module.exports = {
  activeCallContainsText,
  captureRingcxActiveCallForPublishedLead,
  coerceActiveCallList,
  extractActiveCallUii,
  findMatchingActiveCall,
  scoreActiveCallMatch,
  summarizeActiveCall,
  waitForRingcxCampaignCall,
};
