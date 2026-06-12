"use strict";

// clientCaseDiscoveryService — break the caseProfile blind-spot loop.
//
// THE LOOP (found live, June 2026, $5,803 of invisible initials): a case
// sold directly in Logics — no intake, no tracked call (e.g. the auth-spam
// window when the call-log pipeline was down) — never gets a caseProfile.
// The hourly payment reconcile ITERATES caseProfiles, so it never visits
// the case, so its payments never sync, so the payment-trigger that would
// have created the profile never fires. Permanently invisible to metrics.
//
// THE FIX: discover client cases from Logics STATUS, independent of call
// logs and intake. GetCasesByStatus is the doctrine-approved quiet GET
// (per-case enumeration; NEVER the group ActivityReport). For each case in
// a client status with no caseProfile:
//   1. reconcilePaymentsForCase — the production path; if the case has
//      payments this creates the profile (CaseInfo seed), ledger rows, and
//      counters exactly the way the hourly would have.
//   2. If still no profile (signed but unbilled), create a minimal one
//      (statusCategory client) so the hourly owns the case from now on.
//
// Status IDs come from CLIENT_CASE_DISCOVERY_STATUS_IDS (comma list) — the
// "[TIER n]" enrolled statuses. Unset = sweep skips and says so.

const { createLogicsClient } = require("../../shared-integrations/src");
const { reconcilePaymentsForCase } = require("./paymentReconcileService");
const {
  caseProfileRepository,
} = require("../../shared-repositories/src");

function parseStatusIds(value) {
  return String(value || "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function unwrapRows(payload) {
  const data = payload?.data !== undefined && payload?.data !== null
    ? payload.data
    : payload?.Data !== undefined && payload?.Data !== null
      ? payload.Data
      : payload;
  if (typeof data === "string") {
    try { return unwrapRows(JSON.parse(data)); } catch { return []; }
  }
  return Array.isArray(data) ? data : [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureClientCaseProfiles({
  domains = String(process.env.CLIENT_CASE_DISCOVERY_DOMAINS || "TAG").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  statusIds = parseStatusIds(process.env.CLIENT_CASE_DISCOVERY_STATUS_IDS),
  paceMs = 300,
  dryRun = false,
  logger = null,
} = {}) {
  if (!statusIds.length) {
    return { skipped: true, reason: "no-status-ids-configured (CLIENT_CASE_DISCOVERY_STATUS_IDS)" };
  }

  const mongoose = require("mongoose");
  require("../../shared-models/src");
  const CaseProfile = mongoose.model("ControlPlaneCaseProfile");

  const result = { domains: {}, dryRun: Boolean(dryRun) };
  for (const domain of domains) {
    const client = createLogicsClient(domain);
    const domainResult = { statuses: {}, discovered: 0, adopted: 0, seeded: 0, failures: 0 };

    for (const statusId of statusIds) {
      let rows;
      try {
        rows = unwrapRows(await client.getCasesByStatus(statusId));
      } catch (error) {
        domainResult.failures += 1;
        domainResult.statuses[statusId] = { error: error.message };
        logger?.warn?.("client_case_discovery.status_failed", { domain, statusId, error: error.message });
        continue;
      }
      const caseIds = [...new Set(
        rows.map((r) => Number(r?.CaseID ?? r?.CaseId ?? r?.caseId)).filter((n) => Number.isFinite(n) && n > 0),
      )];
      const existing = new Set(
        (await CaseProfile.find({ domain, caseId: { $in: caseIds } }, { caseId: 1 }).lean())
          .map((p) => Number(p.caseId)),
      );
      const missing = caseIds.filter((id) => !existing.has(id));
      domainResult.statuses[statusId] = { cases: caseIds.length, missing: missing.length };
      domainResult.discovered += missing.length;

      for (const caseId of missing) {
        if (dryRun) continue;
        try {
          // Production path first: payments → profile + ledger + counters.
          await reconcilePaymentsForCase({ domain, caseId, lane: "nightly", logger });
          const created = await CaseProfile.exists({ domain, caseId });
          if (created) {
            domainResult.adopted += 1;
          } else {
            // Signed but unbilled: minimal profile so the hourly owns it.
            const row = rows.find((r) => Number(r?.CaseID ?? r?.CaseId) === caseId) || {};
            const name = [row.FirstName, row.LastName].filter(Boolean).join(" ").trim()
              || row.FullName || row.Name || null;
            await caseProfileRepository.createCaseProfileIfMissing(domain, caseId, {
              name,
              firstName: row.FirstName || null,
              lastName: row.LastName || null,
              statusId,
              statusCategory: "client",
            });
            domainResult.seeded += 1;
          }
          logger?.info?.("client_case_discovery.case_ensured", { domain, caseId, statusId });
        } catch (error) {
          domainResult.failures += 1;
          logger?.warn?.("client_case_discovery.case_failed", { domain, caseId, error: error.message });
        }
        await sleep(paceMs + Math.floor(Math.random() * 150));
      }
    }
    result.domains[domain] = domainResult;
  }
  logger?.info?.("client_case_discovery.complete", result);
  return result;
}

module.exports = {
  ensureClientCaseProfiles,
  parseStatusIds,
};
