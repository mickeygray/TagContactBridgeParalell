"use strict";

// ldSpendService — turn LD lead counts into REAL spend entries.
//
// LD leads have been counted (lead cadences carry routeCampaignKey
// ld-custom / ld-custom-2 / ld-general) and the nightly email has shown an
// "estimated cost" for months — but nothing ever wrote that cost into the
// spend ledger, so the metrics panel ran LD revenue against zero spend
// (funny money), patched by occasional manual nudges.
//
// Design rules (the system is close-but-not-perfect and has run quietly for
// ~6 weeks, so every write is deliberately conservative):
//   - COUNTS come from buildVendorDailySummary — the exact rows the nightly
//     email prints. One code path; the email and the ledger cannot drift.
//   - RATES live here (env-overridable) and are exported so the email's
//     estimators read the SAME numbers: general $1.50, custom $3, custom-2 $3.
//   - WRITES are idempotent: SpendEntry identity (date, domain, channel,
//     campaign=familyKey) — re-running a date corrects the row in place.
//   - MANUAL NUDGES WIN: if a date already has an LD-looking spend row that
//     we didn't write (an operator nudge), that family+date is SKIPPED and
//     reported as a collision — never double-counted.

const {
  upsertSpendEntry,
  listSpendEntries,
} = require("../../shared-repositories/src/spendEntryRepository");
const {
  buildVendorDailySummary,
  classifyVendorFamily,
} = require("./vendorDailySummaryService");

const LD_SPEND_CHANNEL = "lead-data";

const LD_FAMILIES = Object.freeze([
  { key: "ld-general", label: "LD GENERAL", rateEnv: "LD_GENERAL_COST_PER_LEAD", defaultRate: 1.5 },
  { key: "ld-custom", label: "LD CUSTOM", rateEnv: "LD_CUSTOM_COST_PER_LEAD", defaultRate: 3 },
  { key: "ld-custom-2", label: "LD CUSTOM 2", rateEnv: "LD_CUSTOM_2_COST_PER_LEAD", defaultRate: 3 },
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
    if (["ld-general", "ld-custom", "ld-custom-2", "ld-posting"].includes(family.key)
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
    await upsertSpendEntry(entry);
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

module.exports = {
  LD_SPEND_CHANNEL,
  getLdRates,
  computeLdSpendEntries,
  findLdCollisions,
  materializeLdSpendForDate,
};
