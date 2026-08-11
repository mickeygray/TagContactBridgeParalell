"use strict";

// Detached, Mongo-independent last-resort nightly sender. This script is
// intentionally tiny so it can still run when the control-plane's database
// connection or nightly task graph is the thing that failed.

const {
  DEFAULT_STATE_FILE,
  sendEmergencyNightlyClose,
} = require("../packages/shared-services/src/nightlyEmergencyCloseService");

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] != null ? process.argv[index + 1] : fallback;
}

async function main() {
  const dateKey = arg("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) {
    throw new Error("send-nightly-emergency-close requires --date YYYY-MM-DD");
  }
  await sendEmergencyNightlyClose({
    dateKey,
    reasonCode: arg("reason", "pipeline-failed"),
    taskKey: arg("task"),
    stateFile: arg("state", DEFAULT_STATE_FILE),
  });
}

main().catch(() => {
  process.exitCode = 1;
});
