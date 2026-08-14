"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const {
  AUTOMATED_RECORDING_ARCHIVE_ENABLED,
  processCallRecordingArchive,
  queueCallRecordingArchiveJob,
} = require("../../packages/shared-services/src/recordingArchiveService");
const {
  BACKGROUND_RECORDING_RETRY_ENABLED,
} = require("../../packages/shared-services/src/transcriptionScoringService");
const {
  AUTOMATED_RECORDING_DOWNLOADS_ENABLED,
  createEodRecordingArchiveRuntime,
} = require("../../apps/control-plane/src/services/eodRecordingArchiveRuntime");

test("automatic recording downloads and background retries are hard-gated", async () => {
  assert.equal(AUTOMATED_RECORDING_ARCHIVE_ENABLED, false);
  assert.equal(BACKGROUND_RECORDING_RETRY_ENABLED, false);
  assert.equal(AUTOMATED_RECORDING_DOWNLOADS_ENABLED, false);
  assert.deepEqual(await queueCallRecordingArchiveJob({}), {
    queued: false,
    reason: "retired-links-only",
  });
  assert.deepEqual(await processCallRecordingArchive({}), {
    status: "skipped",
    reason: "retired-links-only",
  });
});

test("the legacy EOD archive cannot arm or run even when configuration says enabled", async () => {
  const events = [];
  const runtime = createEodRecordingArchiveRuntime({
    config: { enabled: true },
    runtime: {
      logger: {
        info: (...args) => events.push(["info", ...args]),
        warn: (...args) => events.push(["warn", ...args]),
        error: (...args) => events.push(["error", ...args]),
      },
    },
  });

  await runtime.start();
  assert.equal(runtime.getState().enabled, false);
  assert.deepEqual((await runtime.runArchive()).reason, "retired-links-only");
  assert.ok(events.some((event) => event[1] === "recording-archive.eod.disabled"));
  await runtime.stop();
});

test("the retry claimant excludes both retired recording handlers", () => {
  const passSource = fs.readFileSync(
    require.resolve("../../apps/control-plane/src/services/passRuntimeFactory"),
    "utf8",
  );
  const eventSource = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/hourlyJobEventService"),
    "utf8",
  );
  const scoringSource = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/transcriptionScoringService"),
    "utf8",
  );
  const hygieneSource = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/hourlyCallLogHygieneService"),
    "utf8",
  );

  assert.match(passSource, /retryCallRecordingPipeline/);
  assert.match(passSource, /retryCallRecordingArchive/);
  assert.match(passSource, /excludedHandlerKeys:\s*RETIRED_RECORDING_DOWNLOAD_HANDLER_KEYS/);
  assert.match(eventSource, /query\.handlerKey = \{ \$nin: excludedHandlerKeys \}/);
  assert.match(scoringSource, /if \(BACKGROUND_RECORDING_RETRY_ENABLED\) \{[\s\S]*emitHourlyJobEvent/);
  assert.match(hygieneSource, /const BACKGROUND_CALL_RECORDING_PROCESSING_ENABLED = false/);
  assert.match(hygieneSource, /BACKGROUND_CALL_RECORDING_PROCESSING_ENABLED[\s\S]*options\.scorePendingCalls === true/);
});
