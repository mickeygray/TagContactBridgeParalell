"use strict";

const { getCompanyKeys } = require("../../shared-config/src/companyConfig");
const {
  syncHourlyMetricsForDomain,
} = require("./metricsBackfillService");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function todayIsoLA(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function resolveDomains(options = {}) {
  const requested = []
    .concat(options.domain || [])
    .concat(options.domains || [])
    .map(normalizeDomain)
    .filter(Boolean);
  if (requested.length > 0) {
    return [...new Set(requested)];
  }
  return [...new Set(getCompanyKeys().map(normalizeDomain).filter(Boolean))];
}

async function runHourlyMetricsRefresh({
  domain,
  domains,
  date = null,
  preferLegacyContactActivities = false,
  preferCallLedger = false,
  logger = null,
} = {}) {
  const dateKey = String(date || todayIsoLA()).trim();
  const selectedDomains = resolveDomains({ domain, domains });
  const results = [];
  const totals = {
    domains: selectedDomains.length,
    callStatImports: 0,
    callStatUpserts: 0,
    callStatModifications: 0,
    snapshotsRebuilt: 0,
    errors: 0,
  };

  for (const selectedDomain of selectedDomains) {
    try {
      const result = await syncHourlyMetricsForDomain({
        domain: selectedDomain,
        date: dateKey,
        preferLegacyContactActivities,
        preferCallLedger,
      });
      totals.callStatImports += Number(result?.calls?.imported || 0);
      totals.callStatUpserts += Number(result?.calls?.upserted || 0);
      totals.callStatModifications += Number(result?.calls?.modified || 0);
      totals.snapshotsRebuilt += Number(result?.snapshots?.rebuilt || 0);
      results.push({
        domain: selectedDomain,
        ok: true,
        result,
      });
    } catch (error) {
      totals.errors += 1;
      logger?.warn?.("hourly.metrics_refresh.domain_failed", {
        domain: selectedDomain,
        error: error.message,
      });
      results.push({
        domain: selectedDomain,
        ok: false,
        error: error.message,
      });
    }
  }

  return {
    date: dateKey,
    domains: results,
    totals,
  };
}

module.exports = {
  runHourlyMetricsRefresh,
};
