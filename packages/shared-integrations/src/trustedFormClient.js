"use strict";

const { env, envInt } = require("../../shared-config/src");
const { requestJson } = require("./httpClient");

function extractCertId(certUrl) {
  const value = String(certUrl || "").trim();
  if (!value) return null;

  const match = value.match(/trustedform\.com\/([a-z0-9]+)/i);
  return match ? match[1] : null;
}

function createTrustedFormClient() {
  const apiKey = String(env("TRUSTEDFORM_API_KEY", "")).trim();
  const timeoutMs = envInt("TRUSTEDFORM_TIMEOUT_MS", 10000);

  async function checkInCertificate(certUrl) {
    if (!apiKey) {
      return { ok: false, skipped: true, reason: "missing-api-key" };
    }

    const certId = extractCertId(certUrl);
    if (!certId) {
      return { ok: false, skipped: true, reason: "invalid-cert-url" };
    }

    const authHeader = `Basic ${Buffer.from(`API:${apiKey}`).toString("base64")}`;
    const response = await requestJson(
      `https://cert.trustedform.com/${certId}/check_in`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      {
        timeoutMs,
        retries: 1,
      },
    );

    if (!response.ok) {
      const error = new Error(
        `TrustedForm check-in failed with status ${response.status}`,
      );
      error.status = response.status;
      error.response = response.data;
      throw error;
    }

    return {
      ok: true,
      certId,
      status: response.status,
      data: response.data,
    };
  }

  return {
    checkInCertificate,
    extractCertId,
  };
}

module.exports = {
  createTrustedFormClient,
  extractCertId,
};
