"use strict";

const { getCompanyRuntime } = require("./companyRuntime");
const { ExternalServiceError } = require("../../shared-errors/src");
const { requestJson } = require("./httpClient");
const { getCompanyKeys } = require("../../shared-config/src/companyConfig");

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

    const params = {
      search: e164,
      per_page: options.perPage || 5,
      direction: "inbound",
      company_id: options.companyId || integration.companyId,
      time_zone: options.timeZone || DEFAULT_TIME_ZONE,
      sort: options.sort || "start_time",
      order: options.order || "desc",
      fields: (options.fields || DEFAULT_FIELDS).join(","),
    };
    if (options.startDate && options.endDate) {
      params.start_date = options.startDate;
      params.end_date = options.endDate;
    } else {
      params.date_range = options.dateRange || "this_month";
    }

    return request("calls.json", params);
  }

  async function getCall(callId, options = {}) {
    return request(`calls/${encodeURIComponent(callId)}.json`, {
      fields: (options.fields || DEFAULT_FIELDS).join(","),
    });
  }

  async function getCallRecording(callId) {
    return request(`calls/${encodeURIComponent(callId)}/recording.json`);
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

  /**
   * Send an SMS via CallRail. Mirrors v2 `smsService.sendViaCallRail`:
   *   POST /v3/a/{accountId}/text-messages.json
   *   { customer_phone_number, tracking_number, content, company_id }
   *
   * `trackingNumber` defaults to the company's configured tracking DID.
   * Pass an explicit one only if you're routing multiple numbers per
   * company (e.g. future per-campaign tracking numbers).
   */
  async function sendSms({ phone, text, trackingNumber } = {}) {
    ensureConfigured();
    const customerPhone = toE164(phone);
    const body = String(text || "").trim();
    if (!customerPhone) {
      throw new ExternalServiceError("callrail", "Customer phone is required", {
        status: 400,
        retryable: false,
      });
    }
    if (!body) {
      throw new ExternalServiceError("callrail", "SMS text is required", {
        status: 400,
        retryable: false,
      });
    }
    const fromNumber = String(trackingNumber || integration.trackingNumber || "").trim();
    if (!fromNumber) {
      throw new ExternalServiceError(
        "callrail",
        `CallRail tracking number missing for ${company.key}`,
        { status: 500, retryable: false, details: { company: company.key } },
      );
    }

    const url = `https://api.callrail.com/v3/a/${integration.accountId}/text-messages.json`;
    const response = await requestJson(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Token token=${integration.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customer_phone_number: customerPhone,
          tracking_number: fromNumber,
          content: body,
          company_id: integration.companyId || undefined,
        }),
      },
      { timeoutMs: 15000, retries: 1 },
    );

    if (!response.ok) {
      throw new ExternalServiceError(
        "callrail",
        `CallRail SMS send failed for ${company.key}: ${response.status}`,
        {
          status: response.status === 429 ? 429 : 502,
          retryable: response.status === 429 || response.status >= 500,
          details: {
            company: company.key,
            responseStatus: response.status,
            responseBody: response.data,
          },
        },
      );
    }

    return {
      provider: "callrail",
      providerMessageId:
        response.data?.id || response.data?.message?.id || null,
      providerResponse: response.data || null,
      customerPhone,
      trackingNumber: fromNumber,
      sentAt: new Date().toISOString(),
    };
  }

  return {
    company,
    normalizePhone,
    toE164,
    getLastMonthRange,
    lookupInboundCallByPhone,
    getCall,
    getCallRecording,
    listInboundCallsForRange,
    listInboundCallsForLastMonth,
    sendSms,
  };
}

/**
 * Given the `destination_number` from an inbound SMS webhook, resolve
 * which company it belongs to by matching against each configured
 * tracking number. Returns the company key (TAG/WYNN) or null.
 *
 * Built lazily so a runtime config swap picks up without restart.
 */
function resolveCompanyByTrackingNumber(destinationNumber) {
  const needle = normalizePhone(destinationNumber);
  if (!needle) return null;
  for (const key of getCompanyKeys()) {
    const runtime = getCompanyRuntime(key);
    const tracking = normalizePhone(runtime.company.integrations?.callrail?.trackingNumber);
    if (tracking && tracking === needle) return key;
  }
  return null;
}

/**
 * Inspect every company's configured CallRail tracking number and
 * report:
 *   - `conflicts`: phone numbers claimed by two or more companies
 *     (inbound → company routing would be ambiguous; reject at boot)
 *   - `unconfigured`: companies with no tracking number set
 *     (auto-responder reply will fall back to no-phone text; warn but
 *     don't block boot — a dev environment might legitimately skip it)
 *
 * Intentionally silent when everything lines up. Caller decides what
 * to do with the result (typically: throw on conflicts, log warnings
 * on unconfigured).
 */
// Per-company env var names mirror the definitions in
// `shared-config/src/companyConfig.js`. Kept here so the validator can
// distinguish "operator explicitly set two colliding values" from
// "neither is configured yet and both fell through to the generic
// CALL_RAIL_TRACKING_NUMBER fallback." Only the former is a real
// conflict worth blocking boot over.
const COMPANY_CALLRAIL_TRACKING_ENV = Object.freeze({
  TAG: "TAG_CALL_RAIL_TRACKING_NUMBER",
  WYNN: "WYNN_CALL_RAIL_TRACKING_NUMBER",
  AMITY: "AMITY_CALL_RAIL_TRACKING_NUMBER",
});

function validateCompanyTrackingNumbers() {
  const byNumber = new Map();
  const unconfigured = [];
  for (const key of getCompanyKeys()) {
    const runtime = getCompanyRuntime(key);
    const raw = runtime.company.integrations?.callrail?.trackingNumber;
    const normalized = normalizePhone(raw);
    const explicitlySet = Boolean(
      process.env[COMPANY_CALLRAIL_TRACKING_ENV[key]],
    );
    if (!normalized) {
      unconfigured.push(key);
      continue;
    }
    if (!explicitlySet) {
      // Using the generic `CALL_RAIL_TRACKING_NUMBER` fallback. Treat
      // as "unconfigured" for conflict purposes — two companies sharing
      // the generic fallback aren't really a misconfiguration, they
      // just haven't been differentiated yet.
      unconfigured.push(key);
      continue;
    }
    if (!byNumber.has(normalized)) byNumber.set(normalized, []);
    byNumber.get(normalized).push(key);
  }
  const conflicts = [];
  for (const [number, companies] of byNumber.entries()) {
    if (companies.length > 1) {
      conflicts.push({ number, companies });
    }
  }
  return { conflicts, unconfigured };
}

module.exports = {
  DEFAULT_FIELDS,
  createCallrailClient,
  getLastMonthRange,
  normalizePhone,
  toE164,
  resolveCompanyByTrackingNumber,
  validateCompanyTrackingNumbers,
};
