"use strict";

const { env } = require("./env");

/**
 * Deploy targets are configured via GITHUB_DEPLOY_TARGETS, a JSON array.
 * Tokens are NEVER placed in this JSON — they come from env vars keyed by
 * the target's key. This keeps secrets out of logs / config dumps / audit
 * trails that might serialize the target list.
 *
 * Per-target env convention — for a target with key "tag-site":
 *   GITHUB_DEPLOY_TOKEN_TAG_SITE=ghp_... or ghs_...
 *   GITHUB_OWNER_TAG_SITE=org-or-user
 *   GITHUB_REPO_TAG_SITE=repo-slug
 *
 * Each falls back to the shared GITHUB_DEPLOY_TOKEN / GITHUB_OWNER / GITHUB_REPO
 * if the target-specific value isn't set. So the simple case (one repo, one
 * PAT for everything) still works; the fine-grained case (one PAT per repo)
 * just adds the suffixed vars.
 *
 * Example:
 *   GITHUB_DEPLOY_TARGETS=[
 *     {"key":"tag-site","label":"TAG site","workflow":"deploy.yml","ref":"main","inputs":{"brand":"TAG"}},
 *     {"key":"wynn-site","label":"WYNN site","workflow":"deploy.yml","ref":"main","inputs":{"brand":"WYNN"}}
 *   ]
 *   GITHUB_DEPLOY_TOKEN_TAG_SITE=ghs_xxx
 *   GITHUB_OWNER_TAG_SITE=taxadvocategroup
 *   GITHUB_REPO_TAG_SITE=tag-site
 *   GITHUB_DEPLOY_TOKEN_WYNN_SITE=ghs_yyy
 *   GITHUB_OWNER_WYNN_SITE=taxadvocategroup
 *   GITHUB_REPO_WYNN_SITE=wynn-site
 */

function envSuffix(key) {
  return String(key || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseDeployTargets(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const key = String(entry.key || "").trim();
        const workflow = String(entry.workflow || "").trim();
        if (!key || !workflow) return null;
        return {
          key,
          label: String(entry.label || key).trim(),
          description: entry.description ? String(entry.description) : null,
          workflow,
          ref: String(entry.ref || "main").trim(),
          inputs:
            entry.inputs && typeof entry.inputs === "object"
              ? { ...entry.inputs }
              : {},
          company: entry.company ? String(entry.company).toUpperCase() : null,
          // JSON-level overrides (optional). Token is never read from JSON.
          ownerOverride: entry.owner ? String(entry.owner).trim() : null,
          repoOverride: entry.repo ? String(entry.repo).trim() : null,
          allowedActions:
            Array.isArray(entry.allowedActions) && entry.allowedActions.length > 0
              ? entry.allowedActions.map((action) => String(action))
              : ["full", "content", "restart"],
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveTargetAuth(target) {
  const suffix = envSuffix(target.key);
  const sharedToken = env("GITHUB_DEPLOY_TOKEN", env("GITHUB_TOKEN", ""));
  const sharedOwner = env("GITHUB_OWNER", "");
  const sharedRepo = env("GITHUB_REPO", "");

  return {
    token: String(env(`GITHUB_DEPLOY_TOKEN_${suffix}`, "") || sharedToken || "").trim(),
    owner: String(
      target.ownerOverride ||
        env(`GITHUB_OWNER_${suffix}`, "") ||
        sharedOwner ||
        "",
    ).trim(),
    repo: String(
      target.repoOverride ||
        env(`GITHUB_REPO_${suffix}`, "") ||
        sharedRepo ||
        "",
    ).trim(),
  };
}

function isTargetConfigured(target) {
  const auth = resolveTargetAuth(target);
  return Boolean(auth.token && auth.owner && auth.repo);
}

function getGithubConfig() {
  const targets = parseDeployTargets(
    env("GITHUB_DEPLOY_TARGETS", env("DEPLOY_TARGETS", "")),
  );
  const sharedToken = env("GITHUB_DEPLOY_TOKEN", env("GITHUB_TOKEN", ""));
  const sharedOwner = env("GITHUB_OWNER", "");
  const sharedRepo = env("GITHUB_REPO", "");

  return {
    apiBaseUrl: env("GITHUB_API_BASE_URL", "https://api.github.com"),
    userAgent: env("GITHUB_API_USER_AGENT", "tagcontactbridge-parallel"),
    targets,

    // Shared-token fallback (legacy simple mode). Present for backwards
    // compatibility + for the top-level "Not configured" gate.
    token: String(sharedToken || "").trim(),
    owner: String(sharedOwner || "").trim(),
    repo: String(sharedRepo || "").trim(),

    resolveTargetAuth,
    isTargetConfigured,
    findTarget(key) {
      return targets.find((target) => target.key === String(key)) || null;
    },
    isConfigured() {
      return targets.some(isTargetConfigured);
    },
  };
}

module.exports = {
  getGithubConfig,
  parseDeployTargets,
  resolveTargetAuth,
  isTargetConfigured,
  envSuffix,
};
