"use strict";

const { env } = require("../../shared-config/src");
const { requestJson } = require("./httpClient");

function createNeverBounceClient() {
  const apiKey = env("NEVERBOUNCE_API_KEY", "");
  const route = env("NEVERBOUNCE_ROUTE", "https://api.neverbounce.com/v4/single/check");

  async function validateEmail(email) {
    const normalizedEmail = String(email || "").trim();
    if (!normalizedEmail) {
      return {
        email: normalizedEmail,
        result: "missing",
        isValid: false,
        canSend: false,
        error: "No email provided",
      };
    }

    if (!apiKey) {
      return {
        email: normalizedEmail,
        result: "skipped",
        isValid: false,
        canSend: true,
        skipped: true,
        reason: "missing-api-key",
      };
    }

    const url = `${route}?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(normalizedEmail)}`;
    const response = await requestJson(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
      {
        retries: 1,
        timeoutMs: 10000,
      },
    );

    const data = response.data || {};
    if (!response.ok || data.status !== "success") {
      throw new Error(
        data.message ||
          data.error ||
          `NeverBounce request failed with status ${response.status}`,
      );
    }

    const result = String(data.result || "unknown").toLowerCase();
    return {
      email: normalizedEmail,
      raw: data,
      result,
      isValid: result === "valid",
      isInvalid: result === "invalid",
      isDisposable: result === "disposable",
      isCatchall: result === "catchall",
      isUnknown: result === "unknown",
      flags: Array.isArray(data.flags) ? data.flags : [],
      hasDNS: Array.isArray(data.flags) ? data.flags.includes("has_dns") : false,
      hasMX: Array.isArray(data.flags) ? data.flags.includes("has_dns_mx") : false,
      suggestedCorrection: data.suggested_correction || null,
      canSend: ["valid", "catchall", "unknown"].includes(result),
      error: null,
    };
  }

  return {
    validateEmail,
  };
}

module.exports = {
  createNeverBounceClient,
};
