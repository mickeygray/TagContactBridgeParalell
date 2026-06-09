#!/usr/bin/env node
"use strict";

// Local helper: restart only the RingCX -> AI bus gRPC bridge with a chosen
// realtime transcription model. Leaves the AI bus and ngrok alone.

const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const LOG_DIR = path.join(ROOT, "runtime", "live-coach-grpc-bridge");

const MODEL_ALIASES = new Map([
  ["4o", "gpt-4o-transcribe"],
  ["4o-transcribe", "gpt-4o-transcribe"],
  ["gpt-4o", "gpt-4o-transcribe"],
  ["gpt-4o-transcribe", "gpt-4o-transcribe"],
  ["realtime-whisper", "gpt-realtime-whisper"],
  ["rt-whisper", "gpt-realtime-whisper"],
  ["gpt-realtime-whisper", "gpt-realtime-whisper"],
  ["whisper", "gpt-realtime-whisper"],
  ["whisper-1", "whisper-1"],
]);

const SIDE_BY_SIDE_MAP = "bhansen=gpt-realtime-whisper,cbolt=gpt-4o-transcribe";

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function runPowerShell(command) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  ).trim();
}

function listeningPids(port) {
  const raw = runPowerShell(
    `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue ` +
      "| Select-Object -ExpandProperty OwningProcess -Unique",
  );
  return raw
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter(Boolean);
}

function stopPort(port) {
  const pids = listeningPids(port).filter((pid) => pid !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  return pids;
}

async function waitForPort(port, expectedPid, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pids = listeningPids(port);
    if (pids.includes(expectedPid)) return pids;
    if (pids.length) return pids;
    await sleep(250);
  }
  return listeningPids(port);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = String(argv[0] || "").trim().toLowerCase();
  const sideBySide = mode === "side-by-side" || mode === "sidebyside" || mode === "brad-chris";
  const requested = readFlag(argv, "--model", sideBySide ? "4o" : argv[0] || "4o").trim().toLowerCase();
  const model = MODEL_ALIASES.get(requested) || requested;
  const port = Number(readFlag(argv, "--port", "3344")) || 3344;
  const aiBusUrl = readFlag(argv, "--ai-bus-url", "http://127.0.0.1:7000");
  const eagerness = readFlag(argv, "--eagerness", "high");
  const modelMap = readFlag(argv, "--stt-model-map", readFlag(argv, "--model-map", sideBySide ? SIDE_BY_SIDE_MAP : ""));

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stopped = stopPort(port);
  await sleep(800);

  const logStamp = stamp();
  const outLog = path.join(LOG_DIR, `bridge-local-${logStamp}-${model}.out.log`);
  const errLog = path.join(LOG_DIR, `bridge-local-${logStamp}-${model}.err.log`);
  const outFd = fs.openSync(outLog, "a");
  const errFd = fs.openSync(errLog, "a");

  const childArgs = [
    "-r",
    "dotenv/config",
    "scripts/ringcx-grpc-live-coach-bridge.js",
    "--port",
    String(port),
    "--ai-bus-url",
    aiBusUrl,
    "--stt-provider",
    "openai-realtime",
    "--stt-model",
    model,
    "--turn-detection",
    "semantic_vad",
    "--semantic-vad-eagerness",
    eagerness,
  ];
  if (modelMap) {
    childArgs.push("--stt-model-map", modelMap);
  }

  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const listening = await waitForPort(port, child.pid);
  const tail = fs.existsSync(outLog)
    ? fs.readFileSync(outLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-10)
    : [];

  console.log(JSON.stringify({
    ok: listening.includes(child.pid),
    model,
    modelMap: modelMap || null,
    port,
    aiBusUrl,
    eagerness,
    stoppedPids: stopped,
    pid: child.pid,
    listeningPids: listening,
    outLog,
    errLog,
    tail,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
});
