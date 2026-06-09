"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  createLiveCoachMongoPersistence,
} = require("../../packages/shared-services/src/liveCoachPersistenceService");

function chainReturning(docs) {
  const chain = {
    sort() { return chain; },
    limit() { return chain; },
    lean() { return chain; },
    exec: async () => docs,
  };
  return chain;
}

test("loadPriorCallSummaries queries by caseId, excludes current session, returns a compact summary", async () => {
  let captured = null;
  const docs = [{
    _id: "coach-prior-1",
    sessionId: "coach-prior-1",
    status: "stopped",
    lastPersistedAt: new Date(),
    sessionUpdatedAt: new Date().toISOString(),
    memory: {
      contexts: [{ matches: [{ key: "irs_notice" }, { key: "collection_pressure" }] }],
      coachingSuggestions: [{ say: "Ask which notice and year they are holding." }],
      transcripts: [{ role: "prospect", text: "I got a CP504 about a balance." }],
    },
  }];
  const LiveCoachSession = { find: (q) => { captured = q; return chainReturning(docs); } };
  const p = createLiveCoachMongoPersistence({ LiveCoachSession });

  const out = await p.loadPriorCallSummaries({ caseId: "12345", excludeSessionId: "coach-current" });
  assert.ok(captured.$or.some((c) => c["metadata.caseId"] === "12345"));
  assert.deepEqual(captured._id, { $ne: "coach-current" });
  assert.equal(out.length, 1);
  assert.ok(out[0].issues.includes("irs_notice"));
  assert.ok(out[0].issues.includes("collection_pressure"));
  assert.match(out[0].lastCoachLine, /which notice/);
  assert.match(out[0].lastProspectLine, /CP504/);
  assert.equal(out[0].status, "stopped");
});

test("loadPriorCallSummaries makes NO query and returns [] without caseId/phone", async () => {
  let called = false;
  const LiveCoachSession = { find: () => { called = true; return chainReturning([]); } };
  const p = createLiveCoachMongoPersistence({ LiveCoachSession });
  const out = await p.loadPriorCallSummaries({});
  assert.equal(called, false);
  assert.equal(out.length, 0);
});

test("loadPriorCallSummaries queries phone (digits only) and filters out empty summaries", async () => {
  let captured = null;
  const LiveCoachSession = { find: (q) => { captured = q; return chainReturning([{ _id: "empty", status: "listening", memory: {} }]); } };
  const p = createLiveCoachMongoPersistence({ LiveCoachSession });
  const out = await p.loadPriorCallSummaries({ phone: "(310) 555-1234" });
  assert.ok(captured.$or.some((c) => c["metadata.phone"] === "3105551234"));
  assert.equal(out.length, 0, "a prior call with no issues/coach/prospect content is dropped");
});

test("loadPriorCallSummaries never throws on a model error (returns [])", async () => {
  const LiveCoachSession = { find: () => { throw new Error("db down"); } };
  const p = createLiveCoachMongoPersistence({ LiveCoachSession });
  const out = await p.loadPriorCallSummaries({ caseId: "9" });
  assert.equal(out.length, 0);
});
