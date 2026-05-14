"use strict";

const { execFileSync } = require("child_process");

const REQUIRED_PORTS = [
  { port: 3001, name: "web-client" },
  { port: 4001, name: "inbound-gateway" },
  { port: 4002, name: "outbound-gateway" },
  { port: 5001, name: "control-plane" },
  { port: 6101, name: "ringcentral-cx" },
];

function run(command, args = []) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readWindowsListeningPorts() {
  const output = run("netstat", ["-ano", "-p", "tcp"]);
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
    const port = Number(localAddress.split(":").pop());
    const pid = Number(pidText);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    listeners.set(port, pid);
  }
  return listeners;
}

function readLsofListeningPorts() {
  const output = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const listeners = new Map();
  for (const rawLine of output.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pid = Number(parts[1]);
    const match = line.match(/:(\d+)\s*(?:\(LISTEN\))?$/);
    const port = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    listeners.set(port, pid);
  }
  return listeners;
}

function readSsListeningPorts() {
  const output = run("ss", ["-ltnp"]);
  const listeners = new Map();
  for (const rawLine of output.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim();
    if (!line || !line.startsWith("LISTEN")) continue;
    const parts = line.split(/\s+/);
    const localAddress = parts[3] || "";
    const portMatch = localAddress.match(/:(\d+)$/);
    const pidMatch = line.match(/pid=(\d+)/);
    const port = portMatch ? Number(portMatch[1]) : NaN;
    const pid = pidMatch ? Number(pidMatch[1]) : NaN;
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    listeners.set(port, pid);
  }
  return listeners;
}

function readUnixNetstatListeningPorts() {
  const output = run("netstat", ["-ltnp"]);
  const listeners = new Map();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("tcp")) continue;
    const parts = line.split(/\s+/);
    const localAddress = parts[3] || "";
    const processInfo = parts[6] || "";
    const portMatch = localAddress.match(/:(\d+)$/);
    const pidMatch = processInfo.match(/^(\d+)\//);
    const port = portMatch ? Number(portMatch[1]) : NaN;
    const pid = pidMatch ? Number(pidMatch[1]) : NaN;
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    listeners.set(port, pid);
  }
  return listeners;
}

function readListeningPorts() {
  try {
    if (process.platform === "win32") return readWindowsListeningPorts();
    for (const reader of [readLsofListeningPorts, readSsListeningPorts, readUnixNetstatListeningPorts]) {
      try {
        const listeners = reader();
        if (listeners.size > 0) return listeners;
      } catch {
        // Try the next platform tool.
      }
    }
    return new Map();
  } catch (error) {
    console.error("[dev:preflight] Failed to inspect listening ports:", error.message);
    process.exit(1);
  }
}

function readProcessLabel(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return "";
  if (process.platform === "win32") {
    try {
      const output = run("powershell", [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
      ]).trim();
      if (output) return output;
    } catch {
      // fall through
    }

    try {
      const output = run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).trim();
      if (output) return output;
    } catch {
      // ignore
    }
    return "";
  }

  try {
    return run("ps", ["-p", String(pid), "-o", "args="]).trim();
  } catch {
    return "";
  }
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
