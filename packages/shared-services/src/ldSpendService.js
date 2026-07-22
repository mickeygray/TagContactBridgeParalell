"use strict";

// ldSpendService — turn LD lead counts into REAL spend entries.
//
// LD leads have been counted (lead cadences carry routeCampaignKey
// ld-custom / ld-custom-2 / ld-custom-3 / ld-general) and the nightly email has shown an
// "estimated cost" for months — but nothing ever wrote that cost into the
// spend ledger, so the metrics panel ran LD revenue against zero spend
// (funny money), patched by occasional manual nudges.
//
// Design rules (the system is close-but-not-perfect and has run quietly for
// ~6 weeks, so every write is deliberately conservative):
//   - COUNTS come from buildVendorDailySummary — the exact rows the nightly
//     email prints. One code path; the email and the ledger cannot drift.
//   - RATES live here (env-overridable) and are exported so the email's
//     estimators read the SAME numbers: general $1.50, custom $3, custom-2 $3, custom-3 $3.
//   - WRITES are idempotent: SpendEntry identity (date, domain, channel,
//     campaign=familyKey) — re-running a date corrects the row in place.
//   - MANUAL NUDGES WIN: if a date already has an LD-looking spend row that
//     we didn't write (an operator nudge), that family+date is SKIPPED and
//     reported as a collision — never double-counted.

const {
  listSpendEntries,
  incrementSpendEntry,
} = require("../../shared-repositories/src/spendEntryRepository");
const leadCadenceRepository = require("../../shared-repositories/src/leadCadenceRepository");
const marketingMoneyService = require("./marketingMoneyService");
const {
  buildVendorDailySummary,
  classifyVendorFamily,
} = require("./vendorDailySummaryService");

const LD_SPEND_CHANNEL = "lead-data";

const LD_FAMILIES = Object.freeze([
  { key: "ld-general", label: "LD GENERAL", rateEnv: "LD_GENERAL_COST_PER_LEAD", defaultRate: 1.5 },
  { key: "ld-custom", label: "LD CUSTOM", rateEnv: "LD_CUSTOM_COST_PER_LEAD", defaultRate: 3 },
  { key: "ld-custom-2", label: "LD CUSTOM 2", rateEnv: "LD_CUSTOM_2_COST_PER_LEAD", defaultRate: 3 },
  { key: "ld-custom-3", label: "LD CUSTOM 3", rateEnv: "LD_CUSTOM_3_COST_PER_LEAD", defaultRate: 3 },
]);

function rateFor(family) {
  const parsed = Number(process.env[family.rateEnv]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : family.defaultRate;
}

// Exported so nightlyCloseService's email estimators price with the SAME
// rates as the ledger (they hardcoded general at $2 — overstated for the
// whole time the estimate has been running).
function getLdRates() {
  return Object.fromEntries(LD_FAMILIES.map((f) => [f.key, rateFor(f)]));
}

// Pure: vendor-summary family rows -> proposed spend entries. Zero-lead
// days still produce a $0 row so idempotent re-runs can correct DOWNWARD
// (a stale backfilled figure shrinks to truth instead of lingering).
function computeLdSpendEntries({ domain, dateKey, families = [] }) {
  const byKey = new Map(
    (Array.isArray(families) ? families : [])
      .map((row) => [String(row.family || "").toLowerCase(), row]),
  );
  return LD_FAMILIES.map((family) => {
    const leads = Math.max(0, Number(byKey.get(family.key)?.leads || 0));
    const rate = rateFor(family);
    const spend = Math.round(leads * rate * 100) / 100;
    return {
      date: String(dateKey),
      domain: String(domain || "").trim().toUpperCase(),
      channel: LD_SPEND_CHANNEL,
      source: family.label,
      campaign: family.key, // identity key: (date, domain, channel, campaign)
      spend,
      leadsReported: leads,
      costPerLead: rate,
      raw: {
        computedBy: "ld-spend-materializer",
        familyKey: family.key,
        leads,
        rate,
      },
    };
  });
}

// An LD-looking spend row for the same date that we did NOT write = a
// manual nudge (sheet row, operator correction). The nudge wins.
function findLdCollisions({ existingRows = [], dateKey }) {
  const collisions = [];
  for (const row of existingRows) {
    if (String(row.date) !== String(dateKey)) continue;
    if (row.raw?.computedBy === "ld-spend-materializer") continue;
    const family = classifyVendorFamily(row.source, row.channel, row.campaign);
    if (["ld-general", "ld-custom", "ld-custom-2", "ld-custom-3", "ld-posting"].includes(family.key)
      && Number(row.spend || 0) !== 0) {
      collisions.push({
        familyKey: family.key,
        source: row.source,
        channel: row.channel,
        spend: Number(row.spend || 0),
      });
    }
  }
  return collisions;
}

async function materializeLdSpendForDate({ domain, dateKey, dryRun = false, logger = null } = {}) {
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const date = String(dateKey || "").trim();
  if (!normalizedDomain || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error("materializeLdSpendForDate requires domain and dateKey (YYYY-MM-DD)"), { status: 400 });
  }

  // The same pipeline the nightly email prints — leads per LD family.
  const vendor = await buildVendorDailySummary(normalizedDomain, { date });
  const proposed = computeLdSpendEntries({
    domain: normalizedDomain,
    dateKey: date,
    families: vendor.families,
  });

  // Manual-nudge detection across this date's existing spend rows.
  const existingRows = await listSpendEntries(normalizedDomain, { date, limit: 500 });
  const collisions = findLdCollisions({ existingRows, dateKey: date });
  const collidedFamilies = new Set(collisions.map((c) => c.familyKey));

  const results = [];
  for (const entry of proposed) {
    const collided = collidedFamilies.has(entry.campaign);
    if (collided || dryRun) {
      results.push({
        family: entry.campaign,
        leads: entry.leadsReported,
        rate: entry.costPerLead,
        spend: entry.spend,
        written: false,
        skippedReason: collided ? "manual-nudge-collision" : "dry-run",
      });
      continue;
    }
    await marketingMoneyService.recordComputedSpend(entry);
    results.push({
      family: entry.campaign,
      leads: entry.leadsReported,
      rate: entry.costPerLead,
      spend: entry.spend,
      written: true,
    });
  }

  const summary = {
    domain: normalizedDomain,
    date,
    dryRun: Boolean(dryRun),
    rows: results,
    totalSpend: results.filter((r) => r.written).reduce((sum, r) => sum + r.spend, 0),
    collisions,
  };
  logger?.info?.("ld_spend.materialize", summary);
  return summary;
}

// PT calendar date (YYYY-MM-DD) — the same basis the nightly materializer attributes a lead's
// spend to, so the real-time tick and the nightly reconcile land on the same SpendEntry row.
function ldSpendDateKey(now = new Date()) {
  const when = now instanceof Date ? now : new Date(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(when);
}

// Pure: a lead's routeCampaignKey -> { family, label, rate } if it is an LD family, else null.
// custom / custom-2 / custom-3 = $3, general = $1.50 (env-overridable via getLdRates). Exported for tests.
function resolveLdLeadSpend(routeCampaignKey, rates = getLdRates()) {
  const key = String(routeCampaignKey || "").trim().toLowerCase();
  if (!key) return null;
  const family = LD_FAMILIES.find((f) => f.key === key);
  if (!family) return null;
  const rate = Number(rates?.[family.key]);
  if (!Number.isFinite(rate) || rate < 0) return null;
  return { family: family.key, label: family.label, rate };
}

// Real-time LD-spend tick: when an LD-family lead comes in, increment the day's LD SpendEntry by
// the lead's rate EXACTLY ONCE (CAS-guarded on the lead cadence via claimLdSpendTick). The nightly
// materializer stays the reconcile backstop (recompute leads x rate and SET). Best-effort — the
// caller must wrap this so it can never break lead intake. deps are injectable for unit tests.
async function recordRealtimeLdLeadSpend({
  domain,
  caseId,
  routeCampaignKey,
  now = new Date(),
  rates = getLdRates(),
  logger = null,
  deps = {},
} = {}) {
  const spend = resolveLdLeadSpend(routeCampaignKey, rates);
  if (!spend) return { skipped: true, reason: "not-ld-family" };
  const normalizedDomain = String(domain || "").trim().toUpperCase();
  const numericCaseId = Number(caseId);
  if (!normalizedDomain || !Number.isFinite(numericCaseId) || numericCaseId <= 0) {
    return { skipped: true, reason: "missing-identity" };
  }
  const realtimeEnabled = deps.legacyRealtimeEnabled ??
    (String(process.env.LEGACY_REALTIME_LD_SPEND_ENABLED || "false").toLowerCase() === "true");
  if (!realtimeEnabled) {
    return { skipped: true, reason: "single-owner-reconciliation", family: spend.family };
  }
  const dateKey = ldSpendDateKey(now);
  const claim = deps.claimLdSpendTick || leadCadenceRepository.claimLdSpendTick;
  const increment = deps.incrementSpendEntry || incrementSpendEntry;
  const release = deps.releaseLdSpendTick || leadCadenceRepository.releaseLdSpendTick;

  const won = await claim(normalizedDomain, numericCaseId, { family: spend.family, rate: spend.rate, dateKey, now });
  if (!won) return { skipped: true, reason: "already-counted", family: spend.family };

  try {
    await increment(
      { date: dateKey, domain: normalizedDomain, channel: LD_SPEND_CHANNEL, campaign: spend.family },
      { spend: spend.rate, leadsReported: 1 },
      {
        source: spend.label,
        costPerLead: spend.rate,
        raw: { computedBy: "ld-spend-materializer", familyKey: spend.family, realtime: true },
      },
    );
  } catch (error) {
    // The claim is stamped but the increment never landed. Release the claim so a re-ingest can
    // re-tick this lead intraday (the nightly materializer is still the final backstop), then
    // re-throw so the caller's best-effort guard logs the failure.
    try {
      await release(normalizedDomain, numericCaseId);
    } catch (releaseError) {
      logger?.warn?.("ld_spend.realtime_tick.release_failed", {
        domain: normalizedDomain,
        caseId: numericCaseId,
        error: releaseError?.message,
      });
    }
    throw error;
  }
  logger?.info?.("ld_spend.realtime_tick", {
    domain: normalizedDomain,
    caseId: numericCaseId,
    family: spend.family,
    rate: spend.rate,
    date: dateKey,
  });
  return { ticked: true, family: spend.family, rate: spend.rate, date: dateKey };
}

module.exports = {
  LD_SPEND_CHANNEL,
  getLdRates,
  computeLdSpendEntries,
  findLdCollisions,
  materializeLdSpendForDate,
  ldSpendDateKey,
  resolveLdLeadSpend,
  recordRealtimeLdLeadSpend,
};
