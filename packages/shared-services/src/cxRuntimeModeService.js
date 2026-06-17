"use strict";

function normalizeCxRuntimeMode(value) {
  const token = String(value || "").trim().toLowerCase();
  if (["cx-only", "cx_only", "cxonly", "ringcx-only", "ringcx_only"].includes(token)) {
    return "cx-only";
  }
  if (["legacy", "default", "off", "false", "0"].includes(token)) return "legacy";
  return null;
}

function getCxRuntimeMode(options = {}) {
  const explicit = normalizeCxRuntimeMode(options.cxRuntimeMode);
  if (explicit) return explicit;
  const envMode = normalizeCxRuntimeMode(process.env.RC_CX_RUNTIME_MODE || process.env.CX_RUNTIME_MODE);
  return envMode || "legacy";
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
  normalizeCxRuntimeMode,
  suppressExArtifactsForCx,
  suppressExBusyRoutingReason,
};
