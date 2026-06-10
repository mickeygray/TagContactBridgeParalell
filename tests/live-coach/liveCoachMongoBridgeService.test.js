"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalAgentEmail,
  createLiveCoachMongoBridge,
  eventMatchesFilters,
  normalizeCoachCallEvent,
} = require("../../packages/shared-services/src/liveCoachMongoBridgeService");

function makeFindChain(rows, single = false) {
  let current = rows.slice();
  return {
    sort() {
      return this;
    },
    limit(value) {
      current = current.slice(0, value);
      return this;
    },
    lean() {
      return Promise.resolve(single ? current[0] || null : current);
    },
  };
}

function getPath(input, path) {
  const parts = String(path || "").split(".");
  let cursor = input;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function matchesQuery(row, query) {
  return Object.entries(query || {}).every(([key, expected]) => {
    const actual = getPath(row, key);
    if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
      return expected.$in.includes(actual);
    }
    return String(actual ?? "") === String(expected ?? "");
  });
}

function makeModel(rows = []) {
  return {
    find(query) {
      return makeFindChain(rows.filter((row) => matchesQuery(row, query)));
    },
    findOne(query) {
      return makeFindChain(rows.filter((row) => matchesQuery(row, query)).slice(0, 1), true);
    },
    findById(id) {
      return makeFindChain(
        rows.filter((row) => String(row._id || row.id || "") === String(id)).slice(0, 1),
        true,
      );
    },
  };
}

test("normalizes cx.call.placed payload into coach binding fields", () => {
  const event = normalizeCoachCallEvent({
    _id: "event-1",
    eventType: "cx.call.placed",
    sourceService: "ringcentral-cx",
    aggregateType: "case",
    aggregateId: "124930",
    createdAt: "2026-06-04T17:03:48.752Z",
    payload: {
      queueItemId: "6a21351c05a598ee27c926a2",
      caseId: 124930,
      extensionId: "4545",
      agentEmail: "CBolt@taxadvocategroup.com",
      agentName: "Chris Bolt",
      phone: "(310) 555-1000",
      uii: "202606041703487520000174567278",
    },
  });

  assert.equal(event.id, "event-1");
  assert.equal(event.queueItemId, "6a21351c05a598ee27c926a2");
  assert.equal(event.caseId, "124930");
  assert.equal(event.extensionId, "4545");
  assert.equal(event.agentEmail, "cbolt@taxadvocategroup.com");
  assert.equal(event.phone, "3105551000");
  assert.equal(event.uii, "202606041703487520000174567278");
});

test("matches events by exact UII and agent identity", () => {
  const event = {
    uii: "uii-1",
    callSessionId: "session-1",
    extensionId: "4545",
    agentEmail: "cbolt+50810001_8283@taxadvocategroup.com",
  };

  assert.equal(canonicalAgentEmail("cbolt+50810001_8283@taxadvocategroup.com"), "cbolt@taxadvocategroup.com");
  assert.equal(eventMatchesFilters(event, { uii: "uii-1" }), true);
  assert.equal(eventMatchesFilters(event, { callSessionId: "session-1" }), true);
  assert.equal(eventMatchesFilters(event, { agentExtensionId: "4545" }), true);
  assert.equal(eventMatchesFilters(event, { agentEmail: "CBOLT@taxadvocategroup.com" }), true);
  assert.equal(eventMatchesFilters(event, { agentExtensionId: "4545", agentEmail: "cbolt@taxadvocategroup.com" }), true);
  assert.equal(eventMatchesFilters(event, { uii: "uii-2" }), false);
  assert.equal(eventMatchesFilters(event, { callSessionId: "session-2" }), false);
  assert.equal(eventMatchesFilters(event, { agentExtensionId: "3344" }), false);
  assert.equal(eventMatchesFilters(event, { agentEmail: "bhansen@taxadvocategroup.com" }), false);
});

test("resolves active binding and enriches from CallSession", async () => {
  const nowMs = Date.parse("2026-06-04T17:05:00.000Z");
  const EventRecord = makeModel([
    {
      _id: "event-1",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      aggregateType: "case",
      aggregateId: "124930",
      createdAt: "2026-06-04T17:03:48.752Z",
      payload: {
        queueItemId: "6a21351c05a598ee27c926a2",
        caseId: 124930,
        extensionId: "4545",
        agentEmail: "cbolt@taxadvocategroup.com",
        agentName: "Chris Bolt",
        uii: "uii-active",
      },
    },
  ]);
  const CallSession = makeModel([
    {
      _id: "665555555555555555555555",
      state: "connected",
      agentId: "4545",
      agentEmail: "cbolt@taxadvocategroup.com",
      agentName: "Chris Bolt",
      queueItemId: "6a21351c05a598ee27c926a2",
      domain: "TAG",
      logicsCaseId: "124930",
      contactName: "Jane Doe",
      phoneNumber: "3105551000",
      rcxUii: "uii-active",
      startedAt: "2026-06-04T17:03:48.000Z",
    },
  ]);
  const WorkflowRecord = makeModel([]);
  const bridge = createLiveCoachMongoBridge({
    EventRecord,
    CallSession,
    WorkflowRecord,
    now: () => nowMs,
  });

  const result = await bridge.resolveCoachBinding({ agentExtensionId: "4545" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(result.binding.active, true);
  assert.equal(result.binding.metadata.agentExtension, "4545");
  assert.equal(result.binding.metadata.contactName, "Jane Doe");
  assert.equal(result.binding.metadata.phone, "3105551000");
  assert.match(result.binding.sessionId, /^coach-cx-4545-/);
});

test("closed disposition-hangup marks binding inactive", async () => {
  const EventRecord = makeModel([
    {
      _id: "event-closed",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      aggregateType: "case",
      aggregateId: "124930",
      createdAt: "2026-06-04T17:03:48.752Z",
      payload: {
        queueItemId: "6a21351c05a598ee27c926a2",
        extensionId: "4545",
        uii: "uii-closed",
      },
    },
  ]);
  const CallSession = makeModel([]);
  const WorkflowRecord = makeModel([
    {
      _id: "workflow-1",
      family: "cx",
      subtype: "disposition-hangup",
      stage: "completed",
      aggregateType: "dial-request",
      aggregateId: "6a21351c05a598ee27c926a2",
      happenedAt: "2026-06-04T17:04:10.000Z",
      summary: "Ended CX call after no answer",
    },
  ]);
  const bridge = createLiveCoachMongoBridge({
    EventRecord,
    CallSession,
    WorkflowRecord,
    now: () => Date.parse("2026-06-04T17:05:00.000Z"),
  });

  const result = await bridge.resolveCoachBinding({ agentExtensionId: "4545" });

  assert.equal(result.status, "closed");
  assert.equal(result.binding.active, false);
  assert.equal(result.binding.reason, "disposition-hangup");
  assert.equal(result.binding.close.aggregateId, "6a21351c05a598ee27c926a2");
});

test("agent-current resolver rejects old uii when a newer agent call exists", async () => {
  const EventRecord = makeModel([
    {
      _id: "event-new",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      createdAt: "2026-06-04T17:06:00.000Z",
      payload: {
        queueItemId: "new-queue",
        extensionId: "4545",
        uii: "uii-new",
      },
    },
    {
      _id: "event-old",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      createdAt: "2026-06-04T17:03:00.000Z",
      payload: {
        queueItemId: "old-queue",
        extensionId: "4545",
        uii: "uii-old",
      },
    },
  ]);
  const bridge = createLiveCoachMongoBridge({
    EventRecord,
    CallSession: makeModel([]),
    WorkflowRecord: makeModel([]),
    now: () => Date.parse("2026-06-04T17:07:00.000Z"),
  });

  const result = await bridge.resolveCoachBinding({
    agentExtensionId: "4545",
    uii: "uii-old",
  });

  assert.equal(result.status, "not_current");
  assert.equal(result.active, false);
  assert.equal(result.binding.reason, "agent-current-uii-mismatch");
  assert.equal(result.binding.event.uii, "uii-new");
});

test("agent-current resolver can bind latest event even when stream supplies current uii", async () => {
  const EventRecord = makeModel([
    {
      _id: "event-new",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      createdAt: "2026-06-04T17:06:00.000Z",
      payload: {
        queueItemId: "new-queue",
        extensionId: "4545",
        uii: "uii-new",
      },
    },
  ]);
  const bridge = createLiveCoachMongoBridge({
    EventRecord,
    CallSession: makeModel([]),
    WorkflowRecord: makeModel([]),
    now: () => Date.parse("2026-06-04T17:07:00.000Z"),
  });

  const result = await bridge.resolveCoachBinding({
    agentExtensionId: "4545",
    uii: "uii-new",
  });

  assert.equal(result.status, "active");
  assert.equal(result.binding.active, true);
  assert.equal(result.binding.metadata.uii, "uii-new");
});

test("agent-current resolver rejects old call session when a newer agent call exists", async () => {
  const EventRecord = makeModel([
    {
      _id: "event-new-session",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      createdAt: "2026-06-04T17:06:00.000Z",
      payload: {
        queueItemId: "new-queue",
        extensionId: "4545",
        callSessionId: "session-new",
      },
    },
    {
      _id: "event-old-session",
      eventType: "cx.call.placed",
      sourceService: "ringcentral-cx",
      createdAt: "2026-06-04T17:03:00.000Z",
      payload: {
        queueItemId: "old-queue",
        extensionId: "4545",
        callSessionId: "session-old",
      },
    },
  ]);
  const bridge = createLiveCoachMongoBridge({
    EventRecord,
    CallSession: makeModel([]),
    WorkflowRecord: makeModel([]),
    now: () => Date.parse("2026-06-04T17:07:00.000Z"),
  });

  const result = await bridge.resolveCoachBinding({
    agentExtensionId: "4545",
    callSessionId: "session-old",
  });

  assert.equal(result.status, "not_current");
  assert.equal(result.active, false);
  assert.equal(result.binding.reason, "agent-current-call-session-mismatch");
  assert.equal(result.binding.event.callSessionId, "session-new");
});
