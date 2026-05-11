"use strict";

const MONTHLY_SOURCE_OVERLAYS = {
  TAG: {
    "2026-04": {
      anchorDate: "2026-04-24",
      rows: [
        {
          source: "LD Posting",
          channel: "ld-posting",
          leadsReported: 1233,
          count: 1233,
          spend: 1233 * 3,
        },
        {
          source: "Lead Form Affiliate",
          channel: "affiliate",
          leadsReported: 318,
          count: 318,
          spend: 0,
        },
        {
          source: "VF Meta",
          channel: "paid-social",
          leadsReported: 67,
          count: 67,
          spend: 0,
        },
      ],
    },
  },
};

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toDateKey(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function buildMonthBounds(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(String(monthKey || ""))) {
    return null;
  }

  const from = `${monthKey}-01`;
  const cursor = new Date(`${from}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime())) {
    return null;
  }
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  cursor.setUTCDate(0);
  return {
    from,
    to: cursor.toISOString().slice(0, 10),
  };
}

function resolveFilterWindow(filters = {}) {
  const explicitDate = toDateKey(filters.date);
  if (explicitDate) {
    return {
      from: explicitDate,
      to: explicitDate,
    };
  }

  const from = toDateKey(filters.from);
  const to = toDateKey(filters.to);
  if (!from && !to) {
    return null;
  }

  return {
    from: from || to,
    to: to || from,
  };
}

function windowsIntersect(left, right) {
  if (!left || !right) return false;
  return String(left.from) <= String(right.to) && String(left.to) >= String(right.from);
}

function cloneOverlayRow(row = {}) {
  return {
    source: row.source || "Unknown",
    channel: row.channel || null,
    spend: Number(row.spend || 0),
    pieces: Number(row.pieces || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    leadsReported: Number(row.leadsReported || 0),
    count: Number(row.count || 0),
  };
}

function listManualMetricSourceRows(domain, filters = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const domainConfig = MONTHLY_SOURCE_OVERLAYS[normalizedDomain];
  if (!domainConfig) return [];

  const window = resolveFilterWindow(filters);
  const rows = [];

  for (const [monthKey, config] of Object.entries(domainConfig)) {
    const monthBounds = buildMonthBounds(monthKey);
    if (!monthBounds) continue;
    if (window && !windowsIntersect(window, monthBounds)) continue;
    rows.push(...(config.rows || []).map(cloneOverlayRow));
  }

  return rows;
}

function listManualDailySummaryRows(domain, date) {
  const normalizedDomain = normalizeDomain(domain);
  const domainConfig = MONTHLY_SOURCE_OVERLAYS[normalizedDomain];
  const dateKey = toDateKey(date);
  if (!domainConfig || !dateKey) return [];

  const rows = [];
  for (const config of Object.values(domainConfig)) {
    if (String(config.anchorDate) !== dateKey) continue;
    rows.push(...(config.rows || []).map(cloneOverlayRow));
  }
  return rows;
}

function getLatestManualDailySummaryDate(domain) {
  const normalizedDomain = normalizeDomain(domain);
  const domainConfig = MONTHLY_SOURCE_OVERLAYS[normalizedDomain];
  if (!domainConfig) return null;

  return Object.values(domainConfig)
    .map((config) => toDateKey(config.anchorDate))
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
}

function getManualLeadOverlayTotal(domain, date) {
  return listManualDailySummaryRows(domain, date).reduce(
    (sum, row) => sum + Number(row.leadsReported || row.count || 0),
    0,
  );
}

module.exports = {
  getManualLeadOverlayTotal,
  getLatestManualDailySummaryDate,
  listManualDailySummaryRows,
  listManualMetricSourceRows,
};
