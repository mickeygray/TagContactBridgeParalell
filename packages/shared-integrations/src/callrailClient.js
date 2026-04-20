"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");

const DEFAULT_TIME_ZONE = "America/Los_Angeles";

const DEFAULT_FIELDS = [
  "id",
  "customer_phone_number",
  "tracking_phone_number",
  "formatted_tracking_phone_number",
  "source",
  "source_name",
  "start_time",
  "duration",
  "direction",
];

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits.slice(-10);
}

function toE164(phone) {
  const normalized = normalizePhone(phone);
  return normalized ? `+1${normalized}` : "";
}

function getLastMonthRange() {
  return {
    dateRange: "last_month",
    timeZone: DEFAULT_TIME_ZONE,
  };
}

function createCallrailClient(companyKey) {
  const runtime = getCompanyRuntime(companyKey);
  const { company } = runtime;
  const integration = company.integrations.callrail || {};

  function ensureConfigured() {
    if (!integration.accountId || !integration.apiKey) {
      throw new ExternalServiceError(
        "callrail",
        `CallRail configuration missing for ${company.key}`,
        {
          status: 500,
          retryable: false,
          details: {
            company: company.key,
            hasAccountId: Boolean(integration.accountId),
            hasApiKey: Boolean(integration.apiKey),
          },
        },
      );
    }
  }

  function buildUrl(path, params = {}) {
    const url = new URL(
      path.replace(/^\//, ""),
      `https://api.callrail.com/v3/a/${integration.accountId}/`,
    );

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });

    return url.toString();
  }

  async function request(path, params = {}) {
    ensureConfigured();
    const url = buildUrl(path, params);
    const response = await requestJson(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Token token=${integration.apiKey}`,
          "Content-Type": "application/json",
        },
      },
      {
        timeoutMs: 15000,
        retries: 1,
      },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        "callrail",
        `CallRail request failed for ${company.key} ${path}: ${response.status}`,
        {
          status: 502,
          retryable: response.status >= 500,
          details: {
            company: company.key,
            path,
            responseStatus: response.status,
            responseBody: response.data,
          },
        },
      );
    }

    return response.data;
  }
  
  async function lookupInboundCallByPhone(phone, options = {}) {
    const e164 = toE164(phone);
    if (!e164) {
      throw new ExternalServiceError("callrail", "Phone number is required for CallRail lookup", {
        status: 400,
        retryable: false,
      });
    }

    return request("calls.json", {
      search: e164,
      per_page: options.perPage || 5,
      direction: "inbound",
      company_id: options.companyId || integration.companyId,
      date_range: options.dateRange || "this_month",
      time_zone: options.timeZone || DEFAULT_TIME_ZONE,
      sort: options.sort || "start_time",
      order: options.order || "desc",
      fields: (options.fields || DEFAULT_FIELDS).join(","),
    });
  }

  async function getCall(callId, options = {}) {
    return request(`calls/${encodeURIComponent(callId)}.json`, {
      fields: (options.fields || DEFAULT_FIELDS).join(","),
    });
  }

  async function listInboundCallsForRange(options = {}) {
    const perPage = Math.min(Number(options.perPage) || 250, 250);
    let page = 1;
    const calls = [];
    const baseParams = {
      direction: "inbound",
      company_id: options.companyId || integration.companyId,
      sort: options.sort || "start_time",
      order: options.order || "desc",
      fields: (options.fields || DEFAULT_FIELDS).join(","),
      time_zone: options.timeZone || DEFAULT_TIME_ZONE,
    };

    if (options.dateRange) {
      baseParams.date_range = options.dateRange;
    } else if (options.startDate && options.endDate) {
      baseParams.start_date = options.startDate;
      baseParams.end_date = options.endDate;
    }

    while (page <= (options.maxPages || 100)) {
      const payload = await request("calls.json", {
        ...baseParams,
        per_page: perPage,
        page,
      });

      const pageCalls = payload.calls || [];
      calls.push(...pageCalls);

      if (pageCalls.length < perPage) {
        return {
          ...payload,
          dateRange: baseParams.date_range || null,
          startDate: baseParams.start_date || null,
          endDate: baseParams.end_date || null,
          timeZone: baseParams.time_zone,
          calls,
        };
      }

      page += 1;
    }

    return {
      page: page - 1,
      per_page: perPage,
      total_records: calls.length,
      dateRange: baseParams.date_range || null,
      startDate: baseParams.start_date || null,
      endDate: baseParams.end_date || null,
      timeZone: baseParams.time_zone,
      calls,
      truncated: true,
    };
  }

  async function listInboundCallsForLastMonth(options = {}) {
    return listInboundCallsForRange({
      ...options,
      dateRange: "last_month",
    });
  }

  return {
    company,
    normalizePhone,
    toE164,
    getLastMonthRange,
    lookupInboundCallByPhone,
    getCall,
    listInboundCallsForRange,
    listInboundCallsForLastMonth,
  };
}

module.exports = {
  DEFAULT_FIELDS,
  createCallrailClient,
  getLastMonthRange,
  normalizePhone,
  toE164,
};
