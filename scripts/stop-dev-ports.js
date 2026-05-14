"use strict";

const { execFileSync } = require("child_process");

const TARGET_PORTS = [3001, 4001, 4002, 5001, 6101];

function run(command, args = []) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readWindowsListeningPortOwners() {
  const owners = new Map();
  const output = run("netstat", ["-ano", "-p", "tcp"]);
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
  return owners;
}

function readLsofListeningPortOwners() {
  const owners = new Map();
  const output = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]);
  for (const rawLine of output.split(/\r?\n/).slice(1)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pid = Number(parts[1]);
    const match = line.match(/:(\d+)\s*(?:\(LISTEN\))?$/);
    const port = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(port) || !Number.isFinite(pid)) continue;
    if (!TARGET_PORTS.includes(port)) continue;
    owners.set(port, pid);
  }
  return owners;
}

function readSsListeningPortOwners() {
  const owners = new Map();
  const output = run("ss", ["-ltnp"]);
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
    if (!TARGET_PORTS.includes(port)) continue;
    owners.set(port, pid);
  }
  return owners;
}

function readUnixNetstatListeningPortOwners() {
  const owners = new Map();
  const output = run("netstat", ["-ltnp"]);
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
    if (!TARGET_PORTS.includes(port)) continue;
    owners.set(port, pid);
  }
  return owners;
}

function readListeningPortOwners() {
  try {
    if (process.platform === "win32") return readWindowsListeningPortOwners();
    for (const reader of [readLsofListeningPortOwners, readSsListeningPortOwners, readUnixNetstatListeningPortOwners]) {
      try {
        const owners = reader();
        if (owners.size > 0) return owners;
      } catch {
        // Try the next platform tool.
      }
    }
    return new Map();
  } catch (error) {
    console.error("[dev:stop] Failed to inspect listening ports:", error.message);
    process.exit(1);
  }
}

function killPid(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/F"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return;
  }
  process.kill(pid, "SIGTERM");
}

const owners = readListeningPortOwners();
const uniquePids = [...new Set([...owners.values()])];

if (uniquePids.length === 0) {
  console.log("[dev:stop] No TagContactBridgeParallel dev ports are currently listening.");
  process.exit(0);
}

for (const pid of uniquePids) {
  try {
    killPid(pid);
    console.log(`[dev:stop] Killed PID ${pid}.`);
  } catch (error) {
    if (error.code === "ESRCH") continue;
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
