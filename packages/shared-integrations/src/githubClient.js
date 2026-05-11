"use strict";

const {
  getGithubConfig,
  resolveTargetAuth,
} = require("../../shared-config/src");

/**
 * Minimal GitHub REST client scoped to workflow_dispatch + runs queries.
 *
 * Every call takes an explicit `auth` argument: `{owner, repo, token}`. Most
 * callers resolve this via `resolveTargetAuth(target)` from shared-config so
 * each deploy target can carry its own fine-grained PAT + repo.
 */

function authHeaders(auth, userAgent) {
  if (!auth?.token) {
    const err = new Error("GitHub auth token is required");
    err.status = 503;
    throw err;
  }
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${auth.token}`,
    "User-Agent": userAgent || "tagcontactbridge-parallel",
  };
}

function assertAuth(auth) {
  if (!auth?.owner || !auth?.repo || !auth?.token) {
    const err = new Error(
      "GitHub auth incomplete. Need owner, repo, and token for this target.",
    );
    err.status = 503;
    throw err;
  }
}

async function githubFetch(path, { method = "GET", body, auth }) {
  const config = getGithubConfig();
  const url = `${config.apiBaseUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      ...authHeaders(auth, config.userAgent),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? safeJson(text) : null;

  if (!response.ok) {
    const error = new Error(
      (payload && payload.message) || `GitHub ${method} ${path} failed (${response.status})`,
    );
    error.status = response.status;
    error.details = payload;
    throw error;
  }

  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Dispatch a workflow_dispatch event. Returns `{ ok, dispatchedAt }`.
 *
 * GitHub does not return the run id synchronously; the new run shows up in
 * `listWorkflowRuns` a moment later.
 */
async function dispatchWorkflow({ auth, workflow, ref, inputs = {} }) {
  assertAuth(auth);
  if (!workflow) throw new Error("workflow is required");

  await githubFetch(
    `/repos/${auth.owner}/${auth.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      body: { ref: ref || "main", inputs },
      auth,
    },
  );
  return { ok: true, dispatchedAt: new Date().toISOString() };
}

async function listWorkflowRuns({
  auth,
  workflow = null,
  perPage = 15,
  branch = null,
} = {}) {
  assertAuth(auth);

  const params = new URLSearchParams();
  params.set("per_page", String(Math.min(Math.max(perPage, 1), 50)));
  if (branch) params.set("branch", branch);
  params.set("event", "workflow_dispatch");

  const path = workflow
    ? `/repos/${auth.owner}/${auth.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
    : `/repos/${auth.owner}/${auth.repo}/actions/runs`;

  const payload = await githubFetch(`${path}?${params.toString()}`, { auth });
  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
}

async function getWorkflowRun({ auth, runId }) {
  assertAuth(auth);
  return githubFetch(
    `/repos/${auth.owner}/${auth.repo}/actions/runs/${encodeURIComponent(runId)}`,
    { auth },
  );
}

async function cancelWorkflowRun({ auth, runId }) {
  assertAuth(auth);
  return githubFetch(
    `/repos/${auth.owner}/${auth.repo}/actions/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", auth },
  );
}

module.exports = {
  dispatchWorkflow,
  listWorkflowRuns,
  getWorkflowRun,
  cancelWorkflowRun,
  resolveTargetAuth,
};
