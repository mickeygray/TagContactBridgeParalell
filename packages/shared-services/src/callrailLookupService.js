"use strict";

const { createCallrailClient } = require("../../shared-integrations/src");

function mapCall(call) {
  if (!call) return null;

  return {
    callId: call.id || null,
    customerPhoneNumber: call.customer_phone_number || null,
    trackingNumber: call.tracking_phone_number || null,
    formattedTrackingNumber:
      call.formatted_tracking_phone_number || call.tracking_phone_number || null,
    sourceName: call.source_name || call.source || null,
    startTime: call.start_time || null,
    durationSeconds: call.duration || 0,
    direction: call.direction || null,
  };
}

async function lookupInboundCall(companyKey, phone, options = {}) {
  const client = createCallrailClient(companyKey);
  const payload = await client.lookupInboundCallByPhone(phone, options);
  const calls = payload.calls || [];
  const call = calls[0] || null;

  return {
    company: client.company.key,
    searchedPhone: client.toE164(phone),
    totalMatches: payload.total_records || calls.length,
    call: mapCall(call),
  };
}

/**
 * Every inbound call for a phone, mapped — for callers applying the
 * attribution rule (longest call on the close day), which needs the full
 * set, not just the most recent.
 */
async function listInboundCallsForPhone(companyKey, phone, options = {}) {
  const client = createCallrailClient(companyKey);
  const payload = await client.lookupInboundCallByPhone(phone, options);
  return (payload.calls || []).map(mapCall).filter(Boolean);
}

async function listLastMonthInboundCalls(companyKey, options = {}) {
  const client = createCallrailClient(companyKey);
  const payload = await client.listInboundCallsForLastMonth(options);
  const calls = payload.calls || [];

  return {
    company: client.company.key,
    dateRange: payload.dateRange || null,
    startDate: payload.startDate,
    endDate: payload.endDate,
    timeZone: payload.timeZone || null,
    totalCalls: calls.length,
    totalRecords: payload.total_records || calls.length,
    truncated: Boolean(payload.truncated),
    sample: calls.slice(0, 25).map(mapCall),
  };
}

module.exports = {
  listInboundCallsForPhone,
  listLastMonthInboundCalls,
  lookupInboundCall,
  mapCall,
};
