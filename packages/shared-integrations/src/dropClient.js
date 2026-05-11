"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

const DROP_API_BASE = "https://customerapi.drop.co";

function createDropClient(companyKey) {
  const runtime = getCompanyRuntime(companyKey);
  const { company } = runtime;
  const integration = company.integrations.drop || {};

  function ensureConfigured() {
    if (!integration.apiKey) {
      throw new ExternalServiceError("drop", `Drop configuration missing for ${company.key}`, {
        status: 500,
        retryable: false,
        details: { company: company.key, hasApiKey: Boolean(integration.apiKey) },
      });
    }
  }

  async function post(path, params = {}) {
    ensureConfigured();
    const url = new URL(path.replace(/^\//, ""), `${DROP_API_BASE}/`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    const response = await requestJson(
      url.toString(),
      {
        method: "POST",
      },
      {
        timeoutMs: 15000,
        retries: 1,
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError("drop", `Drop request failed for ${company.key} ${path}: ${response.status}`, {
        status: 502,
        retryable: response.status >= 500,
        details: {
          company: company.key,
          path,
          responseStatus: response.status,
          responseBody: response.data,
        },
      });
    }

    return response.data;
  }

  function normalizePhone(phone) {
    let digits = String(phone || "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return digits;
  }

  return {
    company,
    normalizePhone,
    checkBalance() {
      return post("/BalanceCheck", {
        ApiKey: integration.apiKey,
      });
    },
    getCampaignStats(dateFrom, dateTo) {
      return post("/VMDropStats", {
        ApiKey: integration.apiKey,
        CampaignToken: integration.campaignToken,
        DateFrom: dateFrom,
        DateTo: dateTo,
      });
    },
    // Status endpoint requires ApiKey + ActivityToken. Used by the
    // async disposition poller — the initial /delivery/ POST returns
    // ApiStatusCode 1038 ("API Post Accepted") immediately, but the
    // actual drop outcome (delivered / DNC-rejected / no-voicemail-box
    // / number-disconnected) only surfaces here on subsequent polls.
    // DropStatusCode = -1 means still pending; other codes indicate
    // terminal dispositions (see classifyDropDisposition).
    getDropStatus(activityToken) {
      return post("/VMDropStatus", {
        ApiKey: integration.apiKey,
        ActivityToken: activityToken,
      });
    },
    dropVoicemail({ phone, caseId, name, source, audioUrl }) {
      const digits = normalizePhone(phone);
      if (digits.length !== 10) {
        throw new ExternalServiceError("drop", "Invalid phone number for Drop voicemail", {
          status: 400,
          retryable: false,
          details: { phone },
        });
      }

      if (!integration.campaignToken) {
        throw new ExternalServiceError("drop", `Drop campaign token missing for ${company.key}`, {
          status: 500,
          retryable: false,
          details: { company: company.key },
        });
      }

      return post("/delivery/", {
        ApiKey: integration.apiKey,
        CampaignToken: integration.campaignToken,
        PhoneTo: digits,
        AllowDuplicates: "true",
        Source: source || "control-plane",
        C1: String(caseId || ""),
        C2: String(name || ""),
        C3: new Date().toISOString(),
        Audio: audioUrl || "",
      });
    },
  };
}

module.exports = {
  createDropClient,
};
