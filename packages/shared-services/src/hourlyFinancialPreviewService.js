"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const { createLogicsClient, requestJson } = require("../../shared-integrations/src");
const {
  caseProfileRepository,
  dailyCallStatRepository,
  leadCadenceRepository,
  paymentLedgerRepository,
  sourceCanonicalRepository,
  spendEntryRepository,
} = require("../../shared-repositories/src");
const { isMailerConfigLoaded, loadMailerConfigCache } = require("./mailerConfigService");
const { normalizePaymentRows } = require("./paymentReconcileService");
const {
  getSpendSheets,
  parseCsv,
} = require("./spendSyncService");
const { resolveCanonicalSource } = require("./sourceCanonicalService");

const DEFAULT_BCD_COST_PER_CALL = 4;
const DEFAULT_LD_COST_PER_LEAD = 3;
const DEFAULT_AFFILIATE_COST_PER_LEAD = 10;
const DEFAULT_MAX_CASES_PER_DOMAIN = 25;
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function todayIso(timezone = "America/Los_Angeles", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function resolveDomains(options = {}) {
  const domains = toArray(options.domains || options.domain)
    .map(normalizeDomain)
    .filter(Boolean);
  if (domains.length > 0) {
    return [...new Set(domains)];
  }
  if (options.allDomains) {
    return getCompanyKeys().map(normalizeDomain).filter(Boolean);
  }
  return ["TAG"];
}

function getLdCostPerLead() {
  const parsed = Number(process.env.LD_COST_PER_LEAD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LD_COST_PER_LEAD;
}

function getAffiliateCostPerLead() {
  const parsed = Number(process.env.AFFILIATE_COST_PER_LEAD);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AFFILIATE_COST_PER_LEAD;
}

function getBcdCostPerCall() {
  const parsed = Number(process.env.BCD_COST_PER_CALL);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BCD_COST_PER_CALL;
}

function buildDateWindow(options = {}) {
  const timezone = options.timezone || "America/Los_Angeles";
  const date = String(options.date || todayIso(timezone));
  const from = String(options.from || date);
  const to = String(options.to || date);
  return {
    date,
    from: from <= to ? from : to,
    to: to >= from ? to : from,
  };
}

function isDateWithinWindow(value, window = {}) {
  const date = String(value || "").trim();
  if (!date) return false;
  return date >= String(window.from || "") && date <= String(window.to || "");
}

function classifyDerivedLeadSpendRow(row = {}) {
  const haystack = [
    row.sourceChannel,
    row.sourceName,
    row.intakeSource,
    row.intakeRoute,
    row.partnerSource,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!haystack) return null;

  if (haystack.includes("affiliate")) {
    return {
      bucket: "affiliate",
      channel: "affiliate",
      sheetId: "derived-affiliate-hourly",
      defaultSource: row.sourceName || row.partnerSource || "Lead Form Affiliate",
      costPerLead: getAffiliateCostPerLead(),
    };
  }

  if (
    haystack.includes("ld posting") ||
    haystack.includes("ld-posting") ||
    haystack.includes("lead data") ||
    haystack.includes("lead post") ||
    haystack.includes("a+ leads") ||
    haystack.includes("lead-source") ||
    haystack.includes("source=ld") ||
    String(row.sourceChannel || "").trim().toLowerCase() === "ld" ||
    String(row.sourceChannel || "").trim().toLowerCase() === "ld-posting"
  ) {
    return {
      bucket: "ld",
      channel: "ld-posting",
      sheetId: "derived-ld-hourly",
      defaultSource: row.sourceName || row.intakeSource || "LD Posting",
      costPerLead: getLdCostPerLead(),
    };
  }

  return null;
}

function resolveMetricFamilyKey(channel, source) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const value = `${normalizedChannel} ${normalizedSource}`;

  if (
    normalizedChannel === "mailer" ||
    normalizedChannel === "mail" ||
    value.includes("direct mail")
  ) {
    return "mail";
  }
  if (
    normalizedChannel === "bcd" ||
    (normalizedChannel === "vendor" && normalizedSource.includes("bcd")) ||
    normalizedSource.includes("bcd")
  ) {
    return "bcd";
  }
  if (
    normalizedChannel === "ld" ||
    normalizedChannel === "ld-posting" ||
    normalizedChannel === "affiliate" ||
    normalizedChannel === "lead-distribution" ||
    normalizedChannel === "lead-data" ||
    /lead data|lead post|affiliate|digital|a\+ leads/.test(normalizedSource)
  ) {
    return "ld";
  }
  if (
    normalizedChannel === "meta" ||
    normalizedChannel === "paid-social" ||
    normalizedChannel === "paid-search" ||
    normalizedChannel === "facebook" ||
    normalizedChannel === "instagram" ||
    normalizedChannel === "tiktok" ||
    normalizedChannel === "social" ||
    /vf meta|meta|facebook|instagram|tiktok|\bfb\b/.test(normalizedSource)
  ) {
    return "meta";
  }
  if (
    normalizedChannel === "dialer" ||
    normalizedChannel === "callfire" ||
    /callfire|dialer|hand dialer|rvm transfer/.test(normalizedSource)
  ) {
    return "dialer";
  }
  if (normalizedChannel.includes("mailer")) {
    return "mail";
  }
  return "other";
}

function buildPaymentOperation(entry, meta = {}) {
  return {
    collection: "PaymentLedger",
    filter: {
      casePaymentId: Number(entry.casePaymentId),
    },
    update: {
      $set: entry,
    },
    meta,
  };
}

function buildSpendOperation(entry, meta = {}) {
  return {
    collection: "SpendEntry",
    filter: spendEntryRepository.buildSpendEntryIdentity(entry),
    update: {
      $set: entry,
    },
    meta,
  };
}

function summarizeSpendOperations(operations = []) {
  const summary = {
    rows: operations.length,
    totalSpend: 0,
    byChannel: {},
  };

  for (const operation of operations) {
    const entry = operation?.update?.$set || {};
    const channel = String(entry.channel || "unknown").trim().toLowerCase() || "unknown";
    const spend = Number(entry.spend || 0);
    summary.totalSpend += spend;
    if (!summary.byChannel[channel]) {
      summary.byChannel[channel] = {
        rows: 0,
        spend: 0,
      };
    }
    summary.byChannel[channel].rows += 1;
    summary.byChannel[channel].spend += spend;
  }

  return summary;
}

function summarizePaymentCases(cases = []) {
  return cases.reduce(
    (accumulator, item) => {
      accumulator.casesScanned += 1;
      accumulator.casesWithPayments += item.payments > 0 ? 1 : 0;
      accumulator.newLedgerRows += Number(item.newLedgerRows || 0);
      accumulator.flaggedFailures += Number(item.flaggedFailures || 0);
      accumulator.reversals += Number(item.reversals || 0);
      accumulator.totalPaymentsObserved += Number(item.payments || 0);
      accumulator.totalAmountObserved += Number(item.totalAmountObserved || 0);
      if (item.error) accumulator.errors += 1;
      return accumulator;
    },
    {
      casesScanned: 0,
      casesWithPayments: 0,
      newLedgerRows: 0,
      flaggedFailures: 0,
      reversals: 0,
      errors: 0,
      totalPaymentsObserved: 0,
      totalAmountObserved: 0,
    },
  );
}

async function resolveSourceShape(domain, query = {}, fallback = {}) {
  const canonical = await resolveCanonicalSource({
    domain,
    internalName: query.internalName || fallback.source,
    sourceName: query.sourceName || fallback.source,
    rawName: query.rawName || fallback.source,
    trackerName: query.trackerName || null,
    queueName: query.queueName || null,
    trackingNumber: query.trackingNumber || null,
    sourceId: query.sourceId != null ? query.sourceId : null,
  }).catch(() => null);

  return {
    sourceCanonicalId: canonical?.doc?._id || null,
    source: canonical?.internalName || fallback.source || "Unknown",
    channel: canonical?.channel || fallback.channel || null,
    matchedBy: canonical?.matchedBy || null,
  };
}

async function previewPaymentCase({
  domain,
  caseId,
  previewTimestamp,
  logger = null,
} = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = Number(caseId);
  if (!Number.isFinite(normalizedCaseId)) {
    return {
      caseId,
      payments: 0,
      newLedgerRows: 0,
      flaggedFailures: 0,
      reversals: 0,
      totalAmountObserved: 0,
      operations: [],
      caseProfileEffects: [],
      reviewItems: [],
      checkpoint: null,
      error: "invalid-case-id",
    };
  }

  const client = createLogicsClient(normalizedDomain);
  let rawPayments;
  try {
    rawPayments = await client.getCasePayments(normalizedCaseId);
  } catch (error) {
    const status = error?.details?.responseStatus;
    if (status === 404) {
      rawPayments = [];
    } else {
      logger?.warn?.("payment.preview.logics_error", {
        domain: normalizedDomain,
        caseId: normalizedCaseId,
        error: error.message,
      });
      return {
        caseId: normalizedCaseId,
        payments: 0,
        newLedgerRows: 0,
        flaggedFailures: 0,
        reversals: 0,
        totalAmountObserved: 0,
        operations: [],
        caseProfileEffects: [],
        reviewItems: [],
        checkpoint: null,
        error: error.message,
      };
    }
  }

  const normalizedRows = normalizePaymentRows(rawPayments, normalizedDomain);

  const priorLedgerRows = await paymentLedgerRepository.listPayments(
    normalizedDomain,
    { caseId: normalizedCaseId, limit: 500 },
  );
  const priorById = new Map(
    priorLedgerRows.map((row) => [Number(row.casePaymentId), row]),
  );

  const operations = [];
  const caseProfileEffects = [];
  const reviewItems = [];
  let newLedgerRows = 0;
  let flaggedFailures = 0;
  let reversals = 0;
  let totalAmountObserved = 0;

  for (const payment of normalizedRows) {
    const prior = priorById.get(payment.casePaymentId);
    const alreadyPresent = Boolean(prior);
    const priorStatus = String(prior?.transactionStatus || "").toUpperCase();
    const newStatus = String(payment.transactionStatus || "").toUpperCase();
    totalAmountObserved += Number(payment.amount || 0);

    const payload = {
      domain: normalizedDomain,
      caseId: payment.caseId,
      casePaymentId: payment.casePaymentId,
      paymentDate: payment.paymentDate,
      paymentDateKey: payment.paymentDateKey,
      amount: payment.amount,
      paymentType: payment.paymentType,
      transactionStatus: payment.transactionStatus,
      raw: payment.raw,
    };

    operations.push(
      buildPaymentOperation(payload, {
        wasPresent: alreadyPresent,
        previousStatus: prior?.transactionStatus || null,
      }),
    );

    if (!alreadyPresent) {
      newLedgerRows += 1;
      if (newStatus === "SUCCESS") {
        caseProfileEffects.push({
          type: "apply-payment",
          caseId: payment.caseId,
          paymentId: payment.casePaymentId,
          amount: payment.amount,
          paidAt: payment.paymentDate,
        });
      }
    } else if (priorStatus === "SUCCESS" && newStatus !== "SUCCESS") {
      reversals += 1;
      caseProfileEffects.push({
        type: "reverse-payment",
        caseId: payment.caseId,
        paymentId: payment.casePaymentId,
        amount: Number(prior.amount) || payment.amount,
        priorStatus,
        newStatus,
      });
      reviewItems.push({
        category: "payment-chargeback",
        severity: "warning",
        caseId: payment.caseId,
        title: `Payment reversed on case ${payment.caseId}`,
        summary: `$${(Number(prior.amount) || 0).toFixed(2)} flipped from ${priorStatus} to ${newStatus} (CasePaymentID ${payment.casePaymentId})`,
      });
    }

    if (
      newStatus &&
      newStatus !== "SUCCESS" &&
      newStatus !== "PENDING"
    ) {
      flaggedFailures += 1;
      reviewItems.push({
        category: "payment-failure",
        severity: "warning",
        caseId: payment.caseId,
        title: `Payment ${payment.transactionStatus} on case ${payment.caseId}`,
        summary: `Amount $${payment.amount.toFixed(2)} on ${payment.paymentDateKey} (CasePaymentID ${payment.casePaymentId})`,
      });
    }
  }

  const checkpoint = {
    type: "payment-reconcile-checkpoint",
    caseId: normalizedCaseId,
    update: {
      paymentReconcile: {
        lastCheckedAt: previewTimestamp,
        lastResult: normalizedRows.length > 0 ? "ok" : "no-payments",
      },
    },
  };

  return {
    caseId: normalizedCaseId,
    payments: normalizedRows.length,
    totalAmountObserved,
    newLedgerRows,
    flaggedFailures,
    reversals,
    operations,
    caseProfileEffects,
    reviewItems,
    checkpoint,
    error: null,
  };
}

async function previewPaymentsForDomain(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const maxCases = Math.min(
    Number(options.maxCasesPerDomain || options.maxCases || DEFAULT_MAX_CASES_PER_DOMAIN),
    200,
  );
  const staleAfterMs = Number(options.staleAfterMs || DEFAULT_STALE_AFTER_MS);
  const previewTimestamp = options.previewTimestamp || new Date();

  const due = options.caseId != null
    ? [{ caseId: Number(options.caseId) }]
    : await caseProfileRepository.findCaseProfilesDueForPaymentReconcile(
      normalizedDomain,
      staleAfterMs,
      maxCases,
    );

  const cases = [];
  for (const profile of due) {
    const caseId = Number(profile.caseId);
    if (!Number.isFinite(caseId)) continue;
    cases.push(
      await previewPaymentCase({
        domain: normalizedDomain,
        caseId,
        previewTimestamp,
      }),
    );
  }

  return {
    domain: normalizedDomain,
    previewedAt: previewTimestamp,
    summary: summarizePaymentCases(cases),
    cases,
  };
}

async function fetchSheetPreview(sheetConfig, options = {}) {
  const window = buildDateWindow(options);
  const previewTimestamp = options.previewTimestamp || new Date();
  const includeAllSheetRows = Boolean(options.includeAllSheetRows);

  if (sheetConfig.channel === "mailer" && !isMailerConfigLoaded()) {
    await loadMailerConfigCache();
  }

  const response = await requestJson(sheetConfig.url, {}, {
    timeoutMs: 30000,
    retries: 1,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch spend sheet ${sheetConfig.id}: ${response.status}`);
  }

  const rawRows = parseCsv(response.data);
  const parsedRows = rawRows
    .map((row) => sheetConfig.parser(row, sheetConfig))
    .filter(Boolean);
  const selectedRows = includeAllSheetRows
    ? parsedRows
    : parsedRows.filter((row) => isDateWithinWindow(row.date, window));

  const operations = selectedRows.map((row) => {
    const entry = {
      ...row,
      syncedAt: previewTimestamp,
    };
    return buildSpendOperation(entry, {
      source: "sheet",
      sheetId: sheetConfig.id,
      label: sheetConfig.label,
    });
  });

  return {
    id: sheetConfig.id,
    label: sheetConfig.label,
    domain: sheetConfig.domain,
    channel: sheetConfig.channel,
    parsedRowCount: rawRows.length,
    selectedRowCount: selectedRows.length,
    operations,
    summary: summarizeSpendOperations(operations),
  };
}

async function previewSheetSpendForDomain(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const config = options.config || {};
  const selectedSheetIds = new Set(
    toArray(options.sheetIds || options.sheetId)
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );

  const sheets = getSpendSheets(config).filter((sheet) => {
    if (sheet.domain !== normalizedDomain) return false;
    if (selectedSheetIds.size > 0) return selectedSheetIds.has(sheet.id);
    return true;
  });

  const results = [];
  for (const sheet of sheets) {
    try {
      results.push(await fetchSheetPreview(sheet, options));
    } catch (error) {
      results.push({
        id: sheet.id,
        label: sheet.label,
        domain: sheet.domain,
        channel: sheet.channel,
        parsedRowCount: 0,
        selectedRowCount: 0,
        operations: [],
        summary: summarizeSpendOperations([]),
        error: error.message,
      });
    }
  }

  const operations = results.flatMap((item) => item.operations || []);
  return {
    domain: normalizedDomain,
    sheets: results,
    operations,
    summary: summarizeSpendOperations(operations),
  };
}

async function previewLeadCadenceDerivedSpend(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const window = buildDateWindow(options);
  const previewTimestamp = options.previewTimestamp || new Date();
  const leadRows = await leadCadenceRepository.listLeadCadence(normalizedDomain, {
    createdAtAfter: window.from,
    createdAtBefore: window.to,
    limit: Number(options.maxLeadCadenceRows || 20000),
  });

  const groups = new Map();
  for (const row of leadRows) {
    const classification = classifyDerivedLeadSpendRow(row);
    if (!classification) continue;

    const inputSource =
      row.sourceName ||
      row.partnerSource ||
      row.intakeSource ||
      classification.defaultSource;
    const inputChannel = row.sourceChannel || row.intakeRoute || classification.channel;
    const key = [
      classification.bucket,
      String(inputSource || "Unknown").trim().toLowerCase(),
      String(inputChannel || classification.channel || "").trim().toLowerCase(),
    ].join("::");

    if (!groups.has(key)) {
      groups.set(key, {
        classification,
        inputSource,
        inputChannel,
        caseIds: [],
        count: 0,
      });
    }

    const group = groups.get(key);
    group.count += 1;
    if (row.caseId != null) {
      group.caseIds.push(Number(row.caseId));
    }
  }

  const operations = [];
  for (const group of groups.values()) {
    const inputSource = group.inputSource || group.classification.defaultSource || "Unknown";
    const inputChannel = group.inputChannel || group.classification.channel || null;
    const costPerLead = Number(
      group.classification.costPerLead ||
      (group.classification.bucket === "affiliate"
        ? getAffiliateCostPerLead()
        : getLdCostPerLead()),
    );

    const sourceMeta = await resolveSourceShape(
      normalizedDomain,
      {
        sourceName: inputSource,
        internalName: inputSource,
        rawName: inputSource,
      },
      {
        source: inputSource,
        channel: inputChannel || group.classification.channel || "ld",
      },
    );

    const entry = {
      date: window.to,
      domain: normalizedDomain,
      channel: sourceMeta.channel || inputChannel || group.classification.channel || "ld",
      source: sourceMeta.source,
      sheetId: group.classification.sheetId,
      sourceCanonicalId: sourceMeta.sourceCanonicalId,
      spend: Number(group.count || 0) * costPerLead,
      cost: Number(group.count || 0) * costPerLead,
      leadsReported: Number(group.count || 0),
      leadsAccepted: Number(group.count || 0),
      costPerLead,
      syncedAt: previewTimestamp,
      raw: {
        derivedFrom: "lead-cadence-created-window",
        derivedBucket: group.classification.bucket,
        from: window.from,
        to: window.to,
        count: Number(group.count || 0),
        intakeSource: inputSource,
        intakeRoute: inputChannel,
        sampleCaseIds: Array.isArray(group.caseIds) ? group.caseIds.slice(0, 25) : [],
      },
    };

    operations.push(
      buildSpendOperation(entry, {
        source: "derived",
        derivedKind: "ld",
        matchedBy: sourceMeta.matchedBy,
        inputSource,
        inputChannel,
      }),
    );
  }

  return {
    domain: normalizedDomain,
    date: window.to,
    operations,
    summary: summarizeSpendOperations(operations),
  };
}

async function previewBcdDerivedSpend(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const date = String(options.date || todayIso());
  const previewTimestamp = options.previewTimestamp || new Date();
  const bcdCostPerCall = Number(options.bcdCostPerCall || getBcdCostPerCall());
  const excludePieces = await sourceCanonicalRepository
    .listPiecesAssignedToOtherDomains(normalizedDomain)
    .catch(() => []);

  const rows = await dailyCallStatRepository.summarizeCallStats({
    date,
    excludePieces,
  });

  const operations = [];

  for (const row of rows) {
    const piece = row._id?.piece || "Unknown";
    const channel = row._id?.channel || null;
    if (resolveMetricFamilyKey(channel, piece) !== "bcd") {
      continue;
    }

    const totalCalls = Number(row.totalCalls || 0);
    if (totalCalls <= 0) continue;

    const sourceMeta = await resolveSourceShape(
      normalizedDomain,
      {
        sourceName: piece,
        internalName: piece,
        rawName: piece,
      },
      {
        source: piece,
        channel: channel || "bcd",
      },
    );

    const entry = {
      date,
      domain: normalizedDomain,
      channel: sourceMeta.channel || channel || "bcd",
      source: sourceMeta.source,
      sheetId: "derived-bcd-hourly",
      sourceCanonicalId: sourceMeta.sourceCanonicalId,
      spend: totalCalls * bcdCostPerCall,
      cost: totalCalls * bcdCostPerCall,
      syncedAt: previewTimestamp,
      raw: {
        derivedFrom: "daily-call-stats",
        piece,
        totalCalls,
        callsOver5: Number(row.callsOver5 || 0),
        uniqueCallers: Number(row.uniqueCallers || 0),
        costPerCall: bcdCostPerCall,
      },
    };

    operations.push(
      buildSpendOperation(entry, {
        source: "derived",
        derivedKind: "bcd",
        matchedBy: sourceMeta.matchedBy,
        inputSource: piece,
        inputChannel: channel,
      }),
    );
  }

  return {
    domain: normalizedDomain,
    date,
    operations,
    summary: summarizeSpendOperations(operations),
  };
}

async function previewHourlyFinancialSync(options = {}) {
  const previewTimestamp = options.previewTimestamp || new Date();
  const date = String(options.date || todayIso(options.timezone || "America/Los_Angeles"));
  const domains = resolveDomains(options);
  const spendConfig = options.spendConfig || {};

  const domainResults = [];

  for (const domain of domains) {
    const payments = options.includePayments === false
      ? null
      : await previewPaymentsForDomain(domain, {
        ...options,
        previewTimestamp,
      });

    const sheetSpend = options.includeSheetSpend === false
      ? {
          domain,
          sheets: [],
          operations: [],
          summary: summarizeSpendOperations([]),
        }
      : await previewSheetSpendForDomain(domain, {
        ...options,
        date,
        previewTimestamp,
        config: spendConfig,
      });

    const leadCadenceSpend = options.includeDerivedSpend === false
      ? {
          domain,
          date,
          operations: [],
          summary: summarizeSpendOperations([]),
        }
      : await previewLeadCadenceDerivedSpend(domain, {
        ...options,
        date,
        previewTimestamp,
      });

    const bcdSpend = options.includeDerivedSpend === false
      ? {
          domain,
          date,
          operations: [],
          summary: summarizeSpendOperations([]),
        }
      : await previewBcdDerivedSpend(domain, {
        ...options,
        date,
        previewTimestamp,
      });

    const spendOperations = [
      ...sheetSpend.operations,
      ...leadCadenceSpend.operations,
      ...bcdSpend.operations,
    ];

    domainResults.push({
      domain,
      date,
      payments,
      spend: {
        sheets: sheetSpend.sheets,
        derived: {
          ld: leadCadenceSpend.operations,
          bcd: bcdSpend.operations,
        },
        operations: spendOperations,
        summary: summarizeSpendOperations(spendOperations),
      },
    });
  }

  return {
    mode: "dry-run",
    generatedAt: previewTimestamp.toISOString(),
    date,
    config: {
      ldCostPerLead: getLdCostPerLead(),
      affiliateCostPerLead: getAffiliateCostPerLead(),
      bcdCostPerCall: getBcdCostPerCall(),
      maxCasesPerDomain: Number(options.maxCasesPerDomain || options.maxCases || DEFAULT_MAX_CASES_PER_DOMAIN),
      includeAllSheetRows: Boolean(options.includeAllSheetRows),
    },
    domains: domainResults,
  };
}

module.exports = {
  DEFAULT_BCD_COST_PER_CALL,
  DEFAULT_LD_COST_PER_LEAD,
  DEFAULT_AFFILIATE_COST_PER_LEAD,
  previewHourlyFinancialSync,
  previewPaymentsForDomain,
  previewSheetSpendForDomain,
  previewLeadCadenceDerivedSpend,
  previewBcdDerivedSpend,
};
