"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  APPLY_ACKNOWLEDGEMENT,
  EXPECTED_FOLDER_MAPPING_DIGEST,
  MONDAY_CHECKPOINT_KEY,
  PRELOAD_AGENT_IDS,
  PreloadCliError,
  buildPreloadConfiguration,
  createProgressReporter,
  executePreload,
  findArmedPhoneBurnerWriters,
  folderMappingDigest,
  parseArgs,
  runCli,
  safeFailure,
  summarizeResult,
} = require("../../scripts/phoneburner-july-preload");

const SNAPSHOT = new Date("2026-07-13T14:30:00.000Z");
const CONFIG_PATH = path.resolve(__dirname, "../../config/lead-delivery-agents.json");

function checkedInConfiguration() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function successfulResult(overrides = {}) {
  return {
    status: "completed",
    dryRun: false,
    scanned: 40,
    eligible: 20,
    selected: 10,
    assigned: 10,
    accepted: 10,
    recovered: 0,
    countsByAgent: Object.fromEntries(PRELOAD_AGENT_IDS.map((agentId) => [agentId, {
      assigned: 2,
      accepted: 2,
      fullPhone: "not-safe",
    }])),
    backpressure: false,
    checkpoint: {
      status: "completed",
      cutoffAt: SNAPSHOT,
      admitted: 10,
      accepted: 10,
      pending: 0,
      failed: 0,
      conflicts: 0,
      capReached: false,
      completedAt: new Date("2026-07-13T18:00:00.000Z"),
      phone: "not-safe",
    },
    rawLead: { phone: "not-safe" },
    ...overrides,
  };
}

test("argument parser defaults to a fixed July-start dry-run and one run snapshot", () => {
  const options = parseArgs([], { snapshot: SNAPSHOT });

  assert.equal(options.apply, false);
  assert.equal(options.dryRun, true);
  assert.equal(options.receivedFrom.toISOString(), "2026-07-01T07:00:00.000Z");
  assert.equal(options.receivedBefore.toISOString(), SNAPSHOT.toISOString());
  assert.equal(options.maxContacts, 5000);
  assert.deepEqual(options.agentIds, PRELOAD_AGENT_IDS);
});

test("apply requires the exact acknowledgement string", () => {
  assert.throws(
    () => parseArgs(["--apply"], { snapshot: SNAPSHOT }),
    (error) => error instanceof PreloadCliError && error.code === "apply-ack-required",
  );
  assert.throws(
    () => parseArgs(["--apply", "--ack=almost"], { snapshot: SNAPSHOT }),
    (error) => error instanceof PreloadCliError && error.code === "apply-ack-required",
  );

  const options = parseArgs([
    `--snapshot=${SNAPSHOT.toISOString()}`,
    "--apply",
    `--ack=${APPLY_ACKNOWLEDGEMENT}`,
  ], { snapshot: SNAPSHOT });
  assert.equal(options.apply, true);
  assert.equal(options.dryRun, false);
});

test("apply requires an explicit snapshot so every retry reuses one durable preload key", () => {
  assert.throws(
    () => parseArgs([
      "--apply",
      `--ack=${APPLY_ACKNOWLEDGEMENT}`,
    ], { snapshot: SNAPSHOT }),
    (error) => error instanceof PreloadCliError && error.code === "apply-snapshot-required",
  );

  const explicit = parseArgs([
    `--snapshot=${SNAPSHOT.toISOString()}`,
    "--apply",
    `--ack=${APPLY_ACKNOWLEDGEMENT}`,
  ], { snapshot: new Date("2026-07-13T14:45:00.000Z") });
  assert.equal(explicit.receivedBefore.toISOString(), SNAPSHOT.toISOString());
});

test("limit is positive, bounded at 5000, and unknown options fail closed", () => {
  assert.equal(parseArgs(["--limit=25"], { snapshot: SNAPSHOT }).maxContacts, 25);
  assert.throws(
    () => parseArgs(["--limit=5001"], { snapshot: SNAPSHOT }),
    (error) => error.code === "limit-over-cap",
  );
  assert.throws(
    () => parseArgs(["--limit=0"], { snapshot: SNAPSHOT }),
    (error) => error.code === "limit-invalid",
  );
  assert.throws(
    () => parseArgs(["--folder=unsafe"], { snapshot: SNAPSHOT }),
    (error) => error.code === "unknown-argument",
  );
});

test("single run snapshot must remain inside July 2026 Pacific bounds", () => {
  assert.throws(
    () => parseArgs([], { snapshot: new Date("2026-07-01T06:59:59.999Z") }),
    (error) => error.code === "snapshot-before-july",
  );
  assert.throws(
    () => parseArgs([], { snapshot: new Date("2026-08-01T07:00:00.000Z") }),
    (error) => error.code === "snapshot-after-july",
  );
});

test("explicit ISO snapshot lets dry-run and apply share one preload window", () => {
  const snapshotArgument = "--snapshot=2026-07-13T14:30:00.000Z";
  const preview = parseArgs([snapshotArgument], {
    snapshot: new Date("2026-07-13T14:31:00.000Z"),
  });
  const apply = parseArgs([
    snapshotArgument,
    "--apply",
    `--ack=${APPLY_ACKNOWLEDGEMENT}`,
  ], {
    snapshot: new Date("2026-07-13T14:32:00.000Z"),
  });

  assert.equal(preview.receivedBefore.toISOString(), "2026-07-13T14:30:00.000Z");
  assert.equal(apply.receivedBefore.toISOString(), preview.receivedBefore.toISOString());
  assert.throws(
    () => parseArgs(["--snapshot=2026-07-13"], { snapshot: SNAPSHOT }),
    (error) => error.code === "snapshot-invalid",
  );
});

test("writer preflight refuses legacy rotation, an action-capable runtime, and explicit PB feeders", () => {
  assert.deepEqual(findArmedPhoneBurnerWriters({}), []);
  assert.deepEqual(findArmedPhoneBurnerWriters({
    PHONEBURNER_ROTATION_ENABLED: "true",
    LEAD_DELIVERY_ENABLED: "true",
    LEAD_DELIVERY_ACTIONS_ENABLED: "true",
    PHONEBURNER_FEEDER_ENABLED: "TRUE",
  }), [
    "LEAD_DELIVERY_ACTIONS_ENABLED",
    "PHONEBURNER_FEEDER_ENABLED",
    "PHONEBURNER_ROTATION_ENABLED",
  ]);
  assert.deepEqual(findArmedPhoneBurnerWriters({
    LEAD_DELIVERY_ENABLED: "true",
    LEAD_DELIVERY_ACTIONS_ENABLED: "false",
  }), []);
});

test("checked-in folder mapping is pinned without changing or printing the original config", () => {
  const original = checkedInConfiguration();
  const before = JSON.stringify(original);
  assert.equal(folderMappingDigest(original), EXPECTED_FOLDER_MAPPING_DIGEST);

  const enabled = buildPreloadConfiguration(original);
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(Object.keys(enabled.agents).sort(), [...PRELOAD_AGENT_IDS].sort());
  for (const agentId of PRELOAD_AGENT_IDS) assert.equal(enabled.agents[agentId].enabled, true);

  const wrong = checkedInConfiguration();
  wrong.agents[PRELOAD_AGENT_IDS[0]].distributionFolderId = "changed";
  assert.throws(
    () => buildPreloadConfiguration(wrong),
    (error) => error.code === "configuration-folder-mapping-mismatch",
  );
});

test("dry-run calls the service preload interface with exact bounds and cleans up", async () => {
  const calls = [];
  let closed = 0;
  const options = parseArgs(["--limit=20"], { snapshot: SNAPSHOT });
  const summary = await executePreload(options, {
    env: {},
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async ({ configuration, options: receivedOptions }) => {
      calls.push({ configuration, receivedOptions });
      return {
        runtime: {
          async preloadWindow(input) {
            calls.push({ input });
            return successfulResult({
              status: "preview",
              dryRun: true,
              accepted: 0,
              assigned: 10,
            });
          },
        },
        async close() { closed += 1; },
      };
    },
  });

  assert.equal(calls[0].receivedOptions.dryRun, true);
  assert.equal(calls[0].configuration.agents.bruce_allen.enabled, true);
  assert.deepEqual(calls[1].input, {
    receivedFrom: new Date("2026-07-01T07:00:00.000Z"),
    receivedBefore: SNAPSHOT,
    agentIds: PRELOAD_AGENT_IDS,
    maxContacts: 20,
    dryRun: true,
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.dryRun, true);
  assert.equal(closed, 1);
});

test("apply forwards dryRun false and returns only whitelisted PII-free counts", async () => {
  const options = parseArgs([
    `--snapshot=${SNAPSHOT.toISOString()}`,
    "--apply",
    `--ack=${APPLY_ACKNOWLEDGEMENT}`,
  ], { snapshot: SNAPSHOT });
  let received = null;
  const onProgress = () => {};
  const summary = await executePreload(options, {
    env: {},
    onProgress,
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async () => ({
      runtime: {
        async preloadWindow(input) {
          received = input;
          return successfulResult();
        },
      },
      async close() {},
    }),
  });

  assert.equal(received.dryRun, false);
  assert.equal(received.checkpointKey, MONDAY_CHECKPOINT_KEY);
  assert.equal(received.onProgress, onProgress);
  assert.equal(summary.ok, true);
  assert.equal(summary.accepted, 10);
  assert.equal(summary.checkpoint.status, "completed");
  const rendered = JSON.stringify(summary);
  assert.doesNotMatch(rendered, /not-safe/);
  const configuration = checkedInConfiguration();
  for (const agent of Object.values(configuration.agents)) {
    for (const folderId of [agent.distributionFolderId, agent.receivingFolderId]) {
      if (!String(folderId || "").trim()) continue;
      assert.equal(rendered.includes(String(folderId)), false);
    }
  }
});

test("partial, backpressure, and unknown results are non-successful", () => {
  const options = parseArgs([], { snapshot: SNAPSHOT });
  assert.equal(summarizeResult(successfulResult({ status: "partial" }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ status: "resumable" }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ backpressure: true }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ status: "completed", pending: 1 }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ status: "completed", failed: 1 }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ status: "completed", conflictCount: 1 }), options).ok, false);
  assert.equal(summarizeResult(successfulResult({ checkpoint: { status: "partial" } }), {
    ...options,
    dryRun: false,
  }).ok, false);
  assert.equal(summarizeResult({}, options).ok, false);
});

test("apply exits nonzero when an eligible scan accepts nothing, while completed resume stays successful", async () => {
  const args = [
    `--snapshot=${SNAPSHOT.toISOString()}`,
    "--apply",
    `--ack=${APPLY_ACKNOWLEDGEMENT}`,
  ];
  const emptyAcceptance = await runCli(args, {
    snapshot: new Date("2026-07-13T14:45:00.000Z"),
    env: {},
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async () => ({
      runtime: {
        async preloadWindow() {
          return successfulResult({ selected: 0, assigned: 0, accepted: 0 });
        },
      },
      async close() {},
    }),
  });
  assert.equal(emptyAcceptance.summary.ok, false);
  assert.equal(emptyAcceptance.exitCode, 1);

  const completedResume = await runCli(args, {
    snapshot: new Date("2026-07-13T15:00:00.000Z"),
    env: {},
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async () => ({
      runtime: {
        async preloadWindow() {
          return successfulResult({ assigned: 0, recovered: 0 });
        },
      },
      async close() {},
    }),
  });
  assert.equal(completedResume.summary.ok, true);
  assert.equal(completedResume.exitCode, 0);
});

test("progress reporter emits only PII-free 25-accepted milestones", () => {
  const lines = [];
  const report = createProgressReporter({ write: (line) => lines.push(line) });
  report({ accepted: 24, phone: "not-safe" });
  report({ accepted: 25, folderId: "not-safe" });
  report({ accepted: 26 });
  report({ accepted: 76, rawLead: "not-safe" });

  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { type: "phoneburner_july_preload_progress", accepted: 25, agentCount: 5 },
    { type: "phoneburner_july_preload_progress", accepted: 50, agentCount: 5 },
    { type: "phoneburner_july_preload_progress", accepted: 75, agentCount: 5 },
  ]);
  assert.doesNotMatch(lines.join(""), /not-safe/);
});

test("runtime cleanup runs when preload fails and raw errors are never printed", async () => {
  let closed = 0;
  const options = parseArgs([], { snapshot: SNAPSHOT });
  await assert.rejects(() => executePreload(options, {
    env: {},
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async () => ({
      runtime: {
        async preloadWindow() {
          throw new Error("phone and token must not be rendered");
        },
      },
      async close() { closed += 1; },
    }),
  }));
  assert.equal(closed, 1);
  assert.deepEqual(safeFailure(new Error("phone and token must not be rendered")), {
    ok: false,
    status: "error",
    reason: "preload-failed",
  });
});

test("writer conflicts fail before bootstrap and the package command stays dry by default", async () => {
  let bootstrapped = false;
  const options = parseArgs([], { snapshot: SNAPSHOT });
  await assert.rejects(() => executePreload(options, {
    env: { PHONEBURNER_ROTATION_ENABLED: "true" },
    loadConfiguration: checkedInConfiguration,
    createBootstrap: async () => {
      bootstrapped = true;
      return null;
    },
  }), (error) => error.code === "phoneburner-writer-armed");
  assert.equal(bootstrapped, false);

  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"));
  assert.equal(packageJson.scripts["phoneburner:july-preload"], "node scripts/phoneburner-july-preload.js");

  const help = await runCli(["--help"], { snapshot: SNAPSHOT });
  assert.equal(help.exitCode, 0);
  assert.match(help.text, /dry-run by default/i);
  assert.match(help.text, new RegExp(APPLY_ACKNOWLEDGEMENT));
  assert.match(help.text, /snapshot.*required for apply/is);
});
