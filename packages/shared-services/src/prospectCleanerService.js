"use strict";

const { getSharedConfig } = require("../../shared-config/src");
const {
  leadCadenceRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { createLogicsFacade } = require("./logicsFacadeService");
const { recordWorkflowStage } = require("./workflowStateService");

/**
 * Nightly MasterProspect sweep.
 *
 * For every prospect currently at a "prospect" status (default 2), call
 * Logics `Case/CaseInfo` to refresh:
 *
 * - If the case has moved to a DNC / suppression status → delete the
 *   MasterProspect + LeadCadence rows (opt-outs can't be re-blasted).
 * - If the case is still at a prospect status and the MasterProspect is
 *   missing `cellPhone` or `email` → patch whichever Logics now has.
 * - If the case has converted to a different status (payment / client) →
 *   mark for future caseprofile upgrade (touched via `needsStatusRefresh`)
 *   and leave the MasterProspect row alone for this pass.
 *
 * Every batch writes workflow stages so an operator can audit what the
 * cleaner did.
 */
async function runProspectSweep({
  domain,
  limit,
  dryRun = false,
  dncStatusIds,
  prospectStatusIds,
  delayMsBetweenCalls,
} = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  if (!normalizedDomain) {
    const err = new Error("domain is required");
    err.status = 400;
    throw err;
  }

  const config = getSharedConfig();
  const dncSet = new Set(
    (Array.isArray(dncStatusIds) ? dncStatusIds : config.logicsDncStatusIds).map(
      (value) => Number(value),
    ),
  );
  const prospectSet = new Set(
    (Array.isArray(prospectStatusIds)
      ? prospectStatusIds
      : config.logicsProspectStatusIds
    ).map((value) => Number(value)),
  );
  const maxScanned = Math.min(
    Number(limit) || config.prospectCleaner.defaultLimit,
    5000,
  );
  const throttleMs = Math.max(
    0,
    Number(delayMsBetweenCalls) || config.prospectCleaner.delayMsBetweenCalls,
  );

  const startedAt = new Date();
  const batchAggregateId = `${normalizedDomain}-${startedAt.getTime()}`;

  await recordWorkflowStage({
    domain: normalizedDomain,
    family: "prospect-cleaner",
    subtype: "sweep",
    stage: "requested",
    aggregateType: "prospect-sweep",
    aggregateId: batchAggregateId,
    sourceService: "control-plane",
    title: "Prospect sweep requested",
    summary: `Scan up to ${maxScanned} missing-contact prospects (status ${[...prospectSet].join(",")})`,
    payload: {
      dncStatusIds: [...dncSet],
      prospectStatusIds: [...prospectSet],
      maxScanned,
      throttleMs,
      dryRun,
    },
  });

  const facade = createLogicsFacade(normalizedDomain);
  const stats = {
    scanned: 0,
    patched: 0,
    deleted: 0,
    movedToConverted: 0,
    skipped: 0,
    errors: 0,
  };
  const errors = [];
  const deletedCaseIds = [];
  const patchedCaseIds = [];

  // Only sweep prospects at a prospect status AND missing at least one channel.
  const [primaryStatus, ...otherStatuses] = [...prospectSet];
  const iter = masterProspectRepository.iterateMasterProspects(
    normalizedDomain,
    { statusId: primaryStatus ?? 2, missingContact: true },
    100,
  );

  for await (const prospect of iter) {
    if (stats.scanned >= maxScanned) break;
    stats.scanned += 1;

    const caseId = Number(prospect.caseId);
    if (!Number.isFinite(caseId)) {
      stats.skipped += 1;
      continue;
    }

    try {
      const fresh = await facade.fetchCaseInfo(caseId);
      if (!fresh.ok || !fresh.data) {
        stats.errors += 1;
        errors.push({ caseId, error: fresh.error || "No data" });
        continue;
      }

      const freshStatusId = Number(fresh.status);
      const freshCell =
        String(fresh.data.CellPhone || "").trim() ||
        String(fresh.data.HomePhone || "").trim() ||
        null;
      const freshEmail = String(fresh.data.Email || "").trim() || null;

      if (dncSet.size > 0 && dncSet.has(freshStatusId)) {
        if (!dryRun) {
          await Promise.all([
            masterProspectRepository.deleteMasterProspect(normalizedDomain, caseId),
            leadCadenceRepository.deleteLeadCadence(normalizedDomain, caseId),
          ]);
        }
        stats.deleted += 1;
        deletedCaseIds.push(caseId);
        continue;
      }

      if (prospectSet.size > 0 && !prospectSet.has(freshStatusId)) {
        // Case left the prospect bucket (converted, closed, etc.). Leave
        // the MasterProspect row but mark it for caseprofile upgrade later.
        if (!dryRun) {
          await masterProspectRepository.updateMasterProspect(normalizedDomain, caseId, {
            statusId: freshStatusId,
            needsStatusRefresh: true,
            lastStatusCheckAt: new Date(),
          });
        }
        stats.movedToConverted += 1;
        continue;
      }

      // Still in prospect bucket — patch any missing contact fields.
      const patch = {};
      if (!prospect.cellPhone && freshCell) patch.cellPhone = freshCell;
      if (!prospect.email && freshEmail) patch.email = freshEmail;

      if (Object.keys(patch).length === 0) {
        stats.skipped += 1;
        continue;
      }

      if (!dryRun) {
        await masterProspectRepository.updateMasterProspect(normalizedDomain, caseId, {
          ...patch,
          lastStatusCheckAt: new Date(),
          needsSourceRefresh: false,
        });
      }
      stats.patched += 1;
      patchedCaseIds.push(caseId);
    } catch (error) {
      stats.errors += 1;
      errors.push({ caseId, error: error.message });
    }

    if (throttleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, throttleMs));
    }
  }

  const finishedAt = new Date();
  const result = {
    domain: normalizedDomain,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    dryRun,
    stats,
    deletedCaseIds,
    patchedCaseIds,
    errors: errors.slice(0, 25),
  };

  await recordWorkflowStage({
    domain: normalizedDomain,
    family: "prospect-cleaner",
    subtype: "sweep",
    stage: "completed",
    aggregateType: "prospect-sweep",
    aggregateId: batchAggregateId,
    sourceService: "control-plane",
    title: "Prospect sweep completed",
    summary: `${stats.scanned} scanned · ${stats.patched} patched · ${stats.deleted} deleted · ${stats.movedToConverted} converted · ${stats.errors} errors`,
    result,
  });

  return result;
}

module.exports = {
  runProspectSweep,
};
