"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveBlastCampaignId,
  toDialablePhone,
  normalizeBlastTarget,
  dedupeTargets,
  planBatches,
  shapeRingcxLead,
  buildLeadLoaderPayload,
  buildProspectBlast,
  loadProspectBlast,
} = require("../../packages/shared-services/src/predictiveCampaignService");

// ── campaign id (default 2435) ────────────────────────────────────────────────
test("resolveBlastCampaignId: defaults to 2435, env/override win", () => {
  const saved = process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID;
  delete process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID;
  assert.equal(resolveBlastCampaignId(), 2435);
  assert.equal(resolveBlastCampaignId(999), 999);
  process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID = "5000";
  assert.equal(resolveBlastCampaignId(), 5000);
  if (saved === undefined) delete process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID;
  else process.env.RINGCX_PROSPECT_BLAST_CAMPAIGN_ID = saved;
});

// ── phone + target normalization ──────────────────────────────────────────────
test("toDialablePhone: 10-digit → +1, 11-digit → +, junk → empty", () => {
  assert.equal(toDialablePhone("3105551234"), "+13105551234");
  assert.equal(toDialablePhone("13105551234"), "+13105551234");
  assert.equal(toDialablePhone("(310) 555-1234"), "+13105551234");
  assert.equal(toDialablePhone(""), "");
});

test("normalizeBlastTarget: reads varied phone/name/case fields", () => {
  assert.deepEqual(
    normalizeBlastTarget({ primaryPhone: "3105551234", caseId: "42", firstName: "A", email: "a@b.c" }),
    { phone: "+13105551234", caseId: 42, firstName: "A", lastName: null, email: "a@b.c" },
  );
});

// ── dedupe + batching ─────────────────────────────────────────────────────────
test("dedupeTargets: unique by dialable phone, drops empties", () => {
  const out = dedupeTargets([
    { phone: "3105551234" },
    { phone: "(310) 555-1234" }, // same number, different format
    { phone: "" },               // dropped
    { phone: "3105559999" },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((t) => t.phone), ["+13105551234", "+13105559999"]);
});

test("planBatches: chunks by size, tolerates remainder + edge sizes", () => {
  assert.equal(planBatches([1, 2, 3, 4, 5], 2).length, 3);
  assert.deepEqual(planBatches([1, 2, 3, 4, 5], 2)[2], [5]);
  assert.equal(planBatches([], 100).length, 0);
  assert.equal(planBatches([1, 2], 0).length, 1); // size<=0 → default (one batch), never batches-of-1
  assert.equal(planBatches([1, 2], -5).length, 1); // negative also → default, not size 1
});

test("shapeRingcxLead: maps to the PROVEN RingCX shape (externId/leadPhone/email)", () => {
  assert.deepEqual(shapeRingcxLead({ phone: "+13105551234", caseId: 7, firstName: "A", lastName: "B", email: "a@b.c" }), {
    externId: "7",
    leadPhone: "+13105551234",
    firstName: "A",
    lastName: "B",
    email: "a@b.c",
    extendedLeadData: { source: "parallel-prospect-blast", caseId: "7" },
  });
});

test("buildLeadLoaderPayload: wraps leads with dial controls + RingCX-side dedup", () => {
  const p = buildLeadLoaderPayload([{ leadPhone: "+1310" }], { campaignId: 2435, batch: 0, totalBatches: 2 });
  assert.equal(p.uploadLeads.length, 1);
  assert.equal(p.duplicateHandling, "REMOVE_FROM_LIST");
  assert.equal(p.dialPriority, "IMMEDIATE");
  assert.equal(p.listState, "ACTIVE");
  assert.match(p.description, /batch 1\/2/);
});

// ── build list (upload + injected resolve) ────────────────────────────────────
test("buildProspectBlast: an upload is used directly + deduped", async () => {
  const out = await buildProspectBlast({ upload: [{ phone: "3105551234" }, { phone: "3105551234" }] });
  assert.equal(out.length, 1);
});

test("buildProspectBlast: no upload → resolves from lead-cadence via injected resolver", async () => {
  const deps = { resolveDispatchTargets: async () => [{ primaryPhone: "3105550000", caseId: 1 }] };
  const out = await buildProspectBlast({ domain: "TAG", audienceSource: "lead-cadence" }, deps);
  assert.equal(out.length, 1);
  assert.equal(out[0].phone, "+13105550000");
});

// ── paced load orchestration (fake loadLeads + fake sleep) ────────────────────
test("loadProspectBlast: loads paced batches into campaign 2435, sleeps BETWEEN only", async () => {
  const calls = { load: [], sleeps: [] };
  const deps = {
    loadLeads: async (campaignId, payload) => { calls.load.push({ campaignId, count: payload.uploadLeads.length, dedup: payload.duplicateHandling }); return { ok: true }; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
  };
  const targets = Array.from({ length: 5 }, (_, i) => ({ phone: `31055500${10 + i}` }));
  const out = await loadProspectBlast({ targets, batchSize: 2, paceMs: 250 }, deps);
  assert.equal(out.campaignId, 2435);
  assert.equal(out.batches, 3);
  assert.equal(out.loaded, 5);
  assert.equal(calls.load.length, 3);
  assert.equal(calls.load[0].campaignId, 2435);
  assert.equal(calls.sleeps.length, 2, "sleep between the 3 batches, not after the last");
});

test("loadProspectBlast: dryRun plans without loading", async () => {
  const calls = { load: [] };
  const deps = { loadLeads: async () => { calls.load.push(1); }, sleep: async () => {} };
  const out = await loadProspectBlast({ targets: [{ phone: "3105550001" }], dryRun: true }, deps);
  assert.equal(out.dryRun, true);
  assert.equal(out.loaded, 0);
  assert.equal(calls.load.length, 0);
});

test("loadProspectBlast: dryRun does not resolve the live RingCX loader", async () => {
  const out = await loadProspectBlast({ targets: [{ phone: "3105550001" }], dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.loaded, 0);
  assert.equal(out.failed, 0);
});

test("loadProspectBlast: a failed batch is captured, not thrown", async () => {
  const deps = {
    loadLeads: async (id, p) => { if (p.uploadLeads[0].leadPhone.endsWith("0002")) throw new Error("ringcx 500"); return { ok: true }; },
    sleep: async () => {},
  };
  const out = await loadProspectBlast({ targets: [{ phone: "3105550001" }, { phone: "3105550002" }], batchSize: 1 }, deps);
  assert.equal(out.batches, 2);
  assert.equal(out.loaded, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.results.filter((r) => r.error).length, 1);
});
