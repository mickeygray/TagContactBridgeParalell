"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  planProspectBlast,
  loadProspectBlast,
} = require("../../packages/shared-services/src/predictiveCampaignService");
const jobStore = require("../../packages/shared-services/src/blastJobStore");

// ── plan-preview (decide chunk size) ──────────────────────────────────────────
test("planProspectBlast: previews total + chunk plan without loading", async () => {
  const upload = Array.from({ length: 5 }, (_, i) => ({ phone: `31055500${10 + i}` }));
  const plan = await planProspectBlast({ upload, batchSize: 2 });
  assert.equal(plan.total, 5);
  assert.equal(plan.batchSize, 2);
  assert.equal(plan.batches, 3);
  assert.deepEqual(plan.plan.map((p) => p.size), [2, 2, 1]);
  assert.equal(plan.campaignId, 2435);
});

// ── per-chunk progress callback (the progress bar) ────────────────────────────
test("loadProspectBlast: fires onProgress once per chunk with cumulative loaded", async () => {
  const ticks = [];
  const deps = {
    loadLeads: async () => ({ ok: true }),
    sleep: async () => {},
    onProgress: async (p) => { ticks.push({ batchesDone: p.batchesDone, totalBatches: p.totalBatches, loaded: p.loaded }); },
  };
  const targets = Array.from({ length: 5 }, (_, i) => ({ phone: `31055501${10 + i}` }));
  await loadProspectBlast({ targets, batchSize: 2 }, deps);
  assert.deepEqual(ticks, [
    { batchesDone: 1, totalBatches: 3, loaded: 2 },
    { batchesDone: 2, totalBatches: 3, loaded: 4 },
    { batchesDone: 3, totalBatches: 3, loaded: 5 },
  ]);
});

// ── blast job store (progress-bar backing) ────────────────────────────────────
test("blastJobStore: create → running at 0%, progress → pct, finish → complete 100%", () => {
  jobStore._resetBlastJobs();
  const job = jobStore.createBlastJob({ jobId: "j1", campaignId: 2435, total: 5, batches: 3, batchSize: 2, paceMs: 100 });
  assert.equal(job.status, "running");
  assert.equal(job.progressPct, 0);

  const p2 = jobStore.recordBlastProgress("j1", { batchesDone: 2, loaded: 4 });
  assert.equal(p2.progressPct, 67); // round(2/3*100)
  assert.equal(p2.loaded, 4);

  const done = jobStore.finishBlastJob("j1", { status: "complete" });
  assert.equal(done.status, "complete");
  assert.equal(done.progressPct, 100);
  assert.ok(done.finishedAt);
});

test("blastJobStore: getBlastJob returns a copy; unknown id → null", () => {
  jobStore._resetBlastJobs();
  jobStore.createBlastJob({ jobId: "j2", total: 0, batches: 0 });
  const got = jobStore.getBlastJob("j2");
  assert.equal(got.jobId, "j2");
  assert.equal(got.progressPct, 0);
  got.loaded = 999; // mutating the copy must not affect the store
  assert.equal(jobStore.getBlastJob("j2").loaded, 0);
  assert.equal(jobStore.getBlastJob("nope"), null);
});

test("blastJobStore: hasActiveJob = one live blast per campaign+domain (dry-runs don't count)", () => {
  jobStore._resetBlastJobs();
  jobStore.createBlastJob({ jobId: "a", campaignId: 2435, domain: "TAG", total: 5, batches: 1, dryRun: false });
  assert.equal(jobStore.hasActiveJob({ campaignId: 2435, domain: "TAG" }), true);
  assert.equal(jobStore.hasActiveJob({ campaignId: 2435, domain: "WYNN" }), false, "different domain is free");
  assert.equal(jobStore.hasActiveJob({ campaignId: 9999, domain: "TAG" }), false, "different campaign is free");
  jobStore.finishBlastJob("a", { status: "complete" });
  assert.equal(jobStore.hasActiveJob({ campaignId: 2435, domain: "TAG" }), false, "finished job frees the slot");

  jobStore.createBlastJob({ jobId: "d", campaignId: 2435, domain: "TAG", total: 5, batches: 1, dryRun: true });
  assert.equal(jobStore.hasActiveJob({ campaignId: 2435, domain: "TAG" }), false, "a running dry-run does not block a live blast");
});

test("blastJobStore: failure path records error + status", () => {
  jobStore._resetBlastJobs();
  jobStore.createBlastJob({ jobId: "j3", total: 1, batches: 1 });
  const failed = jobStore.finishBlastJob("j3", { status: "failed", error: "ringcx down" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "ringcx down");
});
