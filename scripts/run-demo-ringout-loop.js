"use strict";

const { getControlPlaneConfig } = require("../apps/control-plane/src/services/appConfig");
const { createDemoRingoutRuntime } = require("../apps/control-plane/src/services/demoRingoutRuntime");
const { initializeServiceRuntime } = require("../packages/shared-runtime/src");

function hasArg(name) {
  return process.argv.includes(name);
}

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ""));
  return Number.isFinite(value) ? value : fallback;
}

async function main() {
  const config = getControlPlaneConfig();
  const runtime = await initializeServiceRuntime({
    ...config,
    serviceName: "demo-ringout-loop-script",
  });
  const dryRun = hasArg("--live") ? false : true;
  const loopCount = readNumberArg("--count", 45);
  const ringSeconds = readNumberArg("--ring-seconds", 120);
  const pauseSeconds = readNumberArg("--pause-seconds", 60);
  const demo = createDemoRingoutRuntime({
    config: {
      ...(config.demoRingout || {}),
      enabled: true,
      dryRun,
      loopCount,
      ringSeconds,
      pauseSeconds,
    },
    runtime,
  });

  try {
    const result = await demo.fire({
      scheduled: false,
      reason: dryRun ? "manual-loop-script-dry-run" : "manual-loop-script-live",
      loopCount,
      ringSeconds,
      pauseSeconds,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await runtime.shutdown("demo-ringout-loop-script-complete");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
