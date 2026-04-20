"use strict";

const {
  caseProfileRepository,
  deepCutRunRepository,
  reviewQueueRepository,
} = require("../../shared-repositories/src");

const activeRuns = new Map();

function buildDailyDeepCutPlan() {
  return {
    cadence: "daily-afterhours",
    groups: [
      {
        key: "attribution-gathering",
        purpose: "run the deepest attribution pass against call log, scored calls, lead cadence, case profiles, and shallow prospects",
        sources: [
          "Call log scoring results",
          "LeadCadence",
          "CaseProfile",
          "MasterProspectIndex",
          "CallRail",
          "RingCentral",
        ],
        outputs: [
          "attribution updates",
          "unresolved attribution review items",
          "source summaries by channel/vendor",
        ],
      },
      {
        key: "financial-final-pass",
        purpose: "check payments, invoices, billing summary, and final client/payment movements one last time",
        sources: ["Logics payments", "Logics invoices", "Logics billing summary"],
        outputs: [
          "new payment events",
          "payment failures and redlines",
          "daily financial summary for dashboard/report",
        ],
      },
      {
        key: "status-and-suppression",
        purpose: "apply after-hours status changes and STOP/DNC outcomes from SMS, calls, and activities",
        sources: [
          "LeadCadence outcomes",
          "SMS library results",
          "call transcription/scoring results",
          "Logics activities",
        ],
        outputs: [
          "status changes",
          "suppression actions",
          "human review items for legal/consent risk",
        ],
      },
      {
        key: "spend-and-source-summary",
        purpose: "sync spend after intake is settled so LD, BCD, FB, DM and other sources are persisted once and summarized",
        sources: ["Spend sheets", "Daily spend sync", "source canonical", "daily call stats"],
        outputs: [
          "spend rows synced",
          "source/channel totals",
          "dashboard-ready ROI summary inputs",
        ],
      },
      {
        key: "weekly-ai-case-review",
        purpose: "run Claude case-profile review only for case files not reviewed in the last 7 days",
        cadence: "weekly-within-daily-window",
        sources: ["CaseProfile", "AI activity review", "Logics activities", "financial status"],
        outputs: [
          "case review summaries",
          "concerns and positive notes",
          "cases due for manual human follow-up",
        ],
      },
      {
        key: "reporting-and-dashboard",
        purpose: "package deep-cut outputs into summaries for internal humans and client-facing dashboards",
        sources: ["all daily-afterhours groups"],
        outputs: [
          "deep cut run summary",
          "dashboard cards",
          "report payloads and human review feed",
        ],
      },
    ],
  };
}

async function buildDailyDeepCutDashboard(domain) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const latestRun = await deepCutRunRepository.getLatestDeepCutRun(normalizedDomain);
  const aiDue = await caseProfileRepository.findCaseProfilesDueForAiCaseReview(
    normalizedDomain,
    7,
    25,
  );

  return {
    domain: normalizedDomain,
    latestRun,
    weeklyAiReview: {
      dueCount: aiDue.length,
      sampleCaseIds: aiDue.slice(0, 10).map((profile) => profile.caseId),
    },
  };
}

function buildPlannedSections() {
  return buildDailyDeepCutPlan().groups.map((group) => ({
    key: group.key,
    title: group.key
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
    status: "planned",
    summary: null,
    metrics: null,
  }));
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSection(domain, sectionKey) {
  const normalizedDomain = String(domain || "").toUpperCase();
  switch (sectionKey) {
    case "attribution-gathering": {
      const unresolved = await reviewQueueRepository.countReviewQueueItems(normalizedDomain, {
        workflow: "hourly-hygiene",
        category: "attribution-unresolved",
        status: "open",
      });
      return {
        key: sectionKey,
        status: "completed",
        summary: unresolved
          ? `${unresolved} unresolved attribution items remain open.`
          : "No unresolved attribution review items are currently open.",
        metrics: {
          unresolvedAttributionItems: unresolved,
        },
      };
    }
    case "financial-final-pass": {
      const withPayments = await caseProfileRepository.countCaseProfilesWithPayments(normalizedDomain);
      return {
        key: sectionKey,
        status: "completed",
        summary: `${withPayments} case profiles currently show one or more payments.`,
        metrics: {
          profilesWithPayments: withPayments,
          paymentsDetected: withPayments,
        },
      };
    }
    case "status-and-suppression": {
      const stopSignals = await reviewQueueRepository.countReviewQueueItems(normalizedDomain, {
        workflow: "hourly-hygiene",
        category: "stop-detected",
        status: "open",
      });
      return {
        key: sectionKey,
        status: "completed",
        summary: stopSignals
          ? `${stopSignals} open STOP/suppression items need human review.`
          : "No open STOP/suppression review items were found.",
        metrics: {
          stopSignalsDetected: stopSignals,
        },
      };
    }
    case "spend-and-source-summary": {
      return {
        key: sectionKey,
        status: "completed",
        summary: "Spend/source summary stage is wired and ready for spend sync integration.",
        metrics: {
          spendRowsSynced: 0,
        },
      };
    }
    case "weekly-ai-case-review": {
      const due = await caseProfileRepository.findCaseProfilesDueForAiCaseReview(
        normalizedDomain,
        7,
        50,
      );
      return {
        key: sectionKey,
        status: "completed",
        summary: `${due.length} case profiles are currently due for weekly AI case review.`,
        metrics: {
          aiCaseReviewsDue: due.length,
          sampleCaseIds: due.slice(0, 10).map((profile) => profile.caseId),
        },
      };
    }
    case "reporting-and-dashboard": {
      const openReviewItems = await reviewQueueRepository.countReviewQueueItems(normalizedDomain, {
        status: "open",
      });
      return {
        key: sectionKey,
        status: "completed",
        summary: `${openReviewItems} open review items are available for the dashboard.`,
        metrics: {
          openReviewItems,
        },
      };
    }
    default:
      return {
        key: sectionKey,
        status: "completed",
        summary: "No-op section",
        metrics: {},
      };
  }
}

async function finalizeRun(runId, runType, domain, sections, options = {}) {
  const totalCasesTouched = await caseProfileRepository.countCaseProfilesByDomain(domain);
  const summary = sections.reduce(
    (acc, section) => {
      const metrics = section.metrics || {};
      acc.totalCasesTouched = totalCasesTouched;
      acc.statusChanges += metrics.statusChanges || 0;
      acc.paymentsDetected += metrics.paymentsDetected || 0;
      acc.redlinesDetected += metrics.redlinesDetected || 0;
      acc.attributionUpdates += metrics.unresolvedAttributionItems || 0;
      acc.stopSignalsDetected += metrics.stopSignalsDetected || 0;
      acc.spendRowsSynced += metrics.spendRowsSynced || 0;
      acc.aiCaseReviewsDue += metrics.aiCaseReviewsDue || 0;
      acc.aiCaseReviewsCompleted += metrics.aiCaseReviewsCompleted || 0;
      return acc;
    },
    {
      totalCasesTouched: 0,
      statusChanges: 0,
      paymentsDetected: 0,
      redlinesDetected: 0,
      attributionUpdates: 0,
      stopSignalsDetected: 0,
      spendRowsSynced: 0,
      aiCaseReviewsDue: 0,
      aiCaseReviewsCompleted: 0,
    },
  );

  const status = sections.some((section) => section.status === "failed")
    ? "failed"
    : "completed";

  await deepCutRunRepository.updateDeepCutRun(runId, {
    status,
    completedAt: new Date(),
    sections,
    summary,
    notes: options.notes || [],
  });

  activeRuns.delete(String(runId));
}

async function executeDeepCutRun(runId, domain, runType, options = {}) {
  const sectionKeys =
    runType === "daily-deep-cut-verification"
      ? ["reporting-and-dashboard", "weekly-ai-case-review", "status-and-suppression"]
      : buildDailyDeepCutPlan().groups.map((group) => group.key);

  const sectionMap = new Map(
    buildPlannedSections()
      .filter((section) => sectionKeys.includes(section.key))
      .map((section) => [section.key, { ...section, status: "running" }]),
  );

  await deepCutRunRepository.updateDeepCutRun(runId, {
    status: "running",
    sections: [...sectionMap.values()],
  });

  const sectionPromises = sectionKeys.map(async (sectionKey, index) => {
    try {
      if (index > 0) {
        await pause(150 * index);
      }
      const result = await runSection(domain, sectionKey);
      sectionMap.set(sectionKey, {
        ...sectionMap.get(sectionKey),
        ...result,
      });
      await deepCutRunRepository.updateDeepCutRun(runId, {
        sections: [...sectionMap.values()],
      });
    } catch (error) {
      sectionMap.set(sectionKey, {
        ...sectionMap.get(sectionKey),
        status: "failed",
        summary: error.message,
        metrics: {
          error: error.message,
        },
      });
      await deepCutRunRepository.updateDeepCutRun(runId, {
        sections: [...sectionMap.values()],
      });
    }
  });

  await Promise.allSettled(sectionPromises);
  await finalizeRun(runId, runType, domain, [...sectionMap.values()], options);
}

async function startDailyDeepCutRun(domain, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const run = await deepCutRunRepository.createDeepCutRun({
    domain: normalizedDomain,
    runType: "daily-deep-cut",
    status: "planned",
    startedAt: new Date(),
    sections: buildPlannedSections(),
    notes: options.notes || [],
  });

  const runId = String(run._id);
  activeRuns.set(runId, {
    runId,
    runType: "daily-deep-cut",
    domain: normalizedDomain,
    status: "running",
  });

  setTimeout(() => {
    executeDeepCutRun(runId, normalizedDomain, "daily-deep-cut", options).catch(async (error) => {
      await deepCutRunRepository.updateDeepCutRun(runId, {
        status: "failed",
        completedAt: new Date(),
        notes: [error.message],
      });
      activeRuns.delete(runId);
    });
  }, 0);

  return {
    ok: true,
    runId,
    status: "planned",
    runType: "daily-deep-cut",
  };
}

async function startDailyDeepCutVerification(domain, options = {}) {
  const normalizedDomain = String(domain || "").toUpperCase();
  const sections = buildPlannedSections().filter((section) =>
    ["reporting-and-dashboard", "weekly-ai-case-review", "status-and-suppression"].includes(section.key),
  );
  const run = await deepCutRunRepository.createDeepCutRun({
    domain: normalizedDomain,
    runType: "daily-deep-cut-verification",
    status: "planned",
    startedAt: new Date(),
    sections,
    notes: options.notes || [],
    payload: {
      parentRunId: options.parentRunId || null,
    },
  });

  const runId = String(run._id);
  activeRuns.set(runId, {
    runId,
    runType: "daily-deep-cut-verification",
    domain: normalizedDomain,
    status: "running",
  });

  setTimeout(() => {
    executeDeepCutRun(runId, normalizedDomain, "daily-deep-cut-verification", options).catch(async (error) => {
      await deepCutRunRepository.updateDeepCutRun(runId, {
        status: "failed",
        completedAt: new Date(),
        notes: [error.message],
      });
      activeRuns.delete(runId);
    });
  }, 0);

  return {
    ok: true,
    runId,
    status: "planned",
    runType: "daily-deep-cut-verification",
  };
}

async function recordDailyDeepCutRun(input = {}) {
  const normalizedDomain = String(input.domain || "").toUpperCase();
  return deepCutRunRepository.createDeepCutRun({
    domain: normalizedDomain,
    runType: input.runType || "daily-deep-cut",
    status: input.status || "completed",
    startedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
    completedAt: input.completedAt ? new Date(input.completedAt) : new Date(),
    summary: input.summary || {},
    sections: input.sections || [],
    notes: input.notes || [],
    payload: input.payload || null,
    reportRecipients: input.reportRecipients || [],
  });
}

async function listDailyDeepCutRuns(domain, filters = {}) {
  return deepCutRunRepository.listDeepCutRuns(domain, filters);
}

async function getDailyDeepCutRun(runId) {
  return deepCutRunRepository.getDeepCutRunById(runId);
}

module.exports = {
  buildDailyDeepCutDashboard,
  buildDailyDeepCutPlan,
  getDailyDeepCutRun,
  listDailyDeepCutRuns,
  recordDailyDeepCutRun,
  startDailyDeepCutRun,
  startDailyDeepCutVerification,
};
