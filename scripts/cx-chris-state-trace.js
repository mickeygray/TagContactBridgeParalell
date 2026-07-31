#!/usr/bin/env node
"use strict";

// Short-lived, PII-free RingCX agent-state trace for Chris.
//
//   node scripts/cx-chris-state-trace.js run
//   node scripts/cx-chris-state-trace.js stop
//
// Read-only: this script never logs out an agent or mutates RingCX. It records
// every state change plus a periodic heartbeat, then stops automatically.

const fs = require("fs");
const path = require("path");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const {
  createRingcxVoiceClient,
} = require("../packages/shared-integrations/src/ringcxVoiceClient");
const {
  activeCallRows,
  callMatchesAgent,
  isSoftphoneLogin,
  loginState,
  offhookCount,
} = require("./cx-suspect-watchdog");

const TARGET = Object.freeze({
  name: "Chris",
  agentId: "21810",
  agentGroupId: "2187",
});
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_DURATION_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 15_000;
const RUNTIME_DIR = path.resolve(__dirname, "..", "runtime", "cx-chris-state-trace");
const PID_PATH = path.join(RUNTIME_DIR, "trace.pid");
const LOG_PATH = path.join(
  RUNTIME_DIR,
  `trace-${new Date().toISOString().slice(0, 10)}.jsonl`,
);

function str(value) {
  return String(value == null ? "" : value).trim();
}

function readFlag(argv, name, fallback) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && index < argv.length - 1 && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

function safeError(error) {
  return {
    status: Number(error?.status || error?.statusCode) || null,
    code: str(error?.code) || null,
    message: str(error?.message || error)
      .replace(/\b\d{7,}\b/g, "[masked]")
      .slice(0, 160),
  };
}

function emit(event, details = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const row = {
    at: new Date().toISOString(),
    event,
    agent: TARGET.name,
    ...details,
  };
  const line = JSON.stringify(row);
  fs.appendFileSync(LOG_PATH, `${line}\n`, "utf8");
  console.log(line);
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimPid() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const prior = readPid();
  if (prior && alive(prior)) throw new Error("Chris state trace is already running");
  fs.writeFileSync(PID_PATH, `${process.pid}\n`, "utf8");
}

function releasePid() {
  if (readPid() !== process.pid) return;
  try {
    fs.unlinkSync(PID_PATH);
  } catch {}
}

function signature(snapshot) {
  return JSON.stringify(snapshot);
}

async function snapshot(client) {
  const [loginResult, callsResult] = await Promise.allSettled([
    client.getAgentLogin(TARGET.agentId, TARGET.agentGroupId),
    client.listActiveCalls({
      product: "ACCOUNT",
      productId: process.env.RINGCX_VOICE_ACCOUNT_ID,
    }),
  ]);

  const login = loginResult.status === "fulfilled" ? loginResult.value : null;
  const calls = callsResult.status === "fulfilled"
    ? activeCallRows(callsResult.value)
    : [];
  return {
    loginPresent: Boolean(login),
    state: login ? loginState(login) : "LOGGED_OUT",
    softphone: login ? isSoftphoneLogin(login) : false,
    liveOffhookCount: login ? offhookCount(login) : 0,
    hasActiveCall: calls.some((row) => callMatchesAgent(row, TARGET.agentId)),
    loginReadOk: loginResult.status === "fulfilled",
    activeCallReadOk: callsResult.status === "fulfilled",
    loginError: loginResult.status === "rejected"
      ? safeError(loginResult.reason)
      : null,
    activeCallError: callsResult.status === "rejected"
      ? safeError(callsResult.reason)
      : null,
  };
}

async function run(argv) {
  const intervalMs = Math.max(500, Number(readFlag(argv, "--interval-ms", DEFAULT_INTERVAL_MS)) || DEFAULT_INTERVAL_MS);
  const durationMs = Math.max(10_000, Number(readFlag(argv, "--duration-ms", DEFAULT_DURATION_MS)) || DEFAULT_DURATION_MS);
  claimPid();

  let stopping = false;
  let lastSignature = null;
  let lastHeartbeatAt = 0;
  let samples = 0;
  const startedAt = Date.now();
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    emit("trace.stopping", { reason, samples });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  emit("trace.started", { intervalMs, durationMs });
  while (!stopping && Date.now() - startedAt < durationMs) {
    const observed = await snapshot(createRingcxVoiceClient());
    samples += 1;
    const nextSignature = signature(observed);
    const heartbeatDue = Date.now() - lastHeartbeatAt >= HEARTBEAT_MS;
    if (nextSignature !== lastSignature || heartbeatDue) {
      emit(nextSignature !== lastSignature ? "trace.state_changed" : "trace.heartbeat", {
        sample: samples,
        ...observed,
      });
      lastSignature = nextSignature;
      lastHeartbeatAt = Date.now();
    }
    if (!stopping) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  if (!stopping) emit("trace.completed", { reason: "duration-complete", samples });
  releasePid();
}

function stop() {
  const pid = readPid();
  if (!pid || !alive(pid)) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch {}
    emit("trace.stop_noop", { reason: "not-running" });
    return;
  }
  process.kill(pid, "SIGTERM");
  emit("trace.stop_requested");
}

async function main() {
  const argv = process.argv.slice(2);
  const command = str(argv[0] || "run").toLowerCase();
  if (command === "stop") {
    stop();
    return;
  }
  if (command !== "run") throw new Error(`unknown command: ${command}`);
  await run(argv);
}

main()
  .catch((error) => {
    emit("trace.fatal", { error: safeError(error) });
    releasePid();
    process.exitCode = 1;
  })
  .finally(releasePid);
