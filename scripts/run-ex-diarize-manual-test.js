"use strict";

// One-command dev harness for the EX live monitor diarization test.
//
// It starts the RingEX AI Monitor softphone on a temp local dashboard,
// waits for the monitor to register, then places the known-good RingCX
// manual outbound call using the browser-cookie request shape.
//
// Example:
//   npm run rc:live-monitor:diarize-manual -- --to 13106665997
//
// Dashboard default:
//   http://127.0.0.1:7332/

const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

function readFlag(argv, name, fallback = "") {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return fallback;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function maskPhone(value) {
  const digits = normalizePhone(value);
  if (!digits) return "";
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function scriptPath(name) {
  return path.resolve(__dirname, name);
}

function log(message) {
  console.log(`[ex-diarize-test] ${message}`);
}

function printHelp() {
  console.log(`RingEX diarize manual-call test

Usage:
  node scripts/run-ex-diarize-manual-test.js [options]
  npm.cmd run rc:live-monitor:diarize-manual -- [options]

Defaults are Mickey dev-test friendly:
  --agent-ext 101
  --supervisor-ext 987
  --dashboard-port 7332
  --username mgray+50810001_9702@taxadvocategroup.com
  --to 13106665997
  --caller-id 8182728593
  --stt-model gpt-4o-transcribe-diarize

Useful options:
  --no-dial                 Start only the EX monitor/dashboard
  --to PHONE                Destination/cell to dial
  --caller-id PHONE         RingCX outbound caller ID
  --chunk-sec 5             Seconds per transcription chunk
  --sentence-hold-ms 2000   Hold fragments briefly for sentence cleanup
  --supervise-wait-sec 600  How long AI Monitor waits for the live CX call
  --timeout-sec 900         Max monitor runtime

Dashboard:
  http://127.0.0.1:7332/
`);
}

function spawnNode(script, args, options = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    windowsHide: true,
    ...options,
  });
  return child;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    printHelp();
    return;
  }

  const dashboardPort = readFlag(argv, "--dashboard-port", "7332");
  const agentExt = readFlag(argv, "--agent-ext", process.env.EX_LIVE_MONITOR_AGENT_EXT || "101");
  const supervisorExt = readFlag(argv, "--supervisor-ext", process.env.EX_LIVE_MONITOR_SUPERVISOR_EXT || "987");
  const username = readFlag(
    argv,
    "--username",
    process.env.EX_LIVE_MONITOR_TEST_USERNAME
      || process.env.RINGCX_MANUAL_TEST_USERNAME
      || "mgray+50810001_9702@taxadvocategroup.com",
  );
  const destination = normalizePhone(readFlag(
    argv,
    "--to",
    process.env.EX_LIVE_MONITOR_TEST_TO || "13106665997",
  ));
  const callerId = normalizePhone(readFlag(
    argv,
    "--caller-id",
    process.env.EX_LIVE_MONITOR_TEST_CALLER_ID || "8182728593",
  ));
  const chunkSec = readFlag(argv, "--chunk-sec", "5");
  const sentenceHoldMs = readFlag(argv, "--sentence-hold-ms", "2000");
  const coachEverySec = readFlag(argv, "--coach-every-sec", "15");
  const timeoutSec = readFlag(argv, "--timeout-sec", "900");
  const superviseWaitSec = readFlag(argv, "--supervise-wait-sec", "600");
  const ringDuration = readFlag(argv, "--ring-duration", "20");
  const dialDelaySec = Math.max(0, Number(readFlag(argv, "--dial-delay-sec", "2")) || 0);
  const sttModel = readFlag(argv, "--stt-model", "gpt-4o-transcribe-diarize");
  const noDial = hasFlag(argv, "--no-dial");

  if (!agentExt) throw new Error("--agent-ext is required");
  if (!supervisorExt) throw new Error("--supervisor-ext is required");
  if (!noDial && !destination) throw new Error("--to is required unless --no-dial is set");
  if (!noDial && !callerId) throw new Error("--caller-id is required unless --no-dial is set");

  const monitorArgs = [
    "--supervise",
    "--agent-ext", agentExt,
    "--supervisor-ext", supervisorExt,
    "--dashboard-port", String(dashboardPort),
    "--stt-model", sttModel,
    "--stt-response-format", "diarized_json",
    "--no-speaker-labels",
    "--call-flow", "outbound",
    "--initial-human-speaker", "prospect",
    "--chunk-sec", String(chunkSec),
    "--sentence-hold-ms", String(sentenceHoldMs),
    "--coach-every-sec", String(coachEverySec),
    "--supervise-wait-sec", String(superviseWaitSec),
    "--timeout-sec", String(timeoutSec),
  ];

  log(`dashboard: http://127.0.0.1:${dashboardPort}/`);
  log(`monitor: EX ${supervisorExt} listening to agent EX ${agentExt}`);
  log(`stt: ${sttModel} / diarized_json`);
  if (!noDial) {
    log(`manual dial: ${username} -> ${maskPhone(destination)} callerId=${maskPhone(callerId)}`);
  }

  const monitor = spawnNode(scriptPath("rc-ex-live-trainer-oneoff.js"), monitorArgs);
  let dialStarted = false;
  let monitorExited = false;

  function stopMonitor() {
    if (!monitorExited) monitor.kill("SIGINT");
  }

  process.on("SIGINT", () => {
    log("stopping monitor");
    stopMonitor();
    process.exit(130);
  });

  async function startManualDial() {
    if (dialStarted || noDial) return;
    dialStarted = true;
    if (dialDelaySec > 0) {
      log(`monitor registered; placing manual call in ${dialDelaySec}s`);
      await new Promise((resolve) => setTimeout(resolve, dialDelaySec * 1000));
    }

    const dialArgs = [
      "--username", username,
      "--to", destination,
      "--caller-id", callerId,
      "--ring-duration", String(ringDuration),
      "--timeout-sec", "60",
    ];
    const dial = spawnNode(scriptPath("ringcx-manual-cookie-smoke.js"), dialArgs);
    dial.stdout.on("data", (chunk) => process.stdout.write(`[manual] ${chunk}`));
    dial.stderr.on("data", (chunk) => process.stderr.write(`[manual] ${chunk}`));
    dial.on("exit", (code) => {
      log(`manual dial exited with code ${code}`);
      if (code !== 0) {
        log("manual dial failed; monitor is still up briefly for inspection");
        setTimeout(stopMonitor, 5000);
      }
    });
  }

  monitor.stdout.on("data", (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[monitor] ${text}`);
    if (text.includes("[register] headless AI Monitor phone registered")) {
      void startManualDial();
    }
  });
  monitor.stderr.on("data", (chunk) => process.stderr.write(`[monitor] ${chunk}`));
  monitor.on("exit", (code) => {
    monitorExited = true;
    log(`monitor exited with code ${code}`);
    process.exit(code || 0);
  });
}

main().catch((error) => {
  console.error(`[ex-diarize-test] fatal: ${error.message}`);
  process.exit(1);
});
