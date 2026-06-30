"use strict";

// RingCX publisher adapter for the bulk_load rail.
//
// Pure payload/result mapping (buildUploadLead, buildBulkLeadLoaderPayload,
// toCandidatePublishPatch) tests with zero mocks. Two thin I/O calls wrap the
// RingCX client: publishBatchToRingcx (one loadLeads batch) and
// cancelBatchForSession (kill cleanup). The state machine and orchestrator never
// see RingCX payload quirks. Lead-loader field shape mirrors the canonical
// buildLeadLoaderPayload in ringcxLeadServingService. See plan "### 5. RingCX
// Publisher Adapter".
//
// dialPriority defaults to NORMAL: bulk dials in load order (FIFO), not LIFO.

const { logCxAlpha } = require("./cxAlphaTraceService");

function str(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeDomain(value) {
  return str(value).toUpperCase() || "TAG";
}

function normalizeDialPriority(value, fallback = "NORMAL") {
  const v = str(value).toUpperCase();
  return v === "IMMEDIATE" || v === "NORMAL" ? v : fallback;
}

function splitName(name) {
  const parts = str(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

// PURE. One candidate draft -> one RingCX uploadLead.
function buildUploadLead(candidate = {}) {
  const { firstName, lastName } = splitName(candidate.name);
  return {
    externId: candidate.externId || null,
    leadPhone: candidate.phone || null,
    firstName,
    lastName,
    extendedLeadData: {
      source: "parallel-cx-bulk-load",
      domain: normalizeDomain(candidate.domain),
      caseId: candidate.caseId != null ? Number(candidate.caseId) || null : null,
      queueItemId: candidate.queueItemId ? str(candidate.queueItemId) : null,
    },
  };
}

// PURE. A batch of candidates -> one lead-loader request. Drops drafts missing an
// externId or phone (they could never match or dial).
function buildBulkLeadLoaderPayload(candidates = [], options = {}) {
  const uploadLeads = (Array.isArray(candidates) ? candidates : [])
    .map(buildUploadLead)
    .filter((lead) => lead.externId && lead.leadPhone);
  return {
    description: `Parallel CX bulk-load (${uploadLeads.length} leads)`,
    dialPriority: normalizeDialPriority(options.dialPriority, "NORMAL"),
    duplicateHandling: "REMOVE_FROM_LIST",
    listState: "ACTIVE",
    timeZoneOption: "NPA_NXX",
    phoneNumbersI18nEnabled: false,
    internationalNumberFormat: false,
    uploadLeads,
  };
}

const TOTAL_FAILURE_STATUSES = Object.freeze(new Set(["GENERAL_FAILURE", "NO_LEADS_PASSED_VALIDATION"]));

function extractRejectedExternIds(result = {}) {
  const set = new Set();
  const rows = Array.isArray(result.rejectedRows) ? result.rejectedRows : [];
  for (const row of rows) {
    const ext = str(row && (row.externId || (row.lead && row.lead.externId)));
    if (ext) set.add(ext);
  }
  return set;
}

function readInsertedCount(result = {}) {
  for (const key of ["leadsInserted", "inserted", "acceptedCount", "successfulLeads"]) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) continue;
    const value = Number(result[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

// PURE. Map a LeadListProcessingResult onto per-candidate accept/reject patches.
// A whole-batch failure status rejects every candidate; otherwise everything not
// in rejectedRows is accepted.
function toCandidatePublishPatch(result = {}, candidates = []) {
  const list = Array.isArray(candidates) ? candidates : [];
  const status = str(result.processingStatus).toUpperCase();
  if (status && TOTAL_FAILURE_STATUSES.has(status)) {
    return {
      accepted: [],
      rejected: list.map((c) => ({ queueItemId: c.queueItemId, externId: c.externId, reason: status })),
    };
  }
  const rejectedExternIds = extractRejectedExternIds(result);
  const insertedCount = readInsertedCount(result);
  if (insertedCount !== null && insertedCount <= 0 && rejectedExternIds.size === 0 && list.length > 0) {
    return {
      accepted: [],
      rejected: list.map((c) => ({
        queueItemId: c.queueItemId,
        externId: c.externId || null,
        reason: "NO_LEADS_INSERTED",
      })),
    };
  }
  const accepted = [];
  const rejected = [];
  for (const c of list) {
    if (!c.externId) {
      rejected.push({ queueItemId: c.queueItemId, externId: null, reason: "MISSING_EXTERN_ID" });
    } else if (rejectedExternIds.has(c.externId)) {
      rejected.push({ queueItemId: c.queueItemId, externId: c.externId, reason: "rejected" });
    } else {
      accepted.push({ queueItemId: c.queueItemId, externId: c.externId, candidate: c });
    }
  }
  return { accepted, rejected };
}

// Thin I/O. One batch publish. Returns the per-candidate patch the orchestrator
// turns into buffer.publish_accepted / buffer.publish_failed events.
async function publishBatchToRingcx(client, input = {}) {
  if (!client || typeof client.loadLeads !== "function") {
    throw new Error("publishBatchToRingcx requires a RingCX client with loadLeads");
  }
  const campaignId = str(input.campaignId);
  if (!campaignId) throw new Error("publishBatchToRingcx requires a campaignId");

  const payload = buildBulkLeadLoaderPayload(input.candidates, { dialPriority: input.dialPriority });
  if (!payload.uploadLeads.length) {
    const rejected = (Array.isArray(input.candidates) ? input.candidates : [])
      .map((c) => ({ queueItemId: c.queueItemId, externId: c.externId || null, reason: "NOT_UPLOADED" }));
    return { supplied: 0, accepted: [], rejected, result: null };
  }
  const uploadedExternIds = new Set(payload.uploadLeads.map((lead) => lead.externId));
  const uploadedCandidates = (Array.isArray(input.candidates) ? input.candidates : [])
    .filter((candidate) => candidate.externId && uploadedExternIds.has(candidate.externId));
  const notUploaded = (Array.isArray(input.candidates) ? input.candidates : [])
    .filter((candidate) => !candidate.externId || !uploadedExternIds.has(candidate.externId))
    .map((candidate) => ({
      queueItemId: candidate.queueItemId,
      externId: candidate.externId || null,
      reason: "NOT_UPLOADED",
    }));
  const result = await client.loadLeads(campaignId, payload);
  const patch = toCandidatePublishPatch(result, uploadedCandidates);
  // ALPHA observability: log the RingCX publish-batch reconciliation at the transport boundary —
  // the one place the "publish accepted but RingCX never dialed" / phantom-lead class shows up
  // (RingCX reports leadsInserted < what we counted accepted). The service trace only carries the
  // accepted externId; this surfaces processingStatus + leadsInserted + reject reasons. Gated by
  // CX_ALPHA_TRACE_ENABLED, PII-redacted, never throws.
  const rejectAll = [...patch.rejected, ...notUploaded];
  const insertedCount = readInsertedCount(result);
  const rejectReasons = {};
  for (const r of rejectAll) {
    const reason = str(r && r.reason) || "unknown";
    rejectReasons[reason] = (rejectReasons[reason] || 0) + 1;
  }
  logCxAlpha("cx.alpha.publish.batch", {
    rail: "bulk_load",
    campaignId,
    dialPriority: str(input.dialPriority) || "NORMAL",
    supplied: payload.uploadLeads.length,
    acceptedCount: patch.accepted.length,
    rejectedCount: rejectAll.length,
    insertedCount, // RingCX leadsInserted (null = not reported in the response)
    processingStatus: str(result && result.processingStatus) || null,
    rejectReasons,
    acceptedExternIds: patch.accepted.map((a) => a.externId).filter(Boolean),
    acceptedQueueItemIds: patch.accepted.map((a) => str(a.queueItemId)).filter(Boolean),
    // accepted by us but RingCX inserted fewer -> these may never actually dial (phantom lead).
    phantomSuspected: patch.accepted.length > 0 && insertedCount !== null && insertedCount < patch.accepted.length,
  });
  return { supplied: payload.uploadLeads.length, accepted: patch.accepted, rejected: rejectAll, result };
}

// Thin I/O. Cancel still-buffered candidates for a killed session (no dial ever
// happens for these; no terminal disposition is fabricated).
async function cancelBatchForSession(client, input = {}) {
  if (!client || typeof client.leadAction !== "function") {
    throw new Error("cancelBatchForSession requires a RingCX client with leadAction");
  }
  const campaignId = str(input.campaignId);
  const externIds = (Array.isArray(input.candidates) ? input.candidates : [])
    .map((c) => str(c.externId || (c.ringcx && c.ringcx.externId)))
    .filter(Boolean);
  if (!externIds.length) return { cancelled: 0, result: null };
  if (!campaignId) throw new Error("cancelBatchForSession requires a campaignId");

  const result = await client.leadAction("CANCEL_LEADS", {
    campaignLeadSearchCriteria: { campaignId, campaignIds: campaignId ? [campaignId] : undefined, externIds },
    leadActionParams: {},
  });
  return { cancelled: externIds.length, result };
}

module.exports = {
  buildUploadLead,
  buildBulkLeadLoaderPayload,
  toCandidatePublishPatch,
  publishBatchToRingcx,
  cancelBatchForSession,
};
