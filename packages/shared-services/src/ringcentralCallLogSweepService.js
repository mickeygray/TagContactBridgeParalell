"use strict";

const { DEFAULT_COMPANY } = require("../../shared-config/src");
const { createRingCentralClient } = require("../../shared-integrations/src");
const { callLogRepository } = require("../../shared-repositories/src");
const {
  resolveInboundCallSource,
} = require("./callAttributionResolverService");

const DEFAULT_SINCE_MS = 65 * 60 * 1000;
const DEFAULT_LIMIT = 1000;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 20;

function normalizeDomain(domain) {
  return String(domain || DEFAULT_COMPANY || "WYNN").trim().toUpperCase();
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeDirection(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "inbound" || raw === "outbound") return raw;
  return "unknown";
}

function normalizeDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.slice(-10);
}

function buildWindow(options = {}, now = new Date()) {
  const explicitFrom = toDate(options.from);
  const explicitTo = toDate(options.to);
  if (explicitFrom || explicitTo) {
    return {
      from: explicitFrom || new Date(now.getTime() - DEFAULT_SINCE_MS),
      to: explicitTo || now,
    };
  }

  const sinceMs = Math.max(
    Number(options.sinceMs) || DEFAULT_SINCE_MS,
    5 * 60 * 1000,
  );
  return {
    from: new Date(now.getTime() - sinceMs),
    to: now,
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return null;
}

function pickTelephonySessionId(record = {}) {
  return firstNonEmpty(
    record.telephonySessionId,
    ...(Array.isArray(record.legs)
      ? record.legs.map((leg) => leg?.telephonySessionId)
      : []),
    record.sessionId,
    record.id,
  );
}

function pickExtensionId(record = {}) {
  const legs = Array.isArray(record.legs) ? record.legs : [];
  return firstNonEmpty(
    record.extension?.id,
    record.extensionId,
    record.to?.extensionId,
    record.from?.extensionId,
    ...legs.flatMap((leg) => [
      leg?.extension?.id,
      leg?.extensionId,
      leg?.to?.extensionId,
      leg?.from?.extensionId,
    ]),
  );
}

function pickAgentName(record = {}) {
  const legs = Array.isArray(record.legs) ? record.legs : [];
  return firstNonEmpty(
    record.extension?.name,
    record.to?.name,
    record.from?.name,
    ...legs.flatMap((leg) => [
      leg?.extension?.name,
      leg?.to?.name,
      leg?.from?.name,
    ]),
  );
}

function pickCustomerPhone(record = {}) {
  const direction = normalizeDirection(record.direction);
  if (direction === "inbound") {
    return firstNonEmpty(record.from?.phoneNumber, record.from?.extensionNumber);
  }
  if (direction === "outbound") {
    return firstNonEmpty(record.to?.phoneNumber, record.to?.extensionNumber);
  }
  return firstNonEmpty(
    record.from?.phoneNumber,
    record.to?.phoneNumber,
    record.from?.extensionNumber,
    record.to?.extensionNumber,
  );
}

function dedupeRecords(records = []) {
  const bySession = new Map();
  const noSession = [];

  for (const record of records) {
    const sessionId = pickTelephonySessionId(record);
    if (!sessionId) {
      noSession.push(record);
      continue;
    }
    const existing = bySession.get(sessionId);
    if (!existing) {
      bySession.set(sessionId, record);
      continue;
    }
    const existingDuration = Number(existing.duration || 0);
    const nextDuration = Number(record.duration || 0);
    if (nextDuration > existingDuration) {
      bySession.set(sessionId, record);
    }
  }

  return [...bySession.values(), ...noSession];
}

async function fetchAccountCallLogRecords({
  from,
  to,
  limit = DEFAULT_LIMIT,
  perPage = DEFAULT_PER_PAGE,
  maxPages = DEFAULT_MAX_PAGES,
  logger = null,
} = {}) {
  const rc = createRingCentralClient();
  const clampedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 20000);
  const clampedPerPage = Math.min(
    Math.max(Number(perPage) || DEFAULT_PER_PAGE, 1),
    DEFAULT_PER_PAGE,
  );
  const pageCap = Math.min(
    Math.max(Number(maxPages) || DEFAULT_MAX_PAGES, 1),
    Math.ceil(clampedLimit / clampedPerPage),
  );
  const records = [];

  for (let page = 1; page <= pageCap && records.length < clampedLimit; page += 1) {
    const query = {
      view: "Detailed",
      type: "Voice",
      dateFrom: from.toISOString(),
      dateTo: to.toISOString(),
      perPage: clampedPerPage,
      page,
    };

    const payload = await rc.getAccountCallLog(query);
    const pageRecords = Array.isArray(payload?.records) ? payload.records : [];
    records.push(...pageRecords);
    if (pageRecords.length < clampedPerPage) break;
  }

  if (records.length >= clampedLimit) {
    logger?.warn?.("ringcentral.call_log_sweep.limit_reached", {
      limit: clampedLimit,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  }

  return dedupeRecords(records).slice(0, clampedLimit);
}

async function resolveAccountCallLogRecord(record, {
  defaultDomain,
  resolverActor = "reconcile",
  logger = null,
} = {}) {
  const telephonySessionId = pickTelephonySessionId(record);
  if (!telephonySessionId) {
    return { status: "skipped", reason: "missing-telephony-session-id" };
  }

  const customerPhone = pickCustomerPhone(record);
  if (!normalizeDigits(customerPhone)) {
    return {
      status: "skipped",
      reason: "missing-customer-phone",
      telephonySessionId,
    };
  }

  const existing = await callLogRepository.findCallLogBySessionId(
    telephonySessionId,
  );

  const result = await resolveInboundCallSource({
    domain: defaultDomain,
    customerPhone,
    record,
    telephonySessionId,
    extensionId: pickExtensionId(record),
    agentName: pickAgentName(record),
    resolverActor,
    logger,
  });

  return {
    status: result?.matched ? "resolved" : "processed",
    telephonySessionId,
    inserted: !existing,
    caseId: result?.caseId || null,
    caseDomain: result?.caseDomain || null,
    strategy: result?.strategy || null,
    confidence: result?.confidence || null,
  };
}

async function runRingCentralCallLogSweep(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const window = buildWindow(options, now);
  const defaultDomain = normalizeDomain(options.defaultDomain);
  const summary = {
    enabled: true,
    defaultDomain,
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    scanned: 0,
    processed: 0,
    inserted: 0,
    resolved: 0,
    skipped: 0,
    errors: 0,
    samples: [],
  };

  const records = await fetchAccountCallLogRecords({
    from: window.from,
    to: window.to,
    limit: options.limit,
    perPage: options.perPage,
    maxPages: options.maxPages,
    logger: options.logger || null,
  });

  summary.scanned = records.length;

  for (const record of records) {
    try {
      const result = await resolveAccountCallLogRecord(record, {
        defaultDomain,
        resolverActor: options.resolverActor || "reconcile",
        logger: options.logger || null,
      });
      if (result.status === "skipped") {
        summary.skipped += 1;
      } else {
        summary.processed += 1;
        if (result.inserted) summary.inserted += 1;
        if (result.status === "resolved") summary.resolved += 1;
      }
      if (summary.samples.length < 10) summary.samples.push(result);
    } catch (error) {
      summary.errors += 1;
      if (summary.samples.length < 10) {
        summary.samples.push({
          status: "error",
          telephonySessionId: pickTelephonySessionId(record),
          error: error.message,
        });
      }
      options.logger?.warn?.("ringcentral.call_log_sweep.record_failed", {
        telephonySessionId: pickTelephonySessionId(record),
        error: error.message,
      });
    }
  }

  return summary;
}

module.exports = {
  fetchAccountCallLogRecords,
  runRingCentralCallLogSweep,
};
