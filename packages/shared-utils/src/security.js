"use strict";

const crypto = require("crypto");

function safeSecretEquals(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  if (!leftText || !rightText) return false;
  const leftBuffer = Buffer.from(leftText, "utf8");
  const rightBuffer = Buffer.from(rightText, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isStrictRuntime(config = {}) {
  if (config.startupValidation?.strict != null) {
    return Boolean(config.startupValidation.strict);
  }
  return String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
}

function buildHealthAccessMiddleware(config = {}) {
  const expectedToken = String(config.healthToken || "").trim();
  const strictRuntime = isStrictRuntime(config);

  return (req, res, next) => {
    const provided = String(
      req.headers["x-health-token"] ||
        req.headers["x-service-secret"] ||
        "",
    ).trim();

    if (expectedToken) {
      if (safeSecretEquals(provided, expectedToken)) {
        req.healthAccess = { detailed: true, tokenAuthenticated: true };
        return next();
      }
      return res.status(401).json({ ok: false, error: "Health token required" });
    }

    req.healthAccess = {
      detailed: !strictRuntime,
      tokenAuthenticated: false,
    };
    return next();
  };
}

function isDetailedHealthRequest(req = {}) {
  return req.healthAccess?.detailed !== false;
}

function buildPublicHealthPayload(config = {}, mongo = null) {
  const mongoOk = mongo == null ? true : mongo.connected === true || mongo.skipped === true;
  return {
    ok: mongoOk,
    service: config.serviceName || "unknown-service",
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  buildHealthAccessMiddleware,
  buildPublicHealthPayload,
  isDetailedHealthRequest,
  safeSecretEquals,
};
