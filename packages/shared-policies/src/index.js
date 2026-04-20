"use strict";

const { AuthorizationError } = require("../../shared-errors/src");

function hasCapability(user, capability) {
  return Array.isArray(user?.capabilities) && user.capabilities.includes(capability);
}

function requireCapability(user, capability) {
  if (!hasCapability(user, capability)) {
    throw new AuthorizationError(`Missing capability: ${capability}`);
  }
}

function canAccessAudience(user, audience) {
  return user?.audience === audience || user?.role === "admin";
}

module.exports = {
  canAccessAudience,
  hasCapability,
  requireCapability,
};
