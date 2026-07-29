"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  createTrainingCallReviewProviderService,
  hostnameMatchesAllowedRule,
  parseAllowedRecordingHosts,
} = require("../../packages/shared-services/src/trainingCallReviewProviderService");

const WAV_FIXTURE = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from("WAVEfmt ", "ascii"),
  Buffer.from([0x01, 0x00, 0x01, 0x00]),
]);

function audioResponse() {
  return new Response(WAV_FIXTURE, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "content-length": String(WAV_FIXTURE.length),
    },
  });
}

async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trainer-host-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("host rules are exact unless explicitly configured as a dot suffix", () => {
  assert.deepEqual(
    parseAllowedRecordingHosts(
      "recordings.example.com, .trusted.example; RECORDINGS.EXAMPLE.COM",
    ),
    ["recordings.example.com", ".trusted.example"],
  );
  assert.equal(
    hostnameMatchesAllowedRule(
      "recordings.example.com",
      "recordings.example.com",
    ),
    true,
  );
  assert.equal(
    hostnameMatchesAllowedRule(
      "sub.recordings.example.com",
      "recordings.example.com",
    ),
    false,
  );
  assert.equal(
    hostnameMatchesAllowedRule("audio.trusted.example", ".trusted.example"),
    true,
  );
  assert.equal(
    hostnameMatchesAllowedRule("trusted.example", ".trusted.example"),
    false,
  );
});

test("a public-DNS redirect still fails before fetch when its host is not allowlisted", async (t) => {
  const tempRoot = await makeTempRoot(t);
  const sourceUri = "https://allowed.example.test/start";
  let fetches = 0;
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: { recordingArchive: { sourceUri } },
      recordingCandidate: {
        eligible: true,
        provider: "phoneburner",
        kind: "persisted-provider-recording",
        locator: { sourceUri },
      },
    }),
    allowedRecordingHosts: ["allowed.example.test"],
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => {
      fetches += 1;
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://public-but-not-allowed.example.test/audio.wav",
        },
      });
    },
    tempRoot,
  });

  await assert.rejects(
    service.downloadRecording(),
    (error) =>
      error.code === "TRAINER_CALL_REVIEW_RECORDING_HOST_NOT_ALLOWED",
  );
  assert.equal(fetches, 1);
});

test("EX adds the configured RingCentral API hostname as an exact production authority", async (t) => {
  const tempRoot = await makeTempRoot(t);
  const recordingUrl =
    "https://platform.ringcentral.example.test/exact-recording.wav";
  let fetches = 0;
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: {
        telephonySessionId: "exact-session",
        callStartTime: "2026-07-28T10:00:00.000Z",
      },
      recordingCandidate: {
        eligible: true,
        provider: "ex",
        kind: "exact-telephony-session",
        locator: { telephonySessionId: "exact-session" },
      },
    }),
    allowedRecordingHosts: [],
    createRingCentralClientImpl: () => ({
      config: { serverUrl: "https://platform.ringcentral.example.test" },
      async getAccountCallLog() {
        return {
          records: [
            {
              telephonySessionId: "exact-session",
              recording: { contentUri: recordingUrl },
            },
          ],
        };
      },
      async authenticate() {
        return "synthetic-token";
      },
    }),
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url) => {
      fetches += 1;
      assert.equal(String(url), recordingUrl);
      return audioResponse();
    },
    tempRoot,
  });

  const artifact = await service.downloadRecording();
  assert.equal(fetches, 1);
  await artifact.cleanup();
});
