"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  hasSubstantiveCloseoutEvidence,
  shouldSendManagerOutlierEmail,
} = require("../../packages/shared-services/src/liveCoachCloseoutService");

test("duration alone is not substantive evidence for grading/email", () => {
  assert.equal(
    hasSubstantiveCloseoutEvidence({
      metrics: {
        durationSec: 446,
        prospectCharCount: 0,
        transcriptCount: 0,
        coachTurnCount: 0,
        contextCount: 0,
      },
      facts: [],
    }),
    false,
  );
});

test("coach/context artifacts alone do not count without usable transcript text", () => {
  assert.equal(
    hasSubstantiveCloseoutEvidence({
      metrics: {
        prospectCharCount: 0,
        transcriptCount: 0,
        coachTurnCount: 2,
        contextCount: 3,
      },
      facts: [],
    }),
    false,
  );
});

test("coach/context artifacts can support evidence when tied to transcript text", () => {
  assert.equal(
    hasSubstantiveCloseoutEvidence({
      metrics: {
        prospectCharCount: 90,
        transcriptCount: 1,
        coachTurnCount: 1,
        contextCount: 1,
      },
      facts: [],
    }, { minTranscriptChars: 200 }),
    true,
  );
});

test("manager outlier email is suppressed for insufficient-evidence grade", () => {
  const gate = shouldSendManagerOutlierEmail({
    metrics: { durationSec: 446, prospectCharCount: 0, transcriptCount: 0 },
    facts: [],
    callGrade: {
      grade: {
        overallScore: 12,
        verdict: "Insufficient evidence to assess performance; no transcript was provided.",
      },
    },
  }, {
    agentEmailManagersEnabled: true,
    agentEmailManagerMinDurationSec: 300,
    agentEmailManagerLowScore: 55,
  });

  assert.equal(gate.ok, false);
  assert.equal(gate.reason, "below-manager-email-evidence-threshold");
});
