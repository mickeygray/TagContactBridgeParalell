"use strict";

const { execSync } = require("child_process");

const TARGET_PORTS = [3001, 4001, 4002, 5001, 6101];

function readListeningPortOwners() {
  const owners = new Map();
  try {
    const output = execSync("netstat -ano -p tcp", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("TCP")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddress = parts[1];
      const state = parts[3];
      const pidText = parts[4];
      if (state !== "LISTENING") continue;
      const port = Number(localAddress.split(":").pop());
      const pid = Number(pidText);
      if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
      if (!TARGET_PORTS.includes(port)) continue;
      owners.set(port, pid);
    }
  } catch (error) {
    console.error("[dev:stop] Failed to inspect listening ports:", error.message);
    process.exit(1);
  }
  return owners;
}

const owners = readListeningPortOwners();
const uniquePids = [...new Set([...owners.values()])];

if (uniquePids.length === 0) {
  console.log("[dev:stop] No TagContactBridgeParallel dev ports are currently listening.");
  process.exit(0);
}

for (const pid of uniquePids) {
  try {
    execSync(`taskkill /PID ${pid} /F`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(`[dev:stop] Killed PID ${pid}.`);
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    const stdout = String(error.stdout || "").trim();
    const detail = stderr || stdout || error.message;
    console.error(`[dev:stop] Failed to kill PID ${pid}: ${detail}`);
    process.exitCode = 1;
  }
}

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log("[dev:stop] Parallel dev ports cleared.");
