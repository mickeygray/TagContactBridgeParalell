"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyCallGradeResult,
  buildCallGradeAiTaskPayload,
  buildNightlyCallGradeEmail,
  buildCallGradePrompt,
  buildCallGradeTaskPacket,
  buildNightlyCallGradeReport,
  groupNotesByAgent,
  hasEnoughGradeEvidence,
  markCallGradeFailure,
  normalizeCallGradeResult,
  runNightlyCallGrading,
} = require("./cxNightlyCallGradeService");

function noteFixture(overrides = {}) {
  return {
    noteKey: "uii:abc123",
    uii: "abc123",
    coachSessionId: "coach-session-abc123",
    domain: "WYNN",
    caseId: 123,
    queueItemId: "queue-1",
    prospectName: "Test Prospect",
    agentEmail: "Agent@Example.com",
    agentName: "Agent One",
    agentExtensionId: "1001",
    happenedAt: "2026-06-26T20:00:00.000Z",
    durationSec: 180,
    outcome: "answered",
    source: "cx-terminal-outbox-drain",
    summary: "Prospect discussed an IRS notice and asked about payment options.",
    transcriptSummary: "Prospect discussed an IRS notice and asked about payment options.",
    nextStep: "Confirm year and balance.",
    contextKeys: ["tax_issue", "open_question"],
    facts: [{ kind: "fact", text: "IRS notice received" }],
    coachSuggestions: ["Ask for the tax year and current balance."],
    metrics: { transcriptCount: 4 },
    gradeCandidate: true,
    metadata: {
      rollingSummary: {
        summaryText: "Prospect received an IRS notice and is worried about payment.",
        summary: [
          {
            sequence: 1,
            kind: "tax_issue",
            text: "Prospect received an IRS notice.",
            sourceTranscriptIds: ["t1"],
          },
        ],
        factsCaptured: ["IRS notice received"],
        openQuestions: ["Confirm year and balance"],
        taxIssues: ["IRS notice"],
        nextBestFocus: "Confirm year and balance.",
      },
    },
    ...overrides,
  };
}

test("buildCallGradeTaskPacket carries drained note and rolling summary into Codex input", () => {
  const packet = buildCallGradeTaskPacket(noteFixture(), {
    generatedAt: "2026-06-26T21:00:00.000Z",
  });

  assert.equal(packet.taskId, "liveCoach.callGrader");
  assert.equal(packet.idempotencyKey, "call-grade:uii:abc123");
  assert.equal(packet.call.agentEmail, "agent@example.com");
  assert.equal(packet.evidence.rollingSummary.summary[0].text, "Prospect received an IRS notice.");
  assert.equal(packet.evidence.facts[0].text, "IRS notice received");
  assert.equal(hasEnoughGradeEvidence(noteFixture(), { minDurationSec: 120 }), true);
});

test("buildCallGradePrompt returns JSON-only Codex prompt around packet", () => {
  const packet = buildCallGradeTaskPacket(noteFixture());
  const prompt = buildCallGradePrompt(packet);

  assert.match(prompt.system, /Return JSON only/);
  assert.match(prompt.prompt, /cx\.nightly-call-grade-result\.v1/);
  assert.match(prompt.prompt, /uii:abc123/);
});

test("buildCallGradeAiTaskPayload maps durable note packet into canonical bus input", () => {
  const packet = buildCallGradeTaskPacket(noteFixture());
  const payload = buildCallGradeAiTaskPayload(packet);
  const input = JSON.parse(payload.input);

  assert.equal(input.metadata.noteKey, "uii:abc123");
  assert.equal(input.metadata.agentEmail, "agent@example.com");
  assert.equal(input.outcome, "answered");
  assert.match(input.sparseSummary, /IRS notice/);
  assert.deepEqual(input.contextKeys, ["tax_issue", "open_question"]);
  assert.deepEqual(input.facts, ["IRS notice received"]);
});

test("normalizeCallGradeResult validates and clamps model output", () => {
  const grade = normalizeCallGradeResult({
    overallScore: 140,
    verdict: "Good discovery, but confirm more facts.",
    scores: { rapport: 80, discovery: 90, compliance: -5 },
    whatWorked: ["Good calm opening"],
    factsCaptured: ["IRS notice"],
  });

  assert.equal(grade.overallScore, 100);
  assert.equal(grade.scores.compliance, 0);
  assert.equal(grade.whatWorked[0], "Good calm opening");
});

test("apply and failure helpers use repository markGradeStatus", async () => {
  const calls = [];
  const repository = {
    async markGradeStatus(noteKey, status, patch) {
      calls.push({ noteKey, status, patch });
      return { noteKey, status, ...patch };
    },
  };

  const applied = await applyCallGradeResult("uii:abc123", {
    verdict: "Useful call.",
    summaryForAgent: "Agent should confirm balance earlier.",
  }, repository);
  await markCallGradeFailure("uii:def456", new Error("Codex timeout"), repository);

  assert.equal(applied.status, "graded");
  assert.equal(calls[0].patch.grade.verdict, "Useful call.");
  assert.equal(calls[1].status, "failed");
  assert.equal(calls[1].patch.reason, "Codex timeout");
});

test("buildNightlyCallGradeReport summarizes packet readiness", () => {
  const report = buildNightlyCallGradeReport([
    noteFixture(),
    noteFixture({ noteKey: "uii:short", durationSec: 5, summary: "", transcriptSummary: "", facts: [] }),
  ], { minDurationSec: 120 });

  assert.equal(report.count, 2);
  assert.equal(report.eligibleCount, 1);
  assert.equal(report.rows[0].eligible, true);
  assert.equal(report.rows[1].eligible, false);
});

test("groupNotesByAgent batches by normalized agent email", () => {
  const groups = groupNotesByAgent([
    noteFixture({ noteKey: "uii:1", agentEmail: "Agent@Example.com" }),
    noteFixture({ noteKey: "uii:2", agentEmail: "agent@example.com" }),
    noteFixture({ noteKey: "uii:3", agentEmail: "other@example.com" }),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].agentEmail, "agent@example.com");
  assert.equal(groups[0].rows.length, 2);
});

test("buildNightlyCallGradeEmail summarizes a single agent batch", () => {
  const email = buildNightlyCallGradeEmail({
    agentEmail: "agent@example.com",
    generatedAt: "2026-06-26T23:00:00.000Z",
    rows: [
      {
        status: "graded",
        note: noteFixture(),
        grade: { overallScore: 88, verdict: "Strong discovery." },
      },
      {
        status: "failed",
        note: noteFixture({ noteKey: "uii:failed", prospectName: "Failed Prospect" }),
        error: "transport_timeout",
      },
    ],
  });

  assert.match(email.subject, /agent@example\.com/);
  assert.match(email.text, /Graded: 1/);
  assert.match(email.text, /Failed Prospect/);
  assert.match(email.text, /transport_timeout/);
});

test("runNightlyCallGrading filters, grades, persists, and sends one email per agent", async () => {
  const statusCalls = [];
  const aiCalls = [];
  const emails = [];
  const notes = [
    noteFixture({ noteKey: "uii:a1", agentEmail: "Agent@Example.com" }),
    noteFixture({ noteKey: "uii:a2", agentEmail: "other@example.com" }),
    noteFixture({
      noteKey: "uii:short",
      agentEmail: "other@example.com",
      durationSec: 20,
      summary: "",
      transcriptSummary: "",
      facts: [],
    }),
  ];
  const repository = {
    async listNightlyGradeCandidates(query) {
      assert.equal(query.minDurationSec, 120);
      return notes;
    },
    async markGradeStatus(noteKey, status, patch) {
      statusCalls.push({ noteKey, status, patch });
      return { noteKey, status, ...patch };
    },
  };
  const result = await runNightlyCallGrading(
    {
      generatedAt: "2026-06-26T23:00:00.000Z",
      minDurationSec: 120,
      sendEmail: true,
    },
    {
      repository,
      now: () => new Date("2026-06-26T23:00:00.000Z"),
      async runAiTask(taskId, payload) {
        aiCalls.push({ taskId, payload: JSON.parse(payload.input) });
        return {
          ok: true,
          result: {
            overallScore: 82,
            verdict: "Good call.",
            summaryForAgent: "Confirm payment ability earlier.",
          },
        };
      },
      async sendGradeEmail(email) {
        emails.push(email);
        return { ok: true };
      },
    },
  );

  assert.equal(result.agentCount, 2);
  assert.equal(result.gradedCount, 2);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.emailCount, 2);
  assert.equal(aiCalls.length, 2);
  assert.equal(aiCalls[0].taskId, "liveCoach.callGrader");
  assert.equal(aiCalls[0].payload.metadata.noteKey, "uii:a1");
  assert.ok(statusCalls.some((call) => call.noteKey === "uii:short" && call.status === "skipped"));
  assert.ok(statusCalls.some((call) => call.noteKey === "uii:a1" && call.status === "graded"));
  assert.equal(emails.length, 2);
});
