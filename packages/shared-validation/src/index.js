"use strict";

const { ValidationError } = require("../../shared-errors/src");

function requireFields(payload, fields) {
  const missing = fields.filter((field) => {
    const value = payload?.[field];
    return value === undefined || value === null || value === "";
  });

  if (missing.length > 0) {
    throw new ValidationError(`Missing required fields: ${missing.join(", ")}`, {
      missing,
    });
  }
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new ValidationError(`${label} must be one of: ${allowed.join(", ")}`, {
      label,
      allowed,
      received: value,
    });
  }
}

function validateDemoEventPayload(kind, payload) {
  const requirements = {
    inbound: ["leadId"],
    outbound: ["messageId"],
    ring: ["callId"],
  };

  requireFields(payload, requirements[kind] || []);
}

module.exports = {
  assertOneOf,
  requireFields,
  validateDemoEventPayload,
};
