"use strict";

// blastJobStore — progress tracking for a paced prospect blast (the chunk-completion
// progress bar). A blast loads its chunks over time (paced), so the HTTP "start" call
// returns a jobId immediately and the UI polls this store for {batchesDone/totalBatches}.
//
// IN-MEMORY, single-process: progress is held in a Map, so it does NOT survive a
// process restart and is NOT shared across processes. Good enough for one control-plane
// process driving the dispatch UI; swap in a Mongo-backed store later if blasts must
// survive restarts. The interface (create/progress/finish/get) is the seam for that swap.

const crypto = require("crypto");

const jobs = new Map();
const MAX_JOBS = 200; // keep the most recent N; prune oldest beyond that

function newBlastJobId() {
  return `blast_${crypto.randomUUID()}`;
}

function pct(done, total) {
  if (!total || total <= 0) return 100;
  return Math.min(100, Math.round((done / total) * 100));
}

function pruneOldest() {
  while (jobs.size > MAX_JOBS) {
    const oldestKey = jobs.keys().next().value;
    jobs.delete(oldestKey);
  }
}

function createBlastJob({ jobId, campaignId, total, batches, batchSize, paceMs, dryRun = false, domain = null, startedAt = null } = {}) {
  const id = jobId || newBlastJobId();
  const job = {
    jobId: id,
    status: "running",
    domain,
    campaignId,
    total: Number(total) || 0,
    totalBatches: Number(batches) || 0,
    batchSize: Number(batchSize) || 0,
    paceMs: Number(paceMs) || 0,
    dryRun: Boolean(dryRun),
    batchesDone: 0,
    loaded: 0,
    progressPct: 0,
    error: null,
    startedAt: startedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(id, job);
  pruneOldest();
  return { ...job };
}

function recordBlastProgress(jobId, { batchesDone, loaded } = {}) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (batchesDone != null) job.batchesDone = Number(batchesDone);
  if (loaded != null) job.loaded = Number(loaded);
  job.progressPct = pct(job.batchesDone, job.totalBatches);
  job.updatedAt = new Date().toISOString();
  return { ...job };
}

function finishBlastJob(jobId, { status = "complete", error = null } = {}) {
  const job = jobs.get(jobId);
  if (!job) return null;
  job.status = status;
  job.error = error;
  if (status === "complete") job.progressPct = 100;
  job.finishedAt = new Date().toISOString();
  job.updatedAt = job.finishedAt;
  return { ...job };
}

function getBlastJob(jobId) {
  const job = jobs.get(jobId);
  return job ? { ...job } : null;
}

// Is a LIVE (non-dry-run) blast already running for this campaign+domain? Used to
// enforce one concurrent live blast per campaign/domain (a runaway-load guard).
function hasActiveJob({ campaignId, domain = null } = {}) {
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.dryRun) continue;
    if (Number(job.campaignId) !== Number(campaignId)) continue;
    if ((job.domain || null) !== (domain || null)) continue;
    return true;
  }
  return false;
}

// Test-only: reset the store.
function _resetBlastJobs() {
  jobs.clear();
}

module.exports = {
  newBlastJobId,
  createBlastJob,
  recordBlastProgress,
  finishBlastJob,
  getBlastJob,
  hasActiveJob,
  _resetBlastJobs,
};
