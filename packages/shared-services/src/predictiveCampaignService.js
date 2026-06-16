"use strict";

// predictiveCampaignService — the dispatch rewrite (item 4): build a PROSPECT list
// (from lead cadence / caseIds via dispatchListService, or a direct upload) and load
// it into a RingCX predictive-dialer campaign (default CX 2435), PACED in batches.
// This is the "free" prospect blast — our own agents dial — vs the per-message-cost
// text/email tools, which now live in /resolution (resolutionContactService).
//
// Heavy deps (ringcxVoiceClient, dispatchListService) are lazy-required so the
// batching/pacing/dedupe orchestration is fully unit-testable with injected fakes.
//
// The RingCX leadLoader/direct payload (shapeRingcxLead + buildLeadLoaderPayload) now
// MATCHES the proven path in scripts/ringcx-predictive-test-runner.js. STILL FLAGGED:
// resolveLoadLeads's voice-client config (createRingcxVoiceClient({domain})) has no
// existing caller — confirm the client constructs correctly before a live blast.

const DEFAULT_BLAST_CAMPAIGN_ID = 2435; // user-specified CX prospect-blast campaign
const DEFAULT_BATCH_SIZE = 100;

function resolveBlastCampaignId(override = null) {
  const raw = override != null ? override : process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLAST_CAMPAIGN_ID;
}

// Local, dependency-free phone normalizer for dedupe keys + the load payload.
// (The exact RingCX phone format should be confirmed; normalizeRingcxPhone exists.)
function toDialablePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

// Tolerant mapping from a dispatch target / uploaded row to a blast target.
function normalizeBlastTarget(row = {}) {
  const phone = row.phone || row.primaryPhone || row.phoneNumber || row.cell || null;
  return {
    phone: toDialablePhone(phone),
    caseId: row.caseId != null ? Number(row.caseId) : null,
    firstName: row.firstName || row.first || null,
    lastName: row.lastName || row.last || null,
    email: row.email || row.Email || null,
  };
}

// Dedupe by dialable phone (drop empties), keeping first occurrence.
function dedupeTargets(targets = []) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(targets) ? targets : []) {
    const t = normalizeBlastTarget(raw);
    if (!t.phone || seen.has(t.phone)) continue;
    seen.add(t.phone);
    out.push(t);
  }
  return out;
}

// Normalize a batch size: anything ≤0 / NaN falls back to the default, so a
// misconfigured size can never explode into thousands of single-lead loads.
function normalizeBatchSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_SIZE;
}

// Chunk into pacing batches.
function planBatches(items = [], batchSize = DEFAULT_BATCH_SIZE) {
  const size = normalizeBatchSize(batchSize);
  const list = Array.isArray(items) ? items : [];
  const batches = [];
  for (let i = 0; i < list.length; i += size) batches.push(list.slice(i, i + size));
  return batches;
}

// RingCX leadLoader/direct lead shape — matches the PROVEN path in
// scripts/ringcx-predictive-test-runner.js (externId/leadPhone — NOT phoneNumber/externalId).
function shapeRingcxLead(target = {}) {
  const externId = target.caseId != null ? String(target.caseId) : "";
  return {
    externId,
    leadPhone: target.phone || "",
    firstName: target.firstName || "",
    lastName: target.lastName || "",
    email: target.email || undefined,
    extendedLeadData: { source: "parallel-prospect-blast", caseId: externId || undefined },
  };
}

// The leadLoader/direct envelope (dial controls + RingCX-side dedup). Mirrors the
// proven payload in scripts/ringcx-predictive-test-runner.js. duplicateHandling
// REMOVE_FROM_LIST means a re-load of the same externIds won't double-dial.
function buildLeadLoaderPayload(uploadLeads, { campaignId, batch = 0, totalBatches = 1 } = {}) {
  return {
    description: `Parallel prospect blast ${campaignId} batch ${batch + 1}/${totalBatches}`,
    dialPriority: "IMMEDIATE",
    duplicateHandling: "REMOVE_FROM_LIST",
    listState: "ACTIVE",
    timeZoneOption: "NPA_NXX",
    phoneNumbersI18nEnabled: false,
    internationalNumberFormat: false,
    uploadLeads,
    dncTags: [],
  };
}

// Build the prospect list: an explicit upload wins; otherwise resolve from lead
// cadence / caseIds via dispatchListService.resolveDispatchTargets (injectable).
async function buildProspectBlast(input = {}, deps = {}) {
  if (Array.isArray(input.upload) && input.upload.length) {
    return dedupeTargets(input.upload);
  }
  const resolve = deps.resolveDispatchTargets
    || require("./dispatchListService").resolveDispatchTargets;
  const targets = await resolve(input);
  return dedupeTargets(Array.isArray(targets) ? targets : []);
}

// Preview: resolve the list + batch plan WITHOUT loading, so the UI can show
// "N leads → M chunks of S" and let the operator decide the chunk size before
// committing. Pure read; reuses buildProspectBlast (upload or lead-cadence).
async function planProspectBlast(input = {}, deps = {}) {
  const targets = await buildProspectBlast(input, deps);
  const batchSize = normalizeBatchSize(input.batchSize);
  const batches = planBatches(targets, batchSize);
  return {
    campaignId: resolveBlastCampaignId(input.campaignId),
    total: targets.length,
    batchSize,
    batches: batches.length,
    plan: batches.map((b, i) => ({ batch: i, size: b.length })),
  };
}

// Load a paced blast into the campaign. dryRun plans without loading. paceMs sleeps
// BETWEEN batches (not after the last). Per-batch isolation: a failed load is captured,
// not thrown. deps.loadLeads is injected in tests; otherwise lazy-resolved.
async function loadProspectBlast(input = {}, deps = {}) {
  const campaignId = resolveBlastCampaignId(input.campaignId);
  const batchSize = normalizeBatchSize(input.batchSize);
  const paceMs = Math.max(0, Number(input.paceMs) || 0);
  const dryRun = Boolean(input.dryRun);

  const deduped = dedupeTargets(input.targets || []);
  const batches = planBatches(deduped, batchSize);
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let loadLeads = deps.loadLeads || null;

  const results = [];
  let loaded = 0;
  for (let i = 0; i < batches.length; i += 1) {
    const leads = batches[i].map(shapeRingcxLead).filter((l) => l.leadPhone);
    let result;
    if (dryRun) {
      result = { batch: i, size: leads.length, loaded: false, dryRun: true };
    } else {
      try {
        if (!loadLeads) loadLeads = resolveLoadLeads(input.domain);
        const response = await loadLeads(
          campaignId,
          buildLeadLoaderPayload(leads, { campaignId, batch: i, totalBatches: batches.length }),
        );
        loaded += leads.length;
        result = { batch: i, size: leads.length, loaded: true, response };
      } catch (error) {
        result = { batch: i, size: leads.length, loaded: false, error: error && error.message };
      }
    }
    results.push(result);
    // Per-chunk progress for the UI progress bar (batchesDone = i+1 of totalBatches).
    if (typeof deps.onProgress === "function") {
      await deps.onProgress({
        batchesDone: i + 1,
        totalBatches: batches.length,
        loaded,
        total: deduped.length,
        lastResult: result,
      });
    }
    if (!dryRun && paceMs > 0 && i < batches.length - 1) await sleep(paceMs);
  }

  const failed = results.filter((r) => r && r.error).length;
  return { campaignId, total: deduped.length, batches: batches.length, loaded, dryRun, failed, results };
}

// FLAGGED: voice-client config is best-inference (no existing loadLeads caller).
function resolveLoadLeads(domain) {
  const { createRingcxVoiceClient } = require("../../shared-integrations/src/ringcxVoiceClient");
  const client = createRingcxVoiceClient({ domain });
  return (campaignId, payload) => client.loadLeads(campaignId, payload);
}

module.exports = {
  DEFAULT_BLAST_CAMPAIGN_ID,
  resolveBlastCampaignId,
  toDialablePhone,
  normalizeBlastTarget,
  dedupeTargets,
  normalizeBatchSize,
  planBatches,
  shapeRingcxLead,
  buildLeadLoaderPayload,
  buildProspectBlast,
  planProspectBlast,
  loadProspectBlast,
};
