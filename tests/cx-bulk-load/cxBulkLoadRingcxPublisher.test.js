"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildUploadLead,
  buildBulkLeadLoaderPayload,
  toCandidatePublishPatch,
  publishBatchToRingcx,
  cancelBatchForSession,
} = require("../../packages/shared-services/src/cxBulkLoadRingcxPublisher");

function candidate(queueItemId) {
  return { queueItemId, domain: "TAG", caseId: 42, name: "Jane Doe", phone: "5551234567", externId: `cxbl-tag-${queueItemId}` };
}

// ── pure payload builders ───────────────────────────────────────────────
test("buildUploadLead maps a candidate to the RingCX uploadLead shape", () => {
  const lead = buildUploadLead(candidate("q1"));
  assert.equal(lead.externId, "cxbl-tag-q1");
  assert.equal(lead.leadPhone, "5551234567");
  assert.equal(lead.firstName, "Jane");
  assert.equal(lead.lastName, "Doe");
  assert.equal(lead.extendedLeadData.queueItemId, "q1");
  assert.equal(lead.extendedLeadData.caseId, 42);
});

test("buildBulkLeadLoaderPayload batches leads, defaults dialPriority NORMAL, drops phone/extern-less drafts", () => {
  const payload = buildBulkLeadLoaderPayload([candidate("q1"), candidate("q2"), { queueItemId: "q3" /* no phone/extern */ }]);
  assert.equal(payload.dialPriority, "NORMAL");
  assert.equal(payload.duplicateHandling, "REMOVE_FROM_LIST");
  assert.equal(payload.listState, "ACTIVE");
  assert.equal(payload.uploadLeads.length, 2); // q3 dropped
});

test("buildBulkLeadLoaderPayload honors an IMMEDIATE override", () => {
  const payload = buildBulkLeadLoaderPayload([candidate("q1")], { dialPriority: "immediate" });
  assert.equal(payload.dialPriority, "IMMEDIATE");
});

// ── pure result mapping ─────────────────────────────────────────────────
test("toCandidatePublishPatch: no rejectedRows -> all accepted", () => {
  const patch = toCandidatePublishPatch({ processingStatus: "DEFAULT_NOT_A_FAILURE", rejectedRows: [] }, [candidate("q1"), candidate("q2")]);
  assert.equal(patch.accepted.length, 2);
  assert.equal(patch.rejected.length, 0);
  assert.equal(patch.accepted[0].externId, "cxbl-tag-q1");
});

test("toCandidatePublishPatch: rejectedRows split out by externId", () => {
  const patch = toCandidatePublishPatch(
    { rejectedRows: [{ externId: "cxbl-tag-q2" }] },
    [candidate("q1"), candidate("q2")],
  );
  assert.deepEqual(patch.accepted.map((a) => a.queueItemId), ["q1"]);
  assert.deepEqual(patch.rejected.map((r) => r.queueItemId), ["q2"]);
});

test("toCandidatePublishPatch: rejectedRows can use nested lead.externId", () => {
  const patch = toCandidatePublishPatch(
    { rejectedRows: [{ lead: { externId: "cxbl-tag-q2" } }] },
    [candidate("q1"), candidate("q2")],
  );
  assert.deepEqual(patch.accepted.map((a) => a.queueItemId), ["q1"]);
  assert.deepEqual(patch.rejected.map((r) => r.queueItemId), ["q2"]);
});

test("toCandidatePublishPatch: whole-batch failure status rejects everyone", () => {
  const patch = toCandidatePublishPatch({ processingStatus: "NO_LEADS_PASSED_VALIDATION" }, [candidate("q1"), candidate("q2")]);
  assert.equal(patch.accepted.length, 0);
  assert.equal(patch.rejected.length, 2);
  assert.equal(patch.rejected[0].reason, "NO_LEADS_PASSED_VALIDATION");
});

test("toCandidatePublishPatch: GENERAL_FAILURE rejects everyone", () => {
  const patch = toCandidatePublishPatch({ processingStatus: "GENERAL_FAILURE" }, [candidate("q1"), candidate("q2")]);
  assert.equal(patch.accepted.length, 0);
  assert.equal(patch.rejected.length, 2);
  assert.equal(patch.rejected[0].reason, "GENERAL_FAILURE");
});

test("toCandidatePublishPatch: zero inserted with no rejects fails closed", () => {
  const patch = toCandidatePublishPatch(
    { processingStatus: "COMPLETED", leadsInserted: 0, rejectedRows: [] },
    [candidate("q1"), candidate("q2")],
  );
  assert.equal(patch.accepted.length, 0);
  assert.equal(patch.rejected.length, 2);
  assert.deepEqual(patch.rejected.map((r) => r.reason), ["NO_LEADS_INSERTED", "NO_LEADS_INSERTED"]);
});

// ── thin I/O (fake client) ──────────────────────────────────────────────
test("publishBatchToRingcx makes one loadLeads call and returns the patch", async () => {
  const calls = [];
  const fakeClient = {
    loadLeads: async (campaignId, payload) => {
      calls.push({ campaignId, payload });
      return { leadsSupplied: 2, leadsInserted: 2, rejectedRows: [] };
    },
  };
  const out = await publishBatchToRingcx(fakeClient, { campaignId: "camp1", candidates: [candidate("q1"), candidate("q2")] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].campaignId, "camp1");
  assert.equal(calls[0].payload.uploadLeads.length, 2);
  assert.equal(out.supplied, 2);
  assert.equal(out.accepted.length, 2);
});

test("publishBatchToRingcx never accepts a candidate that was not uploaded", async () => {
  const calls = [];
  const fakeClient = {
    loadLeads: async (campaignId, payload) => {
      calls.push({ campaignId, payload });
      return { rejectedRows: [] };
    },
  };
  const out = await publishBatchToRingcx(fakeClient, {
    campaignId: "camp1",
    candidates: [candidate("q1"), { queueItemId: "q2" }],
  });
  assert.equal(calls[0].payload.uploadLeads.length, 1);
  assert.equal(out.supplied, 1);
  assert.deepEqual(out.accepted.map((a) => a.queueItemId), ["q1"]);
  assert.deepEqual(out.rejected.map((r) => r.queueItemId), ["q2"]);
  assert.equal(out.rejected[0].reason, "NOT_UPLOADED");
});

test("publishBatchToRingcx short-circuits an empty batch without calling RingCX", async () => {
  let called = false;
  const fakeClient = { loadLeads: async () => ((called = true), {}) };
  const out = await publishBatchToRingcx(fakeClient, { campaignId: "camp1", candidates: [{ queueItemId: "q3" }] });
  assert.equal(called, false);
  assert.equal(out.supplied, 0);
});

test("publishBatchToRingcx requires a campaignId", async () => {
  await assert.rejects(() => publishBatchToRingcx({ loadLeads: async () => ({}) }, { candidates: [candidate("q1")] }), /campaignId/);
});

test("cancelBatchForSession cancels by externId, no-op on an empty set", async () => {
  const calls = [];
  const fakeClient = { leadAction: async (action, body) => (calls.push({ action, body }), { ok: true }) };
  const out = await cancelBatchForSession(fakeClient, {
    campaignId: "camp1",
    candidates: [candidate("q1"), { queueItemId: "q2", ringcx: { externId: "cxbl-tag-q2" } }, { queueItemId: "q9" /* no extern */ }],
  });
  assert.equal(out.cancelled, 2);
  assert.equal(calls[0].action, "CANCEL_LEADS");
  assert.deepEqual(calls[0].body.campaignLeadSearchCriteria.externIds, ["cxbl-tag-q1", "cxbl-tag-q2"]);

  const noop = await cancelBatchForSession(fakeClient, { campaignId: "camp1", candidates: [] });
  assert.equal(noop.cancelled, 0);
});

test("cancelBatchForSession requires campaignId before scoped cancel", async () => {
  const fakeClient = { leadAction: async () => ({ ok: true }) };
  await assert.rejects(
    () => cancelBatchForSession(fakeClient, { campaignId: "", candidates: [candidate("q1")] }),
    /campaignId/,
  );
});

// ── alpha publish-batch observability (the phantom-lead diagnostic) ──
async function capturePublish(client, input, alphaEnabled) {
  const prevEnv = process.env.CX_ALPHA_TRACE_ENABLED;
  const prevInfo = console.info;
  const logs = [];
  process.env.CX_ALPHA_TRACE_ENABLED = alphaEnabled ? "true" : "";
  console.info = (...a) => logs.push(a);
  try {
    await publishBatchToRingcx(client, input);
  } finally {
    console.info = prevInfo;
    if (prevEnv === undefined) delete process.env.CX_ALPHA_TRACE_ENABLED;
    else process.env.CX_ALPHA_TRACE_ENABLED = prevEnv;
  }
  return logs.filter((l) => l[0] === "cx.alpha.publish.batch").map((l) => l[1]);
}

test("publish logs cx.alpha.publish.batch with phantomSuspected when RingCX inserts fewer than accepted", async () => {
  const client = { loadLeads: async () => ({ processingStatus: "SUCCESS", leadsInserted: 1, rejectedRows: [] }) };
  const input = { campaignId: "camp1", candidates: [candidate("q1"), candidate("q2")] };
  const events = await capturePublish(client, input, true);
  assert.equal(events.length, 1);
  const p = events[0];
  assert.equal(p.supplied, 2);
  assert.equal(p.acceptedCount, 2);
  assert.equal(p.insertedCount, 1);
  assert.equal(p.phantomSuspected, true, "accepted 2 but RingCX inserted 1 -> phantom");
  // PII redaction: no raw phone digits in the payload
  assert.equal(JSON.stringify(p).includes("5551234567"), false, "raw phone must not leak into the alpha log");
});

test("publish alpha event is gated off by default (no CX_ALPHA_TRACE_ENABLED)", async () => {
  const client = { loadLeads: async () => ({ processingStatus: "SUCCESS", leadsInserted: 2, rejectedRows: [] }) };
  const input = { campaignId: "camp1", candidates: [candidate("q1"), candidate("q2")] };
  const off = await capturePublish(client, input, false);
  assert.equal(off.length, 0, "no alpha event when the trace flag is off");
  const on = await capturePublish(client, input, true);
  assert.equal(on[0].phantomSuspected, false, "inserted==accepted -> not phantom");
});
