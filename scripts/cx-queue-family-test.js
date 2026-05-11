"use strict";

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
  override: true,
});

const mongoose = require("mongoose");
const {
  listControlPlaneLeadCadenceByCaseIds,
  findLeadCadence,
} = require("../packages/shared-repositories/src/leadCadenceRepository");
const cxDialQueueRepository = require("../packages/shared-repositories/src/cxDialQueueRepository");
const {
  previewCxAssignment,
  releaseCxQueueItem,
} = require("../packages/shared-services/src/cxCadenceService");

const FAMILY_MAP = Object.freeze({
  new: "fresh-day1",
  fresh: "fresh-day1",
  "fresh-day1": "fresh-day1",
  old: "fresh-day2to10",
  older: "fresh-day2to10",
  "fresh-day2to10": "fresh-day2to10",
  aged: "aged",
});

const FAMILY_CONFIG = Object.freeze({
  "fresh-day1": {
    label: "new",
    queueTier: "day0",
    activeDay: 0,
    nextDelayMinutes: 5,
    priorityScore: 9999,
  },
  "fresh-day2to10": {
    label: "old",
    queueTier: "later",
    activeDay: 3,
    nextDelayMinutes: 30,
    priorityScore: 9998,
  },
  aged: {
    label: "aged",
    queueTier: "later",
    activeDay: 11,
    nextDelayMinutes: 120,
    priorityScore: 9997,
  },
});

const DEFAULT_OVERRIDES = Object.freeze({
  state: "ready",
  callsPlaced: null,
  activeDay: null,
  daysAgo: null,
  currentStage: null,
  progressiveStage: null,
});

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function normalizeCaseId(caseId) {
  const parsed = Number(caseId);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid caseId: ${caseId}`);
  }
  return parsed;
}

function resolveFamily(raw) {
  const normalized = String(raw || "").trim().toLowerCase();
  const family = FAMILY_MAP[normalized];
  if (!family) {
    throw new Error(`Unsupported family "${raw}". Use new, old, or aged.`);
  }
  return family;
}

function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

async function connect() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`connected: db=${mongoose.connection.name}`);
}

async function loadLead(domain, caseId) {
  const controlPlaneDocs = await listControlPlaneLeadCadenceByCaseIds(domain, [caseId]);
  if (controlPlaneDocs.length > 0) {
    return {
      source: "control-plane",
      lead: controlPlaneDocs[0],
    };
  }

  const legacyDoc = await findLeadCadence(domain, caseId);
  if (legacyDoc) {
    return {
      source: "legacy",
      lead: legacyDoc,
    };
  }

  throw new Error(`No lead found for ${domain}/${caseId}`);
}

function parseNumberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveQueueFamilyRank(family) {
  if (family === "fresh-day1") return 0;
  if (family === "fresh-day2to10") return 1;
  if (family === "aged") return 2;
  return 99;
}

function resolveProgressiveStage(raw, family, callsPlaced = 0) {
  if (family !== "fresh-day1") {
    return {
      progressiveStageKey: null,
      progressiveStageIndex: 99,
      progressiveStageLabel: null,
      actionKey: null,
    };
  }

  const normalized = String(raw || "").trim().toLowerCase();
  if (
    normalized === "2"
    || normalized === "second"
    || normalized === "second-contact"
    || normalized === "new-2"
  ) {
    return {
      progressiveStageKey: "second-contact",
      progressiveStageIndex: 1,
      progressiveStageLabel: "Second contact",
      actionKey: "cx-day0-2",
    };
  }
  if (
    normalized === "3"
    || normalized === "third"
    || normalized === "third-contact"
    || normalized === "new-3"
  ) {
    return {
      progressiveStageKey: "third-contact",
      progressiveStageIndex: 2,
      progressiveStageLabel: "Third contact",
      actionKey: "cx-day0-3",
    };
  }
  if (
    normalized === "1"
    || normalized === "first"
    || normalized === "just"
    || normalized === "just-came-in"
    || normalized === "new-1"
  ) {
    return {
      progressiveStageKey: "just-came-in",
      progressiveStageIndex: 0,
      progressiveStageLabel: "Just came in",
      actionKey: "cx-day0-1",
    };
  }

  if (callsPlaced >= 2) {
    return {
      progressiveStageKey: "third-contact",
      progressiveStageIndex: 2,
      progressiveStageLabel: "Third contact",
      actionKey: "cx-day0-3",
    };
  }
  if (callsPlaced >= 1) {
    return {
      progressiveStageKey: "second-contact",
      progressiveStageIndex: 1,
      progressiveStageLabel: "Second contact",
      actionKey: "cx-day0-2",
    };
  }
  return {
    progressiveStageKey: "just-came-in",
    progressiveStageIndex: 0,
    progressiveStageLabel: "Just came in",
    actionKey: "cx-day0-1",
  };
}

function buildQueueSeed(lead, family, overrides = {}) {
  const config = FAMILY_CONFIG[family];
  const now = new Date();
  const state = String(overrides.state || "ready").trim().toLowerCase() || "ready";
  const phone = formatPhone(lead.primaryPhone || lead.phone || lead.normalizedPhone);
  const firstName = String(lead.firstName || "").trim();
  const lastName = String(lead.lastName || "").trim();
  const name = String(lead.name || `${firstName} ${lastName}` || "").trim() || null;
  const daysAgo = parseNumberOrNull(overrides.daysAgo);
  const simulatedCreatedAt = daysAgo != null
    ? new Date(now.getTime() - (daysAgo * 24 * 60 * 60 * 1000))
    : null;
  const activeDay = parseNumberOrNull(overrides.activeDay) ?? config.activeDay;
  const requestedCallsPlaced = parseNumberOrNull(overrides.callsPlaced) ?? 0;
  const progressiveStage = resolveProgressiveStage(overrides.progressiveStage, family, requestedCallsPlaced);
  const callsPlaced = family === "fresh-day1"
    ? Math.max(requestedCallsPlaced, progressiveStage.progressiveStageIndex)
    : requestedCallsPlaced;
  const lastPlacedAt = callsPlaced > 0
    ? new Date(now.getTime() - Math.min(callsPlaced, 1) * 15 * 60 * 1000)
    : null;
  const currentStage = String(
    overrides.currentStage || lead.currentStage || config.label,
  ).trim();

  return {
    leadCadenceId: lead._id ? String(lead._id) : null,
    phone,
    name,
    intakeSource: lead.intakeSource || null,
    intakeRoute: lead.intakeRoute || null,
    sourceName: lead.sourceName || lead.attributionContext?.source || null,
    state,
    queueFamily: family,
    queueFamilyRank: resolveQueueFamilyRank(family),
    queueTier: config.queueTier,
    progressiveStageKey: progressiveStage.progressiveStageKey,
    progressiveStageIndex: progressiveStage.progressiveStageIndex,
    progressiveStageLabel: progressiveStage.progressiveStageLabel,
    priorityScore: config.priorityScore,
    releaseAt: now,
    claimUntil: null,
    lastClaimedAt: null,
    completedAt: null,
    cancelledAt: null,
    placedCalls: callsPlaced,
    lastPlacedAt,
    callPlan: {
      phaseIndex: family === "fresh-day1" ? progressiveStage.progressiveStageIndex : 0,
      delaysMinutes: [5, 115, 120],
      activeDay,
      nextDelayMinutes: config.nextDelayMinutes,
    },
    assignment: {
      extensionId: null,
      agentName: null,
      assignedAt: null,
      queueFamilySnapshot: null,
    },
    metadata: {
      requestedBy: "cx-family-test",
      executionOwner: "ringcentral-cx",
      futureAdapterPort: 6101,
      actionKey: progressiveStage.actionKey,
      queueFamily: family,
      queueFamilyRank: resolveQueueFamilyRank(family),
      familyLabel: config.label,
      progressiveStageKey: progressiveStage.progressiveStageKey,
      progressiveStageIndex: progressiveStage.progressiveStageIndex,
      progressiveStageLabel: progressiveStage.progressiveStageLabel,
      sourceLeadStage: lead.currentStage || null,
      simulatedCurrentStage: currentStage,
      simulatedLeadCreatedAt: simulatedCreatedAt,
      simulatedDaysAgo: daysAgo,
      simulatedPlacedCalls: callsPlaced,
      simulatedActiveDay: activeDay,
      seededAt: now,
      testHarness: true,
    },
  };
}

async function reseedCaseFamily(domain, caseId, family, overrides = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = normalizeCaseId(caseId);
  const { source, lead } = await loadLead(normalizedDomain, normalizedCaseId);

  await releaseCxQueueItem({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
    reason: "cx-family-test-reset",
    releaseAt: new Date(),
  }).catch(() => null);

  const update = buildQueueSeed(lead, family, overrides);
  const queueItem = await cxDialQueueRepository.upsertQueueItem(
    normalizedDomain,
    normalizedCaseId,
    update,
  );

  return {
    source,
    lead,
    overrides: {
      state: update.state,
      activeDay: update.callPlan?.activeDay ?? null,
      callsPlaced: update.placedCalls ?? 0,
      progressiveStage: update.progressiveStageKey || null,
      daysAgo: update.metadata?.simulatedDaysAgo ?? null,
      currentStage: update.metadata?.simulatedCurrentStage || null,
    },
    queueItem: queueItem?.toObject ? queueItem.toObject() : queueItem,
  };
}

function summarizeQueueItem(queueItem) {
  if (!queueItem) return null;
  return {
    id: queueItem._id ? String(queueItem._id) : null,
    domain: queueItem.domain || null,
    caseId: Number(queueItem.caseId || 0) || null,
    state: queueItem.state || null,
    queueFamily: queueItem.queueFamily || null,
    queueFamilyRank: Number(queueItem.queueFamilyRank ?? 99),
    queueTier: queueItem.queueTier || null,
    progressiveStageKey: queueItem.progressiveStageKey || null,
    progressiveStageIndex: Number(queueItem.progressiveStageIndex ?? 99),
    progressiveStageLabel: queueItem.progressiveStageLabel || null,
    priorityScore: Number(queueItem.priorityScore || 0),
    releaseAt: queueItem.releaseAt || null,
    phone: queueItem.phone || null,
    assignedExtensionId: queueItem.assignment?.extensionId || null,
    assignedAgentName: queueItem.assignment?.agentName || null,
  };
}

function summarizePreview(preview) {
  return {
    queueItem: preview.queueItem,
    queueFamily: preview.queueFamily,
    selected: preview.selected,
    topRanked: Array.isArray(preview.rankedAgents)
      ? preview.rankedAgents.slice(0, 5)
      : [],
  };
}

async function inspectCase(domain, caseId) {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedCaseId = normalizeCaseId(caseId);
  const { source, lead } = await loadLead(normalizedDomain, normalizedCaseId);
  const queueItems = await cxDialQueueRepository.listQueueItems({
    domain: normalizedDomain,
    caseId: normalizedCaseId,
    limit: 10,
  });

  console.log(JSON.stringify({
    ok: true,
    domain: normalizedDomain,
    caseId: normalizedCaseId,
    source,
    lead: {
      id: lead._id ? String(lead._id) : null,
      active: lead.active,
      currentStage: lead.currentStage || null,
      firstName: lead.firstName || null,
      lastName: lead.lastName || null,
      phone: formatPhone(lead.primaryPhone || lead.phone || lead.normalizedPhone),
      intakeSource: lead.intakeSource || null,
      intakeRoute: lead.intakeRoute || null,
      sourceName: lead.sourceName || null,
    },
    queueItems: queueItems.map(summarizeQueueItem),
  }, null, 2));
}

async function previewFamily(domain, caseId, family, candidateExtensionIds = []) {
  const seeded = await reseedCaseFamily(domain, caseId, family, candidateExtensionIds.overrides || DEFAULT_OVERRIDES);
  const preview = await previewCxAssignment({
    queueItemId: String(seeded.queueItem._id),
    domain: normalizeDomain(domain),
    caseId: normalizeCaseId(caseId),
    candidateExtensionIds: candidateExtensionIds.values || [],
  });

  console.log(JSON.stringify({
    ok: true,
    family,
    source: seeded.source,
    overrides: seeded.overrides,
    seeded: summarizeQueueItem(seeded.queueItem),
    preview: summarizePreview(preview),
  }, null, 2));
}

async function cycleFamilies(domain, caseId, candidateExtensionIds = [], overrides = DEFAULT_OVERRIDES) {
  const families = ["fresh-day1", "fresh-day2to10", "aged"];
  const results = [];

  for (const family of families) {
    const seeded = await reseedCaseFamily(domain, caseId, family, overrides);
    const preview = await previewCxAssignment({
      queueItemId: String(seeded.queueItem._id),
      domain: normalizeDomain(domain),
      caseId: normalizeCaseId(caseId),
      candidateExtensionIds,
    });
    results.push({
      family,
      overrides: seeded.overrides,
      seeded: summarizeQueueItem(seeded.queueItem),
      selected: preview.selected || null,
      topRanked: Array.isArray(preview.rankedAgents)
        ? preview.rankedAgents.slice(0, 5)
        : [],
    });
  }

  console.log(JSON.stringify({
    ok: true,
    domain: normalizeDomain(domain),
    caseId: normalizeCaseId(caseId),
    candidateExtensionIds,
    results,
  }, null, 2));
}

function parseCandidateExtensionIds(rawValues) {
  return Array.from(
    new Set(
      rawValues
        .flatMap((value) => String(value || "").split(","))
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

function parseArgs(argv) {
  const positional = [];
  const flags = {
    state: null,
    callsPlaced: null,
    activeDay: null,
    daysAgo: null,
    currentStage: null,
    progressiveStage: null,
    candidateExtensionIds: [],
  };

  for (const raw of argv) {
    const value = String(raw || "").trim();
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const [flag, inlineValue] = value.includes("=")
      ? value.split(/=(.*)/s, 2)
      : [value, null];
    const nextValue = inlineValue != null ? inlineValue : null;

    if (flag === "--state") flags.state = nextValue;
    else if (flag === "--calls-placed") flags.callsPlaced = nextValue;
    else if (flag === "--active-day") flags.activeDay = nextValue;
    else if (flag === "--days-ago") flags.daysAgo = nextValue;
    else if (flag === "--stage") flags.currentStage = nextValue;
    else if (flag === "--progressive-stage") flags.progressiveStage = nextValue;
    else if (flag === "--extensions" && nextValue != null) {
      flags.candidateExtensionIds.push(...parseCandidateExtensionIds([nextValue]));
    }
  }

  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = String(positional[0] || "inspect").trim().toLowerCase();
  const domain = positional[1] || "WYNN";
  const caseId = positional[2];
  const familyArg = positional[3];
  const candidateExtensionIds = parseCandidateExtensionIds([
    ...positional.slice(4),
    ...flags.candidateExtensionIds,
  ]);
  const overrides = {
    state: flags.state || "ready",
    callsPlaced: flags.callsPlaced,
    activeDay: flags.activeDay,
    daysAgo: flags.daysAgo,
    currentStage: flags.currentStage,
    progressiveStage: flags.progressiveStage,
  };

  await connect();

  if (command === "inspect") {
    await inspectCase(domain, caseId);
  } else if (command === "seed") {
    const family = resolveFamily(familyArg);
    const seeded = await reseedCaseFamily(domain, caseId, family, overrides);
    console.log(JSON.stringify({
      ok: true,
      family,
      source: seeded.source,
      overrides: seeded.overrides,
      seeded: summarizeQueueItem(seeded.queueItem),
    }, null, 2));
  } else if (command === "preview") {
    const family = resolveFamily(familyArg);
    await previewFamily(domain, caseId, family, {
      values: candidateExtensionIds,
      overrides,
    });
  } else if (command === "cycle") {
    await cycleFamilies(domain, caseId, candidateExtensionIds, overrides);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
