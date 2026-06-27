"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyRollingSummaryToSession,
  buildRollingSummaryApplyPlan,
  buildRollingSummaryBatchRequest,
  buildRollingSummaryCursorFromApplyPlan,
  mergeAppendOnlySummary,
  parseRollingSummaryResult,
} = require("./liveCoachRollingSummaryService");

function conversation(overrides = {}) {
  return {
    sessionId: "coach-cx-1001-uii-a",
    agent: {
      email: "agent@example.com",
      extension: "1001",
    },
    call: {
      uii: "uii-a",
      callSessionId: "call-a",
      queueItemId: "queue-a",
    },
    arrays: {
      transcript: [
        { id: "t1", role: "prospect", text: "I owe the IRS and got a notice.", at: "2026-06-26T10:00:00.000Z" },
        { id: "t2", role: "agent", text: "We can review the notice and balance.", at: "2026-06-26T10:00:08.000Z" },
        { id: "p1", role: "prospect", text: "half word", provisional: true, at: "2026-06-26T10:00:09.000Z" },
        { id: "t3", role: "prospect", text: "I am worried about payment.", at: "2026-06-26T10:00:15.000Z" },
      ],
    },
    ...overrides,
  };
}

test("buildRollingSummaryBatchRequest sends final rows after cursor only", () => {
  const request = buildRollingSummaryBatchRequest(
    { conversations: [conversation()] },
    {
      generatedAt: "2026-06-26T10:01:00.000Z",
      cursor: {
        conversations: {
          "coach-cx-1001-uii-a": { lastTranscriptId: "t1" },
        },
      },
    },
  );

  assert.equal(request.calls.length, 1);
  assert.deepEqual(
    request.calls[0].rows.map((row) => row.transcriptId),
    ["t2", "t3"],
  );
  assert.equal(request.calls[0].agentEmail, "agent@example.com");
  assert.equal(request.calls[0].uii, "uii-a");
});

test("buildRollingSummaryApplyPlan rejects stale UII rows", () => {
  const parsed = parseRollingSummaryResult({
    batchId: "b1",
    summaries: [
      {
        sessionId: "coach-cx-1001-uii-a",
        uii: "uii-other",
        agentEmail: "agent@example.com",
        agentExtensionId: "1001",
        summary: [
          { sequence: 1, kind: "fact", text: "Prospect has an IRS notice.", sourceTranscriptIds: ["t1"] },
        ],
      },
    ],
  });

  const plan = buildRollingSummaryApplyPlan({ conversations: [conversation()] }, parsed);
  assert.equal(plan.applyCount, 0);
  assert.equal(plan.rejectedCount, 1);
  assert.equal(plan.rejected[0].reason, "uii-mismatch");
});

test("append-only merge preserves old entries and adds new evidence", () => {
  const merged = mergeAppendOnlySummary(
    [
      { sequence: 1, kind: "fact", text: "Original fact stays.", sourceTranscriptIds: ["t1"] },
    ],
    [
      { sequence: 1, kind: "fact", text: "Changed old fact should append, not rewrite.", sourceTranscriptIds: ["t2"] },
      { sequence: 2, kind: "objection", text: "Prospect is worried about payment.", sourceTranscriptIds: ["t3"] },
    ],
  );

  assert.deepEqual(
    merged.map((row) => row.text),
    [
      "Original fact stays.",
      "Changed old fact should append, not rewrite.",
      "Prospect is worried about payment.",
    ],
  );
  assert.deepEqual(merged.map((row) => row.sequence), [1, 2, 3]);
});

test("apply plan carries processed transcript cursor even when no new summary is added", () => {
  const activeBatch = { conversations: [conversation({ callSummary: "Original memory." })] };
  const request = buildRollingSummaryBatchRequest(activeBatch, {
    generatedAt: "2026-06-26T10:01:00.000Z",
  });
  const parsed = parseRollingSummaryResult({
    batchId: request.batchId,
    generatedAt: request.generatedAt,
    summaries: [
      {
        sessionId: "coach-cx-1001-uii-a",
        uii: "uii-a",
        agentEmail: "agent@example.com",
        agentExtensionId: "1001",
        summary: [],
      },
    ],
  });

  const plan = buildRollingSummaryApplyPlan(activeBatch, parsed, { batchRequest: request });
  const cursor = buildRollingSummaryCursorFromApplyPlan(plan);

  assert.equal(plan.applyCount, 1);
  assert.equal(plan.applies[0].payload.summary.length, 1);
  assert.equal(cursor.conversations["coach-cx-1001-uii-a"].lastTranscriptId, "t3");
});

test("cursor MERGES onto the prior cursor — a session omitted this tick keeps its place (no reprocessing)", () => {
  const prior = { conversations: { "sess-B": { lastTranscriptId: "b-9", uii: "uii-b" } } };
  const plan = {
    generatedAt: "2026-06-26T10:05:00.000Z",
    applies: [
      { target: { sessionId: "sess-A", uii: "uii-a" }, payload: { summaryCursor: { lastTranscriptId: "a-3" }, summary: [{}] } },
    ],
  };
  const cursor = buildRollingSummaryCursorFromApplyPlan(plan, { previousCursor: prior });
  assert.equal(cursor.conversations["sess-A"].lastTranscriptId, "a-3", "the summarized session advances");
  assert.equal(cursor.conversations["sess-B"].lastTranscriptId, "b-9", "the OMITTED session keeps its prior cursor (not dropped -> not reprocessed)");
});

test("cursor onlySessionIds — only written sessions advance; a skipped (e.g. terminal) session does not", () => {
  const prior = { conversations: { "sess-A": { lastTranscriptId: "a-old" } } };
  const plan = {
    generatedAt: "2026-06-26T10:06:00.000Z",
    applies: [
      { target: { sessionId: "sess-A" }, payload: { summaryCursor: { lastTranscriptId: "a-new" }, summary: [{}] } },
      { target: { sessionId: "sess-T" }, payload: { summaryCursor: { lastTranscriptId: "t-new" }, summary: [{}] } },
    ],
  };
  // sess-T was skipped by the writeback (terminal) -> not reported as written.
  const cursor = buildRollingSummaryCursorFromApplyPlan(plan, { previousCursor: prior, onlySessionIds: ["sess-A"] });
  assert.equal(cursor.conversations["sess-A"].lastTranscriptId, "a-new", "written session advances");
  assert.ok(!cursor.conversations["sess-T"], "skipped session did NOT advance (no junk cursor entry)");
});

test("writeCallSummary:false leaves session.callSummary untouched (digest owns it)", () => {
  const session = { id: "s1", latest: {}, memory: {}, callSummary: "DIGEST-OWNED" };
  applyRollingSummaryToSession(session, {
    sessionId: "s1",
    summary: [{ sequence: 1, kind: "fact", text: "x", sourceTranscriptIds: [] }],
    summaryText: "new rolling text",
  }, { mutate: true, writeCallSummary: false });
  assert.equal(session.latest.rollingSummary.summaryText, "new rolling text", "rollingSummary IS written");
  assert.equal(session.callSummary, "DIGEST-OWNED", "callSummary is NOT touched");
});

test("applyRollingSummaryToSession stores structured memory and readable callSummary", () => {
  const session = {
    id: "coach-cx-1001-uii-a",
    latest: {},
    memory: {},
  };
  const updated = applyRollingSummaryToSession(session, {
    sessionId: "coach-cx-1001-uii-a",
    uii: "uii-a",
    agentEmail: "agent@example.com",
    agentExtensionId: "1001",
    summary: [
      { sequence: 1, kind: "fact", text: "Prospect discussed an IRS notice.", sourceTranscriptIds: ["t1"] },
    ],
  });

  assert.notEqual(updated, session);
  assert.equal(updated.callSummary, "Prospect discussed an IRS notice.");
  assert.equal(updated.latest.rollingSummary.summary[0].sourceTranscriptIds[0], "t1");
  assert.equal(updated.memory.rollingSummaryHistory.length, 1);
});
