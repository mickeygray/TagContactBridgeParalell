"use strict";

const { getCompanyKeys } = require("../../shared-config/src");
const { ReviewQueueItem } = require("../../shared-models/src");
const {
  caseProfileRepository,
  masterProspectRepository,
} = require("../../shared-repositories/src");
const { listActiveSourceCanonicals } = require("./sourceCanonicalService");

const GLOBAL_METRICS_DOMAIN = "ALL";
const REVIEW_WORKFLOW = "attribution-review";
const REVIEW_CATEGORY = "metrics-source";
const REVIEW_SOURCE_SERVICE = "metrics";
const STATUS_OPEN = "open";
const STATUS_RESOLVED = "reviewed";
const STATUS_IGNORED = "dismissed";

const NUMERIC_OBSERVED_FIELDS = Object.freeze([
  "spend",
  "pieces",
  "impressions",
  "clicks",
  "reportedLeads",
  "leads",
  "calls",
  "callsOver5",
  "callsOver2",
  "uniqueCallers",
  "scoredCalls",
  "totalCollected",
  "initialPayments",
  "initialPaymentCount",
  "dncToday",
  "postdateToday",
]);

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function isGlobalMetricsDomain(domain) {
  const normalized = normalizeDomain(domain);
  return !normalized || normalized === GLOBAL_METRICS_DOMAIN;
}

function listMetricsDomains() {
  return [...new Set(getCompanyKeys().map((value) => normalizeDomain(value)).filter(Boolean))];
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findCanonicalResolution(canonicals = [], source, channel = null) {
  const wantedSource = normalizeText(source);
  const wantedChannel = normalizeText(channel);
  const matches = canonicals.filter((row) => {
    const names = [row.internalName, row.canonicalKey, ...(row.aliases || [])]
      .map(normalizeText)
      .filter(Boolean);
    return names.includes(wantedSource);
  });
  if (wantedChannel) {
    const channelMatch = matches.find((row) => normalizeText(row.channel) === wantedChannel);
    if (channelMatch) return channelMatch;
  }
  return matches.length === 1 ? matches[0] : null;
}

function toNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function clampLimit(value, fallback = 100) {
  return Math.min(Math.max(Number(value) || fallback, 1), 500);
}

function sanitizeObservedMetrics(metrics = {}) {
  const observed = {};
  for (const field of NUMERIC_OBSERVED_FIELDS) {
    const numeric = toNumber(metrics[field]);
    if (numeric !== 0) {
      observed[field] = numeric;
    }
  }
  return observed;
}

function mergeObservedMetrics(left = {}, right = {}) {
  const merged = {};
  for (const field of NUMERIC_OBSERVED_FIELDS) {
    const numeric = toNumber(left[field]) + toNumber(right[field]);
    if (numeric !== 0) {
      merged[field] = numeric;
    }
  }
  return merged;
}

function summarizeObservedMetrics(metrics = {}) {
  const parts = [];
  if (toNumber(metrics.spend) > 0) parts.push(`spend $${toNumber(metrics.spend).toFixed(2)}`);
  if (toNumber(metrics.totalCollected) > 0) parts.push(`collected $${toNumber(metrics.totalCollected).toFixed(2)}`);
  if (toNumber(metrics.initialPayments) > 0) {
    parts.push(
      `${toNumber(metrics.initialPaymentCount)} initial / $${toNumber(metrics.initialPayments).toFixed(2)}`,
    );
  }
  if (toNumber(metrics.leads) > 0) parts.push(`${toNumber(metrics.leads)} lead${toNumber(metrics.leads) === 1 ? "" : "s"}`);
  if (toNumber(metrics.reportedLeads) > 0) {
    parts.push(`${toNumber(metrics.reportedLeads)} reported lead${toNumber(metrics.reportedLeads) === 1 ? "" : "s"}`);
  }
  if (toNumber(metrics.calls) > 0) {
    parts.push(`${toNumber(metrics.calls)} call${toNumber(metrics.calls) === 1 ? "" : "s"}`);
  }
  if (toNumber(metrics.callsOver5) > 0) parts.push(`${toNumber(metrics.callsOver5)} over 5m`);
  if (toNumber(metrics.dncToday) > 0) parts.push(`${toNumber(metrics.dncToday)} DNC`);
  if (toNumber(metrics.postdateToday) > 0) parts.push(`${toNumber(metrics.postdateToday)} postdate`);
  return parts.join(" · ");
}

function buildMetricsAttributionReviewKey(candidate = {}) {
  const kind = normalizeText(candidate.kind || "unknown") || "unknown";
  const source = normalizeText(candidate.rawSource || candidate.source || "") || "unknown";
  const channel = normalizeText(candidate.rawChannel || candidate.channel || "") || "none";
  const caseId = Number(candidate.caseId);
  const casePaymentId = Number(candidate.casePaymentId);
  const sampleKey = normalizeText(
    candidate.sampleKey ||
      candidate.sample?.telephonySessionId ||
      candidate.sample?.jobNumber ||
      candidate.sample?.paymentReference ||
      candidate.sample?.piece ||
      "",
  );

  const parts = [kind, source, channel];
  if (Number.isFinite(caseId)) parts.push(`case:${caseId}`);
  if (Number.isFinite(casePaymentId)) parts.push(`payment:${casePaymentId}`);
  if (sampleKey) parts.push(sampleKey);
  return parts.join("|");
}

function isUncertainMetricsCandidate(candidate = {}) {
  if (candidate.forceReview) return true;
  const source = normalizeText(candidate.rawSource || candidate.source || "");
  if (!source || source === "unknown") return true;
  return normalizeText(candidate.familyKey || candidate.family || "") === "other";
}

function buildCandidateTitle(candidate = {}) {
  const kind = String(candidate.kind || "item").trim();
  const source = String(candidate.rawSource || candidate.source || "Unknown").trim() || "Unknown";
  if (Number.isFinite(Number(candidate.caseId))) {
    return `${kind} attribution review · Case ${Number(candidate.caseId)}`;
  }
  return `${kind} attribution review · ${source}`;
}

function buildCandidateSummary(candidate = {}) {
  const source = String(candidate.rawSource || candidate.source || "Unknown").trim() || "Unknown";
  const channel = String(candidate.rawChannel || candidate.channel || "").trim();
  const observed = summarizeObservedMetrics(candidate.observed || candidate.metrics || {});
  const notes = [`Raw source: ${source}`];
  if (channel) notes.push(`channel ${channel}`);
  if (candidate.dateKey) notes.push(`date ${candidate.dateKey}`);
  if (observed) notes.push(observed);
  notes.push("Ignored in nightly vendor summary until resolved.");
  return notes.join(" · ");
}

function mapReviewItem(doc = {}) {
  const payload = doc.payload || {};
  return {
    id: String(doc._id),
    domain: doc.domain || null,
    status: doc.status || STATUS_OPEN,
    workflow: doc.workflow || REVIEW_WORKFLOW,
    category: doc.category || REVIEW_CATEGORY,
    severity: doc.severity || "warning",
    title: doc.title || null,
    summary: doc.summary || null,
    happenedAt: doc.happenedAt || null,
    resolvedAt: doc.resolvedAt || null,
    resolutionNote: doc.resolutionNote || null,
    updatedAt: doc.updatedAt || null,
    raw: {
      source: payload.raw?.source || doc.sourceName || null,
      channel: payload.raw?.channel || doc.sourceChannel || null,
      caseId: payload.raw?.caseId ?? doc.caseId ?? null,
      casePaymentId: payload.raw?.casePaymentId ?? null,
      sample: payload.raw?.sample || null,
    },
    observed: payload.observed || {},
    resolution: payload.resolution || null,
    reviewKey: payload.reviewKey || null,
    kind: payload.kind || null,
    dateKey: payload.dateKey || null,
  };
}

function buildReviewQuery(domain, filters = {}) {
  const query = {
    workflow: REVIEW_WORKFLOW,
    category: REVIEW_CATEGORY,
  };

  if (!isGlobalMetricsDomain(domain)) {
    query.domain = normalizeDomain(domain);
  }
  if (filters.status && filters.status !== "all") {
    query.status = filters.status;
  }
  if (filters.date) {
    query["payload.dateKey"] = String(filters.date);
  }
  if (Array.isArray(filters.reviewKeys) && filters.reviewKeys.length > 0) {
    query["payload.reviewKey"] = { $in: filters.reviewKeys };
  }
  return query;
}

async function listMetricsAttributionReviewItems(domain, filters = {}) {
  const limit = clampLimit(filters.limit, 100);
  const query = buildReviewQuery(domain, filters);
  const [items, openCount, resolvedCount, ignoredCount] = await Promise.all([
    ReviewQueueItem.find(query)
      .sort({ status: 1, happenedAt: -1, updatedAt: -1 })
      .limit(limit)
      .lean(),
    ReviewQueueItem.countDocuments(buildReviewQuery(domain, { ...filters, status: STATUS_OPEN })),
    ReviewQueueItem.countDocuments(buildReviewQuery(domain, { ...filters, status: STATUS_RESOLVED })),
    ReviewQueueItem.countDocuments(buildReviewQuery(domain, { ...filters, status: STATUS_IGNORED })),
  ]);

  return {
    domain: isGlobalMetricsDomain(domain) ? GLOBAL_METRICS_DOMAIN : normalizeDomain(domain),
    counts: {
      open: openCount,
      reviewed: resolvedCount,
      dismissed: ignoredCount,
    },
    items: items.map(mapReviewItem),
  };
}

function accumulatePendingCandidate(target, candidate, existingDoc = null) {
  const reviewKey = buildMetricsAttributionReviewKey(candidate);
  if (!reviewKey) return;
  if (!target.has(reviewKey)) {
    target.set(reviewKey, {
      reviewKey,
      candidate: {
        ...candidate,
        observed: sanitizeObservedMetrics(candidate.observed || candidate.metrics || {}),
      },
      existingDoc,
    });
    return;
  }

  const current = target.get(reviewKey);
  current.candidate.observed = mergeObservedMetrics(
    current.candidate.observed,
    sanitizeObservedMetrics(candidate.observed || candidate.metrics || {}),
  );
  current.candidate.sample = current.candidate.sample || candidate.sample || null;
  current.candidate.summary = buildCandidateSummary(current.candidate);
}

async function persistMetricsAttributionReviewItems(domain, pending = new Map()) {
  const normalizedDomain = normalizeDomain(domain);
  const operations = [];

  for (const entry of pending.values()) {
    const candidate = entry.candidate || {};
    const existingDoc = entry.existingDoc || null;
    const reviewKey = entry.reviewKey;
    const observed = sanitizeObservedMetrics(candidate.observed || {});
    const payload = {
      reviewKey,
      kind: candidate.kind || "unknown",
      dateKey: candidate.dateKey || null,
      raw: {
        source: candidate.rawSource || candidate.source || "Unknown",
        channel: candidate.rawChannel || candidate.channel || null,
        caseId: Number.isFinite(Number(candidate.caseId)) ? Number(candidate.caseId) : null,
        casePaymentId: Number.isFinite(Number(candidate.casePaymentId))
          ? Number(candidate.casePaymentId)
          : null,
        sample: candidate.sample || null,
      },
      observed,
      resolution: existingDoc?.payload?.resolution || null,
      lastSeenAt: new Date().toISOString(),
    };

    const update = {
      $set: {
        title: buildCandidateTitle(candidate),
        summary: buildCandidateSummary({ ...candidate, observed }),
        customerName:
          candidate.sample?.customerName ||
          candidate.sample?.caseName ||
          existingDoc?.customerName ||
          null,
        primaryPhone:
          candidate.sample?.phone ||
          candidate.sample?.primaryPhone ||
          existingDoc?.primaryPhone ||
          null,
        sourceName: payload.raw.source,
        sourceChannel: payload.raw.channel,
        happenedAt: candidate.dateKey ? new Date(`${candidate.dateKey}T12:00:00.000Z`) : new Date(),
        caseId: payload.raw.caseId,
        payload,
        tags: ["metrics", "attribution", String(candidate.kind || "unknown")],
      },
      $setOnInsert: {
        domain: normalizedDomain,
        sourceService: REVIEW_SOURCE_SERVICE,
        workflow: REVIEW_WORKFLOW,
        category: REVIEW_CATEGORY,
        severity: "warning",
        status: STATUS_OPEN,
      },
    };

    if (existingDoc?._id) {
      operations.push({
        updateOne: {
          filter: { _id: existingDoc._id },
          update,
          upsert: false,
        },
      });
    } else {
      operations.push({
        updateOne: {
          filter: {
            domain: normalizedDomain,
            workflow: REVIEW_WORKFLOW,
            category: REVIEW_CATEGORY,
            "payload.reviewKey": reviewKey,
          },
          update,
          upsert: true,
        },
      });
    }
  }

  if (operations.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  return ReviewQueueItem.bulkWrite(operations, { ordered: false });
}

async function reconcileMetricsAttributionCandidates(domain, candidates = []) {
  const normalizedDomain = normalizeDomain(domain);
  const keyedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      ...candidate,
      reviewKey: buildMetricsAttributionReviewKey(candidate),
    }))
    .filter((candidate) => candidate.reviewKey);

  if (keyedCandidates.length === 0) {
    return {
      accepted: [],
      review: {
        skipped: 0,
        queued: 0,
        resolved: 0,
        ignored: 0,
      },
    };
  }

  const existing = await ReviewQueueItem.find(
    buildReviewQuery(normalizedDomain, {
      reviewKeys: [...new Set(keyedCandidates.map((candidate) => candidate.reviewKey))],
      status: "all",
    }),
  ).lean();
  const existingByKey = new Map(
    existing.map((doc) => [String(doc.payload?.reviewKey || ""), doc]),
  );

  const pending = new Map();
  const accepted = [];
  let skipped = 0;
  let resolved = 0;
  let ignored = 0;

  for (const candidate of keyedCandidates) {
    const existingDoc = existingByKey.get(candidate.reviewKey) || null;
    const resolution = existingDoc?.payload?.resolution || null;
    if (
      existingDoc?.status === STATUS_RESOLVED &&
      resolution?.source
    ) {
      accepted.push({
        ...candidate,
        source: resolution.source,
        channel: resolution.channel || candidate.rawChannel || candidate.channel || null,
      });
      resolved += 1;
      continue;
    }

    const needsReview = isUncertainMetricsCandidate(candidate);
    if (!needsReview) {
      accepted.push(candidate);
      continue;
    }

    skipped += 1;
    if (existingDoc?.status === STATUS_IGNORED) {
      ignored += 1;
    }
    accumulatePendingCandidate(pending, candidate, existingDoc);
  }

  await persistMetricsAttributionReviewItems(normalizedDomain, pending);

  return {
    accepted,
    review: {
      skipped,
      queued: pending.size,
      resolved,
      ignored,
    },
  };
}

async function resolveMetricsAttributionReviewItem(id, input = {}, actor = {}) {
  const doc = await ReviewQueueItem.findById(id);
  if (!doc) {
    const error = new Error("Metrics attribution review item not found");
    error.status = 404;
    throw error;
  }

  const resolvedSource = String(input.resolvedSource || "").trim();
  if (!resolvedSource) {
    const error = new Error("Resolved source is required");
    error.status = 400;
    throw error;
  }

  const resolvedChannel = String(input.resolvedChannel || "").trim() || null;
  const note = String(input.note || "").trim() || null;
  const caseId = Number(doc.payload?.raw?.caseId ?? doc.caseId);
  let canonical = null;
  if (Number.isFinite(caseId)) {
    canonical = findCanonicalResolution(
      await listActiveSourceCanonicals(doc.domain),
      resolvedSource,
      resolvedChannel,
    );
    if (!canonical?._id) {
      const error = new Error("Resolved case source must match one active canonical source");
      error.status = 400;
      throw error;
    }
  }
  const payload = {
    ...(doc.payload || {}),
    resolution: {
      source: resolvedSource,
      channel: resolvedChannel,
      note,
      resolvedByEmail: actor.email || null,
      resolvedAt: new Date().toISOString(),
    },
  };

  let propagation = null;
  if (canonical?._id && Number.isFinite(caseId)) {
    const [caseProfile, masterProspect] = await Promise.all([
      caseProfileRepository.writeSourceAttribution(doc.domain, caseId, {
        sourceCanonicalId: canonical._id,
        matchedBy: "metrics-review",
        confidence: "manual",
        lockedManual: true,
        allowOverwriteLocked: true,
        forceMirrorSourceName: true,
      }),
      masterProspectRepository.upsertMasterProspect(doc.domain, caseId, {
        sourceCanonicalId: canonical._id,
        needsSourceRefresh: false,
      }),
    ]);
    propagation = {
      sourceCanonicalId: String(canonical._id),
      caseProfile,
      masterProspectUpdated: Boolean(masterProspect),
    };
  }

  const updated = await ReviewQueueItem.findByIdAndUpdate(
    id,
    {
      $set: {
        status: STATUS_RESOLVED,
        resolvedAt: new Date(),
        resolutionNote: note,
        payload,
      },
    },
    { new: true },
  ).lean();

  return { ...mapReviewItem(updated), propagation };
}

async function ignoreMetricsAttributionReviewItem(id, input = {}, actor = {}) {
  const doc = await ReviewQueueItem.findById(id);
  if (!doc) {
    const error = new Error("Metrics attribution review item not found");
    error.status = 404;
    throw error;
  }

  const note = String(input.note || "").trim() || null;
  const payload = {
    ...(doc.payload || {}),
    resolution: {
      ...(doc.payload?.resolution || {}),
      ignoredByEmail: actor.email || null,
      ignoredAt: new Date().toISOString(),
      note,
    },
  };

  const updated = await ReviewQueueItem.findByIdAndUpdate(
    id,
    {
      $set: {
        status: STATUS_IGNORED,
        resolvedAt: new Date(),
        resolutionNote: note,
        payload,
      },
    },
    { new: true },
  ).lean();

  return mapReviewItem(updated);
}

async function reopenMetricsAttributionReviewItem(id) {
  const doc = await ReviewQueueItem.findById(id);
  if (!doc) {
    const error = new Error("Metrics attribution review item not found");
    error.status = 404;
    throw error;
  }

  const payload = {
    ...(doc.payload || {}),
    resolution: null,
  };

  const updated = await ReviewQueueItem.findByIdAndUpdate(
    id,
    {
      $set: {
        status: STATUS_OPEN,
        resolvedAt: null,
        resolutionNote: null,
        payload,
      },
    },
    { new: true },
  ).lean();

  return mapReviewItem(updated);
}

module.exports = {
  GLOBAL_METRICS_DOMAIN,
  REVIEW_CATEGORY,
  REVIEW_WORKFLOW,
  STATUS_IGNORED,
  STATUS_OPEN,
  STATUS_RESOLVED,
  buildMetricsAttributionReviewKey,
  findCanonicalResolution,
  isGlobalMetricsDomain,
  listMetricsAttributionReviewItems,
  listMetricsDomains,
  reconcileMetricsAttributionCandidates,
  resolveMetricsAttributionReviewItem,
  ignoreMetricsAttributionReviewItem,
  reopenMetricsAttributionReviewItem,
};
