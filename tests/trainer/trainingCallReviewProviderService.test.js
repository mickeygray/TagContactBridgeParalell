"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  TrainingCallReviewProviderError,
  createTrainingCallReviewProviderService,
} = require("../../packages/shared-services/src/trainingCallReviewProviderService");

process.env.SALES_TRAINER_CALL_REVIEW_ALLOWED_RECORDING_HOSTS =
  ".example.test";

const WAV_FIXTURE = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from("WAVEfmt ", "ascii"),
  Buffer.from([0x01, 0x00, 0x01, 0x00]),
]);

function audioResponse(buffer = WAV_FIXTURE, headers = {}) {
  return new Response(buffer, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "content-length": String(buffer.length),
      ...headers,
    },
  });
}

function publicDnsLookup() {
  return [{ address: "93.184.216.34", family: 4 }];
}

async function makeTempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trainer-provider-test-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("PhoneBurner downloads only the exact persisted authorized source and returns a cleanup artifact", async (t) => {
  const tempRoot = await makeTempRoot(t);
  let authorizationChecks = 0;
  let fetches = 0;
  const sourceUri = "https://recordings.example.test/exact-phoneburner.wav";
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => {
      authorizationChecks += 1;
      return {
        callLog: {
          recordingArchive: { sourceUri },
        },
        recordingCandidate: {
          eligible: true,
          provider: "phoneburner",
          kind: "persisted-provider-recording",
          locator: { sourceUri },
        },
      };
    },
    fetchImpl: async (url, options) => {
      fetches += 1;
      assert.equal(String(url), sourceUri);
      assert.equal(options.redirect, "manual");
      return audioResponse();
    },
    dnsLookup: publicDnsLookup,
    tempRoot,
  });

  const first = await service.downloadRecording();
  assert.equal(first.provider, "phoneburner");
  assert.equal(first.byteLength, WAV_FIXTURE.length);
  assert.equal(Object.hasOwn(first, "sourceUri"), false);
  assert.deepEqual(await fs.readFile(first.path), WAV_FIXTURE);
  await first.cleanup();
  await assert.rejects(fs.stat(first.path), { code: "ENOENT" });

  const second = await service.downloadRecording();
  await second.cleanup();
  assert.equal(authorizationChecks, 2);
  assert.equal(fetches, 2);
});

test("CallRail uses only the exact authorized providerCallId", async (t) => {
  const tempRoot = await makeTempRoot(t);
  let requestedCallId = null;
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: {
        domain: "TAG",
        providerCallId: "cr_exact_123",
      },
      candidate: {
        eligible: true,
        provider: "callrail",
        kind: "provider-call-lookup",
        locator: { providerCallId: "cr_exact_123" },
      },
    }),
    createCallrailClientImpl: () => ({
      async getCallRecording(callId) {
        requestedCallId = callId;
        return {
          url: "https://recordings.example.test/exact-callrail.wav",
        };
      },
    }),
    fetchImpl: async () => audioResponse(),
    dnsLookup: publicDnsLookup,
    tempRoot,
  });

  const artifact = await service.downloadRecording();
  assert.equal(requestedCallId, "cr_exact_123");
  assert.equal(artifact.provider, "callrail");
  await artifact.cleanup();

  const mismatch = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: {
        domain: "TAG",
        providerCallId: "cr_real",
      },
      candidate: {
        eligible: true,
        provider: "callrail",
        kind: "provider-call-lookup",
        locator: { providerCallId: "cr_other" },
      },
    }),
    createCallrailClientImpl: () => {
      throw new Error("must not create a client for a mismatched locator");
    },
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
    dnsLookup: publicDnsLookup,
    tempRoot,
  });
  await assert.rejects(
    mismatch.downloadRecording(),
    (error) =>
      error instanceof TrainingCallReviewProviderError &&
      error.code === "TRAINER_CALL_REVIEW_CALLRAIL_ID_MISMATCH",
  );
});

test("EX selects a recording only by exact telephonySessionId and never by nearby call", async (t) => {
  const tempRoot = await makeTempRoot(t);
  let authorizationHeader = null;
  const exactUrl = "https://media.example.test/exact-ex.wav";
  const records = [
    {
      telephonySessionId: "nearby-but-wrong",
      recording: {
        contentUri: "https://media.example.test/wrong-nearby.wav",
      },
    },
    {
      telephonySessionId: "parent-session",
      legs: [{ telephonySessionId: "ex_exact_session" }],
      recording: { contentUri: exactUrl },
    },
  ];
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: {
        telephonySessionId: "ex_exact_session",
        callStartTime: "2026-07-28T10:00:00.000Z",
      },
      candidate: {
        eligible: true,
        provider: "ex",
        kind: "exact-telephony-session",
        locator: { telephonySessionId: "ex_exact_session" },
      },
    }),
    createRingCentralClientImpl: () => ({
      async reinitializePlatform() {},
      async getAccountCallLog() {
        return { records };
      },
      async authenticate() {
        return "fixture-rc-token";
      },
    }),
    fetchImpl: async (url, options) => {
      assert.equal(String(url), exactUrl);
      authorizationHeader = options.headers.Authorization;
      return audioResponse();
    },
    dnsLookup: publicDnsLookup,
    tempRoot,
  });

  const artifact = await service.downloadRecording();
  assert.equal(artifact.provider, "ex");
  assert.equal(authorizationHeader, "Bearer fixture-rc-token");
  await artifact.cleanup();

  let fetched = false;
  const noExact = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: {
        telephonySessionId: "missing-session",
        callStartTime: "2026-07-28T10:00:00.000Z",
      },
      candidate: {
        eligible: true,
        provider: "ex",
        kind: "exact-telephony-session",
        locator: { telephonySessionId: "missing-session" },
      },
    }),
    createRingCentralClientImpl: () => ({
      async getAccountCallLog() {
        return { records: [records[0]] };
      },
    }),
    fetchImpl: async () => {
      fetched = true;
      return audioResponse();
    },
    dnsLookup: publicDnsLookup,
    tempRoot,
  });
  await assert.rejects(
    noExact.downloadRecording(),
    (error) =>
      error.code === "TRAINER_CALL_REVIEW_EX_RECORDING_NOT_FOUND",
  );
  assert.equal(fetched, false);
});

test("every redirect target is revalidated and private targets fail before fetch", async (t) => {
  const tempRoot = await makeTempRoot(t);
  const sourceUri = "https://public.example.test/start";
  let fetches = 0;
  const service = createTrainingCallReviewProviderService({
    resolveAuthorizedSource: async () => ({
      callLog: { recordingArchive: { sourceUri } },
      candidate: {
        eligible: true,
        provider: "phoneburner",
        kind: "persisted-provider-recording",
        locator: { sourceUri },
      },
    }),
    fetchImpl: async () => {
      fetches += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://127.0.0.1/internal-audio" },
      });
    },
    dnsLookup: publicDnsLookup,
    tempRoot,
  });

  await assert.rejects(
    service.downloadRecording(),
    (error) =>
      error.code === "TRAINER_CALL_REVIEW_PRIVATE_TARGET_REJECTED",
  );
  assert.equal(fetches, 1);
  assert.deepEqual(await fs.readdir(tempRoot).catch(() => []), []);
});

test("byte, content-type, and audio-magic bounds fail closed without temp residue", async (t) => {
  const tempRoot = await makeTempRoot(t);
  const sourceUri = "https://recordings.example.test/bounded";

  async function expectRejected(response, code, maxBytes = 128) {
    const service = createTrainingCallReviewProviderService({
      resolveAuthorizedSource: async () => ({
        callLog: { recordingArchive: { sourceUri } },
        candidate: {
          eligible: true,
          provider: "phoneburner",
          kind: "persisted-provider-recording",
          locator: { sourceUri },
        },
      }),
      fetchImpl: async () => response,
      dnsLookup: publicDnsLookup,
      tempRoot,
      maxBytes,
    });
    await assert.rejects(
      service.downloadRecording(),
      (error) => error.code === code,
    );
    assert.deepEqual(await fs.readdir(tempRoot).catch(() => []), []);
  }

  await expectRejected(
    audioResponse(WAV_FIXTURE, { "content-length": "999" }),
    "TRAINER_CALL_REVIEW_RECORDING_TOO_LARGE",
    64,
  );
  await expectRejected(
    new Response("<html>not audio</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
    "TRAINER_CALL_REVIEW_AUDIO_CONTENT_TYPE_REJECTED",
  );
  await expectRejected(
    new Response("not really mp3 audio", {
      status: 200,
      headers: { "content-type": "audio/mpeg" },
    }),
    "TRAINER_CALL_REVIEW_AUDIO_CONTENT_INVALID",
  );
});
