"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildActiveLiveCoachChangeSet,
  buildActiveLiveCoachBatch,
  buildConversationProjection,
  shouldIncludeSession,
} = require("../../packages/shared-services/src/liveCoachBatchProjectionService");

const NOW = Date.now();

function iso(offsetMs = 0) {
  return new Date(NOW + offsetMs).toISOString();
}

function session(overrides = {}) {
  return {
    id: "coach-1",
    status: "listening",
    createdAt: iso(-60_000),
    updatedAt: iso(-1_000),
    lastEventAt: iso(-1_000),
    metadata: {
      source: "grpc",
      agentEmail: "Agent@Example.com",
      agentName: "Agent One",
      agentExtension: "101",
      domain: "wynn",
      caseId: "123",
      queueItemId: "q1",
      uii: "u1",
      phone: "(555) 123-9876",
      contactName: "Prospect",
    },
    counters: { transcript: 2, context: 1, dialog: 1 },
    latest: {
      transcript: { id: "tr2", role: "prospect", text: "I owe the IRS.", at: iso(-1000), channel: "turn" },
      provisionalTranscript: { id: "pv1", role: "prospect", text: "and they are garnishing", at: iso(-500), provisional: true },
      context: { id: "ctx1", phraseText: "I owe the IRS.", miniJudgement: { selectedKeys: ["balance"] } },
      dialog: { id: "dlg1", say: "Ask for the balance and collection status.", at: iso(-900), status: "ready" },
      streamStatus: { status: "active", at: iso(-100) },
    },
    memory: {
      transcripts: [
        { id: "tr1", role: "agent", text: "This is Agent from Wynn Tax.", at: iso(-5000), channel: "turn" },
        { id: "tr2", role: "prospect", text: "I owe the IRS.", at: iso(-1000), channel: "turn" },
      ],
      provisionalTranscripts: [
        { id: "pv-old", role: "prospect", text: "and they", at: iso(-700), provisional: true },
      ],
      contexts: [
        { id: "ctx1", phraseText: "I owe the IRS.", matches: [{ key: "balance" }], actionReason: "tax_issue" },
      ],
      coachingSuggestions: [
        { id: "dlg1", say: "Ask for the balance and collection status.", at: iso(-900), status: "ready" },
      ],
      asks: [
        { id: "ask1", question: "What should I ask next?", answer: "Confirm balance.", at: iso(-800), status: "done" },
      ],
    },
    factLedger: {
      balance: { text: "IRS balance mentioned" },
    },
    ...overrides,
  };
}

test("shouldIncludeSession keeps live grpc-like sessions and skips terminal rows", () => {
  assert.equal(shouldIncludeSession(session()), true);
  assert.equal(shouldIncludeSession(session({ status: "released" })), false);
  assert.equal(shouldIncludeSession(session({ metadata: { source: "manual" } })), false);
});

test("buildConversationProjection returns one stable per-agent conversation with arrays", () => {
  const projected = buildConversationProjection(session(), {
    maxTranscriptRows: 10,
    maxProvisionalRows: 10,
  });
  assert.equal(projected.sessionId, "coach-1");
  assert.equal(projected.agent.email, "agent@example.com");
  assert.equal(projected.call.domain, "WYNN");
  assert.equal(projected.call.phoneLast4, "9876");
  assert.equal(projected.arrays.transcript.length, 2);
  assert.equal(projected.arrays.provisionalTranscript.length, 2);
  assert.equal(projected.arrays.context[0].selectedKeys[0], "balance");
  assert.equal(projected.arrays.guidance[0].say, "Ask for the balance and collection status.");
  assert.equal(projected.arrays.asks[0].answer, "Confirm balance.");
  assert.equal(projected.arrays.facts[0].key, "balance");
});

test("buildActiveLiveCoachBatch filters, sorts, and caps active conversations", () => {
  const newer = session({ id: "newer", updatedAt: iso(-100), lastEventAt: iso(-100) });
  const older = session({ id: "older", updatedAt: iso(-5000), lastEventAt: iso(-5000) });
  const terminal = session({ id: "terminal", status: "stale" });
  const batch = buildActiveLiveCoachBatch([older, terminal, newer], {
    maxSessions: 1,
    maxTranscriptRows: 1,
  });
  assert.equal(batch.schemaVersion, "live-coach.active-conversation-batch.v1");
  assert.equal(batch.activeConversationCount, 1);
  assert.equal(batch.conversations[0].sessionId, "newer");
  assert.equal(batch.conversations[0].arrays.transcript.length, 1);
});

test("requireSignal can suppress empty shell sessions", () => {
  const empty = session({
    latest: {},
    memory: {},
    counters: {},
  });
  assert.equal(shouldIncludeSession(empty, { requireSignal: true }), false);
  const batch = buildActiveLiveCoachBatch([empty], { requireSignal: true });
  assert.equal(batch.activeConversationCount, 0);
});

test("buildActiveLiveCoachChangeSet returns all active conversations on first tick", () => {
  const delta = buildActiveLiveCoachChangeSet([session()], { maxTranscriptRows: 10 });
  assert.equal(delta.schemaVersion, "live-coach.active-conversation-changes.v1");
  assert.equal(delta.hasChanges, true);
  assert.equal(delta.changedConversationCount, 1);
  assert.equal(delta.changedConversations[0].change.reason, "new-active-conversation");
  assert.ok(delta.cursor.conversations["coach-1"].signature);
});

test("buildActiveLiveCoachChangeSet returns no changed conversations for identical cursor", () => {
  const first = buildActiveLiveCoachChangeSet([session()], { maxTranscriptRows: 10 });
  const second = buildActiveLiveCoachChangeSet([session()], {
    maxTranscriptRows: 10,
    cursor: first.cursor,
  });
  assert.equal(second.hasChanges, false);
  assert.equal(second.changedConversationCount, 0);
  assert.equal(second.unchangedConversationCount, 1);
});

test("buildActiveLiveCoachChangeSet sends only changed conversations when transcript moves", () => {
  const firstSession = session({ id: "coach-delta" });
  const first = buildActiveLiveCoachChangeSet([firstSession], { maxTranscriptRows: 10 });
  const changedSession = session({
    id: "coach-delta",
    updatedAt: iso(-50),
    lastEventAt: iso(-50),
    latest: {
      ...firstSession.latest,
      transcript: { id: "tr3", role: "prospect", text: "I also have a levy.", at: iso(-50), channel: "turn" },
    },
    memory: {
      ...firstSession.memory,
      transcripts: [
        ...firstSession.memory.transcripts,
        { id: "tr3", role: "prospect", text: "I also have a levy.", at: iso(-50), channel: "turn" },
      ],
    },
  });
  const second = buildActiveLiveCoachChangeSet([changedSession], {
    maxTranscriptRows: 10,
    cursor: first.cursor,
  });
  assert.equal(second.hasChanges, true);
  assert.equal(second.changedConversationCount, 1);
  assert.equal(second.changedConversations[0].change.reason, "conversation-updated");
  assert.equal(second.changedConversations[0].arrays.transcript.at(-1).id, "tr3");
});

test("buildActiveLiveCoachChangeSet reports ended conversations outside model changes", () => {
  const first = buildActiveLiveCoachChangeSet([session()], { maxTranscriptRows: 10 });
  const second = buildActiveLiveCoachChangeSet([], { cursor: first.cursor });
  assert.equal(second.hasChanges, false);
  assert.equal(second.changedConversationCount, 0);
  assert.equal(second.endedConversationCount, 1);
  assert.equal(second.endedConversations[0].sessionId, "coach-1");
});
