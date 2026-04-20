"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

function createLogicsClient(companyKey) {
  const runtime = getCompanyRuntime(companyKey);
  const { company } = runtime;

  function buildUrl(path) {
    const baseUrl = company.integrations.logics.apiUrl || "";
    if (!baseUrl) {
      throw new ExternalServiceError("logics", `Logics API URL missing for ${company.key}`, {
        status: 500,
        retryable: false,
        details: { company: company.key },
      });
    }

    return new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  }

  async function request(path, { method = "GET", body, headers = {} } = {}) {
    const url = buildUrl(path);
    const response = await requestJson(
      url,
      {
        method,
        headers: runtime.basicAuthHeaders({
          "Content-Type": "application/json",
          ...headers,
        }),
        body: body ? JSON.stringify(body) : undefined,
      },
      {
        timeoutMs: 20000,
        retries: method === "GET" ? 1 : 0,
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        "logics",
        `Logics request failed for ${company.key} ${method} ${path}: ${response.status}`,
        {
          status: 502,
          retryable: response.status >= 500,
          details: {
            company: company.key,
            method,
            path,
            responseStatus: response.status,
            responseBody: response.data,
          },
        },
      );
    }

    return response.data;
  }

  async function requestFirst(paths, options) {
    let lastError = null;
    for (const path of paths) {
      try {
        return await request(path, options);
      } catch (error) {
        lastError = error;
        const status = error?.details?.responseStatus;
        if (status && status !== 404) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  return {
    company,
    request,
    getCase(caseId) {
      return request(`Case/CaseInfo?CaseID=${encodeURIComponent(caseId)}`);
    },
    getCaseInfo(caseId, details) {
      const params = new URLSearchParams({ CaseID: String(caseId) });
      if (details) params.set("details", details);
      return request(`Case/CaseInfo?${params.toString()}`);
    },
    getCasesByStatus(statusId, options = {}) {
      const params = new URLSearchParams();
      params.set("StatusID", String(statusId));
      if (options.orderByCreatedDate === true) {
        params.set("orderByCreatedDate", String(Boolean(options.orderByCreatedDate)));
      }
      return request(`Case/GetCasesByStatus?${params.toString()}`);
    },
    getCaseStatusInfo(statusId) {
      return request(`Case/CaseStatusInfo?StatusID=${encodeURIComponent(statusId)}`);
    },
    getCasePayments(caseId) {
      return requestFirst([
        `Billing/CasePayment?CaseID=${encodeURIComponent(caseId)}`,
        `billing/casepayment?CaseID=${encodeURIComponent(caseId)}`,
      ]);
    },
    getCaseInvoices(caseId) {
      return requestFirst([
        `Billing/CaseInvoice?CaseID=${encodeURIComponent(caseId)}`,
        `billing/caseinvoice?CaseID=${encodeURIComponent(caseId)}`,
      ]);
    },
    getCaseBillingSummary(caseId) {
      return requestFirst([
        `Billing/CaseBillingSummary?CaseID=${encodeURIComponent(caseId)}`,
        `Billing/CaseBillingsummary?CaseID=${encodeURIComponent(caseId)}`,
      ]);
    },
    findCaseByPhone(phone) {
      return request(`Find/FindCaseByPhone?phone=${encodeURIComponent(phone)}`);
    },
    getActivities(caseId) {
      return request(`CaseActivity/Activity?CaseID=${encodeURIComponent(caseId)}`);
    },
    createCase(payload) {
      return request("Case/CaseFile", {
        method: "POST",
        body: payload,
      });
    },
  };
}

module.exports = {
  createLogicsClient,
};
