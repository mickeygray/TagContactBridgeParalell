"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  recordServiceAlert,
  recordWorkflowStage,
} = require("../../../../packages/shared-services/src");
const {
  computeNextRunAt,
  normalizeActiveWeekdays,
} = require("./lexisNightlyService");

const PARALLEL_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CONTROL_RUN_LOG_DIR = path.join(
  PARALLEL_ROOT,
  "runtime",
  "blogger",
  "control-plane-runs",
);

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function resolveRuntimePath(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return path.resolve(raw);
}

function maskPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/\.pem$/i.test(raw)) return "<configured>";
  return raw;
}

function createBloggerState(config = {}) {
  const parallelRoot = resolveRuntimePath(config.parallelRoot, PARALLEL_ROOT);
  return {
    enabled: bool(config.enabled, false),
    running: false,
    hour: Number(config.hour ?? 8),
    minute: Number(config.minute ?? 0),
    intervalMs: Number(config.intervalMs || 60000),
    activeWeekdays: normalizeActiveWeekdays(config.activeWeekdays),
    timezone: config.timezone || "America/Los_Angeles",
    timeoutMs: Number(config.timeoutMs || 45 * 60 * 1000),
    parallelRoot,
    runnerPath: resolveRuntimePath(
      config.runnerPath,
      path.join(parallelRoot, "scripts", "blogger-daily-runner.js"),
    ),
    wynnRepo: resolveRuntimePath(config.wynnRepo, ""),
    tagRepo: resolveRuntimePath(config.tagRepo, ""),
    tcbDeployDir: resolveRuntimePath(config.tcbDeployDir, parallelRoot),
    deploy: {
      wynn: {
        repo: resolveRuntimePath(config.deploy?.wynn?.repo || config.wynnRepo, ""),
        host: config.deploy?.wynn?.host || "",
        user: config.deploy?.wynn?.user || "ubuntu",
        pem: resolveRuntimePath(config.deploy?.wynn?.pem, ""),
        remotePath: config.deploy?.wynn?.remotePath || "/var/www/WynnTax",
        pm2: config.deploy?.wynn?.pm2 || "backend",
        branch: config.deploy?.wynn?.branch || "master",
      },
      tag: {
        repo: resolveRuntimePath(config.deploy?.tag?.repo || config.tagRepo, ""),
        host: config.deploy?.tag?.host || "",
        user: config.deploy?.tag?.user || "ubuntu",
        pem: resolveRuntimePath(config.deploy?.tag?.pem, ""),
        remotePath: config.deploy?.tag?.remotePath || "/var/www/taxadvocategroup",
        pm2: config.deploy?.tag?.pm2 || "backend",
        branch: config.deploy?.tag?.branch || "master",
      },
    },
    timer: null,
    nextRunAt: null,
    lastRunId: null,
    activeRunId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastResult: null,
    lastError: null,
  };
}

function summarizeState(state) {
  return {
    enabled: state.enabled,
    running: state.running,
    hour: state.hour,
    minute: state.minute,
    intervalMs: state.intervalMs,
    activeWeekdays: state.activeWeekdays,
    timezone: state.timezone,
    timeoutMs: state.timeoutMs,
    nextRunAt: state.nextRunAt,
    activeRunId: state.activeRunId,
    lastRunId: state.lastRunId,
    lastStartedAt: state.lastStartedAt,
    lastCompletedAt: state.lastCompletedAt,
    lastResult: state.lastResult,
    lastError: state.lastError,
    routing: {
      parallelRoot: state.parallelRoot,
      runnerPath: state.runnerPath,
      wynnRepo: state.wynnRepo,
      tagRepo: state.tagRepo,
      tcbDeployDir: state.tcbDeployDir,
      deploy: {
        wynn: {
          repo: state.deploy.wynn.repo,
          host: state.deploy.wynn.host,
          user: state.deploy.wynn.user,
          pem: maskPath(state.deploy.wynn.pem),
          remotePath: state.deploy.wynn.remotePath,
          pm2: state.deploy.wynn.pm2,
          branch: state.deploy.wynn.branch,
        },
        tag: {
          repo: state.deploy.tag.repo,
          host: state.deploy.tag.host,
          user: state.deploy.tag.user,
          pem: maskPath(state.deploy.tag.pem),
          remotePath: state.deploy.tag.remotePath,
          pm2: state.deploy.tag.pm2,
          branch: state.deploy.tag.branch,
        },
      },
    },
  };
}

function appendLine(filePath, line) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
}

function bloggerEnv(state, options = {}) {
  const env = { ...process.env };
  env.BLOGGER_MANAGED_BY = "control-plane";
  env.BLOGGER_RUN_ID = options.runId || "";
  env.BLOGGER_WYNN_REPO = state.wynnRepo;
  env.BLOGGER_TAG_REPO = state.tagRepo;
  env.BLOGGER_TCB_DEPLOY_DIR = state.tcbDeployDir;
  env.TCB_DEPLOY_DIR = state.tcbDeployDir;
  env.DEPLOY_WYNN_REPO = state.deploy.wynn.repo || state.wynnRepo;
  env.DEPLOY_TAG_REPO = state.deploy.tag.repo || state.tagRepo;
  env.DEPLOY_WYNN_HOST = state.deploy.wynn.host;
  env.DEPLOY_TAG_HOST = state.deploy.tag.host;
  env.DEPLOY_WYNN_USER = state.deploy.wynn.user;
  env.DEPLOY_TAG_USER = state.deploy.tag.user;
  env.DEPLOY_WYNN_PEM = state.deploy.wynn.pem;
  env.DEPLOY_TAG_PEM = state.deploy.tag.pem;
  env.DEPLOY_WYNN_PATH = state.deploy.wynn.remotePath;
  env.DEPLOY_TAG_PATH = state.deploy.tag.remotePath;
  env.DEPLOY_WYNN_PM2 = state.deploy.wynn.pm2;
  env.DEPLOY_TAG_PM2 = state.deploy.tag.pm2;
  env.DEPLOY_WYNN_BRANCH = state.deploy.wynn.branch;
  env.DEPLOY_TAG_BRANCH = state.deploy.tag.branch;
  return env;
}

function buildRunnerArgs(state, options = {}) {
  const args = [state.runnerPath];
  if (options.force) args.push("--force");
  if (options.preflight) args.push("--preflight");
  if (options.dryRun) args.push("--dry-run");
  if (options.override) args.push("--override", String(options.override));
  return args;
}

function validateRoutes(state) {
  const checks = [
    ["parallelRoot", state.parallelRoot, "dir"],
    ["runnerPath", state.runnerPath, "file"],
    ["wynnRepo", state.wynnRepo, "dir"],
    ["tagRepo", state.tagRepo, "dir"],
    ["tcbDeployDir", state.tcbDeployDir, "dir"],
    ["deploy.wynn.pem", state.deploy.wynn.pem, "file"],
    ["deploy.tag.pem", state.deploy.tag.pem, "file"],
  ];
  const failures = [];
  for (const [name, target, kind] of checks) {
    if (!target) {
      failures.push(`${name} is not configured`);
      continue;
    }
    if (!fs.existsSync(target)) {
      failures.push(`${name} not found: ${target}`);
      continue;
    }
    const stat = fs.statSync(target);
    if (kind === "dir" && !stat.isDirectory()) failures.push(`${name} is not a directory: ${target}`);
    if (kind === "file" && !stat.isFile()) failures.push(`${name} is not a file: ${target}`);
  }
  return failures;
}

function createBloggerRuntime({ config = {}, runtime }) {
  const state = createBloggerState(config);

  function startBloggerRun(options = {}) {
    if (state.running) {
      return {
        ok: false,
        skipped: true,
        reason: "blogger-already-running",
        state: summarizeState(state),
      };
    }

    const routeFailures = validateRoutes(state);
    if (routeFailures.length > 0) {
      const completedAt = new Date();
      const result = {
        ok: false,
        skipped: true,
        reason: "blogger-route-validation-failed",
        failures: routeFailures,
        state: summarizeState(state),
      };
      state.lastError = routeFailures.join("; ");
      state.lastResult = result;
      state.lastCompletedAt = completedAt;
      if (options.scheduled) {
        state.nextRunAt = computeNextRunAt(state.hour, state.minute, completedAt, {
          activeWeekdays: state.activeWeekdays,
          timezone: state.timezone,
        });
      }
      return result;
    }

    const runId = `blogger-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
      .toString(16)
      .slice(2, 8)}`;
    const logPath = path.join(CONTROL_RUN_LOG_DIR, `${runId}.log`);
    const startedAt = new Date();
    const args = buildRunnerArgs(state, options);

    state.running = true;
    state.activeRunId = runId;
    state.lastRunId = runId;
    state.lastStartedAt = startedAt;
    state.lastCompletedAt = null;
    state.lastError = null;
    state.lastResult = {
      runId,
      status: "started",
      startedAt,
      scheduled: Boolean(options.scheduled),
      force: Boolean(options.force),
      logPath,
    };

    void executeRun({ runId, logPath, args, startedAt, options }).catch((error) => {
      runtime.logger.error("blogger.run.unhandled", {
        runId,
        error: error.message,
      });
    });

    return {
      ok: true,
      accepted: true,
      runId,
      startedAt,
      logPath,
      state: summarizeState(state),
    };
  }

  async function executeRun({ runId, logPath, args, startedAt, options }) {
    const aggregateId = runId;
    appendLine(logPath, `[${startedAt.toISOString()}] starting ${process.execPath} ${args.join(" ")}`);
    appendLine(logPath, `[${startedAt.toISOString()}] cwd=${state.parallelRoot}`);
    appendLine(logPath, `[${startedAt.toISOString()}] wynnRepo=${state.wynnRepo}`);
    appendLine(logPath, `[${startedAt.toISOString()}] tagRepo=${state.tagRepo}`);

    await recordWorkflowStage({
      domain: "SYSTEM",
      family: "blogger",
      subtype: "blogger-runtime",
      stage: "requested",
      aggregateType: "blogger-runtime",
      aggregateId,
      sourceService: "control-plane",
      title: "Blogger runtime started",
      summary: options.scheduled ? "Scheduled blogger run started" : "Manual blogger run started",
      payload: {
        runId,
        scheduled: Boolean(options.scheduled),
        force: Boolean(options.force),
        preflight: Boolean(options.preflight),
        dryRun: Boolean(options.dryRun),
        routing: summarizeState(state).routing,
      },
    }).catch((error) => {
      appendLine(logPath, `[${new Date().toISOString()}] workflow-stage requested failed: ${error.message}`);
    });

    let timedOut = false;
    let timeout = null;

    try {
      const child = spawn(process.execPath, args, {
        cwd: state.parallelRoot,
        env: bloggerEnv(state, { runId }),
        windowsHide: true,
      });

      timeout = setTimeout(() => {
        timedOut = true;
        appendLine(logPath, `[${new Date().toISOString()}] timeout after ${state.timeoutMs}ms; terminating`);
        child.kill("SIGTERM");
      }, state.timeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();

      child.stdout.on("data", (chunk) => appendLine(logPath, chunk.toString("utf8").trimEnd()));
      child.stderr.on("data", (chunk) => appendLine(logPath, chunk.toString("utf8").trimEnd()));

      const result = await new Promise((resolve) => {
        child.on("error", (error) => resolve({ code: null, signal: null, error }));
        child.on("close", (code, signal) => resolve({ code, signal, error: null }));
      });

      if (timeout) clearTimeout(timeout);
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const ok = !timedOut && !result.error && result.code === 0;
      const finalResult = {
        runId,
        ok,
        status: ok ? "completed" : "failed",
        code: result.code,
        signal: result.signal,
        timedOut,
        error: result.error?.message || null,
        scheduled: Boolean(options.scheduled),
        force: Boolean(options.force),
        startedAt,
        completedAt,
        durationMs,
        logPath,
      };

      state.lastCompletedAt = completedAt;
      state.lastResult = finalResult;
      state.lastError = ok
        ? null
        : result.error?.message || (timedOut ? "blogger runtime timed out" : `blogger exited with code ${result.code}`);
      state.nextRunAt = computeNextRunAt(state.hour, state.minute, completedAt, {
        activeWeekdays: state.activeWeekdays,
        timezone: state.timezone,
      });

      appendLine(logPath, `[${completedAt.toISOString()}] finished ${JSON.stringify(finalResult)}`);

      await recordWorkflowStage({
        domain: "SYSTEM",
        family: "blogger",
        subtype: "blogger-runtime",
        stage: ok ? "completed" : "failed",
        aggregateType: "blogger-runtime",
        aggregateId,
        sourceService: "control-plane",
        status: ok ? "completed" : "failed",
        title: ok ? "Blogger runtime completed" : "Blogger runtime failed",
        summary: ok ? "Blogger run completed successfully" : state.lastError,
        result: finalResult,
      }).catch((error) => {
        appendLine(logPath, `[${new Date().toISOString()}] workflow-stage final failed: ${error.message}`);
      });

      if (!ok) {
        await recordServiceAlert({
          domain: "SYSTEM",
          sourceService: "control-plane",
          category: "blogger",
          severity: "critical",
          title: "Blogger run failed",
          summary: state.lastError,
          payload: finalResult,
          tags: ["blogger", "deploy", "sales-sites"],
        }).catch((error) => {
          appendLine(logPath, `[${new Date().toISOString()}] service-alert failed: ${error.message}`);
        });
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      state.running = false;
      state.activeRunId = null;
    }
  }

  async function start() {
    state.enabled = bool(config.enabled, false);
    state.nextRunAt = computeNextRunAt(state.hour, state.minute, new Date(), {
      activeWeekdays: state.activeWeekdays,
      timezone: state.timezone,
    });

    if (!state.enabled) {
      runtime.logger.warn("blogger.runtime.disabled", {
        nextRunAt: state.nextRunAt,
      });
      return;
    }

    const tick = () => {
      if (state.running || !state.nextRunAt) return;
      if (Date.now() < state.nextRunAt.getTime()) return;
      startBloggerRun({ scheduled: true, force: false });
    };

    state.timer = setInterval(tick, state.intervalMs);
    if (typeof state.timer.unref === "function") state.timer.unref();

    runtime.logger.info("blogger.runtime.armed", {
      hour: state.hour,
      minute: state.minute,
      nextRunAt: state.nextRunAt,
      timezone: state.timezone,
      activeWeekdays: state.activeWeekdays,
      wynnRepo: state.wynnRepo,
      tagRepo: state.tagRepo,
    });
  }

  async function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  return {
    getState: () => summarizeState(state),
    start,
    startBloggerRun,
    stop,
  };
}

module.exports = {
  createBloggerRuntime,
};
