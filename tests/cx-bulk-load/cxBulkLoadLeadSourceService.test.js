"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildExternId,
  buildExternSessionToken,
  isQueueRowContactable,
  normalizeQueueRows,
  excludeSessionCandidates,
  snapshotCandidates,
} = require("../../packages/shared-services/src/cxBulkLoadLeadSourceService");

// ── buildExternId ───────────────────────────────────────────────────────
test("buildExternId is deterministic, tenant-disjoint, and null without a queueItemId", () => {
  assert.equal(buildExternSessionToken("cxbl-ac467317-1208-4304-9303-0a763e1db836"), "0a763e1db836");
  assert.equal(buildExternId({ domain: "TAG", queueItemId: "q1", sessionId: "cxbl-ac467317-1208-4304-9303-0a763e1db836" }), "cxbl-tag-0a763e1db836-q1");
  assert.equal(buildExternId({ domain: "WYNN", queueItemId: "q1", sessionId: "cxbl-ac467317-1208-4304-9303-0a763e1db836" }), "cxbl-wynn-0a763e1db836-q1");
  assert.equal(buildExternId({ domain: "TAG", queueItemId: "q1", sessionId: "s1" }), buildExternId({ domain: "TAG", queueItemId: "q1", sessionId: "s1" }));
  assert.equal(buildExternId({ domain: "TAG", queueItemId: "q1" }), "cxbl-tag-q1");
  assert.equal(buildExternId({ domain: "TAG" }), null);
});

// ── normalizeQueueRows ──────────────────────────────────────────────────
test("normalizeQueueRows maps rows to drafts (with externId + phoneLast4) and drops id-less rows", () => {
  const drafts = normalizeQueueRows([
    { _id: "q1", domain: "tag", caseId: 42, leadPhone: "(555) 123-4567", name: "Jane" },
    { caseId: 99 }, // no id -> dropped
  ]);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0], {
    queueItemId: "q1",
    domain: "TAG",
    caseId: 42,
    name: "Jane",
    phone: "5551234567",
    phoneLast4: "4567",
    externId: "cxbl-tag-q1",
  });
});

// ── excludeSessionCandidates ────────────────────────────────────────────
test("normalizeQueueRows drops obvious client/DNC/contact-blocked rows before they become candidates", () => {
  assert.equal(isQueueRowContactable({ _id: "ok", caseProfile: { statusCategory: "prospect" } }), true);
  assert.equal(isQueueRowContactable({ _id: "client", caseProfile: { statusCategory: "client" } }), false);
  assert.equal(isQueueRowContactable({ _id: "dnc", metadata: { reflectedLogicsStatusCategory: "dnc" } }), false);

  const drafts = normalizeQueueRows([
    { _id: "q1", domain: "TAG", caseId: 1, phone: "5551111000", name: "Prospect", caseProfile: { statusCategory: "prospect" } },
    { _id: "q2", domain: "TAG", caseId: 2, phone: "5551111001", name: "Client", caseProfile: { statusCategory: "client" } },
    { _id: "q3", domain: "TAG", caseId: 3, phone: "5551111002", name: "DNC", statusCategory: "dnc" },
    { _id: "q4", domain: "TAG", caseId: 4, phone: "5551111003", name: "Blocked", metadata: { statusCategory: "contact blocked" } },
  ]);
  assert.deepEqual(drafts.map((d) => d.queueItemId), ["q1"]);
});

test("excludeSessionCandidates removes ids already in buffer/current/completed", () => {
  const session = {
    acceptedBuffer: [{ queueItemId: "q1" }],
    current: { queueItemId: "q2" },
    completed: [{ queueItemId: "q3" }],
  };
  const drafts = [{ queueItemId: "q1" }, { queueItemId: "q2" }, { queueItemId: "q3" }, { queueItemId: "q4" }];
  const out = excludeSessionCandidates(drafts, session);
  assert.deepEqual(out.map((d) => d.queueItemId), ["q4"]);
});

// ── snapshotCandidates (read-only, injected reader) ─────────────────────
test("snapshotCandidates reads, normalizes, excludes, and caps to maxItems", async () => {
  const calls = [];
  const deps = {
    listReadyQueueItems: async (q) => {
      calls.push(q);
      return [
        { _id: "q1", domain: "TAG", caseId: 1 },
        { _id: "q2", domain: "TAG", caseId: 2 },
        { _id: "q3", domain: "TAG", caseId: 3 },
      ];
    },
  };
  const out = await snapshotCandidates(deps, {
    agentEmail: "a@x.com",
    agentExtensionId: "101",
    maxItems: 2,
    session: { acceptedBuffer: [{ queueItemId: "q1" }] }, // q1 already in session
  });
  assert.deepEqual(out.map((d) => d.queueItemId), ["q2", "q3"].slice(0, 2));
  assert.equal(calls[0].agentEmail, "a@x.com");
  assert.equal(calls[0].agentExtensionId, "101");
  assert.equal(calls[0].limit, 2);
});

test("snapshotCandidates forwards agent extension to the read-only queue reader", async () => {
  const calls = [];
  const deps = {
    listReadyQueueItems: async (query) => {
      calls.push(query);
      return [{ _id: "q1", domain: "TAG", caseId: 1 }];
    },
  };
  const out = await snapshotCandidates(deps, {
    agentEmail: "agent@example.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    maxItems: 1,
    session: {},
  });
  assert.equal(out.length, 1);
  assert.deepEqual(calls[0], {
    agentEmail: "agent@example.com",
    agentExtensionId: "63914587001",
    domain: "TAG",
    limit: 1,
  });
});

test("snapshotCandidates refuses to run without a read-only reader", async () => {
  await assert.rejects(() => snapshotCandidates({}, {}), /read-only deps.listReadyQueueItems/);
});
