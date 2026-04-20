"use strict";

const { requestJson } = require("../../shared-integrations/src/httpClient");
const { getCompanyConfig } = require("../../shared-config/src");

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

async function sendOutboundText({ domain, toPhone, trackingNumber, content }) {
  const company = getCompanyConfig(domain);
  const digits = normalizePhone(toPhone);
  const tracking = normalizePhone(trackingNumber);

  if (!company.integrations.callrail.accountId || !company.integrations.callrail.apiKey || !company.integrations.callrail.companyId) {
    return { ok: false, skipped: true, reason: "callrail-not-configured" };
  }

  if (!digits || digits.length !== 10) {
    return { ok: false, skipped: true, reason: "invalid-phone" };
  }

  if (!tracking || tracking.length !== 10) {
    return { ok: false, skipped: true, reason: "missing-tracking-number" };
  }

  const url = `https://api.callrail.com/v3/a/${company.integrations.callrail.accountId}/text-messages.json`;
  const response = await requestJson(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Token token=${company.integrations.callrail.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customer_phone_number: digits,
        tracking_number: tracking,
        content,
        company_id: company.integrations.callrail.companyId,
      }),
    },
    {
      timeoutMs: 15000,
      retries: 1,
    },
  );

  if (!response.ok) {
    return {
      ok: false,
      error: `CallRail text failed: ${response.status}`,
      details: response.data,
    };
  }

  return {
    ok: true,
    provider: "callrail",
    trackingNumber: tracking,
    response: response.data,
  };
}

module.exports = {
  normalizePhone,
  sendOutboundText,
};
