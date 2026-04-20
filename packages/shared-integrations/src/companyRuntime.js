"use strict";

const { getCompanyConfig } = require("../../shared-config/src/companyConfig");

const runtimeCache = new Map();

function createCompanyRuntime(companyKey) {
  const company = getCompanyConfig(companyKey);

  return {
    company,
    authHeaders(extraHeaders = {}) {
      return {
        ...extraHeaders,
      };
    },
    basicAuthHeaders(extraHeaders = {}) {
      const username = company.integrations.logics.apiKey || "";
      const password = company.integrations.logics.secret || "";
      const token = Buffer.from(`${username}:${password}`).toString("base64");

      return {
        Authorization: `Basic ${token}`,
        ...extraHeaders,
      };
    },
  };
}

function getCompanyRuntime(companyKey) {
  const key = String(companyKey || "").toUpperCase() || "WYNN";
  if (!runtimeCache.has(key)) {
    runtimeCache.set(key, createCompanyRuntime(key));
  }
  return runtimeCache.get(key);
}

module.exports = {
  createCompanyRuntime,
  getCompanyRuntime,
};
