"use strict";

const {
  activityAiReviewRepository,
  agentStateRepository,
  caseProfileRepository,
  conversationWorkflowRepository,
  dailyCallStatRepository,
  deepCutRunRepository,
  dispatchListRepository,
  leadCadenceRepository,
  masterProspectRepository,
  metricsSnapshotRepository,
  paymentAlertRepository,
  paymentLedgerRepository,
  qualityReviewRepository,
  reviewQueueRepository,
  spendEntryRepository,
  workflowRecordRepository,
} = require("../../shared-repositories/src");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

async function buildMetricsWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    daily,
    lifetime,
    latestDeepCutRun,
    prospects,
    caseProfiles,
    payments,
    openReviewItems,
  ] = await Promise.all([
    metricsSnapshotRepository.getLatestDailyMetrics(normalizedDomain),
    metricsSnapshotRepository.findMetricsSnapshot(normalizedDomain, "lifetime", "all-time"),
    deepCutRunRepository.getLatestDeepCutRun(normalizedDomain),
    masterProspectRepository.countMasterProspects(normalizedDomain),
    caseProfileRepository.countCaseProfilesByDomain(normalizedDomain),
    paymentLedgerRepository.countPayments(normalizedDomain),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open" }),
  ]);

  return {
    domain: normalizedDomain,
    snapshots: {
      daily,
      lifetime,
    },
    counts: {
      prospects,
      caseProfiles,
      payments,
      openReviewItems,
    },
    latestDeepCutRun,
  };
}

async function buildMetricSourcesWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const [spendRows, paymentRows] = await Promise.all([
    spendEntryRepository.summarizeSpendBySource(normalizedDomain, filters),
    paymentLedgerRepository.listPayments(normalizedDomain, {
      limit: Math.min(Number(filters.paymentLimit) || 500, 2000),
    }),
  ]);

  const bySource = new Map();

  for (const row of spendRows) {
    const source = row._id?.source || "Unknown";
    const channel = row._id?.channel || null;
    bySource.set(source, {
      source,
      channel,
      spend: row.spend || 0,
      pieces: row.pieces || 0,
      impressions: row.impressions || 0,
      clicks: row.clicks || 0,
      leadsReported: row.leadsReported || 0,
      payments: 0,
      paymentCount: 0,
    });
  }

  for (const payment of paymentRows) {
    const source = payment.sourceName || "Unknown";
    if (!bySource.has(source)) {
      bySource.set(source, {
        source,
        channel: payment.sourceChannel || null,
        spend: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
        leadsReported: 0,
        payments: 0,
        paymentCount: 0,
      });
    }
    const entry = bySource.get(source);
    entry.payments += Number(payment.amount || 0);
    entry.paymentCount += 1;
    entry.channel = entry.channel || payment.sourceChannel || null;
  }

  const rows = [...bySource.values()]
    .map((row) => ({
      ...row,
      roas: row.spend > 0 ? row.payments / row.spend : null,
    }))
    .sort((left, right) => (right.spend + right.payments) - (left.spend + left.payments));

  return {
    domain: normalizedDomain,
    rows,
  };
}

async function buildDailySummaryWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const date = String(filters.date || new Date().toISOString().slice(0, 10));
  const [spendRows, paymentRows, callRows] = await Promise.all([
    spendEntryRepository.summarizeSpendBySource(normalizedDomain, { date }),
    paymentLedgerRepository.listPayments(normalizedDomain, { limit: 2000 }),
    dailyCallStatRepository.summarizeCallStats({ date }),
  ]);

  const rows = new Map();

  for (const row of spendRows) {
    const source = row._id?.source || "Unknown";
    rows.set(source, {
      source,
      channel: row._id?.channel || null,
      spend: row.spend || 0,
      pieces: row.pieces || 0,
      impressions: row.impressions || 0,
      clicks: row.clicks || 0,
      leadsReported: row.leadsReported || 0,
      deals: 0,
      paid: 0,
      calls: 0,
      callsOver5: 0,
    });
  }

  for (const payment of paymentRows) {
    const paymentDateKey = String(payment.paymentDate || "").slice(0, 10);
    if (paymentDateKey !== date) continue;
    const source = payment.sourceName || "Unknown";
    if (!rows.has(source)) {
      rows.set(source, {
        source,
        channel: payment.sourceChannel || null,
        spend: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
        leadsReported: 0,
        deals: 0,
        paid: 0,
        calls: 0,
        callsOver5: 0,
      });
    }
    const entry = rows.get(source);
    entry.paid += Number(payment.amount || 0);
    entry.deals += 1;
    entry.channel = entry.channel || payment.sourceChannel || null;
  }

  for (const row of callRows) {
    const source = row._id?.piece || "Unknown";
    if (!rows.has(source)) {
      rows.set(source, {
        source,
        channel: row._id?.channel || null,
        spend: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
        leadsReported: 0,
        deals: 0,
        paid: 0,
        calls: 0,
        callsOver5: 0,
      });
    }
    const entry = rows.get(source);
    entry.calls += row.totalCalls || 0;
    entry.callsOver5 += row.callsOver5 || 0;
    entry.channel = entry.channel || row._id?.channel || null;
  }

  const mergedRows = [...rows.values()].sort((left, right) => {
    const leftWeight = (left.spend || 0) + (left.paid || 0) + (left.calls || 0);
    const rightWeight = (right.spend || 0) + (right.paid || 0) + (right.calls || 0);
    return rightWeight - leftWeight;
  });

  return {
    domain: normalizedDomain,
    date,
    rows: mergedRows,
  };
}

async function buildMailCostWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const [totals, byPiece, rows] = await Promise.all([
    spendEntryRepository.getSpendTotals(normalizedDomain, { ...filters, channel: "mailer" }),
    spendEntryRepository.summarizeMailCosts(normalizedDomain, filters),
    spendEntryRepository.listSpendEntries(normalizedDomain, { ...filters, channel: "mailer", limit: filters.limit || 200 }),
  ]);

  return {
    domain: normalizedDomain,
    totals,
    byPiece,
    rows,
  };
}

async function buildCallrailWorkspace(filters = {}) {
  const [summary, rows] = await Promise.all([
    dailyCallStatRepository.summarizeCallsByChannel(filters),
    dailyCallStatRepository.summarizeCallStats(filters),
  ]);

  return {
    date: filters.date || null,
    from: filters.from || null,
    to: filters.to || null,
    summary,
    rows,
  };
}

async function buildRedlineWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    pendingCount,
    suppressedCount,
    sentCount,
    pendingAlerts,
    reviewRedlines,
  ] = await Promise.all([
    paymentAlertRepository.countPaymentAlerts(normalizedDomain, { status: "pending" }),
    paymentAlertRepository.countPaymentAlerts(normalizedDomain, { status: "suppressed" }),
    paymentAlertRepository.countPaymentAlerts(normalizedDomain, { status: "sent" }),
    paymentAlertRepository.listPaymentAlerts(normalizedDomain, {
      status: filters.status || "pending",
      limit: filters.limit,
    }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, {
      category: "redline",
      limit: 50,
    }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      pending: pendingCount,
      suppressed: suppressedCount,
      sent: sentCount,
      reviewRedlines: reviewRedlines.length,
    },
    alerts: pendingAlerts,
    reviewItems: reviewRedlines,
  };
}

async function buildScheduleWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    activeCadenceCount,
    inactiveCadenceCount,
    dueSmsCount,
    dueEmailCount,
    dueRvmCount,
    dueCxCount,
    recentCadence,
    recentDispatchLists,
  ] = await Promise.all([
    leadCadenceRepository.countLeadCadence(normalizedDomain, { active: true }),
    leadCadenceRepository.countLeadCadence(normalizedDomain, { active: false }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "sms" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "email" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "rvm" }),
    leadCadenceRepository.countDueLeadCadenceByChannel(normalizedDomain, { channel: "cx" }),
    leadCadenceRepository.listLeadCadence(normalizedDomain, { limit: 10 }),
    dispatchListRepository.listDispatchLists(normalizedDomain, { limit: 10 }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      activeCadence: activeCadenceCount,
      inactiveCadence: inactiveCadenceCount,
      dueByChannel: {
        sms: dueSmsCount,
        email: dueEmailCount,
        rvm: dueRvmCount,
        cx: dueCxCount,
      },
    },
    recentCadence,
    recentDispatchLists,
  };
}

async function listScheduleCadence(domain, filters = {}) {
  return leadCadenceRepository.listLeadCadence(normalizeDomain(domain), filters);
}

async function buildReviewWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const [
    openCount,
    reviewedCount,
    warningCount,
    criticalCount,
    recentOpenItems,
    recentDailyRuns,
  ] = await Promise.all([
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "reviewed" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "warning" }),
    reviewQueueRepository.countReviewQueueItems(normalizedDomain, { status: "open", severity: "critical" }),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { status: "open", limit: 15 }),
    deepCutRunRepository.listDeepCutRuns(normalizedDomain, { limit: 10 }),
  ]);

  return {
    domain: normalizedDomain,
    counts: {
      open: openCount,
      reviewed: reviewedCount,
      warning: warningCount,
      critical: criticalCount,
    },
    recentOpenItems,
    recentDailyRuns,
  };
}

async function listReviewWorkspaceItems(domain, filters = {}) {
  return reviewQueueRepository.listReviewQueueItems(normalizeDomain(domain), filters);
}

async function buildClientDetail(domain, caseId) {
  const normalizedDomain = normalizeDomain(domain);
  const numericCaseId = Number(caseId);

  const [
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    recentWorkflowStages,
  ] = await Promise.all([
    masterProspectRepository.findMasterProspect(normalizedDomain, numericCaseId),
    caseProfileRepository.findCaseProfile(normalizedDomain, numericCaseId),
    leadCadenceRepository.findLeadCadence(normalizedDomain, numericCaseId),
    paymentLedgerRepository.listPaymentsForCase(normalizedDomain, numericCaseId),
    reviewQueueRepository.listReviewQueueItems(normalizedDomain, { caseId: numericCaseId, limit: 50 }),
    activityAiReviewRepository.findLatestActivityAiReview(normalizedDomain, numericCaseId),
    qualityReviewRepository.findLatestQualityReview(normalizedDomain, numericCaseId),
    workflowRecordRepository.listWorkflowRecords({
      domain: normalizedDomain,
      caseId: numericCaseId,
      limit: 20,
    }),
  ]);

  const primaryPhone = caseProfile?.primaryPhone || prospect?.cellPhone || prospect?.homePhone || prospect?.workPhone || null;
  const latestConversationWorkflow = primaryPhone
    ? await conversationWorkflowRepository.findConversationWorkflow(normalizedDomain, primaryPhone)
    : null;

  return {
    domain: normalizedDomain,
    caseId: numericCaseId,
    prospect,
    caseProfile,
    cadence,
    payments,
    reviewItems,
    latestActivityReview,
    latestQualityReview,
    latestConversationWorkflow,
    recentWorkflowStages,
  };
}

async function searchClientWorkspace(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const search = String(filters.search || "").trim();
  const limit = Math.min(Number(filters.limit) || 25, 100);

  const [prospects, caseProfiles] = await Promise.all([
    masterProspectRepository.listMasterProspects(normalizedDomain, { search, limit }),
    caseProfileRepository.listCaseProfiles(normalizedDomain, { search, limit }),
  ]);

  return {
    domain: normalizedDomain,
    search,
    prospects,
    caseProfiles,
  };
}

async function buildRingCentralWorkspace(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const agents = await agentStateRepository.listAgentStates({ company: normalizedDomain });

  const summary = agents.reduce((accumulator, agent) => {
    accumulator.total += 1;
    accumulator.byStatus[agent.status] = (accumulator.byStatus[agent.status] || 0) + 1;
    if (agent.cxRouting?.desiredAvailability === "unavailable") {
      accumulator.cxUnavailable += 1;
    }
    if (agent.currentCall?.telephonySessionId) {
      accumulator.activeCalls += 1;
    }
    return accumulator;
  }, {
    total: 0,
    cxUnavailable: 0,
    activeCalls: 0,
    byStatus: {},
  });

  return {
    domain: normalizedDomain,
    summary,
    agents,
  };
}

module.exports = {
  buildClientDetail,
  buildCallrailWorkspace,
  buildDailySummaryWorkspace,
  buildMailCostWorkspace,
  buildMetricsWorkspace,
  buildMetricSourcesWorkspace,
  buildRedlineWorkspace,
  buildReviewWorkspace,
  buildRingCentralWorkspace,
  buildScheduleWorkspace,
  listReviewWorkspaceItems,
  listScheduleCadence,
  searchClientWorkspace,
};
