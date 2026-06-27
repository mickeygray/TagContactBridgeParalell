"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCallGradeTaskPacket,
  hasEnoughGradeEvidence,
} = require("../../packages/shared-services/src/cxNightlyCallGradeService");
const {
  buildAgentCallNoteFromCloseout,
  buildAgentCallNoteFromTerminal,
  hasGradeEvidence,
  noteKeyFrom,
} = require("../../packages/shared-services/src/cxAgentCallNoteService");

test("noteKeyFrom prefers UII, then coach session, then terminal idem key", () => {
  assert.equal(noteKeyFrom({ uii: "abc" }), "uii:abc");
  assert.equal(noteKeyFrom({ coachSessionId: "coach-1" }), "coach:coach-1");
  assert.equal(noteKeyFrom({ idemKey: "q1:u1" }), "terminal:q1:u1");
});

test("buildAgentCallNoteFromTerminal creates sparse drain note and grade gate", () => {
  const note = buildAgentCallNoteFromTerminal({
    row: { idemKey: "q1:u1", rail: "bulk_load" },
    payload: {
      domain: "wynn",
      caseId: 123,
      queueItemId: "q1",
      uii: "u1",
      outcome: "answered",
      agentEmail: "Agent@Example.com",
      agentName: "Agent Example",
      durationSec: 240,
      callSummary: "Outcome: answered. Discussed IRS balance and payment options. Next step: collect documents.",
      facts: ["balance: 25000"],
      contextKeys: ["balance", "payment_plan"],
      at: "2026-06-26T15:00:00.000Z",
    },
    terminalResult: { counted: true },
  });

  assert.equal(note.noteKey, "uii:u1");
  assert.equal(note.domain, "WYNN");
  assert.equal(note.agentEmail, "agent@example.com");
  assert.equal(note.gradeCandidate, true);
  assert.equal(note.terminalResult.counted, true);
});

test("terminal drain notes persist summary material but never carry ghost grades", () => {
  const note = buildAgentCallNoteFromTerminal({
    row: { idemKey: "q1:u1", rail: "bulk_load" },
    payload: {
      domain: "wynn",
      queueItemId: "q1",
      uii: "u1",
      outcome: "answered",
      agentEmail: "Agent@Example.com",
      durationSec: 240,
      callSummary: "Prospect discussed CP504, balance, payment ability, payroll garnishment risk, and next steps with the agent.",
      transcriptSummary: "Prospect discussed CP504, balance, payment ability, payroll garnishment risk, and next steps with the agent.",
      callGrade: { overallScore: 99, verdict: "stale inline grade" },
      rollingSummary: {
        summaryText: "Prospect has a CP504 and needs help understanding next steps.",
        summary: [
          {
            sequence: 1,
            kind: "tax_issue",
            text: "Prospect has a CP504 notice.",
            sourceTranscriptIds: ["t1"],
          },
        ],
        factsCaptured: ["CP504 notice"],
        taxIssues: ["CP504"],
        nextBestFocus: "Confirm balance and deadline.",
      },
      at: "2026-06-26T15:00:00.000Z",
    },
    terminalResult: { counted: true },
  });

  assert.equal(note.grade, null);
  assert.equal(note.gradeCandidate, true);
  assert.equal(note.metadata.rollingSummary.summary[0].text, "Prospect has a CP504 notice.");
  assert.match(note.summary, /CP504/);
  assert.match(note.transcriptSummary, /payment ability/);
});

test("terminal drain note is directly consumable by nightly grader packet", () => {
  const note = buildAgentCallNoteFromTerminal({
    row: { idemKey: "q1:u1", rail: "bulk_load" },
    payload: {
      domain: "wynn",
      caseId: 123,
      queueItemId: "q1",
      uii: "u1",
      outcome: "answered",
      agentEmail: "Agent@Example.com",
      durationSec: 300,
      callSummary: "Prospect discussed CP504, current balance, income, payment ability, and deadline concerns.",
      transcriptSummary: "Prospect discussed CP504, current balance, income, payment ability, and deadline concerns.",
      rollingSummary: {
        summaryText: "Prospect has a CP504 and wants to avoid levy action.",
        summary: [{ sequence: 1, kind: "tax_issue", text: "CP504 notice and levy worry." }],
        factsCaptured: ["CP504 notice"],
        taxIssues: ["CP504"],
        nextBestFocus: "Confirm balance and tax year.",
      },
      at: "2026-06-26T15:00:00.000Z",
    },
  });
  const packet = buildCallGradeTaskPacket(note, {
    generatedAt: "2026-06-26T18:00:00.000Z",
  });

  assert.equal(hasEnoughGradeEvidence(note, { minDurationSec: 120 }), true);
  assert.equal(packet.call.agentEmail, "agent@example.com");
  assert.equal(packet.evidence.rollingSummary.summary[0].text, "CP504 notice and levy worry.");
  assert.match(packet.evidence.transcriptSummary, /deadline concerns/);
});

test("terminal-only note is durable but not a grade candidate without summary evidence", () => {
  const note = buildAgentCallNoteFromTerminal({
    row: { idemKey: "q1:u1" },
    payload: {
      queueItemId: "q1",
      uii: "u1",
      outcome: "did_not_connect",
      durationSec: 8,
      at: "2026-06-26T15:00:00.000Z",
    },
  });

  assert.equal(note.noteKey, "uii:u1");
  assert.equal(note.gradeCandidate, false);
  assert.equal(note.gradeSkippedReason, "insufficient-call-note-evidence");
});

test("buildAgentCallNoteFromCloseout preserves transcript summary for nightly grading", () => {
  const note = buildAgentCallNoteFromCloseout({
    sessionId: "coach-1",
    createdAt: "2026-06-26T15:05:00.000Z",
    metadata: {
      domain: "TAG",
      caseId: "98765",
      agentEmail: "agent@example.com",
      agentName: "Agent Example",
      uii: "u1",
      queueItemId: "q1",
      contactName: "Test Prospect",
    },
    sparse: {
      outcome: "completed",
      durationSec: 420,
      text: "Outcome: completed\nDiscussed: CP504, balance, income, and urgency.\nNext step: send organizer.",
      nextStep: "Send organizer.",
    },
    facts: ["notice: CP504", "balance: 25000"],
    contextKeys: ["notice", "balance", "urgency"],
    metrics: { durationSec: 420, prospectCharCount: 1200, transcriptCount: 12 },
    artifactPath: "/tmp/closeout.json",
    callGrade: { grade: { overallScore: 99, verdict: "legacy inline grade" } },
  });

  assert.equal(note.noteKey, "uii:u1");
  assert.equal(note.prospectName, "Test Prospect");
  assert.equal(note.grade, null);
  assert.equal(note.gradeCandidate, true);
  assert.equal(hasGradeEvidence(note), true);
  assert.match(note.summary, /CP504/);
});
