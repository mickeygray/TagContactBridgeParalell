"use strict";

const path = require("path");

const PARALLEL_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(PARALLEL_ROOT, "..");

function resolveConfiguredPath(names, fallback) {
  const keys = Array.isArray(names) ? names : [names];
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return path.resolve(value);
  }
  return fallback;
}

const WYNN_REPO = resolveConfiguredPath(
  ["BLOGGER_WYNN_REPO", "DEPLOY_WYNN_REPO"],
  path.join(WORKSPACE_ROOT, "WynnTax"),
);

const TAG_REPO = resolveConfiguredPath(
  ["BLOGGER_TAG_REPO", "DEPLOY_TAG_REPO"],
  path.join(WORKSPACE_ROOT, "TaxAdvocateGroup"),
);

const TCB_DEPLOY_DIR = resolveConfiguredPath(
  ["BLOGGER_TCB_DEPLOY_DIR", "TCB_DEPLOY_DIR"],
  path.join(WORKSPACE_ROOT, "TagContactBridge"),
);

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function loadSharp() {
  const configuredModule = String(process.env.BLOGGER_SHARP_MODULE || "").trim();
  if (configuredModule) return require(path.resolve(configuredModule));

  try {
    return require("sharp");
  } catch (_error) {
    return require(path.join(WYNN_REPO, "client", "node_modules", "sharp"));
  }
}

module.exports = {
  PARALLEL_ROOT,
  TAG_REPO,
  TCB_DEPLOY_DIR,
  WORKSPACE_ROOT,
  WYNN_REPO,
  loadSharp,
  npmCommand,
  resolveConfiguredPath,
};
