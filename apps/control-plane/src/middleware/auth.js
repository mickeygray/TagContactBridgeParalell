"use strict";

const { requireAuth, requireRole } = require("../../../../packages/shared-auth/src");
const { ROLES } = require("../../../../packages/shared-types/src");

function buildAuthMiddleware(config) {
  return {
    requireAuth: requireAuth(config),
    requireAdmin: requireRole(ROLES.ADMIN),
  };
}

module.exports = {
  buildAuthMiddleware,
};
