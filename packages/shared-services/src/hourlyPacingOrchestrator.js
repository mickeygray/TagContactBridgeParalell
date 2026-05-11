"use strict";

const {
  agentSliceRepository,
  agentStateRepository,
  poolBudgetRepository,
  queueItemRepository,
} = require("../../shared-repositories/src");
const { getConfig } = require("./pacingConfigService");
const {
  isOperatingNow,
  formatHourBucket,
  getZonedParts,
} = require("./businessHoursGuard");
const { refillPool } = require("./universalQueueService");
const { issueSlice, releaseSliceById, isAgentEligibleForSlice } = require("./agentSliceService");
const { drainPending } = require("./freshLeadAssignmentService");
const { computePacingReport } = require("./pacingReportService");

// hourlyPacingOrchestrator — runs once per hour at the top of the hour.
//
// Sequence:
//   1. Compute pacing report for the PRIOR hour (before counters reset)
//   2. Roll over PoolBudget counters to new hour
//   3. If new hour is outside operating window:
//        - Mark report skippedReason: "outside-hours"
//        - Skip slice issuance, return early
//   4. Release any active slices from prior hour back to the pool
//      (their items get bumped to the bottom of the FIFO)
//   5. Refill pool to floor
//   6. For each eligible idle agent, issue a fresh slice
//   7. Drain pending_assignment fresh-lead lane

async function runHourly({ asOf = new Date() } = {}) {
  const config = await getConfig();
  if (config.enabled === false) {
    return { skipped: true, reason: "config-disabled" };
  }

  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const newHourBucket = formatHourBucket(asOf, tz);

  // Determine prior hour bucket (subtract 1 hour, format)
  const prior = new Date(asOf.getTime() - 60 * 60 * 1000);
  const priorHourBucket = formatHourBucket(prior, tz);

  // 1. Generate report for prior hour
  const operatingPriorHour = isOperatingNow(config, prior);
  const priorReport = await computePacingReport(priorHourBucket, {
    skippedReason: operatingPriorHour ? null : "outside-hours",
  });

  // 2. Roll over counters
  await poolBudgetRepository.rolloverHour(newHourBucket);

  // 3. Operating-window guard for the NEW hour
  const operating = isOperatingNow(config, asOf);
  if (!operating) {
    return {
      skipped: true,
      reason: "outside-hours",
      newHourBucket,
      priorReport,
    };
  }

  // 4. Release prior-hour active slices, but ONLY if no item in the
  //    slice is currently in `dialing` state. Releasing a slice with a
  //    live call would orphan the CallSession (item moves back to
  //    in_pool while the call is still happening). For those slices,
  //    we defer release until the dialing item dispositions or fails.
  const priorSlices = await agentSliceRepository.listSlicesForHour(priorHourBucket);
  let releasedCount = 0;
  let deferredCount = 0;
  for (const slice of priorSlices) {
    if (slice.state !== "active") continue;
    const items = await queueItemRepository.listBySlice(slice.sliceId);
    const hasLiveCall = items.some((it) => it.state === "dialing");
    if (hasLiveCall) {
      deferredCount += 1;
      continue;
    }
    await releaseSliceById(slice.sliceId, { reason: "hour-rollover" });
    releasedCount += 1;
  }

  // 5. Refill pool to floor
  const refillResult = await refillPool({
    floor: config.teamHourlyTarget,
    hourBucket: newHourBucket,
  });

  // 6. Issue slices to eligible idle agents. Eligibility is delegated
  //    to isAgentEligibleForSlice to keep one source of truth — same
  //    logic that gates dialService and freshLeadAssignment.
  const allAgents = await agentStateRepository.listAgentStates({ routingEnabled: true });
  const issuanceResults = [];
  for (const agent of allAgents || []) {
    const elig = await isAgentEligibleForSlice(agent.extensionId, config);
    if (!elig.eligible) {
      issuanceResults.push({
        agentId: agent.extensionId,
        agentName: agent.name,
        issued: false,
        reason: elig.reason,
      });
      continue;
    }
    const result = await issueSlice(agent.extensionId, { hourBucket: newHourBucket });
    issuanceResults.push({
      agentId: agent.extensionId,
      agentName: agent.name,
      ...result,
    });
  }

  // 7. Drain pending fresh-lead lane (ones that arrived overnight or
  //    while everyone was busy)
  const drainResult = await drainPending({ maxItems: 50 });

  return {
    skipped: false,
    newHourBucket,
    priorHourBucket,
    priorReport,
    releasedPriorSlices: releasedCount,
    deferredPriorSlices: deferredCount,
    refillResult,
    slicesIssued: issuanceResults.filter((r) => r.issued).length,
    slicesSkipped: issuanceResults.filter((r) => !r.issued).length,
    issuanceResults,
    drainResult,
  };
}

// ── Morning prep cron — runs at 7am M-F, before 8am rollover ───────
//
// Off-hours refill so the pool is loaded for 8am. Doesn't issue slices
// (those wait for 8am rollover). Drains overnight cadence backlog.

async function runMorningPrep({ asOf = new Date() } = {}) {
  const config = await getConfig();
  if (config.enabled === false) {
    return { skipped: true, reason: "config-disabled" };
  }
  const tz = config.businessHoursTimezone || "America/Los_Angeles";
  const parts = getZonedParts(asOf, tz);
  const days = Array.isArray(config.businessDays) ? config.businessDays : [1, 2, 3, 4, 5];
  if (!days.includes(parts.weekday)) {
    return { skipped: true, reason: "non-business-day" };
  }

  const hourBucket = formatHourBucket(asOf, tz);
  const refillResult = await refillPool({
    floor: config.teamHourlyTarget,
    hourBucket,
    force: true, // bypass operating-hours check; this IS the prep
  });
  return { skipped: false, refillResult };
}

module.exports = {
  runHourly,
  runMorningPrep,
};
