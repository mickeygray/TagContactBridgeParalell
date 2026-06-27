"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  enrichPayloadWithRollingSummary,
  enrichTerminalPacketWithCoachSummary,
} = require("./cxTerminalCoachSummaryBridge");

const rollingSummary = {
  sessionId: "coach-session-1",
  uii: "uii-1",
  agentEmail: "agent@example.com",
  agentExtensionId: "1001",
  summary: [
    {
      sequence: 1,
      kind: "fact",
      text: "Prospect said they received an IRS notice.",
      sourceTranscriptIds: ["t1"],
    },
    {
      sequence: 2,
      kind: "open_question",
      text: "Agent still needs to confirm balance and year.",
      sourceTranscriptIds: ["t2"],
    },
  ],
  factsCaptured: ["IRS notice received"],
  openQuestions: ["Confirm balance and year"],
  taxIssues: ["IRS notice"],
  nextBestFocus: "Confirm year and balance.",
};

test("enrichPayloadWithRollingSummary maps object memory into terminal payload fields", () => {
  const result = enrichPayloadWithRollingSummary(
    {
      domain: "WYNN",
      caseId: 123,
      uii: "uii-1",
      agentEmail: "agent@example.com",
    },
    { rollingSummary },
  );

  assert.equal(result.enriched, true);
  assert.equal(result.payload.callSummary.includes("IRS notice"), true);
  assert.equal(result.payload.transcriptSummary.includes("IRS notice"), true);
  assert.equal(result.payload.nextStep, "Confirm year and balance.");
  assert.equal(result.payload.rollingSummary.summary.length, 2);
  assert.equal(result.payload.contextKeys.includes("tax_issue"), true);
  assert.equal(result.payload.facts[0].kind, "fact");
});

test("enrichTerminalPacketWithCoachSummary can load summary by coachSessionId", async () => {
  const fakeModel = {
    findById(id) {
      assert.equal(id, "coach-session-1");
      return {
        lean() {
          return {
            exec: async () => ({
              _id: "coach-session-1",
              latest: { rollingSummary },
              memory: {},
            }),
          };
        },
      };
    },
  };

  const packet = await enrichTerminalPacketWithCoachSummary(
    {
      row: { idemKey: "queue:uii-1" },
      payload: {
        coachSessionId: "coach-session-1",
        domain: "WYNN",
        caseId: 123,
        uii: "uii-1",
      },
    },
    { LiveCoachSession: fakeModel },
  );

  assert.equal(packet.coachSummary.skipped, false);
  assert.equal(packet.coachSummary.source, "livecoach_sessions");
  assert.equal(packet.payload.callSummary.includes("IRS notice"), true);
  assert.equal(packet.payload.metadata.rollingSummary.summaryLength, 2);
});
