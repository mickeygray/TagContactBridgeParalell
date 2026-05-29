"use strict";

// Local EX AI Monitor manager.
//
// Watches UserAccount.metadata.aiMonitor pairings and starts one headless
// RingEX live monitor per recently-active CX workspace user. This keeps the
// experimental softphone/transcription process outside the live web server:
// login/workspace presence is the signal, but the monitor process is managed
// here.
//
// Examples:
//   node scripts/run-ex-live-monitor-manager.js --active-only
//   node scripts/run-ex-live-monitor-manager.js --email mgray@taxadvocategroup.com --once
//   node scripts/run-ex-live-monitor-manager.js --all --max-agents 7
//   node scripts/run-ex-live-monitor-manager.js --supervisor-owner-ext 101 --active-only

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const { getSharedConfig } = require("../packages/shared-config/src");
const { UserAccount, AgentState } = require("../packages/shared-models/src");

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

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanString(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isRecentDate(value, maxAgeMs) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > 0 && Date.now() - time <= maxAgeMs;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizePresence(agentState, maxAgeMs) {
  const presence = agentState?.appPresence && typeof agentState.appPresence === "object"
    ? agentState.appPresence
    : {};
  const lastSeenAt = presence.lastSeenAt || presence.updatedAt || null;
  const fresh = Boolean(presence.cxWorkspaceActive) && isRecentDate(lastSeenAt, maxAgeMs);
  return {
    active: Boolean(presence.cxWorkspaceActive),
    fresh,
    lastSeenAt,
    source: presence.source || null,
    userEmail: presence.userEmail || null,
  };
}

function buildMonitorArgs(agent, options) {
  const monitor = agent?.metadata?.aiMonitor || {};
  const agentExt = cleanString(agent.extensionNumber);
  const supervisorExt = cleanString(
    options.supervisorOwnerExt || monitor.extensionNumber || agent.metadata?.monitorExtensionNumber,
  );
  if (!agentExt || !supervisorExt) return null;
  if (agentExt === supervisorExt) {
    console.warn(
      `[monitor-manager] skipping ${agent.email || agent.name || agentExt}: agent extension equals supervisor extension (${agentExt}); self-monitoring loops on the monitor leg`,
    );
    return null;
  }

  const port = options.basePort + options.portOffset;
  const args = [
    path.resolve(__dirname, "rc-ex-live-trainer-oneoff.js"),
    "--supervise",
    "--agent-ext", agentExt,
    "--supervisor-ext", supervisorExt,
    "--dashboard-port", String(port),
    "--stt-model", options.sttModel,
    "--stt-response-format", options.sttResponseFormat,
    "--call-flow", "outbound",
    "--initial-human-speaker", "prospect",
    "--chunk-sec", String(options.chunkSec),
    "--sentence-hold-ms", String(options.sentenceHoldMs),
    "--coach-every-sec", String(options.coachEverySec),
    "--supervise-wait-sec", String(options.superviseWaitSec),
    "--supervise-poll-ms", String(options.supervisePollMs),
    "--timeout-sec", String(options.timeoutSec),
  ];

  if (options.eventGated) {
    args.push(
      "--event-gated",
      "--event-gate-active-sec", String(options.eventGateActiveSec),
      "--event-gate-agent-email", cleanEmail(agent.email),
    );
  }
  if (options.fakeEventGate) args.push("--fake-event-gate");
  if (options.splitOnSilence) {
    args.push(
      "--split-on-silence",
      "--silence-split-ms", String(options.silenceSplitMs),
      "--speech-packet-active-pct", String(options.speechPacketActivePct),
      "--speech-packet-max-abs", String(options.speechPacketMaxAbs),
    );
  }
  if (options.stageUntilSilence) args.push("--stage-until-silence");
  if (options.noMaxChunk) args.push("--no-max-chunk");
  if (options.prospectOnlyCoach) {
    args.push("--prospect-only-coach");
    if (options.prospectCoachProvider) args.push("--prospect-coach-provider", options.prospectCoachProvider);
    if (options.prospectCoachModel) args.push("--prospect-coach-model", options.prospectCoachModel);
    if (options.prospectCoachServiceTier) args.push("--prospect-coach-service-tier", options.prospectCoachServiceTier);
    if (options.prospectCoachPlaybookFile) args.push("--prospect-coach-playbook-file", options.prospectCoachPlaybookFile);
    if (options.prospectCoachPlaybookMaxChars) args.push("--prospect-coach-playbook-max-chars", String(options.prospectCoachPlaybookMaxChars));
    if (options.prospectCoachTimeoutMs) args.push("--prospect-coach-timeout-ms", String(options.prospectCoachTimeoutMs));
  }
  if (/diarize/i.test(options.sttModel)) {
    args.push("--chunking-strategy", "auto", "--no-speaker-labels");
  } else {
    args.push("--speaker-labels");
  }

  return {
    args,
    port,
    agentExt,
    supervisorExt,
    supervisorSource: options.supervisorOwnerExt ? "owner-override" : "agent-metadata",
  };
}

async function loadCandidates(options) {
  const query = {
    status: "active",
  };
  if (!options.supervisorOwnerExt || options.requireAiMonitor) {
    query["metadata.aiMonitor.enabled"] = true;
  }
  if (options.email) query.email = options.email;
  if (!options.all && !options.email) {
    query.extensionNumber = { $ne: null };
  }

  const users = await UserAccount.find(query)
    .sort({ name: 1, email: 1 })
    .lean();
  const rows = [];
  for (const user of users) {
    const monitor = user?.metadata?.aiMonitor || {};
    const agentExt = cleanString(user.extensionNumber);
    const supervisorExt = cleanString(
      options.supervisorOwnerExt || monitor.extensionNumber || user.metadata?.monitorExtensionNumber,
    );
    if (!agentExt || !supervisorExt) continue;

    const agentState = user.extensionId
      ? await AgentState.findOne({ extensionId: String(user.extensionId) }).lean()
      : null;
    const presence = summarizePresence(agentState, options.presenceTtlMs);
    if (options.activeOnly && !presence.fresh) continue;
    rows.push({
      user,
      agentState,
      presence,
    });
  }

  return rows.slice(0, options.maxAgents);
}

function startMonitor(row, options, running) {
  const key = cleanEmail(row.user.email);
  if (running.has(key)) return running.get(key);
  const cooldownUntil = options.cooldowns.get(key) || 0;
  if (cooldownUntil > Date.now()) {
    const waitSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
    console.log(`[monitor-manager] cooling down ${key}; retry in ${waitSeconds}s`);
    return null;
  }

  const launchOptions = {
    ...options,
    portOffset: running.size,
  };
  const built = buildMonitorArgs(row.user, launchOptions);
  if (!built) return null;

  fs.mkdirSync(options.logDir, { recursive: true });
  const safeEmail = key.replace(/[^a-z0-9_.-]+/gi, "_");
  const stamp = timestampForFile();
  const outPath = path.join(options.logDir, `${safeEmail}-${stamp}.out.log`);
  const errPath = path.join(options.logDir, `${safeEmail}-${stamp}.err.log`);
  const out = fs.openSync(outPath, "a");
  const err = fs.openSync(errPath, "a");

  const child = spawn(process.execPath, built.args, {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    windowsHide: true,
    stdio: ["ignore", out, err],
  });

  const record = {
    key,
    pid: child.pid,
    email: key,
    name: row.user.name,
    agentExt: built.agentExt,
    supervisorExt: built.supervisorExt,
    supervisorSource: built.supervisorSource,
    port: built.port,
    outPath,
    errPath,
    startedAt: nowIso(),
    child,
  };
  running.set(key, record);

  child.on("exit", (code, signal) => {
    running.delete(key);
    const cleanExit = code === 0 || signal === "SIGINT" || signal === "SIGTERM";
    if (!cleanExit) {
      options.cooldowns.set(key, Date.now() + options.failureCooldownMs);
    }
    fs.closeSync(out);
    fs.closeSync(err);
    console.log(`[monitor-manager] exited ${key} pid=${record.pid} code=${code} signal=${signal || ""}`);
  });

  console.log(
    `[monitor-manager] started ${record.name} <${record.email}> agent=${record.agentExt} monitor=${record.supervisorExt} source=${record.supervisorSource} pid=${record.pid} dashboard=http://127.0.0.1:${record.port}/`,
  );
  return record;
}

async function syncOnce(options, running) {
  const rows = await loadCandidates(options);
  const desired = new Set(rows.map((row) => cleanEmail(row.user.email)));

  for (const row of rows) {
    if (options.dryRun) {
      const built = buildMonitorArgs(row.user, { ...options, portOffset: running.size });
      if (built) {
        console.log(
          `[monitor-manager] dry-run ${row.user.name} <${cleanEmail(row.user.email)}> agent=${built.agentExt} monitor=${built.supervisorExt} source=${built.supervisorSource} dashboard=http://127.0.0.1:${built.port}/`,
        );
      }
      continue;
    }
    startMonitor(row, options, running);
    if (options.launchStaggerMs > 0) {
      await sleep(options.launchStaggerMs);
    }
  }

  if (options.stopStale) {
    for (const [key, record] of running.entries()) {
      if (desired.has(key)) continue;
      console.log(`[monitor-manager] stopping stale ${key} pid=${record.pid}`);
      record.child.kill("SIGINT");
      running.delete(key);
    }
  }

  console.log(
    `[monitor-manager] sync candidates=${rows.length} running=${running.size} activeOnly=${options.activeOnly}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const config = getSharedConfig();
  const options = {
    email: cleanEmail(readFlag(argv, "--email", "")),
    all: hasFlag(argv, "--all"),
    activeOnly: hasFlag(argv, "--active-only") || !hasFlag(argv, "--all"),
    once: hasFlag(argv, "--once"),
    dryRun: hasFlag(argv, "--dry-run"),
    stopStale: hasFlag(argv, "--stop-stale"),
    requireAiMonitor: hasFlag(argv, "--require-ai-monitor"),
    supervisorOwnerExt: cleanString(
      readFlag(
        argv,
        "--supervisor-owner-ext",
        readFlag(argv, "--supervisor-ext", process.env.EX_LIVE_MONITOR_OWNER_EXT || ""),
      ),
    ),
    maxAgents: Math.max(1, Number(readFlag(argv, "--max-agents", "1")) || 1),
    basePort: Math.max(1024, Number(readFlag(argv, "--base-port", "7332")) || 7332),
    intervalMs: Math.max(30000, Number(readFlag(argv, "--interval-ms", "60000")) || 60000),
    launchStaggerMs: Math.max(0, Number(readFlag(argv, "--launch-stagger-ms", "30000")) || 30000),
    failureCooldownMs: Math.max(60_000, Number(readFlag(argv, "--failure-cooldown-ms", "600000")) || 600000),
    presenceTtlMs: Math.max(30_000, Number(readFlag(argv, "--presence-ttl-ms", "300000")) || 300000),
    logDir: path.resolve(readFlag(argv, "--log-dir", path.join("runtime", "ex-live-monitor-manager"))),
    sttModel: readFlag(argv, "--stt-model", "gpt-4o-transcribe"),
    sttResponseFormat: readFlag(argv, "--stt-response-format", "json"),
    chunkSec: Math.max(1, Number(readFlag(argv, "--chunk-sec", "4")) || 4),
    splitOnSilence: !hasFlag(argv, "--no-split-on-silence"),
    stageUntilSilence: !hasFlag(argv, "--no-stage-until-silence"),
    noMaxChunk: hasFlag(argv, "--no-max-chunk"),
    silenceSplitMs: Math.max(500, Number(readFlag(argv, "--silence-split-ms", "2200")) || 2200),
    sentenceHoldMs: Math.max(0, Number(readFlag(argv, "--sentence-hold-ms", "1500")) || 1500),
    speechPacketActivePct: Math.max(0, Number(readFlag(argv, "--speech-packet-active-pct", "1.0")) || 1.0),
    speechPacketMaxAbs: Math.max(0, Number(readFlag(argv, "--speech-packet-max-abs", "1200")) || 1200),
    coachEverySec: Math.max(5, Number(readFlag(argv, "--coach-every-sec", "15")) || 15),
    prospectOnlyCoach: hasFlag(argv, "--prospect-only-coach")
      || String(process.env.EX_LIVE_MONITOR_PROSPECT_ONLY_COACH || "").toLowerCase() === "true",
    prospectCoachProvider: cleanString(readFlag(argv, "--prospect-coach-provider", process.env.LIVE_PROSPECT_COACH_PROVIDER || "")),
    prospectCoachModel: cleanString(readFlag(argv, "--prospect-coach-model", process.env.LIVE_PROSPECT_COACH_MODEL || "")),
    prospectCoachServiceTier: cleanString(readFlag(
      argv,
      "--prospect-coach-service-tier",
      process.env.LIVE_PROSPECT_COACH_SERVICE_TIER || process.env.LIVE_PROSPECT_COACH_OPENAI_SERVICE_TIER || "",
    )),
    prospectCoachPlaybookFile: cleanString(readFlag(
      argv,
      "--prospect-coach-playbook-file",
      process.env.LIVE_PROSPECT_COACH_PLAYBOOK_FILE || path.join("docs", "LIVE_PROSPECT_COACH_PLAYBOOK.md"),
    )),
    prospectCoachPlaybookMaxChars: Math.max(
      2000,
      Number(readFlag(argv, "--prospect-coach-playbook-max-chars", process.env.LIVE_PROSPECT_COACH_PLAYBOOK_MAX_CHARS || "7000")) || 7000,
    ),
    prospectCoachTimeoutMs: Math.max(
      3000,
      Number(readFlag(argv, "--prospect-coach-timeout-ms", process.env.LIVE_PROSPECT_COACH_TIMEOUT_MS || "15000")) || 15000,
    ),
    superviseWaitSec: Math.max(30, Number(readFlag(argv, "--supervise-wait-sec", "7200")) || 7200),
    supervisePollMs: Math.max(15000, Number(readFlag(argv, "--supervise-poll-ms", "60000")) || 60000),
    timeoutSec: Math.max(60, Number(readFlag(argv, "--timeout-sec", "7200")) || 7200),
    eventGated: hasFlag(argv, "--event-gated")
      || String(process.env.EX_LIVE_MONITOR_EVENT_GATED || "").toLowerCase() === "true"
      || String(process.env.EX_LIVE_MONITOR_APP_EVENT_GATED || "").toLowerCase() === "true",
    fakeEventGate: hasFlag(argv, "--fake-event-gate")
      || String(process.env.EX_LIVE_MONITOR_FAKE_EVENT_GATE || "").toLowerCase() === "true",
    eventGateActiveSec: Math.max(30, Number(readFlag(argv, "--event-gate-active-sec", "2700")) || 2700),
  };
  options.cooldowns = new Map();

  if (!config.mongoUri) throw new Error("MONGO_URI is required");
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  console.log(`[monitor-manager] connected mongo db=${mongoose.connection.name}`);
  console.log(`[monitor-manager] mode ${options.email ? `email=${options.email}` : options.all ? "all" : "active-only"} basePort=${options.basePort}`);
  if (options.supervisorOwnerExt) {
    console.log(`[monitor-manager] supervisor owner override ext=${options.supervisorOwnerExt}`);
  }

  const running = new Map();
  const shutdown = async () => {
    console.log("[monitor-manager] shutting down");
    for (const record of running.values()) {
      record.child.kill("SIGINT");
    }
    await mongoose.disconnect().catch(() => null);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await syncOnce(options, running);
  if (options.once || options.dryRun) {
    await mongoose.disconnect();
    return;
  }

  setInterval(() => {
    syncOnce(options, running).catch((error) => {
      console.error(`[monitor-manager] sync failed: ${error.message}`);
    });
  }, options.intervalMs);
}

main().catch((error) => {
  console.error(`[monitor-manager] fatal: ${error.message}`);
  process.exit(1);
});
