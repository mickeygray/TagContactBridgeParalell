"use strict";

const crypto = require("crypto");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  CALL_REVIEW_ALLOWED_PROVIDERS,
  resolveCallReviewRecordingCandidate,
} = require("../../packages/shared-services/src/trainingCallReviewSourceContract");
const {
  createTrainingCallReviewSourceService,
  hasMeaningfulConnectedCall,
} = require("../../packages/shared-services/src/trainingCallReviewSourceService");

const PRINCIPAL = Object.freeze({ email: "agent@example.test" });

function baseCall(overrides = {}) {
  return {
    domain: "TAG",
    caseId: 707,
    telephonySessionId: "session-base",
    callStartTime: "2026-07-28T17:00:00.000Z",
    durationSec: 300,
    direction: "outbound",
    connected: true,
    missed: false,
    outcome: "completed",
    ...overrides,
  };
}

function issuer({ authorization, callLog }) {
  const seed = `${authorization.actorEmail}|${authorization.domain}|${authorization.caseId}|${callLog.telephonySessionId}`;
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return {
    sourceId: `trsrc_${digest}`,
    callFingerprint: `call:${digest}`,
    recordingFingerprint: `recording:${digest}`,
  };
}

function makeService({ rows, issueRecordingSource = issuer, observations = {} } = {}) {
  return createTrainingCallReviewSourceService({
    isCallReviewEnabled: true,
    findUserAccountByEmail: async () => ({
      id: "account-fixture",
      email: PRINCIPAL.email,
      role: "internal-agent",
      status: "active",
      tagLogicsName: "Casey Smith",
    }),
    getActivitiesForCase: async (...args) => {
      (observations.activities ||= []).push(args);
      return [{
        Subject: "Assigned to Set. Officer : Casey Smith",
        CreatedDate: "2026-07-28T16:00:00.000Z",
      }];
    },
    listCallLogsByCaseId: async (...args) => {
      (observations.calls ||= []).push(args);
      return rows || [];
    },
    issueRecordingSource: async (input) => {
      (observations.issued ||= []).push(input.recordingCandidate.kind);
      return issueRecordingSource(input);
    },
  });
}

test("exact EX, CallRail, and PhoneBurner evidence is eligible while Drive membership alone is ignored", () => {
  assert.deepEqual(CALL_REVIEW_ALLOWED_PROVIDERS, ["ex", "phoneburner", "callrail"]);

  const ex = resolveCallReviewRecordingCandidate(baseCall({
    platform: "ex",
    provider: "ringcentral",
    telephonySessionId: "exact-ex-session",
    recordingArchive: {
      status: "completed",
      provider: "ringcentral",
      driveFileId: "non-authoritative-drive-object",
    },
  }));
  assert.equal(ex.eligible, true);
  assert.equal(ex.kind, "exact-telephony-session-lookup");
  assert.deepEqual(ex.locator, { telephonySessionId: "exact-ex-session" });

  assert.equal(
    resolveCallReviewRecordingCandidate(baseCall({ provider: "ex", platform: null })).eligible,
    false,
    "provider-only EX lacks the authoritative EX platform stamp",
  );

  const callrail = resolveCallReviewRecordingCandidate(baseCall({
    provider: "callrail",
    providerCallId: "exact-callrail-call",
    recordingArchive: { status: "completed", provider: "callrail", driveFileId: "ignored-drive" },
  }));
  assert.equal(callrail.kind, "provider-call-lookup");
  assert.deepEqual(callrail.locator, { providerCallId: "exact-callrail-call" });
  assert.equal(
    resolveCallReviewRecordingCandidate(baseCall({
      provider: "callrail",
      recordingArchive: { status: "completed", provider: "callrail", driveFileId: "drive-only" },
    })).eligible,
    false,
  );

  const phoneburner = resolveCallReviewRecordingCandidate(baseCall({
    provider: "phoneburner",
    platform: "phoneburner",
    recordingArchive: {
      status: "completed",
      provider: "phoneburner",
      driveFileId: "ignored-drive",
      sourceUri: "https://recordings.example.test/exact-phoneburner-call.mp3",
    },
  }));
  assert.equal(phoneburner.kind, "persisted-provider-recording");
  assert.equal(
    resolveCallReviewRecordingCandidate(baseCall({
      provider: "phoneburner",
      platform: "phoneburner",
      recordingArchive: { status: "completed", provider: "phoneburner", driveFileId: "drive-only" },
    })).eligible,
    false,
  );
});

test("meaningful connected status fails closed at the five-minute boundary", () => {
  assert.equal(hasMeaningfulConnectedCall(baseCall({ connected: false })), false);
  assert.equal(hasMeaningfulConnectedCall(baseCall({ missed: true })), false);
  assert.equal(hasMeaningfulConnectedCall(baseCall({ outcome: "no-answer" })), false);
  assert.equal(hasMeaningfulConnectedCall(baseCall({ outcome: "voicemail only" })), false);
  assert.equal(
    hasMeaningfulConnectedCall(baseCall({ connected: null, outcome: "answered", durationSec: 300 })),
    true,
  );
  assert.equal(
    hasMeaningfulConnectedCall(baseCall({ connected: null, outcome: null, durationSec: 300 })),
    false,
  );
});

test("one-case listing returns only safe opaque metadata and exact eligible capabilities", async () => {
  const observations = {};
  const rows = [
    baseCall({
      telephonySessionId: "private-ex-session",
      platform: "ex",
      provider: "ringcentral",
      callStartTime: "2026-07-28T20:00:00.000Z",
      durationSec: 601.9,
      agentName: " Agent\u0000 One ",
      phone: "555-private-ex",
      contactName: "Private Customer",
      recordingArchive: { status: "completed", driveFileId: "private-ex-drive" },
    }),
    baseCall({
      telephonySessionId: "private-callrail-session",
      provider: "callrail",
      providerCallId: "private-callrail-id",
      connected: null,
      outcome: "answered",
      callStartTime: "2026-07-28T19:00:00.000Z",
      durationSec: 300,
    }),
    baseCall({
      telephonySessionId: "private-phoneburner-session",
      provider: "phoneburner",
      platform: "phoneburner",
      callStartTime: "2026-07-28T18:00:00.000Z",
      recordingArchive: {
        sourceUri: "https://recordings.example.test/private-phoneburner.mp3",
      },
    }),
    baseCall({
      telephonySessionId: "private-pending-session",
      provider: "phoneburner",
      platform: "phoneburner",
      callStartTime: "2026-07-28T17:00:00.000Z",
      recordingArchive: { status: "processing" },
    }),
    baseCall({
      telephonySessionId: "private-drive-only-session",
      provider: "callrail",
      callStartTime: "2026-07-28T16:00:00.000Z",
      recordingArchive: { status: "completed", driveFileId: "private-drive-only" },
    }),
    baseCall({ telephonySessionId: "short", durationSec: 299.99 }),
    baseCall({ telephonySessionId: "no-answer", connected: true, outcome: "left voicemail" }),
    baseCall({ telephonySessionId: "explicit-disconnected", connected: false }),
    baseCall({ telephonySessionId: "legacy-unknown", connected: null, outcome: null }),
    baseCall({ telephonySessionId: "wrong-case", caseId: 999 }),
    baseCall({ telephonySessionId: "wrong-domain", domain: "WYNN" }),
    baseCall({ telephonySessionId: "cx", platform: "cx", provider: "ringcentral" }),
    baseCall({ telephonySessionId: "contradictory", platform: "ex", provider: "callrail" }),
    baseCall({ telephonySessionId: "bad-date", callStartTime: "not-a-date" }),
    baseCall({ telephonySessionId: "" }),
  ];
  const service = makeService({ rows, observations });

  const listed = await service.listCaseCalls({
    principal: PRINCIPAL,
    domain: "TAG",
    caseId: 707,
  });

  assert.equal(listed.minimumDurationSec, 300);
  assert.equal(listed.calls.length, 5);
  assert.deepEqual(listed.calls.map((call) => call.provider), [
    "ex",
    "callrail",
    "phoneburner",
    "phoneburner",
    "callrail",
  ]);
  assert.deepEqual(listed.calls.map((call) => call.analysisEligible), [true, true, true, false, false]);
  assert.deepEqual(listed.calls.map((call) => call.recordingStatus), [
    "available",
    "available",
    "available",
    "pending",
    "unavailable",
  ]);
  assert.deepEqual(listed.calls.map((call) => call.analysisReason), [
    null,
    null,
    null,
    "recording-pending",
    "exact-recording-evidence-unavailable",
  ]);
  assert.equal(listed.calls[0].agentName, "Agent One");
  assert.equal(listed.calls[0].durationSec, 601);
  assert.equal(listed.calls.slice(0, 3).every((call) => /^trsrc_/.test(call.sourceId)), true);
  assert.equal(listed.calls.slice(3).every((call) => call.sourceId === null), true);
  assert.deepEqual(observations.issued, [
    "exact-telephony-session-lookup",
    "provider-call-lookup",
    "persisted-provider-recording",
  ]);
  assert.deepEqual(observations.calls, [["TAG", 707, { limit: 500, includeLegacy: false }]]);

  const serialized = JSON.stringify(listed);
  for (const forbidden of [
    "707",
    "private-ex-session",
    "private-callrail-id",
    "private-phoneburner.mp3",
    "private-ex-drive",
    "private-drive-only",
    "555-private-ex",
    "Private Customer",
    "telephonySessionId",
    "providerCallId",
    "sourceUri",
    "driveFileId",
    "callFingerprint",
    "recordingFingerprint",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const resolved = await service.resolveAuthorizedSource({
    principal: PRINCIPAL,
    domain: "TAG",
    caseId: 707,
    sourceId: listed.calls[0].sourceId,
  });
  assert.equal(resolved.callLog.telephonySessionId, "private-ex-session");
  assert.equal(resolved.recordingCandidate.kind, "exact-telephony-session-lookup");
  assert.equal(resolved.source.sourceId, listed.calls[0].sourceId);
  assert.match(resolved.source.callFingerprint, /^call:[a-f0-9]{64}$/);
  assert.match(resolved.source.recordingFingerprint, /^recording:[a-f0-9]{64}$/);
  assert.equal(observations.activities.length, 2, "resolution reloads current assignment");
  assert.equal(observations.calls.length, 2, "resolution rereads exact non-legacy case calls");
});

test("source resolution rejects ambiguous duplicate capabilities without disclosing private rows", async () => {
  const duplicateSourceId = "trsrc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const service = makeService({
    rows: [
      baseCall({ telephonySessionId: "private-one", platform: "ex", provider: "ringcentral" }),
      baseCall({
        telephonySessionId: "private-two",
        provider: "callrail",
        providerCallId: "provider-two",
        callStartTime: "2026-07-28T18:00:00.000Z",
      }),
    ],
    issueRecordingSource: () => ({
      sourceId: duplicateSourceId,
      callFingerprint: "call:aaaaaaaaaaaaaaaa",
      recordingFingerprint: "recording:aaaaaaaaaaaaaaaa",
    }),
  });

  await assert.rejects(
    service.resolveAuthorizedSource({
      principal: PRINCIPAL,
      domain: "TAG",
      caseId: 707,
      sourceId: duplicateSourceId,
    }),
    (error) =>
      error?.code === "TRAINER_CALL_REVIEW_SOURCE_NOT_FOUND" &&
      error?.status === 404 &&
      !JSON.stringify(error).includes("private-one") &&
      !JSON.stringify(error).includes("provider-two"),
  );
});
