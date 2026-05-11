"use strict";

const { env } = require("../../shared-config/src");
const { requestJson } = require("./httpClient");

function normalizeDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

function createRealPhoneValidationClient() {
  const apiKey = env("REAL_VALIDATION_API_KEY", "");
  // Two endpoints, two price points:
  //   - DNCPlus.php    — full check: connected/disconnected, cell type,
  //                      national_dnc, state_dnc, dma, litigator. Used at
  //                      lead creation.
  //   - DNCLookup.php  — DNC-only: national_dnc, state_dnc, dma, litigator,
  //                      iscell. Skips the line-connection ping, ~2-3x
  //                      cheaper. Used for recurring bimonthly rechecks
  //                      where we already know the line is alive from
  //                      the creation-time validation.
  const route = env(
    "REAL_VALIDATION_URL",
    "https://api.realvalidation.com/rpvWebService/DNCPlus.php",
  );
  const lookupRoute = env(
    "REAL_VALIDATION_DNC_LOOKUP_URL",
    "https://api.realvalidation.com/rpvWebService/DNCLookup.php",
  );

  async function validatePhone(phone) {
    const digits = normalizeDigits(phone);
    if (!digits || digits.length !== 10) {
      return {
        phone: digits || null,
        status: "invalid",
        isConnected: false,
        isCell: false,
        onNationalDNC: false,
        onStateDNC: false,
        onDMA: false,
        isLitigator: false,
        isValid: false,
        canText: false,
        canCall: false,
        error: "Invalid phone length",
      };
    }

    if (!apiKey) {
      return {
        phone: digits,
        status: "skipped",
        isConnected: true,
        isCell: true,
        onNationalDNC: false,
        onStateDNC: false,
        onDMA: false,
        isLitigator: false,
        isValid: true,
        canText: true,
        canCall: true,
        skipped: true,
        reason: "missing-api-key",
        error: null,
      };
    }

    const url = `${route}?phone=${encodeURIComponent(digits)}&token=${encodeURIComponent(apiKey)}&output=json`;
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
    if (!response.ok) {
      throw new Error(
        data.message ||
          data.error ||
          `RealPhoneValidation request failed with status ${response.status}`,
      );
    }

    const errorText =
      data.error_text && typeof data.error_text === "object"
        ? Object.keys(data.error_text).length > 0
          ? data.error_text
          : null
        : data.error_text || null;

    return {
      phone: digits,
      raw: data,
      status: data.status || "unknown",
      isConnected: data.status === "connected",
      isCell: data.iscell === "Y",
      onNationalDNC: data.national_dnc === "Y",
      onStateDNC: data.state_dnc === "Y",
      onDMA: data.dma === "Y",
      isLitigator: data.litigator === "Y",
      isValid: data.status === "connected",
      canText: data.status === "connected" && data.iscell === "Y",
      canCall: data.status === "connected" && data.litigator !== "Y",
      error: errorText,
    };
  }

  // Cheaper DNC-only check for the bimonthly recheck path. Returns the
  // same fields as `validatePhone` for the DNC-relevant subset, plus a
  // `mode: "dnc-lookup"` marker so callers can tell which endpoint
  // produced the result (e.g. for audit/logging). `isConnected` /
  // `canCall` / `canText` are NOT meaningful from this endpoint — we
  // copy forward `iscell` only and leave connection status as null.
  async function lookupDnc(phone) {
    const digits = normalizeDigits(phone);
    if (!digits || digits.length !== 10) {
      return {
        mode: "dnc-lookup",
        phone: digits || null,
        status: "invalid",
        onNationalDNC: false,
        onStateDNC: false,
        onDMA: false,
        isLitigator: false,
        isCell: false,
        isValid: false,
        error: "Invalid phone length",
      };
    }

    if (!apiKey) {
      return {
        mode: "dnc-lookup",
        phone: digits,
        status: "skipped",
        onNationalDNC: false,
        onStateDNC: false,
        onDMA: false,
        isLitigator: false,
        isCell: true,
        isValid: true,
        skipped: true,
        reason: "missing-api-key",
        error: null,
      };
    }

    const url = `${lookupRoute}?phone=${encodeURIComponent(digits)}&token=${encodeURIComponent(apiKey)}&output=json`;
    const response = await requestJson(
      url,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
      {
        retries: 1,
        timeoutMs: 10000,
      },
    );

    const data = response.data || {};
    if (!response.ok) {
      throw new Error(
        data.RESPONSEMSG ||
          data.message ||
          data.error ||
          `RealPhoneValidation DNCLookup failed with status ${response.status}`,
      );
    }

    const responseCode = String(data.RESPONSECODE || "").toUpperCase();
    if (responseCode && responseCode !== "OK") {
      throw new Error(
        data.RESPONSEMSG || `RealPhoneValidation DNCLookup error: ${responseCode}`,
      );
    }

    return {
      mode: "dnc-lookup",
      phone: digits,
      raw: data,
      status: "ok",
      onNationalDNC: data.national_dnc === "Y",
      onStateDNC: data.state_dnc === "Y",
      onDMA: data.dma === "Y",
      isLitigator: data.litigator === "Y",
      isCell: data.iscell === "Y",
      isValid: responseCode === "OK" || responseCode === "",
      error: null,
    };
  }

  return {
    validatePhone,
    lookupDnc,
  };
}

module.exports = {
  createRealPhoneValidationClient,
};
