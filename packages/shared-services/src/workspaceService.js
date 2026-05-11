"use strict";

const { ROLES } = require("../../shared-types/src");
const { WORKSPACE_TOOLS } = require("../../shared-contracts/src");

function getWorkspaceForUser(user) {
  const tools =
    user.role === ROLES.ADMIN
      ? Array.from(
          new Set([...(WORKSPACE_TOOLS.admin || []), ...(WORKSPACE_TOOLS.user || [])]),
        )
      : WORKSPACE_TOOLS.user;
  return {
    audience: user.audience,
    workspace: user.workspace || "general",
    stationLabel: user.stationLabel || null,
    capabilities: user.capabilities || [],
    tools,
  };
}

module.exports = {
  getWorkspaceForUser,
};
