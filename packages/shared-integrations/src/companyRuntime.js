"use strict";

const { getCompanyConfig } = require("../../shared-config/src/companyConfig");

const runtimeCache = new Map();

function normalizeAuthOverride(authOverride = null) {
  if (!authOverride || typeof authOverride !== "object") return null;
  const apiKey = String(authOverride.apiKey || authOverride.username || "").trim();
  const secret = String(authOverride.secret || authOverride.password || "").trim();
  if (!apiKey || !secret) return null;
  return { apiKey, secret };
}

function createCompanyRuntime(companyKey, options = {}) {
  const company = getCompanyConfig(companyKey);
  const authOverride = normalizeAuthOverride(options.authOverride);

  return {
    company,
    authOverride,
    authHeaders(extraHeaders = {}) {
      return {
        ...extraHeaders,
      };
    },
    basicAuthHeaders(extraHeaders = {}) {
      const username = authOverride?.apiKey || company.integrations.logics.apiKey || "";
      const password = authOverride?.secret || company.integrations.logics.secret || "";
      const token = Buffer.from(`${username}:${password}`).toString("base64");

      return {
        Authorization: `Basic ${token}`,
        ...extraHeaders,
      };
    },
  };
}

function getCompanyRuntime(companyKey, options = {}) {
  const key = String(companyKey || "").toUpperCase() || "WYNN";
  if (options && options.authOverride) {
    return createCompanyRuntime(key, options);
  }
  if (!runtimeCache.has(key)) {
    runtimeCache.set(key, createCompanyRuntime(key));
  }
  return runtimeCache.get(key);
}

module.exports = {
  createCompanyRuntime,
  getCompanyRuntime,
};
