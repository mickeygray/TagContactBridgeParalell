"use strict";

const { ROLES } = require("../../shared-types/src");
const { WORKSPACE_TOOLS } = require("../../shared-contracts/src");

function getWorkspaceForUser(user) {
  return {
    audience: user.audience,
    workspace: user.workspace || "general",
    stationLabel: user.stationLabel || null,
    capabilities: user.capabilities || [],
    tools:
      user.role === ROLES.ADMIN
        ? WORKSPACE_TOOLS.admin
        : WORKSPACE_TOOLS.user,
  };
}

module.exports = {
  getWorkspaceForUser,
};
