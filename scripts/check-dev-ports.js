"use strict";

const { execSync } = require("child_process");

const REQUIRED_PORTS = [
  { port: 3001, name: "web-client" },
  { port: 4001, name: "inbound-gateway" },
  { port: 4002, name: "outbound-gateway" },
  { port: 5001, name: "control-plane" },
  { port: 6101, name: "ringcentral-cx" },
];

function readListeningPorts() {
  try {
    const output = execSync("netstat -ano -p tcp", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const listeners = new Map();
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || !line.startsWith("TCP")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;
      const localAddress = parts[1];
      const state = parts[3];
      const pidText = parts[4];
      if (state !== "LISTENING") continue;
      const portText = localAddress.split(":").pop();
      const port = Number(portText);
      const pid = Number(pidText);
      if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
      listeners.set(port, pid);
    }
    return listeners;
  } catch (error) {
    console.error("[dev:preflight] Failed to inspect listening ports:", error.message);
    process.exit(1);
  }
}

function readProcessLabel(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return "";
  try {
    const output = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId=${pid}\\" | Select-Object -ExpandProperty CommandLine"`,
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (output) return output;
  } catch {
    // fall through
  }

  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output) return output;
  } catch {
    // ignore
  }

  return "";
}

const listeners = readListeningPorts();
const collisions = REQUIRED_PORTS
  .map((entry) => ({
    ...entry,
    pid: listeners.get(entry.port) || null,
  }))
  .filter((entry) => entry.pid);

if (collisions.length === 0) {
  console.log("[dev:preflight] Required dev ports are free.");
  process.exit(0);
}

console.error("[dev:preflight] One or more TagContactBridgeParallel dev ports are already in use:");
for (const collision of collisions) {
  const detail = readProcessLabel(collision.pid);
  console.error(
    `  - ${collision.name} port ${collision.port} is owned by PID ${collision.pid}${
      detail ? ` :: ${detail}` : ""
    }`,
  );
}
console.error("[dev:preflight] Run `npm run dev:stop` to clear the parallel dev stack ports, then try again.");
process.exit(1);
