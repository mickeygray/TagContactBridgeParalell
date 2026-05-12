"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const {
  getGithubConfig,
  resolveTargetAuth,
} = require("../../shared-config/src");
const { githubClient } = require("../../shared-integrations/src");
const { recordWorkflowStage } = require("./workflowStateService");

const ACTION_KEYS = Object.freeze(["full", "content", "restart"]);
const DESTRUCTIVE_ACTIONS = new Set(["full", "restart"]);
const LOCAL_ACTION_KEYS = Object.freeze(["status", "deploy", "restart", "rollback"]);
const LOCAL_DESTRUCTIVE_ACTIONS = new Set(["deploy", "restart", "rollback"]);

let localDeployServiceCache = undefined;

function loadLocalDeployService() {
  if (localDeployServiceCache !== undefined) return localDeployServiceCache;
  try {
    localDeployServiceCache = require("../../../scripts/deployService");
  } catch (error) {
    localDeployServiceCache = { loadError: error };
  }
  return localDeployServiceCache;
}

function sanitizeDeployLog(line) {
  return String(line || "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "")
    .slice(0, 1000);
}

function runGit(repoPath, args) {
  return execSync(`git ${args}`, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readLocalGitState(repoPath) {
  if (!repoPath) return { configured: false };
  const exists = fs.existsSync(repoPath);
  const gitDirExists = exists && fs.existsSync(path.join(repoPath, ".git"));
  if (!exists || !gitDirExists) {
    return {
      configured: Boolean(repoPath),
      exists,
      gitDirExists,
      error: exists ? "Not a git repository" : "Local repo path does not exist",
    };
  }

  try {
    const branch = runGit(repoPath, "rev-parse --abbrev-ref HEAD");
    let upstream = null;
    let ahead = null;
    let behind = null;
    try {
      upstream = runGit(repoPath, "rev-parse --abbrev-ref --symbolic-full-name @{u}");
      ahead = Number(runGit(repoPath, "rev-list --count @{u}..HEAD")) || 0;
      behind = Number(runGit(repoPath, "rev-list --count HEAD..@{u}")) || 0;
    } catch {}

    const dirtyLines = runGit(repoPath, "status --short")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      configured: true,
      exists: true,
      gitDirExists: true,
      branch,
      upstream,
      ahead,
      behind,
      dirtyCount: dirtyLines.length,
      dirtyPreview: dirtyLines.slice(0, 8),
      headSha: runGit(repoPath, "rev-parse --short HEAD"),
      headMessage: runGit(repoPath, "log -1 --format=%s"),
      headDate: runGit(repoPath, "log -1 --format=%ci"),
    };
  } catch (error) {
    return {
      configured: true,
      exists: true,
      gitDirExists: true,
      error: error.message,
    };
  }
}

function summarizeLocalTarget(key, site, history = null) {
  const pemExists = Boolean(site.pemPath && fs.existsSync(site.pemPath));
  const repoState = readLocalGitState(site.localRepoPath);
  const missing = [
    !site.host && "host",
    !site.pemPath && "pem",
    site.pemPath && !pemExists && "pem-file",
    !site.remotePath && "remote-path",
    !site.localRepoPath && "local-repo",
    site.localRepoPath && !repoState.exists && "local-repo-path",
    repoState.exists && !repoState.gitDirExists && "local-git",
  ].filter(Boolean);
  const warnings = [];

  return {
    key,
    label: site.label || key.toUpperCase(),
    url: site.url || null,
    host: site.host || null,
    user: site.user || null,
    remotePath: site.remotePath || null,
    localRepoPath: site.localRepoPath || null,
    localBuildPath: site.localBuildPath || null,
    pm2Process: site.pm2Process || null,
    branch: site.branch || null,
    pemConfigured: Boolean(site.pemPath),
    pemExists,
    repo: repoState,
    ready: missing.length === 0,
    missing,
    warnings,
    history: history || null,
  };
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    id: String(run.id),
    runNumber: run.run_number ?? null,
    status: run.status ?? null, // queued | in_progress | completed
    conclusion: run.conclusion ?? null,
    event: run.event ?? null,
    name: run.name ?? null,
    workflowId: run.workflow_id != null ? String(run.workflow_id) : null,
    workflowPath: run.path ?? null,
    headBranch: run.head_branch ?? null,
    headSha: run.head_sha ?? null,
    triggeringActor: run.triggering_actor?.login ?? null,
    htmlUrl: run.html_url ?? null,
    runStartedAt: run.run_started_at ?? null,
    updatedAt: run.updated_at ?? null,
    createdAt: run.created_at ?? null,
  };
}

async function fetchRunsForTarget(target, { limit }) {
  const auth = resolveTargetAuth(target);
  if (!auth.token || !auth.owner || !auth.repo) return [];

  try {
    const runs = await githubClient.listWorkflowRuns({
      auth,
      workflow: target.workflow,
      perPage: Math.min(Math.max(limit, 1), 50),
    });
    return runs.map((run) => ({
      ...summarizeRun(run),
      targetKey: target.key,
    }));
  } catch (error) {
    // Don't fail the entire fan-out if one target's token is bad — surface
    // the error as a synthetic row so the UI can still render.
    return [
      {
        id: `error:${target.key}`,
        targetKey: target.key,
        status: "completed",
        conclusion: "action_required",
        name: `Could not read runs: ${error.message}`,
        htmlUrl: null,
        runNumber: null,
        updatedAt: new Date().toISOString(),
      },
    ];
  }
}

/**
 * Returns runs for a specific target, or fans out across every configured
 * target when `target` is null. Results are sorted by updatedAt descending.
 */
async function listDeployRuns({ target = null, limit = 15 } = {}) {
  const config = getGithubConfig();
  if (!config.isConfigured()) return { configured: false, runs: [] };

  const targets = target
    ? [config.findTarget(target)].filter(Boolean)
    : config.targets;

  const perTarget = await Promise.all(
    targets.map((t) => fetchRunsForTarget(t, { limit })),
  );
  const all = perTarget.flat();
  all.sort((left, right) => {
    const leftAt = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rightAt = new Date(right.updatedAt || right.createdAt || 0).getTime();
    return rightAt - leftAt;
  });

  return {
    configured: true,
    runs: all.slice(0, Math.min(limit * 2, 50)),
  };
}

async function buildDeployState() {
  const config = getGithubConfig();
  const configured = config.isConfigured();
  const rawTargets = config.targets;

  const targets = rawTargets.map((target) => {
    const auth = resolveTargetAuth(target);
    const ready = Boolean(auth.token && auth.owner && auth.repo);
    return {
      key: target.key,
      label: target.label,
      description: target.description,
      workflow: target.workflow,
      ref: target.ref,
      company: target.company,
      allowedActions: target.allowedActions,
      ready,
      owner: auth.owner || null,
      repo: auth.repo || null,
      // Token never surfaces — `ready` is the UI-safe signal.
      missing: ready
        ? []
        : [
            !auth.token && "token",
            !auth.owner && "owner",
            !auth.repo && "repo",
          ].filter(Boolean),
    };
  });

  if (!configured) {
    return {
      configured: false,
      missing: ["at least one target with owner, repo, and token"],
      targets,
      recentRuns: [],
    };
  }

  let recentRuns = [];
  let fetchError = null;
  try {
    const { runs } = await listDeployRuns({ limit: 20 });
    recentRuns = runs;
  } catch (error) {
    fetchError = {
      message: error.message,
      status: error.status || null,
    };
  }

  return {
    configured: true,
    targets,
    recentRuns,
    fetchError,
  };
}

async function buildLocalDeployState() {
  const svc = loadLocalDeployService();
  if (!svc || svc.loadError || !svc.SITES) {
    return {
      configured: false,
      missing: ["scripts/deployService.js"],
      targets: [],
      loadError: svc?.loadError?.message || "Local deploy service unavailable",
    };
  }

  const targets = Object.entries(svc.SITES).map(([key, site]) =>
    summarizeLocalTarget(key, site, typeof svc.getStatus === "function" ? svc.getStatus(key) : null),
  );

  return {
    configured: targets.some((target) => target.ready),
    targets,
    missing: targets.length
      ? Array.from(new Set(targets.flatMap((target) => target.missing || [])))
      : ["local deploy targets"],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeLocalAction(action) {
  const value = String(action || "").toLowerCase();
  if (!LOCAL_ACTION_KEYS.includes(value)) {
    const err = new Error(`Unknown local deploy action: ${action}`);
    err.status = 400;
    throw err;
  }
  return value;
}

async function recordLocalDeployEvent({
  targetKey,
  site,
  action,
  stage,
  actor,
  note,
  result,
  logs,
  error,
}) {
  try {
    const domain = targetKey === "wynn" ? "WYNN" : "TAG";
    const workflowRecord = await recordWorkflowStage({
      domain,
      family: "deploy",
      subtype: `local-${action}`,
      stage,
      aggregateType: "sales-site",
      aggregateId: targetKey,
      sourceService: "control-plane-local-deploy",
      title: `${site.label || targetKey} local ${action}`,
      summary:
        note?.trim?.() ||
        (error ? `Local ${action} failed: ${error.message}` : `Local ${action} completed`),
      payload: {
        actorEmail: actor?.email || null,
        actorName: actor?.name || null,
        targetKey,
        targetLabel: site.label || targetKey,
        action,
        stage,
        note: note || null,
        result: result || null,
        error: error
          ? { message: error.message, status: error.status || null }
          : null,
        logs: (logs || []).slice(-80),
      },
    });
    return String(workflowRecord._id);
  } catch {
    return null;
  }
}

async function runLocalDeployCommand({
  targetKey,
  action,
  actor,
  note = null,
  confirm = null,
}) {
  const svc = loadLocalDeployService();
  if (!svc || svc.loadError || !svc.SITES) {
    const err = new Error(
      svc?.loadError?.message || "Local deploy service is unavailable.",
    );
    err.status = 503;
    throw err;
  }

  const key = String(targetKey || "").toLowerCase().trim();
  const site = svc.SITES[key];
  if (!site) {
    const err = new Error(`Unknown local deploy target: ${targetKey}`);
    err.status = 404;
    throw err;
  }

  const normalizedAction = normalizeLocalAction(action);
  if (
    LOCAL_DESTRUCTIVE_ACTIONS.has(normalizedAction) &&
    String(confirm || "").trim() !== key
  ) {
    const err = new Error(
      `Local ${normalizedAction} requires confirmation for ${key}.`,
    );
    err.status = 400;
    throw err;
  }

  const logs = [];
  const onLog = (line) => {
    const clean = sanitizeDeployLog(line);
    if (clean) logs.push(clean);
  };

  let result = null;
  try {
    if (normalizedAction === "status") {
      result = await svc.checkRemote(key);
    } else if (normalizedAction === "deploy") {
      result = await svc.deployBuild(
        key,
        { commitMsg: note ? String(note).trim() : null },
        onLog,
      );
    } else if (normalizedAction === "restart") {
      if (typeof svc.restartSite !== "function") {
        const err = new Error("Local restart is not available in deployService.js");
        err.status = 503;
        throw err;
      }
      result = await svc.restartSite(key, null, onLog);
    } else if (normalizedAction === "rollback") {
      result = await svc.rollbackBuild(key, onLog);
    }

    const workflowRecordId = await recordLocalDeployEvent({
      targetKey: key,
      site,
      action: normalizedAction,
      stage: result?.ok === false ? "completed-with-warnings" : "completed",
      actor,
      note,
      result,
      logs,
    });

    return {
      ok: true,
      targetKey: key,
      action: normalizedAction,
      label: site.label || key,
      result,
      logs: logs.slice(-200),
      completedAt: new Date().toISOString(),
      workflowRecordId,
    };
  } catch (error) {
    await recordLocalDeployEvent({
      targetKey: key,
      site,
      action: normalizedAction,
      stage: "failed",
      actor,
      note,
      logs,
      error,
    });
    error.details = { logs: logs.slice(-200) };
    throw error;
  }
}

function normalizeAction(action) {
  const value = String(action || "").toLowerCase();
  if (!ACTION_KEYS.includes(value)) {
    const err = new Error(`Unknown deploy action: ${action}`);
    err.status = 400;
    throw err;
  }
  return value;
}

/**
 * Dispatches the target's configured workflow with `inputs.action = ...`,
 * merged with any static per-target `inputs`. Records a workflow stage on
 * 5001 so the event ledger shows who pressed the button and when.
 *
 * For destructive actions (full, restart), callers must pass
 * `confirm = target.key` to prove intent. The FE surfaces this via a
 * type-to-confirm dialog. `content` is considered non-destructive and skips
 * the confirm check.
 */
async function triggerDeploy({
  targetKey,
  action,
  actor,
  note = null,
  confirm = null,
}) {
  const config = getGithubConfig();

  const target = config.findTarget(targetKey);
  if (!target) {
    const err = new Error(`Unknown deploy target: ${targetKey}`);
    err.status = 404;
    throw err;
  }

  const auth = resolveTargetAuth(target);
  if (!auth.token || !auth.owner || !auth.repo) {
    const err = new Error(
      `Target ${target.key} is not fully configured (missing owner, repo, or token).`,
    );
    err.status = 503;
    throw err;
  }

  const normalizedAction = normalizeAction(action);
  if (!target.allowedActions.includes(normalizedAction)) {
    const err = new Error(
      `Action ${normalizedAction} is not allowed for target ${target.key}`,
    );
    err.status = 400;
    throw err;
  }

  if (
    DESTRUCTIVE_ACTIONS.has(normalizedAction) &&
    String(confirm || "").trim() !== target.key
  ) {
    const err = new Error(
      `Destructive action ${normalizedAction} requires confirmation.`,
    );
    err.status = 400;
    throw err;
  }

  const inputs = {
    ...target.inputs,
    action: normalizedAction,
    target: target.key,
  };

  const dispatched = await githubClient.dispatchWorkflow({
    auth,
    workflow: target.workflow,
    ref: target.ref,
    inputs,
  });

  const actorEmail = actor?.email || null;
  const domain = target.company || "TAG";

  const workflowRecord = await recordWorkflowStage({
    domain,
    family: "deploy",
    subtype: normalizedAction,
    stage: "requested",
    aggregateType: "deploy-target",
    aggregateId: target.key,
    sourceService: "control-plane",
    title: `${target.label} · ${normalizedAction}`,
    summary: note ? String(note).slice(0, 240) : `Triggered ${normalizedAction} deploy`,
    payload: {
      actorEmail,
      actorName: actor?.name || null,
      targetKey: target.key,
      targetLabel: target.label,
      workflow: target.workflow,
      ref: target.ref,
      owner: auth.owner,
      repo: auth.repo,
      action: normalizedAction,
      inputs,
      note: note || null,
      dispatchedAt: dispatched.dispatchedAt,
    },
  });

  return {
    ok: true,
    targetKey: target.key,
    action: normalizedAction,
    workflow: target.workflow,
    ref: target.ref,
    owner: auth.owner,
    repo: auth.repo,
    dispatchedAt: dispatched.dispatchedAt,
    workflowRecordId: String(workflowRecord._id),
  };
}

/**
 * Cancel requires a target key because runs live in per-target repos with
 * per-target tokens. Runs from `listDeployRuns` carry `targetKey` for this.
 */
async function cancelDeployRun({ runId, targetKey, actor }) {
  const config = getGithubConfig();
  const target = config.findTarget(targetKey);
  if (!target) {
    const err = new Error(`Unknown deploy target: ${targetKey}`);
    err.status = 404;
    throw err;
  }

  const auth = resolveTargetAuth(target);
  if (!auth.token || !auth.owner || !auth.repo) {
    const err = new Error(`Target ${target.key} is not configured`);
    err.status = 503;
    throw err;
  }

  const run = await githubClient.getWorkflowRun({ auth, runId });
  await githubClient.cancelWorkflowRun({ auth, runId });

  await recordWorkflowStage({
    domain: target.company || "TAG",
    family: "deploy",
    subtype: "cancel",
    stage: "requested",
    aggregateType: "deploy-run",
    aggregateId: String(runId),
    sourceService: "control-plane",
    title: `Cancel deploy run #${run?.run_number ?? runId}`,
    summary: `Cancel requested by ${actor?.email || "unknown"}`,
    payload: {
      actorEmail: actor?.email || null,
      runId: String(runId),
      runNumber: run?.run_number ?? null,
      workflowPath: run?.path ?? null,
      targetKey: target.key,
      owner: auth.owner,
      repo: auth.repo,
    },
  });

  return {
    ok: true,
    cancelled: true,
    runId: String(runId),
    targetKey: target.key,
  };
}

module.exports = {
  ACTION_KEYS,
  DESTRUCTIVE_ACTIONS,
  LOCAL_ACTION_KEYS,
  LOCAL_DESTRUCTIVE_ACTIONS,
  buildDeployState,
  buildLocalDeployState,
  cancelDeployRun,
  listDeployRuns,
  runLocalDeployCommand,
  triggerDeploy,
};
