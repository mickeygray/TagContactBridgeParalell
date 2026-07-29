"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CALL_REVIEW_ALLOWED_PROVIDERS,
  assertNoClientLocatorInput,
  buildPublicCallReviewSource,
  buildPublicCaseCallReviewSource,
  isOpaqueReviewSourceId,
  resolveCallReviewRecordingCandidate,
} = require("../../packages/shared-services/src/trainingCallReviewSourceContract");

function callLog(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 12345,
    telephonySessionId: "internal-session-fixture",
    callStartTime: new Date("2026-07-28T17:00:00.000Z"),
    durationSec: 615,
    direction: "outbound",
    ...overrides,
  };
}

test("Call Review explicitly allows EX, PhoneBurner, and CallRail exact sources", () => {
  assert.deepEqual(CALL_REVIEW_ALLOWED_PROVIDERS, [
    "ex",
    "phoneburner",
    "callrail",
  ]);

  const exactEx = resolveCallReviewRecordingCandidate(
    callLog({ platform: "ex", provider: "ringcentral" }),
  );
  assert.deepEqual(exactEx, {
    eligible: true,
    provider: "ex",
    kind: "exact-telephony-session-lookup",
    reason: null,
    locator: { telephonySessionId: "internal-session-fixture" },
  });

  for (const input of [
    { provider: "ex" },
    { provider: "ringcentral" },
    { provider: "ringcentral", platform: "cx" },
    { provider: "callrail", platform: "ex" },
    { provider: "future-provider" },
    {},
  ]) {
    assert.equal(
      resolveCallReviewRecordingCandidate(callLog(input)).eligible,
      false,
      JSON.stringify(input),
    );
  }
});

test("generic Drive archives are never authoritative recording evidence", () => {
  for (const input of [
    {
      provider: "callrail",
      recordingArchive: {
        status: "completed",
        provider: "callrail",
        driveFileId: "private-callrail-drive-fixture",
      },
    },
    {
      provider: "phoneburner",
      platform: "phoneburner",
      recordingArchive: {
        status: "completed",
        provider: "phoneburner",
        driveFileId: "private-phoneburner-drive-fixture",
      },
    },
  ]) {
    const result = resolveCallReviewRecordingCandidate(callLog(input));
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "recording-evidence-unavailable");
    assert.equal(JSON.stringify(result).includes("drive"), false);
  }

  const ex = resolveCallReviewRecordingCandidate(
    callLog({
      platform: "ex",
      provider: "ringcentral",
      recordingArchive: {
        status: "completed",
        provider: "ringcentral",
        driveFileId: "private-ex-drive-fixture",
      },
    }),
  );
  assert.equal(ex.kind, "exact-telephony-session-lookup");
  assert.deepEqual(ex.locator, {
    telephonySessionId: "internal-session-fixture",
  });
  assert.equal(JSON.stringify(ex).includes("private-ex-drive-fixture"), false);
});

test("CallRail requires its exact provider call ID even when a Drive archive exists", () => {
  const result = resolveCallReviewRecordingCandidate(
    callLog({
      provider: "callrail",
      providerCallId: "provider-call-fixture",
      recordingArchive: {
        status: "completed",
        provider: "callrail",
        driveFileId: "ignored-drive-fixture",
      },
    }),
  );
  assert.deepEqual(result, {
    eligible: true,
    provider: "callrail",
    kind: "provider-call-lookup",
    reason: null,
    locator: { providerCallId: "provider-call-fixture" },
  });
  assert.equal(JSON.stringify(result).includes("ignored-drive-fixture"), false);
});

test("PhoneBurner requires an already-persisted safe HTTPS recording URI", () => {
  const missing = resolveCallReviewRecordingCandidate(
    callLog({ provider: "phoneburner", platform: "phoneburner" }),
  );
  assert.equal(missing.eligible, false);

  for (const sourceUri of [
    "http://recordings.example.test/call.mp3",
    "https://user:secret@recordings.example.test/call.mp3",
    "not-a-url",
  ]) {
    assert.equal(
      resolveCallReviewRecordingCandidate(
        callLog({
          provider: "phoneburner",
          platform: "phoneburner",
          recordingArchive: { sourceUri },
        }),
      ).eligible,
      false,
      sourceUri,
    );
  }

  const stored = resolveCallReviewRecordingCandidate(
    callLog({
      provider: "phoneburner",
      platform: "phoneburner",
      recordingArchive: {
        sourceUri: "https://recordings.example.test/call.mp3?opaque=fixture",
        driveFileId: "ignored-drive-fixture",
      },
    }),
  );
  assert.equal(stored.eligible, true);
  assert.equal(stored.kind, "persisted-provider-recording");
  assert.deepEqual(stored.locator, {
    sourceUri: "https://recordings.example.test/call.mp3?opaque=fixture",
  });
});

test("exact provider evidence cannot replace case-bound CallLog authorization", () => {
  const exactSources = [
    { platform: "ex", provider: "ringcentral" },
    { provider: "callrail", providerCallId: "provider-call-fixture" },
    {
      provider: "phoneburner",
      platform: "phoneburner",
      recordingArchive: {
        sourceUri: "https://recordings.example.test/call.mp3",
      },
    },
  ];

  for (const exactSource of exactSources) {
    for (const missing of [
      { domain: "" },
      { caseId: null },
      { telephonySessionId: "" },
    ]) {
      const result = resolveCallReviewRecordingCandidate(
        callLog({ ...exactSource, ...missing }),
      );
      assert.equal(result.eligible, false);
      assert.equal(result.reason, "authorized-call-binding-required");
    }
  }
});

test("client payloads reject raw call, case, recording, customer, and transcript locators", () => {
  assert.equal(
    assertNoClientLocatorInput({
      sourceId: "trsrc_0123456789abcdefghijklmn",
      reflection: { text: "I should have asked one more question." },
    }),
    true,
  );

  for (const payload of [
    { caseId: 12345 },
    { callLogId: "private-call-log" },
    { telephonySessionId: "private-session" },
    { driveFileId: "private-drive" },
    { nested: { providerCallId: "private-provider-call" } },
    { nested: [{ sourceUri: "https://private.example.test" }] },
    { transcript: "private customer words" },
    { phone: "5555555555" },
    { contactName: "Private Customer" },
  ]) {
    assert.throws(
      () => assertNoClientLocatorInput(payload),
      (error) => {
        const serialized = JSON.stringify(error);
        return (
          error?.code === "TRAINER_CALL_REVIEW_LOCATOR_REJECTED" &&
          !serialized.includes("private-session") &&
          !serialized.includes("private-provider-call") &&
          !serialized.includes("private.example.test") &&
          !serialized.includes("private customer words") &&
          !serialized.includes("Private Customer")
        );
      },
    );
  }
});

test("legacy public source summaries contain only opaque IDs and safe call metadata", () => {
  const sourceId = "trsrc_abcdefghijklmnopqrstuvwxyzAB";
  assert.equal(isOpaqueReviewSourceId(sourceId), true);
  const result = buildPublicCallReviewSource({
    sourceId,
    callStartTime: "2026-07-28T17:00:00.000Z",
    durationSec: 615.9,
    direction: "outbound",
    recordingStatus: "available",
    caseId: 12345,
    driveFileId: "private-drive-fixture",
    sourceUri: "https://private.example.test/recording",
  });
  assert.deepEqual(result, {
    sourceId,
    startedAt: "2026-07-28T17:00:00.000Z",
    durationSec: 615,
    direction: "outbound",
    recordingStatus: "available",
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    "12345",
    "private-drive-fixture",
    "private.example.test",
    "caseId",
    "driveFileId",
    "sourceUri",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("browser case-call summaries expose sourceId only when exact analysis is eligible", () => {
  const sourceId = "trsrc_abcdefghijklmnopqrstuvwxyzAB";
  const eligible = buildPublicCaseCallReviewSource({
    sourceId,
    provider: "ex",
    callStartTime: "2026-07-28T17:00:00.000Z",
    durationSec: 615.9,
    direction: "outbound",
    agentName: "Agent Fixture",
    outcome: "completed",
    recordingStatus: "unavailable",
    analysisEligible: true,
    analysisReason: "should-not-surface",
    caseId: 12345,
    telephonySessionId: "private-session-fixture",
    driveFileId: "private-drive-fixture",
  });
  assert.deepEqual(eligible, {
    sourceId,
    provider: "ex",
    startedAt: "2026-07-28T17:00:00.000Z",
    durationSec: 615,
    direction: "outbound",
    agentName: "Agent Fixture",
    outcome: "completed",
    recordingStatus: "available",
    analysisEligible: true,
    analysisReason: null,
  });

  const unavailable = buildPublicCaseCallReviewSource({
    sourceId,
    provider: "callrail",
    callStartTime: "2026-07-28T17:00:00.000Z",
    durationSec: 615,
    direction: "inbound",
    recordingStatus: "available",
    analysisEligible: false,
    analysisReason: "raw-private-reason",
  });
  assert.equal(unavailable.sourceId, null);
  assert.equal(unavailable.recordingStatus, "unavailable");
  assert.equal(
    unavailable.analysisReason,
    "exact-recording-evidence-unavailable",
  );

  const serialized = JSON.stringify({ eligible, unavailable });
  for (const forbidden of [
    "12345",
    "private-session-fixture",
    "private-drive-fixture",
    "telephonySessionId",
    "driveFileId",
    "raw-private-reason",
    "should-not-surface",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});
