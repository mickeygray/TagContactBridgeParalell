"use strict";

const { getControlPlaneConfig } = require("../apps/control-plane/src/services/appConfig");
const { createDemoRingoutRuntime } = require("../apps/control-plane/src/services/demoRingoutRuntime");
const { initializeServiceRuntime } = require("../packages/shared-runtime/src");

function hasArg(name) {
  return process.argv.includes(name);
}

async function main() {
  const config = getControlPlaneConfig();
  const runtime = await initializeServiceRuntime({
    ...config,
    serviceName: "demo-ringout-script",
  });
  const dryRun = hasArg("--live") ? false : true;
  const demo = createDemoRingoutRuntime({
    config: {
      ...(config.demoRingout || {}),
      enabled: true,
      dryRun,
      loopCount: 1,
    },
    runtime,
  });

  try {
    const result = await demo.fire({
      scheduled: false,
      reason: dryRun ? "manual-script-dry-run" : "manual-script-live",
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await runtime.shutdown("demo-ringout-script-complete");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
