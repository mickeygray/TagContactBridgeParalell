"use strict";

// Shared dedup primitives so the nightly close, the hourly refresh,
// and the metrics workspace reads all collapse Parallel + legacy
// records on the same key (`casePaymentId`) and roll them up the same
// way. Without this, two layers can disagree on "how many deals" or
// "how much money" because they sum the same payment from two sources.
//
// Public surface:
//   buildDealsByCase(domain, dateKey)
//   buildPaymentsByCase(domain, dateKey, options)
//   rollupDealsBySource(dealsByCase)
//   rollupPaymentTotals(paymentsByCase)
//
// All four are used inside `nightlyCloseService` and (newly) inside
// `buildDailySummaryWorkspace` so the Daily Pulse panel reads the
// same numbers as the financial close email.

const mongoose = require("mongoose");
const {
  CaseProfile,
  PaymentLedger,
} = require("../../shared-models/src");
const {
  caseProfileRepository,
} = require("../../shared-repositories/src");
const {
  legacyReadDb,
} = require("../../shared-repositories/src/legacyReadDb");

function normalizeDomain(domain) {
  return String(domain || "").trim().toUpperCase();
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function getLegacyDb() {
  return legacyReadDb(mongoose);
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function legacyMetricsDedupEnabled() {
  return boolFromEnv(process.env.METRICS_DEDUP_LEGACY_READS_ENABLED, false);
}

// ── Deals at the case level — one row per casePaymentId ────────────
//
// Initial-success payments only. Returns rows enriched with name +
// resolved source attribution + conflict flag. Same shape the
// financial email + CSV consume.
async function buildDealsByCase(domain, dateKey) {
  const normalizedDomain = normalizeDomain(domain);

  const parallelRows = await PaymentLedger.find({
    domain: normalizedDomain,
    paymentDateKey: dateKey,
    paymentType: "initial",
    transactionStatus: "SUCCESS",
  })
    .populate("sourceCanonicalId", "internalName channel")
    .lean();

  const legacyRows = legacyMetricsDedupEnabled()
    ? await getLegacyDb()
        .collection("dailypaymentsummaries")
        .find({
          domain: normalizedDomain,
          date: String(dateKey),
          type: "initial",
        })
        .toArray()
    : [];

  const byKey = new Map();
  for (const r of parallelRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    const canonical = r.sourceCanonicalId && typeof r.sourceCanonicalId === "object"
      ? r.sourceCanonicalId
      : null;
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      sourceName_parallel: canonical?.internalName || r?.raw?.sourceName || null,
      sourceChannel_parallel: canonical?.channel || r?.raw?.sourceChannel || null,
      sourceCanonicalId: canonical?._id ? String(canonical._id) : null,
      needsSourceReview: Boolean(r.needsSourceReview),
    });
  }
  for (const r of legacyRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    const existing = byKey.get(key) || {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
    };
    existing.sourceName_legacy = r.sourceName || null;
    existing.sourceChannel_legacy = r.sourceChannel || null;
    if (!existing.amount) existing.amount = toNumber(r.amount);
    byKey.set(key, existing);
  }

  // Enrich with case-profile data for name + profile-mirrored source.
  const caseIds = [...new Set(
    [...byKey.values()].map((r) => r.caseId).filter(Number.isFinite),
  )];

  const parallelProfiles = caseIds.length > 0
    ? await caseProfileRepository.listCaseProfilesByCaseIds(normalizedDomain, caseIds).catch(() => [])
    : [];
  const profileByCaseId = new Map(
    parallelProfiles.map((p) => [Number(p.caseId), p]),
  );

  const legacyProfiles = legacyMetricsDedupEnabled() && caseIds.length > 0
    ? await getLegacyDb()
        .collection("rb_caseprofiles")
        .find(
          { domain: normalizedDomain, caseId: { $in: caseIds } },
          { projection: { caseId: 1, name: 1, firstName: 1, lastName: 1, sourceName: 1, sourceChannel: 1 } },
        )
        .toArray()
    : [];
  const legacyProfileByCaseId = new Map(
    legacyProfiles.map((p) => [Number(p.caseId), p]),
  );

  const out = [];
  for (const row of byKey.values()) {
    const profile = profileByCaseId.get(row.caseId) || null;
    const legacyProfile = legacyProfileByCaseId.get(row.caseId) || null;
    const profileName =
      profile?.name ||
      [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() ||
      legacyProfile?.name ||
      [legacyProfile?.firstName, legacyProfile?.lastName].filter(Boolean).join(" ").trim() ||
      null;
    const profileSource = profile?.sourceName || legacyProfile?.sourceName || null;
    const profileChannel = profile?.sourceChannel || legacyProfile?.sourceChannel || null;

    let sourceName, sourceChannel, attributionPath;
    if (row.sourceCanonicalId && row.sourceName_parallel) {
      sourceName = row.sourceName_parallel;
      sourceChannel = row.sourceChannel_parallel;
      attributionPath = "parallel-canonical";
    } else if (profileSource) {
      sourceName = profileSource;
      sourceChannel = profileChannel;
      attributionPath = "case-profile";
    } else if (row.sourceName_legacy) {
      sourceName = row.sourceName_legacy;
      sourceChannel = row.sourceChannel_legacy;
      attributionPath = "legacy-summary";
    } else if (row.sourceName_parallel) {
      sourceName = row.sourceName_parallel;
      sourceChannel = row.sourceChannel_parallel;
      attributionPath = "parallel-raw";
    } else {
      sourceName = "Unknown";
      sourceChannel = null;
      attributionPath = "unknown";
    }

    const signals = [
      row.sourceName_parallel,
      row.sourceName_legacy,
      profileSource,
    ].filter(Boolean);
    const distinct = new Set(signals.map((s) => String(s).trim().toLowerCase()));
    const conflict = distinct.size > 1;

    out.push({
      domain: row.domain,
      caseId: row.caseId,
      casePaymentId: row.casePaymentId,
      amount: row.amount,
      name: profileName,
      sourceName,
      sourceChannel,
      attributionPath,
      conflict,
      sourceName_parallel: row.sourceName_parallel || null,
      sourceChannel_parallel: row.sourceChannel_parallel || null,
      sourceCanonicalId: row.sourceCanonicalId || null,
      sourceName_legacy: row.sourceName_legacy || null,
      sourceChannel_legacy: row.sourceChannel_legacy || null,
      sourceName_profile: profileSource || null,
      sourceChannel_profile: profileChannel || null,
      needsSourceReview: Boolean(row.needsSourceReview) || conflict || attributionPath === "unknown",
    });
  }

  out.sort((a, b) => b.amount - a.amount || a.caseId - b.caseId);
  return out;
}

// ── All-success payments at the case level ─────────────────────────
//
// Same dedup pattern as `buildDealsByCase` but for ALL successful
// payment types. Used by `Money collected today` / Daily Pulse so
// totals never double-count a payment that lives in both Parallel
// and legacy.
//
// Parallel wins on dupes — it's the canonical write target and the
// legacy mirror lags behind once cutover completes.
async function buildPaymentsByCase(domain, dateKey, options = {}) {
  const normalizedDomain = normalizeDomain(domain);
  const fromDateKey = options.fromDateKey || dateKey;
  const toDateKey = options.toDateKey || dateKey;

  const parallelQuery = options.fromDateKey
    ? {
        domain: normalizedDomain,
        paymentDateKey: { $gte: fromDateKey, $lte: toDateKey },
        transactionStatus: "SUCCESS",
      }
    : {
        domain: normalizedDomain,
        paymentDateKey: dateKey,
        transactionStatus: "SUCCESS",
      };
  const parallelRows = await PaymentLedger.find(parallelQuery).lean();

  const legacyQuery = options.fromDateKey
    ? { domain: normalizedDomain, date: { $gte: String(fromDateKey), $lte: String(toDateKey) } }
    : { domain: normalizedDomain, date: String(dateKey) };
  const legacyRows = legacyMetricsDedupEnabled()
    ? await getLegacyDb()
        .collection("dailypaymentsummaries")
        .find(legacyQuery)
        .toArray()
    : [];

  const byKey = new Map();
  for (const r of parallelRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      paymentType: String(r.paymentType || "unknown").toLowerCase(),
      paymentDate: r.paymentDate || null,
      paymentDateKey: r.paymentDateKey || null,
      _source: "parallel",
    });
  }
  for (const r of legacyRows) {
    const key = Number(r.casePaymentId);
    if (!Number.isFinite(key)) continue;
    if (byKey.has(key)) continue; // Parallel wins
    byKey.set(key, {
      domain: r.domain,
      caseId: Number(r.caseId),
      casePaymentId: key,
      amount: toNumber(r.amount),
      paymentType: String(r.type || "unknown").toLowerCase(),
      paymentDate: r.date || dateKey,
      paymentDateKey: r.date || dateKey,
      _source: "legacy",
    });
  }
  return [...byKey.values()];
}

// ── Roll-ups ────────────────────────────────────────────────────────
function rollupDealsBySource(dealsByCase) {
  const bySource = new Map();
  for (const r of dealsByCase) {
    const k = r.sourceName || "Unknown";
    if (!bySource.has(k)) {
      bySource.set(k, {
        source: k,
        channel: r.sourceChannel || null,
        deals: 0,
        initialPayments: 0,
        totalCollected: 0,
        caseIds: [],
      });
    }
    const target = bySource.get(k);
    target.deals += 1;
    target.initialPayments += toNumber(r.amount);
    target.totalCollected += toNumber(r.amount);
    target.caseIds.push(r.caseId);
  }
  return [...bySource.values()].sort(
    (a, b) => b.deals - a.deals || b.totalCollected - a.totalCollected,
  );
}

function rollupPaymentTotals(paymentsByCase) {
  const totals = {
    totalAmount: 0, totalCount: 0,
    initialAmount: 0, initialCount: 0,
    recurringAmount: 0, recurringCount: 0,
  };
  for (const r of paymentsByCase) {
    const amount = toNumber(r.amount);
    totals.totalAmount += amount;
    totals.totalCount += 1;
    if (r.paymentType === "initial") {
      totals.initialAmount += amount;
      totals.initialCount += 1;
    } else {
      totals.recurringAmount += amount;
      totals.recurringCount += 1;
    }
  }
  return totals;
}

module.exports = {
  buildDealsByCase,
  buildPaymentsByCase,
  rollupDealsBySource,
  rollupPaymentTotals,
};
