"use strict";

const {
  pacingReportRepository,
  poolBudgetRepository,
  queueItemRepository,
  agentSliceRepository,
  agentStateRepository,
} = require("../../shared-repositories/src");
const { getConfig } = require("./pacingConfigService");

// pacingReportService — builds the hourly pacing report doc, comparing
// configured targets vs. actual dialing. Called by hourlyPacingOrchestrator
// at hour rollover, BEFORE the rollover counters reset.
//
// The report captures:
//   - Per-agent: targetCount vs actualDialedCount (slice issuance vs dispositioned)
//   - Team: teamHourlyTarget vs sum(actualDialedCount)
//   - Pool: how many remained at hour close, how many entered/refilled
//   - Flags: underUtilized, overTarget
//
// Surface: returned to admin via GET /api/admin/pacing/reports/:hourBucket
// and emailed to admin if alerting is wired up (separate service).

async function computePacingReport(hourBucket, { skippedReason = null } = {}) {
  const config = await getConfig();
  const tz = config.businessHoursTimezone || "America/Los_Angeles";

  // Pull pool budget snapshot (this hour's counters)
  const budget = await poolBudgetRepository.readBudget();

  // Pull all slices issued in this hour
  const slices = await agentSliceRepository.listSlicesForHour(hourBucket);

  // Build per-agent breakdown — for each unique agentId in slices,
  // sum actualDialedCount (= completedCount across their slices in this hour).
  const perAgentMap = new Map();
  for (const slice of slices) {
    const entry = perAgentMap.get(slice.agentId) || {
      agentId: slice.agentId,
      agentName: null,
      targetCount: config.perAgentSliceSize || 10,
      actualDialedCount: 0,
      completedCount: 0,
      sliceState: slice.state,
      eligibilityHours: 1.0,
    };
    entry.actualDialedCount += slice.completedCount || 0;
    entry.completedCount += slice.completedCount || 0;
    if (slice.state === "active" && entry.sliceState !== "released") {
      entry.sliceState = "active";
    }
    perAgentMap.set(slice.agentId, entry);
  }

  // Look up agent names
  for (const entry of perAgentMap.values()) {
    const agent = await agentStateRepository.findAgentStateByExtensionId(entry.agentId);
    entry.agentName = agent?.name || null;
  }

  const perAgent = Array.from(perAgentMap.values()).sort(
    (a, b) => b.actualDialedCount - a.actualDialedCount,
  );
  const teamActualDialedCount = perAgent.reduce((s, e) => s + e.actualDialedCount, 0);
  const teamCompletedCount = perAgent.reduce((s, e) => s + e.completedCount, 0);

  // Pool occupancy at hour close
  const poolRemainingByPartition = budget.inPoolByPartition || { fresh: 0, non_fresh: 0 };
  const poolRemaining = budget.inPoolCount || 0;

  const teamHourlyTarget = config.teamHourlyTarget || 100;
  const underUtilized = !skippedReason
    && teamActualDialedCount < teamHourlyTarget * 0.8
    && poolRemaining > 0;
  const overTarget = teamActualDialedCount > teamHourlyTarget * 1.2;

  const report = {
    hourBucket,
    generatedAt: new Date(),
    perAgentSliceSize: config.perAgentSliceSize || 10,
    teamHourlyTarget,
    teamActualDialedCount,
    teamCompletedCount,
    poolRemaining,
    poolRemainingByPartition,
    poolEnteredThisHour: budget.hourEnteredCount || 0,
    poolRefilledThisHour: budget.hourRefilledCount || 0,
    perAgent,
    operatingHour: !skippedReason,
    skippedReason,
    underUtilized,
    overTarget,
    notes: [],
  };

  await pacingReportRepository.upsertReport(hourBucket, report);
  return report;
}

async function getReport(hourBucket) {
  return pacingReportRepository.findByHour(hourBucket);
}

async function listRecentReports({ limit = 24 } = {}) {
  return pacingReportRepository.listRecent({ limit });
}

// ── Format report as plaintext for email ───────────────────────────

function formatReportText(report) {
  if (!report) return "(no report)";
  const lines = [];
  lines.push(`Hourly Pacing Report — ${report.hourBucket}`);
  lines.push("─".repeat(60));
  if (report.skippedReason) {
    lines.push(`Skipped: ${report.skippedReason}`);
    return lines.join("\n");
  }
  const ratio = report.teamHourlyTarget
    ? Math.round((report.teamActualDialedCount / report.teamHourlyTarget) * 100)
    : 0;
  lines.push(`Team target:   ${report.teamHourlyTarget}    Actual dialed: ${report.teamActualDialedCount}    [${ratio}%]`);
  lines.push(`Pool ended at: ${report.poolRemaining}    Refills:       ${report.poolRefilledThisHour}`);
  if (report.poolEnteredThisHour) {
    lines.push(`Pool entered:  ${report.poolEnteredThisHour}`);
  }
  lines.push("");
  lines.push(`Per-agent (target ${report.perAgentSliceSize} each):`);
  for (const a of report.perAgent || []) {
    const pct = a.targetCount
      ? Math.round((a.actualDialedCount / a.targetCount) * 100)
      : 0;
    const flag = pct >= 200 ? " (top performer)"
      : pct < 40 ? " (below target)"
      : "";
    lines.push(`  ${(a.agentName || a.agentId).padEnd(20)} ${String(a.actualDialedCount).padStart(3)}  (${pct}%${flag})`);
  }
  if (report.underUtilized) lines.push("\n⚠ Underutilized this hour");
  if (report.overTarget) lines.push("\n✓ Overperformed target");
  return lines.join("\n");
}

module.exports = {
  computePacingReport,
  getReport,
  listRecentReports,
  formatReportText,
};
