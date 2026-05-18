"use strict";

// Long-running blogger daemon. Replaces the two Windows Task Scheduler
// entries (WynnTAGBlogger + WynnTAGBloggerHealth). Wrapped by NSSM so
// it survives crashes + auto-restarts on reboot, no logged-in-user
// requirement.
//
// Behavior:
//   - Wakes every 60s. Checks if today's PT date already has a
//     completed run (state.lastRunDate). If yes, sleeps.
//   - If now is past 8:00 AM PT (the scheduled fire time) and we
//     haven't fired today, run the daily flow.
//   - Weekend days are no-ops (state still updated so we don't keep
//     re-checking — same idempotency guard as the manual runner).
//   - Health check: if lastRunDate is more than 1 weekday behind
//     today, email an alert (covers the case where NSSM restarts so
//     fast we never sleep into the firing window).
//
// Why a polling daemon instead of node-cron / cron parser:
//   - The existing daily-runner code is already idempotent on
//     state.lastRunDate. Polling once a minute and short-circuiting
//     on "already ran today" is simpler than wiring a cron lib
//     correctly across DST + sleep/wake boundaries.
//   - NSSM auto-restart means we never need to worry about resilience
//     to unexpected crashes — the daemon comes right back, sees
//     state.lastRunDate, and decides what to do.

const path = require("path");
const fs = require("fs");

require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const STATE_FILE = path.resolve(__dirname, "blogger-state.json");
const RUNNER_PATH = path.resolve(__dirname, "blogger-daily-runner.js");
const RUNTIME_DIR = path.resolve(__dirname, "..", "runtime", "blogger");
const RUN_LOG_DIR = path.join(RUNTIME_DIR, "runs");
const DAEMON_LOG = path.join(RUNTIME_DIR, "blogger-daemon.log");
const LOCK_FILE = path.join(RUNTIME_DIR, "blogger-daemon.lock");

// 8 AM PT is the daily fire time. Polled rather than scheduled, so a
// process restart 5 minutes before the window doesn't miss it.
// FIRE_MINUTE_PT defaults to 0 (top of the hour). Bump temporarily for
// cron verification — e.g. set to 45 to fire at 8:45 PT instead of
// 8:00 PT — and restore to 0 after the test.
const FIRE_HOUR_PT = readPositiveIntEnv("BLOGGER_FIRE_HOUR_PT", 8);
const FIRE_MINUTE_PT = readPositiveIntEnv("BLOGGER_FIRE_MINUTE_PT", 0);
const POLL_MS = Math.max(readPositiveIntEnv("BLOGGER_POLL_MS", 60 * 1000), 15 * 1000);
const RUNNER_TIMEOUT_MS = Math.max(
  readPositiveIntEnv("BLOGGER_RUNNER_TIMEOUT_MS", 90 * 60 * 1000),
  5 * 60 * 1000,
);
const LOCK_STALE_MS = Math.max(
  readPositiveIntEnv("BLOGGER_LOCK_STALE_MS", 2 * 60 * 60 * 1000),
  RUNNER_TIMEOUT_MS,
);
const RUN_ON_START = String(process.env.BLOGGER_RUN_ON_START || "true").toLowerCase() !== "false";

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function ensureRuntimeDirs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(RUN_LOG_DIR, { recursive: true });
}

function nowInPT() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayOfWeek: new Date(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    ).getDay(),
  };
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function isWeekday(dayOfWeek) {
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

// Each fire spawns the daily-runner as a child node process. Spawning
// (vs. require()-ing) means a hard crash inside the runner doesn't
// take the daemon down — NSSM auto-restart handles a daemon crash,
// but a runner crash should be isolated and visible in logs.
const { spawn } = require("child_process");

function acquireRunLock() {
  ensureRuntimeDirs();
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2), "utf8");
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") {
      log(`[daemon] lock failed: ${err.message}`);
      return false;
    }
    try {
      const stat = fs.statSync(LOCK_FILE);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs >= LOCK_STALE_MS) {
        fs.unlinkSync(LOCK_FILE);
        log(`[daemon] removed stale lock ageMs=${Math.round(ageMs)}`);
        return acquireRunLock();
      }
      log(`[daemon] run already locked ageMs=${Math.round(ageMs)}`);
      return false;
    } catch (statErr) {
      log(`[daemon] lock inspection failed: ${statErr.message}`);
      return false;
    }
  }
}

function releaseRunLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (err) {
    log(`[daemon] lock release failed: ${err.message}`);
  }
}

function runLogPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(RUN_LOG_DIR, `${stamp}.log`);
}

function runDailyOnce() {
  if (!acquireRunLock()) {
    return Promise.resolve({ code: null, skipped: "locked" });
  }
  return new Promise((resolve) => {
    const childLogPath = runLogPath();
    const childLog = fs.createWriteStream(childLogPath, { flags: "a" });
    log(`[daemon] firing daily-runner at ${new Date().toISOString()} log=${childLogPath}`);
    childLog.write(`[${new Date().toISOString()}] daily-runner start\n`);
    const child = spawn(process.execPath, [RUNNER_PATH], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      childLog.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      childLog.write(chunk);
    });

    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      log(`[daemon] daily-runner exceeded timeoutMs=${RUNNER_TIMEOUT_MS}; terminating`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 10 * 1000).unref();
    }, RUNNER_TIMEOUT_MS);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      childLog.write(`[${new Date().toISOString()}] daily-runner finish ${JSON.stringify(result)}\n`);
      childLog.end();
      releaseRunLock();
      resolve(result);
    }

    child.on("close", (code, signal) => {
      log(`[daemon] daily-runner exited code=${code} signal=${signal || "none"} timedOut=${timedOut}`);
      finish({ code, signal, timedOut, log: childLogPath });
    });
    child.on("error", (err) => {
      log(`[daemon] daily-runner failed to spawn: ${err.message}`);
      finish({ code: -1, error: err.message, log: childLogPath });
    });
  });
}

// Health alarm — if state.lastRunDate is more than two weekdays behind
// today, the daemon has either been crash-looping or never ran. Send
// a one-time alert per stale state so we don't spam.
let lastHealthAlertDate = null;

async function maybeSendHealthAlert(now, state) {
  if (lastHealthAlertDate === now.dateKey) return;
  if (!state.lastRunDate) {
    // First boot — no history yet. Skip alert.
    return;
  }
  const lastRunMs = Date.parse(`${state.lastRunDate}T12:00:00Z`);
  const todayMs = Date.parse(`${now.dateKey}T12:00:00Z`);
  const dayGap = Math.round((todayMs - lastRunMs) / (24 * 60 * 60 * 1000));
  // Walk back from today, count weekdays. Two missing weekdays = alert.
  let weekdayMissing = 0;
  for (let offset = 0; offset < dayGap; offset += 1) {
    const ms = todayMs - offset * 24 * 60 * 60 * 1000;
    const dow = new Date(ms).getDay();
    if (dow >= 1 && dow <= 5) weekdayMissing += 1;
  }
  if (weekdayMissing < 2) return;

  log(`[daemon] HEALTH ALERT — last run ${state.lastRunDate}, ${weekdayMissing} weekdays missed`);
  try {
    const { sendPlainEmail } = require(
      "../packages/shared-services/src/sendgridMailService",
    );
    const { getInternalFromEmail } = require("../packages/shared-config/src");
    const fromEmail = getInternalFromEmail();
    await sendPlainEmail("TAG", {
      personalizations: [
        {
          to: [{ email: "mgray@taxadvocategroup.com" }],
          custom_args: { channel: "blogger-daemon-health", today: now.dateKey },
        },
      ],
      from: { email: fromEmail, name: "Blogger Daemon" },
      reply_to: { email: fromEmail, name: "Blogger Daemon" },
      subject: `[BLOGGER ALERT] Daemon hasn't posted in ${weekdayMissing} weekdays`,
      content: [
        {
          type: "text/plain",
          value: [
            `The blogger daemon hasn't recorded a run since ${state.lastRunDate}.`,
            `Today is ${now.dateKey}, gap = ${weekdayMissing} weekday(s).`,
            "",
            "Likely causes:",
            "  - Daemon crashing in a loop (check NSSM service status + parallel-parallelblogger.err.log)",
            "  - Sonnet API down for an extended window (check Anthropic status)",
            "  - State file corrupted (scripts/blogger-state.json)",
            "",
            "Manual run: node scripts/blogger-daily-runner.js --force",
            "Service status: Get-Service ParallelBlogger",
          ].join("\n"),
        },
      ],
    });
    lastHealthAlertDate = now.dateKey;
  } catch (err) {
    log(`[daemon] failed to send health alert: ${err.message}`);
  }
}

function log(message) {
  // Always include a timestamp. NSSM captures stdout to disk so this is
  // grep-friendly later. Also write our own file log so Scheduler/NSSM
  // wiring mistakes are diagnosable.
  const line = `[${new Date().toISOString()}] ${message}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    ensureRuntimeDirs();
    fs.appendFileSync(DAEMON_LOG, `${line}\n`, "utf8");
  } catch {
    // If disk logging fails, stdout is still better than crashing.
  }
}

async function tick() {
  const now = nowInPT();
  const state = readState();

  // Already ran today — nothing to do.
  if (state.lastRunDate === now.dateKey) return;

  // Health check (independent of fire-time check)
  await maybeSendHealthAlert(now, state);

  if (!isWeekday(now.dayOfWeek)) {
    // Weekend — no-op for fire, but mark state so we don't keep
    // sending health alerts on Saturday for a Friday post that
    // already happened. Skip the state write if state already
    // matches.
    return;
  }

  if (
    now.hour < FIRE_HOUR_PT ||
    (now.hour === FIRE_HOUR_PT && now.minute < FIRE_MINUTE_PT)
  ) {
    // Too early today — wait for the window.
    return;
  }

  // Past the fire window, today is a weekday, and we haven't run yet → fire.
  await runDailyOnce();
  // The runner writes its own state on success/failure. We don't
  // touch it here.
}

async function main() {
  log("[daemon] blogger daemon starting");
  log(`[daemon] state file: ${STATE_FILE}`);
  log(`[daemon] runner:     ${RUNNER_PATH}`);
  log(`[daemon] runtime:    ${RUNTIME_DIR}`);
  log(
    `[daemon] fire window: ${FIRE_HOUR_PT}:${String(FIRE_MINUTE_PT).padStart(2, "0")} PT, weekdays only`,
  );
  log(`[daemon] pollMs=${POLL_MS} runnerTimeoutMs=${RUNNER_TIMEOUT_MS} runOnStart=${RUN_ON_START}`);

  // Run the tick immediately at startup — covers the case where the
  // service starts after 8 AM PT (e.g. after a reboot at 9). After
  // that, poll every minute.
  if (RUN_ON_START) {
    await tick().catch((err) => log(`[daemon] tick error: ${err.message}`));
  } else {
    log("[daemon] startup tick disabled by BLOGGER_RUN_ON_START=false");
  }
  setInterval(() => {
    tick().catch((err) => log(`[daemon] tick error: ${err.message}`));
  }, POLL_MS);
}

main().catch((err) => {
  log(`[daemon] fatal: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown — NSSM sends SIGTERM on stop.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`[daemon] received ${sig}, exiting`);
    process.exit(0);
  });
}
