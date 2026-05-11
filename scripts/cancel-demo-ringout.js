"use strict";

const { createRingCentralClient } = require("../packages/shared-integrations/src");

function readArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function main() {
  const extensionId = readArg("--extension-id", process.env.DEMO_RINGOUT_EXTENSION_ID || "~");
  const ringOutId = readArg("--ringout-id");
  if (!ringOutId) {
    throw new Error("--ringout-id is required");
  }
  const client = createRingCentralClient();
  const response = await client.deleteRingOut(extensionId, ringOutId);
  process.stdout.write(`${JSON.stringify({ ok: true, extensionId, ringOutId, response: response || null }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
