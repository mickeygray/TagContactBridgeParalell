"use strict";

// Null-safety of the batch projector against a real/persisted session shape.
// The live in-process loop never stores null rows (pushMemory refuses falsy), but
// the projector is exported and may run over a persisted/external snapshot whose
// JSON carries a null element or null latest.* field. It must not throw.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildActiveLiveCoachBatch,
  buildConversationProjection,
} = require("../../packages/shared-services/src/liveCoachBatchProjectionService");

function snapshotSession(extra = {}) {
  const now = new Date().toISOString();
  return {
    id: "coach-snap",
    status: "listening",
    lastEventAt: now,
    updatedAt: now,
    metadata: { source: "grpc-mongo", agentEmail: "sean@tag.com", uii: "uii-snap", domain: "WYNN" },
    // Fresh-session latest: every field null (what startSession initializes).
    latest: { transcript: null, provisionalTranscript: null, context: null, dialog: null, streamStatus: null },
    memory: { transcripts: [], provisionalTranscripts: [], contexts: [], coachingSuggestions: [], asks: [], facts: [] },
    ...extra,
  };
}

test("projection survives null latest.* fields on a fresh session", () => {
  const conv = buildConversationProjection(snapshotSession());
  assert.equal(conv.sessionId, "coach-snap");
  assert.equal(conv.latest.transcript, null);
  assert.equal(conv.latest.provisionalTranscript, null);
});

test("projection survives null ELEMENTS in every memory array (would crash before the cleanArray fix)", () => {
  const session = snapshotSession({
    memory: {
      transcripts: [null, { role: "prospect", text: "real turn" }],
      provisionalTranscripts: [null],
      contexts: [null, { phraseText: "hi" }],
      coachingSuggestions: [null, { say: "go" }],
      asks: [null, { question: "q?", answer: "a" }],
      facts: [],
    },
  });
  // Must not throw, and must drop the nulls while keeping the real rows.
  const conv = buildConversationProjection(session);
  assert.equal(conv.arrays.transcript.length, 1, "null transcript row dropped, real kept");
  assert.equal(conv.arrays.context.length, 1);
  assert.equal(conv.arrays.guidance.length, 1);
  assert.equal(conv.arrays.asks.length, 1);

  // Same through the full batch entry point.
  const batch = buildActiveLiveCoachBatch([session]);
  assert.equal(batch.activeConversationCount, 1);
});
