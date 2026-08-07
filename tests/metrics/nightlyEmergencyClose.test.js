"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  checkpointNeedsRecovery,
  launchEmergencyNightlyClose,
  markNightlyCloseCompleted,
  markNightlyCloseStarted,
  readCheckpoint,
  sendEmergencyNightlyClose,
} = require("../../packages/shared-services/src/nightlyEmergencyCloseService");
const {
  TASK_TIMEOUT,
  withTimeout,
} = require("../../apps/control-plane/src/services/nightlyHygieneRuntime");

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-emergency-"));
  return { dir, stateFile: path.join(dir, "state.json") };
}

test("the emergency close sends without importing Mongo and records only safe status", async (t) => {
  const { dir, stateFile } = tempState();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const result = await sendEmergencyNightlyClose({
    dateKey: "2026-08-07",
    reasonCode: "nightly-task-timeout",
    taskKey: "mail-invoice",
    recipients: ["owner@example.test"],
    stateFile,
    sendMailImpl: async (domain, payload) => {
      calls.push({ domain, payload });
      return { messageId: "accepted" };
    },
  });

  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.subject, /DEGRADED/);
  assert.match(calls[0].payload.text, /does not read Mongo/);
  const checkpoint = readCheckpoint(stateFile);
  assert.equal(checkpoint.status, "fallback-sent");
  assert.equal(checkpoint.reasonCode, "nightly-task-timeout");
  assert.equal(checkpoint.taskKey, "mail-invoice");
  assert.equal(JSON.stringify(checkpoint).includes("owner@example.test"), false);

  const source = fs.readFileSync(
    require.resolve("../../packages/shared-services/src/nightlyEmergencyCloseService"),
    "utf8",
  );
  assert.doesNotMatch(source, /require\([^)]*(shared-models|shared-repositories|event-core)/);
});

test("the emergency checkpoint prevents duplicate fallback mail", async (t) => {
  const { dir, stateFile } = tempState();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let sends = 0;
  const options = {
    dateKey: "2026-08-07",
    stateFile,
    sendMailImpl: async () => { sends += 1; return {}; },
  };
  assert.equal((await sendEmergencyNightlyClose(options)).sent, true);
  const again = await sendEmergencyNightlyClose(options);
  assert.equal(again.skipped, true);
  assert.equal(again.reason, "fallback-already-sent");
  assert.equal(sends, 1);
});

test("a running checkpoint is recoverable after a crash; a completed one is not", (t) => {
  const { dir, stateFile } = tempState();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  markNightlyCloseStarted({ dateKey: "2026-08-07", stateFile });
  assert.equal(checkpointNeedsRecovery(readCheckpoint(stateFile)), true);
  markNightlyCloseCompleted({ dateKey: "2026-08-07", stateFile });
  assert.equal(checkpointNeedsRecovery(readCheckpoint(stateFile)), false);
});

test("detached launch writes the recovery marker before starting the child", (t) => {
  const { dir, stateFile } = tempState();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawns = [];
  const result = launchEmergencyNightlyClose({
    dateKey: "2026-08-07",
    reasonCode: "task-failed",
    taskKey: "spend-sync",
    stateFile,
    scriptPath: path.join(dir, "sender.js"),
    spawnImpl: (...args) => {
      spawns.push(args);
      return { pid: 123, unref() {} };
    },
  });
  assert.equal(result.launched, true);
  assert.equal(spawns.length, 1);
  assert.equal(readCheckpoint(stateFile).status, "fallback-launched");
});

test("nightly task timeout has a stable failure code", async () => {
  await assert.rejects(
    withTimeout(() => new Promise(() => {}), 10, { taskKey: "hung", phase: "apply" }),
    (error) => error.code === TASK_TIMEOUT && /hung apply timed out/.test(error.message),
  );
});
