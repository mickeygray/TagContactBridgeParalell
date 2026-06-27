"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCxCallWrapBody,
  buildCxCallWrapThreadKey,
  normalizeCxCallWrapPacket,
  writeCxCallWrapSummary,
} = require("../../packages/shared-services/src/cxCallWrapService");

function fakeCaseProfileRepository(existing = null) {
  const calls = { appended: [] };
  return {
    calls,
    findCaseProfile: async () => existing,
    appendCommunicationEntry: async (domain, caseId, channel, entry) => {
      calls.appended.push({ domain, caseId, channel, entry });
      return { _id: "case-profile-id" };
    },
  };
}

test("buildCxCallWrapThreadKey prefers UII when no explicit key is supplied", () => {
  assert.equal(buildCxCallWrapThreadKey({ uii: "abc" }), "cx-call:abc");
  assert.equal(buildCxCallWrapThreadKey({ threadKey: "manual-key", uii: "abc" }), "manual-key");
  assert.equal(buildCxCallWrapThreadKey({ coachSessionId: "coach-1" }), "live-coach:coach-1");
  assert.equal(buildCxCallWrapThreadKey({ interviewSnapshotWorkflowId: "wf-1" }), "cx-interview:wf-1");
});

test("normalizeCxCallWrapPacket carries interview and grade metadata without requiring a coach session", () => {
  const packet = normalizeCxCallWrapPacket({
    domain: "wynn",
    caseId: 123,
    uii: "uii-1",
    summary: "Talked through IRS balance.",
    snapshot: { balance: "25000", years: ["2021", "2022"] },
    grade: { overallScore: 88 },
    actor: { email: "agent@example.com", name: "Agent" },
  });
  assert.equal(packet.domain, "WYNN");
  assert.equal(packet.caseId, 123);
  assert.equal(packet.threadKey, "cx-call:uii-1");
  assert.equal(packet.actor.actorEmail, "agent@example.com");
  assert.equal(packet.interviewSnapshot.balance, "25000");
  assert.equal(packet.grade.overallScore, 88);
});

test("buildCxCallWrapBody includes summary, interview details, next step, and outcome", () => {
  const body = buildCxCallWrapBody(normalizeCxCallWrapPacket({
    summary: "Client has levy pressure.",
    nextStep: "Collect notice.",
    outcome: "answered",
    snapshot: { taxIssue: "levy", urgency: "high" },
  }));
  assert.match(body, /Client has levy pressure/);
  assert.match(body, /Interview details/);
  assert.match(body, /taxIssue: levy/);
  assert.match(body, /Next step: Collect notice/);
  assert.match(body, /Outcome: answered/);
});

test("writeCxCallWrapSummary appends one case communication and one Logics activity", async () => {
  const repo = fakeCaseProfileRepository();
  const logicsCalls = [];
  const result = await writeCxCallWrapSummary({
    domain: "TAG",
    caseId: 42,
    uii: "u1",
    phone: "555",
    summary: "Good discovery call.",
    terminalOutcome: "answered",
    actor: { email: "agent@example.com", name: "Agent" },
  }, {
    caseProfileRepository: repo,
    writeLogicsActivity: async (domain, actor, activity) => {
      logicsCalls.push({ domain, actor, activity });
      return { completed: true };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(repo.calls.appended.length, 1);
  assert.equal(repo.calls.appended[0].entry.threadKey, "cx-call:u1");
  assert.equal(repo.calls.appended[0].entry.metadata.uii, "u1");
  assert.equal(logicsCalls.length, 1);
  assert.equal(logicsCalls[0].activity.caseId, 42);
  assert.match(logicsCalls[0].activity.note, /Good discovery call/);
});

test("writeCxCallWrapSummary skips both writes when the thread key already exists", async () => {
  const repo = fakeCaseProfileRepository({
    communications: [{ threadKey: "cx-call:u1" }],
  });
  const logicsCalls = [];
  const result = await writeCxCallWrapSummary({
    domain: "TAG",
    caseId: 42,
    uii: "u1",
    summary: "Duplicate.",
  }, {
    caseProfileRepository: repo,
    writeLogicsActivity: async () => {
      logicsCalls.push("called");
      return { completed: true };
    },
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "duplicate-thread-key");
  assert.equal(repo.calls.appended.length, 0);
  assert.equal(logicsCalls.length, 0);
});

test("writeCxCallWrapSummary does not write Logics after a CaseProfile write failure", async () => {
  const logicsCalls = [];
  const result = await writeCxCallWrapSummary({
    domain: "TAG",
    caseId: 42,
    uii: "u1",
    summary: "This should stop before Logics.",
  }, {
    caseProfileRepository: {
      findCaseProfile: async () => null,
      appendCommunicationEntry: async () => {
        throw new Error("mongo down");
      },
    },
    writeLogicsActivity: async () => {
      logicsCalls.push("called");
      return { completed: true };
    },
    logger: { warn() {} },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "case-profile-write-failed");
  assert.equal(logicsCalls.length, 0);
});
