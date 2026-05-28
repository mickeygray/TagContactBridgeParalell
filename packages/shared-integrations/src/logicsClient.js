"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

// Walk a Logics response (which can be a JSON-string-inside-an-object,
// an array, or a flat object) to extract a CaseID. Conservative —
// returns null on anything ambiguous so callers can fall through to
// "create new" rather than mis-dedup against a similar-but-different
// case. Same shape used in ncoaUploadService.extractCaseId; kept
// inline here to avoid a cross-package dep.
function extractCaseIdFromResponse(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractCaseIdFromResponse(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return extractCaseIdFromResponse(JSON.parse(trimmed));
    } catch {
      const num = Number(trimmed);
      return Number.isFinite(num) && num > 0 ? num : null;
    }
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "object") return null;
  const direct =
    value.CaseID ?? value.caseId ?? value.caseID ?? value.ID ?? value.Id ?? value.id ?? null;
  if (direct != null) {
    const num = Number(direct);
    if (Number.isFinite(num) && num > 0) return num;
  }
  const nested = value.data ?? value.Data ?? null;
  if (nested && nested !== value) {
    return extractCaseIdFromResponse(nested);
  }
  return null;
}

function createLogicsClient(companyKey, options = {}) {
  const runtime = getCompanyRuntime(companyKey, options);
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
    requestActivityReport(payload) {
      return request("Report/ActivityReport", {
        method: "POST",
        body: payload,
      });
    },
    createTask(payload) {
      return request("Task/Task", {
        method: "POST",
        body: payload,
      });
    },
    getTasksByDateRange(startDate, endDate) {
      const params = new URLSearchParams({
        StartDate: String(startDate),
        EndDate: String(endDate),
      });
      return request(`Task/GetTasksByDateRange?${params.toString()}`);
    },
    createActivity(payload) {
      return request("CaseActivity/Activity", {
        method: "POST",
        body: payload,
      });
    },
    updateActivity(payload) {
      return request("CaseActivity/Activity", {
        method: "POST",
        body: payload,
      });
    },
    updateCase(payload) {
      return request("UpdateCase/UpdateCase", {
        method: "POST",
        body: payload,
      });
    },
    /**
     * Create a Logics case with a built-in duplicate-prevention pass.
     *
     * Before posting, we extract any phone digits from the payload
     * (CellPhone / HomePhone / WorkPhone, in that priority) and call
     * `Find/FindCaseByPhone`. If Logics returns an existing case for
     * that phone, we short-circuit and return a synthetic response
     * carrying the existing `CaseID` plus `deduped: true` so callers
     * can tell a fresh create from a dedup hit. This base-layer guard
     * means downstream services (NCOA upload, lead-form intake, CX
     * "create new case during call", scheduled blasts) get dedup for
     * free without each of them having to remember to check first.
     *
     * Failure-mode: if the find request itself errors (404, network,
     * tenant-config drift), we swallow and proceed with the create.
     * A duplicate Logics case is annoying; a refused intake when the
     * find endpoint is flaky is much worse. Net: the dedup is
     * best-effort, the create is the source of truth.
     *
     * Returned shape on dedup hit:
     *   { deduped: true, dedupSource: "logics-find-case-by-phone",
     *     CaseID: <existing>, existing: <raw find response> }
     * Returned shape on fresh create:
     *   <raw Logics POST response> (unchanged from before)
     *
     * Both shapes resolve a `CaseID` via `extractCaseIdFromResponse` so
     * the caller's existing CaseID-extraction logic works unchanged.
     */
    async createCase(payload) {
      const rawPhone =
        payload?.CellPhone || payload?.HomePhone || payload?.WorkPhone || "";
      const digits = String(rawPhone).replace(/\D/g, "");
      const tenDigit =
        digits.length === 11 && digits.startsWith("1")
          ? digits.slice(1)
          : digits.length >= 10
            ? digits.slice(-10)
            : "";

      if (tenDigit) {
        try {
          const existing = await request(
            `Find/FindCaseByPhone?phone=${encodeURIComponent(tenDigit)}`,
          );
          const existingCaseId = extractCaseIdFromResponse(existing);
          if (existingCaseId) {
            return {
              deduped: true,
              dedupSource: "logics-find-case-by-phone",
              CaseID: existingCaseId,
              existing,
            };
          }
        } catch {
          // Find endpoint hiccup — fall through to create. Better to
          // risk a duplicate than refuse intake.
        }
      }

      return request("Case/CaseFile", {
        method: "POST",
        body: payload,
      });
    },
    createCaseInvoice(payload) {
      return request("Billing/CaseInvoice", {
        method: "POST",
        body: payload,
      });
    },
    createCaseAmortization(payload) {
      return request("Billing/CaseAmortization", {
        method: "POST",
        body: payload,
      });
    },
  };
}

module.exports = {
  createLogicsClient,
};
