"use strict";

const { spendEntryRepository } = require("../../shared-repositories/src");
const {
  listManualMetricSourceRows,
} = require("./metricsManualOverlayService");
const {
  DEFAULT_AFFILIATE_COST_PER_LEAD,
  DEFAULT_LD_COST_PER_LEAD,
  previewLeadCadenceDerivedSpend,
  previewSheetSpendForDomain,
} = require("./hourlyFinancialPreviewService");

const TRACKED_BUCKETS = ["mail", "meta", "ld", "affiliate"];
const BUCKET_ORDER = [...TRACKED_BUCKETS, "other"];

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function todayIso(timezone = "America/Los_Angeles", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function monthStartIso(date) {
  const value = String(date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${todayIso().slice(0, 7)}-01`;
  }
  return `${value.slice(0, 7)}-01`;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function classifySpendBucket(channel, source) {
  const normalizedChannel = String(channel || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  const haystack = `${normalizedChannel} ${normalizedSource}`;

  if (
    normalizedChannel === "mailer" ||
    normalizedChannel === "mail" ||
    haystack.includes("direct mail")
  ) {
    return "mail";
  }

  if (
    normalizedChannel === "affiliate" ||
    haystack.includes("affiliate")
  ) {
    return "affiliate";
  }

  if (
    normalizedChannel === "meta" ||
    normalizedChannel === "paid-social" ||
    normalizedChannel === "paid-search" ||
    normalizedChannel === "facebook" ||
    normalizedChannel === "instagram" ||
    normalizedChannel === "tiktok" ||
    normalizedChannel === "social" ||
    haystack.includes("vf meta") ||
    haystack.includes("facebook") ||
    haystack.includes("instagram") ||
    haystack.includes("tiktok") ||
    haystack.includes("meta")
  ) {
    return "meta";
  }

  if (
    normalizedChannel === "ld" ||
    normalizedChannel === "ld-posting" ||
    normalizedChannel === "lead-distribution" ||
    normalizedChannel === "lead-data" ||
    haystack.includes("lead data") ||
    haystack.includes("lead post") ||
    haystack.includes("ld posting") ||
    haystack.includes("a+ leads")
  ) {
    return "ld";
  }

  return "other";
}

function createBucketSummary(bucket) {
  return {
    bucket,
    tracked: TRACKED_BUCKETS.includes(bucket),
    spend: 0,
    rows: 0,
    leadsReported: 0,
    pieces: 0,
    impressions: 0,
    clicks: 0,
  };
}

function buildSourceKey(row = {}) {
  return [
    row.bucket || "other",
    String(row.channel || "").trim().toLowerCase(),
    String(row.source || "Unknown").trim().toLowerCase(),
  ].join("::");
}

function normalizePersistedRow(row = {}) {
  return {
    bucket: classifySpendBucket(row?._id?.channel, row?._id?.source),
    channel: row?._id?.channel || null,
    source: row?._id?.source || "Unknown",
    spend: Number(row.spend || 0),
    rows: Number(row.rows || 0),
    leadsReported: Number(row.leadsReported || 0),
    pieces: Number(row.pieces || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
  };
}

function normalizeProposedOperation(operation = {}) {
  const entry = operation?.update?.$set || {};
  return {
    bucket: classifySpendBucket(entry.channel, entry.source),
    channel: entry.channel || null,
    source: entry.source || "Unknown",
    spend: Number(entry.spend || 0),
    rows: 1,
    leadsReported: Number(entry.leadsReported || 0),
    pieces: Number(entry.pieces || 0),
    impressions: Number(entry.impressions || 0),
    clicks: Number(entry.clicks || 0),
  };
}

function summarizeRows(rows = []) {
  const buckets = Object.fromEntries(
    BUCKET_ORDER.map((bucket) => [bucket, createBucketSummary(bucket)]),
  );
  const bySource = new Map();

  for (const row of rows) {
    const bucket = BUCKET_ORDER.includes(row.bucket) ? row.bucket : "other";
    const bucketSummary = buckets[bucket];
    bucketSummary.spend += Number(row.spend || 0);
    bucketSummary.rows += Number(row.rows || 0);
    bucketSummary.leadsReported += Number(row.leadsReported || 0);
    bucketSummary.pieces += Number(row.pieces || 0);
    bucketSummary.impressions += Number(row.impressions || 0);
    bucketSummary.clicks += Number(row.clicks || 0);

    const key = buildSourceKey({ ...row, bucket });
    if (!bySource.has(key)) {
      bySource.set(key, {
        bucket,
        channel: row.channel || null,
        source: row.source || "Unknown",
        spend: 0,
        rows: 0,
        leadsReported: 0,
        pieces: 0,
        impressions: 0,
        clicks: 0,
      });
    }
    const sourceSummary = bySource.get(key);
    sourceSummary.spend += Number(row.spend || 0);
    sourceSummary.rows += Number(row.rows || 0);
    sourceSummary.leadsReported += Number(row.leadsReported || 0);
    sourceSummary.pieces += Number(row.pieces || 0);
    sourceSummary.impressions += Number(row.impressions || 0);
    sourceSummary.clicks += Number(row.clicks || 0);
  }

  const sourceRows = [...bySource.values()]
    .map((row) => ({
      ...row,
      spend: roundMoney(row.spend),
    }))
    .sort((left, right) => right.spend - left.spend || String(left.source).localeCompare(String(right.source)));

  const totalSpend = roundMoney(
    Object.values(buckets).reduce((sum, bucket) => sum + Number(bucket.spend || 0), 0),
  );
  const trackedTotalSpend = roundMoney(
    TRACKED_BUCKETS.reduce((sum, bucket) => sum + Number(buckets[bucket]?.spend || 0), 0),
  );

  for (const bucket of Object.values(buckets)) {
    bucket.spend = roundMoney(bucket.spend);
  }

  return {
    totalSpend,
    trackedTotalSpend,
    untrackedTotalSpend: roundMoney(totalSpend - trackedTotalSpend),
    totalRows: sourceRows.reduce((sum, row) => sum + Number(row.rows || 0), 0),
    buckets,
    sources: sourceRows,
  };
}

function buildSourceDiffs(persistedSources = [], proposedSources = []) {
  const persistedByKey = new Map(persistedSources.map((row) => [buildSourceKey(row), row]));
  const proposedByKey = new Map(proposedSources.map((row) => [buildSourceKey(row), row]));
  const keys = new Set([...persistedByKey.keys(), ...proposedByKey.keys()]);

  return [...keys]
    .map((key) => {
      const persisted = persistedByKey.get(key) || {};
      const proposed = proposedByKey.get(key) || {};
      return {
        bucket: proposed.bucket || persisted.bucket || "other",
        channel: proposed.channel || persisted.channel || null,
        source: proposed.source || persisted.source || "Unknown",
        persistedSpend: roundMoney(persisted.spend || 0),
        proposedSpend: roundMoney(proposed.spend || 0),
        spendDelta: roundMoney((proposed.spend || 0) - (persisted.spend || 0)),
        persistedLeadsReported: Number(persisted.leadsReported || 0),
        proposedLeadsReported: Number(proposed.leadsReported || 0),
        leadsDelta: Number(proposed.leadsReported || 0) - Number(persisted.leadsReported || 0),
        persistedRows: Number(persisted.rows || 0),
        proposedRows: Number(proposed.rows || 0),
      };
    })
    .filter((row) =>
      row.persistedSpend !== 0 ||
      row.proposedSpend !== 0 ||
      row.persistedLeadsReported !== 0 ||
      row.proposedLeadsReported !== 0,
    )
    .sort((left, right) => Math.abs(right.spendDelta) - Math.abs(left.spendDelta) || right.proposedSpend - left.proposedSpend);
}

function buildBucketDiffs(persistedBuckets = {}, proposedBuckets = {}) {
  return Object.fromEntries(
    BUCKET_ORDER.map((bucket) => {
      const persisted = persistedBuckets[bucket] || createBucketSummary(bucket);
      const proposed = proposedBuckets[bucket] || createBucketSummary(bucket);
      return [
        bucket,
        {
          tracked: TRACKED_BUCKETS.includes(bucket),
          persistedSpend: roundMoney(persisted.spend || 0),
          proposedSpend: roundMoney(proposed.spend || 0),
          spendDelta: roundMoney((proposed.spend || 0) - (persisted.spend || 0)),
          persistedLeadsReported: Number(persisted.leadsReported || 0),
          proposedLeadsReported: Number(proposed.leadsReported || 0),
          leadsDelta: Number(proposed.leadsReported || 0) - Number(persisted.leadsReported || 0),
          persistedRows: Number(persisted.rows || 0),
          proposedRows: Number(proposed.rows || 0),
        },
      ];
    }),
  );
}

function buildWindowComparison({
  label,
  from,
  to,
  persistedRows = [],
  proposedOperations = [],
  sheetBreakdown = null,
} = {}) {
  const persisted = summarizeRows(persistedRows.map(normalizePersistedRow));
  const proposed = summarizeRows(proposedOperations.map(normalizeProposedOperation));

  return {
    label,
    from,
    to,
    persisted,
    proposed,
    delta: {
      trackedSpendDelta: roundMoney(proposed.trackedTotalSpend - persisted.trackedTotalSpend),
      untrackedPersistedSpend: roundMoney(persisted.untrackedTotalSpend),
      buckets: buildBucketDiffs(persisted.buckets, proposed.buckets),
      sources: buildSourceDiffs(persisted.sources, proposed.sources),
    },
    sheets: Array.isArray(sheetBreakdown?.sheets)
      ? sheetBreakdown.sheets.map((sheet) => ({
          id: sheet.id,
          label: sheet.label,
          channel: sheet.channel,
          parsedRowCount: Number(sheet.parsedRowCount || 0),
          selectedRowCount: Number(sheet.selectedRowCount || 0),
          error: sheet.error || null,
        }))
      : [],
  };
}

function buildManualDerivedFallbackOperations(domain, options = {}) {
  const from = String(options.from || options.date || "");
  const to = String(options.to || options.date || "");
  const previewTimestamp = options.previewTimestamp || new Date();
  const ldCostPerLead = Number(
    options.ldCostPerLead ||
    process.env.LD_COST_PER_LEAD ||
    DEFAULT_LD_COST_PER_LEAD,
  );
  const affiliateCostPerLead = Number(
    options.affiliateCostPerLead ||
    process.env.AFFILIATE_COST_PER_LEAD ||
    DEFAULT_AFFILIATE_COST_PER_LEAD,
  );

  return listManualMetricSourceRows(domain, { from, to })
    .map((row) => {
      const channel = String(row.channel || "").trim().toLowerCase();
      const source = row.source || "Unknown";
      const leadsReported = Number(row.leadsReported || row.count || 0);
      if (leadsReported <= 0) return null;

      if (channel === "ld-posting" || channel === "ld") {
        return {
          collection: "SpendEntry",
          filter: {
            date: to,
            domain,
            channel: "ld-posting",
            source,
            sheetId: "derived-ld-hourly",
          },
          update: {
            $set: {
              date: to,
              domain,
              channel: "ld-posting",
              source,
              sheetId: "derived-ld-hourly",
              spend: roundMoney(leadsReported * ldCostPerLead),
              cost: roundMoney(leadsReported * ldCostPerLead),
              leadsReported,
              leadsAccepted: leadsReported,
              costPerLead: ldCostPerLead,
              syncedAt: previewTimestamp,
              raw: {
                derivedFrom: "manual-metrics-overlay",
                from,
                to,
              },
            },
          },
        };
      }

      if (channel === "affiliate") {
        return {
          collection: "SpendEntry",
          filter: {
            date: to,
            domain,
            channel: "affiliate",
            source,
            sheetId: "derived-affiliate-hourly",
          },
          update: {
            $set: {
              date: to,
              domain,
              channel: "affiliate",
              source,
              sheetId: "derived-affiliate-hourly",
              spend: roundMoney(leadsReported * affiliateCostPerLead),
              cost: roundMoney(leadsReported * affiliateCostPerLead),
              leadsReported,
              leadsAccepted: leadsReported,
              costPerLead: affiliateCostPerLead,
              syncedAt: previewTimestamp,
              raw: {
                derivedFrom: "manual-metrics-overlay",
                from,
                to,
              },
            },
          },
        };
      }

      return null;
    })
    .filter(Boolean);
}

function mergeDerivedOperations(primary = [], fallback = []) {
  const seen = new Set(
    primary.map((operation) =>
      buildSourceKey({
        bucket: classifySpendBucket(
          operation?.update?.$set?.channel,
          operation?.update?.$set?.source,
        ),
        channel: operation?.update?.$set?.channel,
        source: operation?.update?.$set?.source,
      }),
    ),
  );

  const merged = [...primary];
  for (const operation of fallback) {
    const key = buildSourceKey({
      bucket: classifySpendBucket(
        operation?.update?.$set?.channel,
        operation?.update?.$set?.source,
      ),
      channel: operation?.update?.$set?.channel,
      source: operation?.update?.$set?.source,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(operation);
  }
  return merged;
}

async function buildSpendSyncRead(domain, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const timezone = options.timezone || "America/Los_Angeles";
  const date = String(options.date || todayIso(timezone));
  const monthStart = String(options.monthStart || monthStartIso(date));
  const previewTimestamp = options.previewTimestamp || new Date();

  const [dailyPersistedRows, monthlyPersistedRows, dailySheets, monthlySheets, dailyDerived, monthlyDerived] = await Promise.all([
    spendEntryRepository.summarizeSpendBySource(normalizedDomain, { date }),
    spendEntryRepository.summarizeSpendBySource(normalizedDomain, { from: monthStart, to: date }),
    previewSheetSpendForDomain(normalizedDomain, {
      date,
      previewTimestamp,
      config: options.spendConfig || {},
    }),
    previewSheetSpendForDomain(normalizedDomain, {
      from: monthStart,
      to: date,
      previewTimestamp,
      config: options.spendConfig || {},
    }),
    previewLeadCadenceDerivedSpend(normalizedDomain, {
      date,
      previewTimestamp,
      ldCostPerLead: options.ldCostPerLead,
      affiliateCostPerLead: options.affiliateCostPerLead,
    }),
    previewLeadCadenceDerivedSpend(normalizedDomain, {
      from: monthStart,
      to: date,
      previewTimestamp,
      ldCostPerLead: options.ldCostPerLead,
      affiliateCostPerLead: options.affiliateCostPerLead,
    }),
  ]);

  const dailyDerivedOperations = mergeDerivedOperations(
    dailyDerived.operations || [],
    buildManualDerivedFallbackOperations(normalizedDomain, {
      date,
      previewTimestamp,
      ldCostPerLead: options.ldCostPerLead,
      affiliateCostPerLead: options.affiliateCostPerLead,
    }),
  );

  const monthlyDerivedOperations = mergeDerivedOperations(
    monthlyDerived.operations || [],
    buildManualDerivedFallbackOperations(normalizedDomain, {
      from: monthStart,
      to: date,
      previewTimestamp,
      ldCostPerLead: options.ldCostPerLead,
      affiliateCostPerLead: options.affiliateCostPerLead,
    }),
  );

  return {
    domain: normalizedDomain,
    generatedAt: previewTimestamp.toISOString(),
    date,
    monthStart,
    config: {
      timezone,
      ldCostPerLead: Number(options.ldCostPerLead || process.env.LD_COST_PER_LEAD || DEFAULT_LD_COST_PER_LEAD),
      affiliateCostPerLead: Number(
        options.affiliateCostPerLead ||
        process.env.AFFILIATE_COST_PER_LEAD ||
        DEFAULT_AFFILIATE_COST_PER_LEAD
      ),
      trackedBuckets: TRACKED_BUCKETS,
    },
    daily: buildWindowComparison({
      label: "daily",
      from: date,
      to: date,
      persistedRows: dailyPersistedRows,
      proposedOperations: [
        ...(dailySheets.operations || []),
        ...dailyDerivedOperations,
      ],
      sheetBreakdown: dailySheets,
    }),
    monthToDate: buildWindowComparison({
      label: "month-to-date",
      from: monthStart,
      to: date,
      persistedRows: monthlyPersistedRows,
      proposedOperations: [
        ...(monthlySheets.operations || []),
        ...monthlyDerivedOperations,
      ],
      sheetBreakdown: monthlySheets,
    }),
  };
}

module.exports = {
  TRACKED_BUCKETS,
  buildSpendSyncRead,
};
