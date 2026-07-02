"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CX_CADENCE_EVENT_TYPES,
  buildTerminalAttemptProofPatch,
  classifyCxTerminalOutcome,
  isBulkLoadOwnedCxQueueItem,
} = require("../../packages/shared-services/src/cxCadenceService");
const {
  buildTerminalOutcomePayload,
} = require("../../packages/shared-services/src/ringcxAgentMonitorService");

test("classifyCxTerminalOutcome only advances explicit no-answer outcomes", () => {
  const result = classifyCxTerminalOutcome({ result: "No Answer" });

  assert.equal(result.safeToAdvance, true);
  assert.equal(result.normalizedOutcome, "did_not_connect");
});

test("classifyCxTerminalOutcome advances explicit voicemail outcomes", () => {
  const result = classifyCxTerminalOutcome({ callOutcome: "LEFT_VOICEMAIL" });

  assert.equal(result.safeToAdvance, true);
  assert.equal(result.normalizedOutcome, "voicemail");
});

test("classifyCxTerminalOutcome reads nested final-call records", () => {
  const result = classifyCxTerminalOutcome({ record: { result: "did not connect" } });

  assert.equal(result.safeToAdvance, true);
  assert.equal(result.normalizedOutcome, "did_not_connect");
});

test("classifyCxTerminalOutcome refuses ambiguous call-ended outcomes", () => {
  for (const value of ["completed", "call ended", "ended", "connected", "busy", "unknown"]) {
    const result = classifyCxTerminalOutcome({ status: value });
    assert.equal(result.safeToAdvance, false, value);
    assert.equal(result.normalizedOutcome, null, value);
  }
});

test("classifyCxTerminalOutcome does not confuse no-voicemail-box with voicemail", () => {
  const result = classifyCxTerminalOutcome({ reason: "No voicemail box" });

  assert.equal(result.safeToAdvance, false);
  assert.equal(result.normalizedOutcome, null);
});

test("classifyCxTerminalOutcome only trusts answered from bulk manual disposition", () => {
  const generic = classifyCxTerminalOutcome({ status: "answered" });
  assert.equal(generic.safeToAdvance, false);
  assert.equal(generic.normalizedOutcome, null);

  const bulk = classifyCxTerminalOutcome({
    sourceService: "cx-bulk-load",
    outcome: "answered",
  });
  assert.equal(bulk.safeToAdvance, true);
  assert.equal(bulk.normalizedOutcome, "answered");
});

test("classifyCxTerminalOutcome only trusts DNC from bulk manual disposition", () => {
  const generic = classifyCxTerminalOutcome({ result: "DNC" });
  assert.equal(generic.safeToAdvance, false);
  assert.equal(generic.normalizedOutcome, null);

  const bulk = classifyCxTerminalOutcome({
    sourceService: "cx-bulk-load",
    disposition: "DNC",
  });
  assert.equal(bulk.safeToAdvance, true);
  assert.equal(bulk.normalizedOutcome, "dnc");
});

test("CX terminal outcome event type is registered", () => {
  assert.equal(CX_CADENCE_EVENT_TYPES.CALL_TERMINAL_OUTCOME, "cx.call.terminal-outcome");
});

test("bulk-owned CX queue rows are identifiable before legacy release paths mutate them", () => {
  assert.equal(isBulkLoadOwnedCxQueueItem({ metadata: { reservationRail: "bulk_load" } }), true);
  assert.equal(isBulkLoadOwnedCxQueueItem({ metadata: { bulkLoadSessionId: "cxbl-1" } }), true);
  assert.equal(isBulkLoadOwnedCxQueueItem({ metadata: { reservationRail: "legacy" } }), false);
  assert.equal(isBulkLoadOwnedCxQueueItem({ metadata: {} }), false);
});

test("bulk terminal attempt proof counts only UII-backed bulk terminal events", () => {
  const queueItem = {
    placedCalls: 0,
    dailyPlacedCalls: 0,
    monthlyPlacedCalls: 0,
  };
  const placedAt = new Date("2026-06-29T16:00:00.000Z");
  const counted = buildTerminalAttemptProofPatch(queueItem, {
    sourceService: "cx-bulk-load",
    uii: "uii-1",
  }, placedAt);

  assert.equal(counted.countable, true);
  assert.equal(counted.terminalUii, "uii-1");
  assert.equal(counted.queuePatch.placedCalls, 1);
  assert.equal(counted.queuePatch.lastPlacedAt, placedAt);

  const legacy = buildTerminalAttemptProofPatch(queueItem, {
    sourceService: "ringcx-agent-monitor",
    uii: "uii-1",
  }, placedAt);
  assert.equal(legacy.countable, false);
  assert.deepEqual(legacy.queuePatch, {});

  const noUii = buildTerminalAttemptProofPatch(queueItem, {
    sourceService: "cx-bulk-load",
  }, placedAt);
  assert.equal(noUii.countable, false);
  assert.deepEqual(noUii.queuePatch, {});
});

test("bulk terminal attempt proof is idempotent: the same UII is never counted twice", () => {
  const placedAt = new Date("2026-06-29T16:00:00.000Z");
  // First terminal for uii-1 counts (0 -> 1).
  const first = buildTerminalAttemptProofPatch(
    { placedCalls: 0, dailyPlacedCalls: 0 },
    { sourceService: "cx-bulk-load", uii: "uii-1" },
    placedAt,
  );
  assert.equal(first.countable, true);
  assert.equal(first.queuePatch.placedCalls, 1);

  // An outbox REPLAY (or the review-dnc lane) of the SAME uii on a row that already recorded it is
  // suppressed -> no second +1.
  const replay = buildTerminalAttemptProofPatch(
    { placedCalls: 1, dailyPlacedCalls: 1, metadata: { lastTerminalAttemptCountedUii: "uii-1" } },
    { sourceService: "cx-bulk-load", uii: "uii-1" },
    placedAt,
  );
  assert.equal(replay.countable, false);
  assert.equal(replay.alreadyCounted, true);
  assert.deepEqual(replay.queuePatch, {});

  // A genuinely DIFFERENT dial (new uii) on the same row still counts (1 -> 2).
  const nextDial = buildTerminalAttemptProofPatch(
    { placedCalls: 1, dailyPlacedCalls: 1, metadata: { lastTerminalAttemptCountedUii: "uii-1" } },
    { sourceService: "cx-bulk-load", uii: "uii-2" },
    placedAt,
  );
  assert.equal(nextDial.countable, true);
  assert.equal(nextDial.queuePatch.placedCalls, 2);
});

test("RingCX monitor payload can feed terminal outcome classification", () => {
  const payload = buildTerminalOutcomePayload(
    {
      _id: "queue-1",
      domain: "WYNN",
      caseId: 123,
      phone: "3106665997",
      assignment: { extensionId: "5877", agentName: "Mickey Gray" },
      metadata: { actionKey: "cx-1" },
    },
    {
      uii: "uii-1",
      result: "NOANSWER",
      destinationPhone: "3106665997",
    },
    new Date("2026-05-12T17:00:00.000Z"),
  );
  const result = classifyCxTerminalOutcome(payload);

  assert.equal(payload.queueItemId, "queue-1");
  assert.equal(payload.caseId, 123);
  assert.equal(payload.assignedExtensionId, "5877");
  assert.equal(result.safeToAdvance, true);
  assert.equal(result.normalizedOutcome, "did_not_connect");
});
