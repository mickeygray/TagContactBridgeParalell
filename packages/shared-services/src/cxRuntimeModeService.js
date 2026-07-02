"use strict";

function normalizeCxRuntimeMode(value) {
  const token = String(value || "").trim().toLowerCase();
  if (["cx-only", "cx_only", "cxonly", "ringcx-only", "ringcx_only"].includes(token)) {
    return "cx-only";
  }
  if (["legacy", "default", "off", "false", "0"].includes(token)) return "legacy";
  return null;
}

function boolFromEnv(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

function isBulkLoadAlphaRuntime(options = {}) {
  const env = options.env || process.env;
  const workspaceMode = String(env.VITE_CX_WORKSPACE_MODE || "").trim().toLowerCase();
  const defaultRuntime = String(env.CX_DIAL_RUNTIME_DEFAULT || "").trim().toLowerCase();
  return boolFromEnv(env.CX_DIAL_RUNTIME_BULK_LOAD_ENABLED)
    && (
      workspaceMode === "bulk_load"
      || workspaceMode === "bulk-load"
      || defaultRuntime === "bulk_load"
      || defaultRuntime === "bulk-load"
    );
}

function getCxRuntimeMode(options = {}) {
  const explicit = normalizeCxRuntimeMode(options.cxRuntimeMode);
  if (explicit) return explicit;
  const envMode = normalizeCxRuntimeMode(process.env.RC_CX_RUNTIME_MODE || process.env.CX_RUNTIME_MODE);
  if (envMode) return envMode;
  return isBulkLoadAlphaRuntime(options) ? "cx-only" : "legacy";
}

function isCxOnlyRuntimeMode(options = {}) {
  return getCxRuntimeMode(options) === "cx-only";
}

function suppressExArtifactsForCx(options = {}) {
  if (isCxOnlyRuntimeMode(options)) return true;
  const raw = String(process.env.RC_CX_EX_ARTIFACT_MODE || "").trim().toLowerCase();
  return ["off", "disabled", "suppress", "suppressed", "cx-only"].includes(raw);
}

function suppressExBusyRoutingReason(reason, options = {}) {
  return suppressExArtifactsForCx(options)
    && String(reason || "").trim().toLowerCase() === "ex-busy";
}

module.exports = {
  getCxRuntimeMode,
  isCxOnlyRuntimeMode,
  isBulkLoadAlphaRuntime,
  normalizeCxRuntimeMode,
  suppressExArtifactsForCx,
  suppressExBusyRoutingReason,
};
