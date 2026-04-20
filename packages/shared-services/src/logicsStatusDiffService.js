"use strict";

const { masterProspectRepository } = require("../../shared-repositories/src");
const { buildDomainStatusScanPlan } = require("./logicsScanService");
const { createLogicsFacade } = require("./logicsFacadeService");

function normalizeCaseIds(payload) {
  if (!payload) return [];
  if (!Array.isArray(payload)) return [];

  return [...new Set(payload.map((value) => Number(value)).filter((value) => Number.isFinite(value)))].sort(
    (left, right) => left - right,
  );
}

async function fetchStatusMembership(domain, statusId, options = {}) {
  const logics = createLogicsFacade(domain);
  const payload = await logics.getCasesByStatus(statusId, options);
  const caseIds = normalizeCaseIds(payload);

  return {
    statusId: Number(statusId),
    caseIds,
    total: caseIds.length,
  };
}

async function buildProspectStatusDiff(domain, options = {}) {
  const plan = buildDomainStatusScanPlan(domain);
  if (!plan) {
    return null;
  }

  const statusScans = [];
  for (const statusId of plan.prospectStatusIds) {
    const scan = await fetchStatusMembership(plan.domain, statusId, {
      orderByCreatedDate: options.orderByCreatedDate,
    });
    statusScans.push(scan);
  }

  const remoteMembership = new Map();
  for (const scan of statusScans) {
    for (const caseId of scan.caseIds) {
      if (!remoteMembership.has(caseId)) {
        remoteMembership.set(caseId, new Set());
      }
      remoteMembership.get(caseId).add(scan.statusId);
    }
  }

  const localRows = await masterProspectRepository.listProspectsByStatusIds(
    plan.domain,
    plan.prospectStatusIds,
  );

  const localByCaseId = new Map(localRows.map((row) => [Number(row.caseId), row]));

  const missingLocally = [];
  for (const [caseId, membership] of remoteMembership.entries()) {
    if (!localByCaseId.has(caseId)) {
      missingLocally.push({
        caseId,
        remoteStatusIds: [...membership].sort((left, right) => left - right),
      });
    }
  }

  const missingRemotely = [];
  for (const row of localRows) {
    if (!remoteMembership.has(Number(row.caseId))) {
      missingRemotely.push({
        caseId: Number(row.caseId),
        localStatusId: Number(row.statusId),
      });
    }
  }

  return {
    domain: plan.domain,
    scannedStatusIds: plan.prospectStatusIds,
    remoteCaseCount: remoteMembership.size,
    localCaseCount: localRows.length,
    statusScans: statusScans.map((scan) => ({ statusId: scan.statusId, total: scan.total })),
    missingLocally,
    missingRemotely,
  };
}

module.exports = {
  buildProspectStatusDiff,
  fetchStatusMembership,
  normalizeCaseIds,
};
