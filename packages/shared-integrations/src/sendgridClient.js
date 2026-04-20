"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

function createSendgridClient(companyKey) {
  const runtime = getCompanyRuntime(companyKey);
  const { company } = runtime;

  async function sendEmail(payload) {
    const response = await requestJson(
      "https://api.sendgrid.com/v3/mail/send",
      {
        method: "POST",
        headers: runtime.authHeaders({
          Authorization: `Bearer ${company.integrations.sendgrid.apiKey}`,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(payload),
      },
      {
        timeoutMs: 15000,
        retries: 1,
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        "sendgrid",
        `SendGrid send failed for ${company.key}: ${response.status}`,
        {
          status: 502,
          retryable: response.status >= 500,
          details: { company: company.key, responseStatus: response.status, responseBody: response.data },
        },
      );
    }

    return {
      ok: true,
      status: response.status,
    };
  }

  return {
    company,
    sendEmail,
  };
}

module.exports = {
  createSendgridClient,
};
