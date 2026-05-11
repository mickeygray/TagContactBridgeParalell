"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const { leadCadenceRepository } = require("../../shared-repositories/src");
const {
  resolveCaseContactEligibility,
} = require("./contactEligibilityService");

function normalizeDomain(value) {
  return String(value || "").trim().toUpperCase();
}

async function runHourlyLeadCadenceEnforcement({
  domains = null,
  domain = null,
  limitPerDomain = 250,
  minStaleMs = 55 * 60 * 1000,
  dryRun = false,
  logger = null,
  sourceService = "hourly-sweeper",
  now = new Date(),
} = {}) {
  const selectedDomains = Array.isArray(domains) && domains.length > 0
    ? domains.map(normalizeDomain).filter(Boolean)
    : domain
      ? [normalizeDomain(domain)]
      : getCompanyKeys().map(normalizeDomain).filter(Boolean);

  const summary = {
    startedAt: new Date(),
    dryRun: Boolean(dryRun),
    limitPerDomain: Math.min(Math.max(Number(limitPerDomain) || 250, 1), 5000),
    minStaleMs: Math.max(Number(minStaleMs) || 0, 0),
    totals: {
      scanned: 0,
      eligible: 0,
      blocked: 0,
      enforced: 0,
      errors: 0,
    },
    domains: [],
  };

  for (const selectedDomain of selectedDomains) {
    const rows = await leadCadenceRepository.listLeadCadenceForEnforcement({
      domain: selectedDomain,
      now,
      minStaleMs: summary.minStaleMs,
      limit: summary.limitPerDomain,
    });

    const domainSummary = {
      domain: selectedDomain,
      scanned: rows.length,
      eligible: 0,
      blocked: 0,
      enforced: 0,
      errors: 0,
      samples: [],
    };

    for (const row of rows) {
      const caseId = Number(row.caseId);
      try {
        const eligibility = await resolveCaseContactEligibility(selectedDomain, caseId, {
          now,
          enforceStop: !dryRun,
          currentStage: "contact-blocked",
          sourceService,
        });

        if (eligibility.ok) {
          domainSummary.eligible += 1;
          if (!dryRun) {
            await leadCadenceRepository.markLeadCadenceEvaluated(selectedDomain, caseId);
          }
          continue;
        }

        domainSummary.blocked += 1;
        if (!dryRun && eligibility.enforcement) {
          domainSummary.enforced += 1;
        }
        if (domainSummary.samples.length < 25) {
          domainSummary.samples.push({
            caseId,
            reason: eligibility.reason || null,
            detail: eligibility.detail || null,
            enforced: Boolean(eligibility.enforcement),
            sourceName: row.sourceName || row.intakeSource || null,
            currentStage: row.currentStage || null,
          });
        }
      } catch (error) {
        domainSummary.errors += 1;
        if (domainSummary.samples.length < 25) {
          domainSummary.samples.push({
            caseId,
            error: error.message,
          });
        }
        logger?.warn?.("hourly.cadence.enforcement.case_failed", {
          domain: selectedDomain,
          caseId,
          error: error.message,
        });
      }
    }

    summary.totals.scanned += domainSummary.scanned;
    summary.totals.eligible += domainSummary.eligible;
    summary.totals.blocked += domainSummary.blocked;
    summary.totals.enforced += domainSummary.enforced;
    summary.totals.errors += domainSummary.errors;
    summary.domains.push(domainSummary);

    if (domainSummary.blocked > 0 || domainSummary.errors > 0) {
      logger?.info?.("hourly.cadence.enforcement.domain", {
        domain: selectedDomain,
        scanned: domainSummary.scanned,
        blocked: domainSummary.blocked,
        enforced: domainSummary.enforced,
        errors: domainSummary.errors,
        dryRun: summary.dryRun,
      });
    }
  }

  summary.finishedAt = new Date();
  summary.durationMs = summary.finishedAt - summary.startedAt;
  return summary;
}

module.exports = {
  runHourlyLeadCadenceEnforcement,
};
