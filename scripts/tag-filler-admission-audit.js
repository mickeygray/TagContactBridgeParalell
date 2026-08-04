"use strict";

/**
 * tag-filler-admission-audit — §3 dry run.
 *
 * The TAG filler pool fills monthly and nothing drinks from it:
 * `fillerPoolRefreshService` re-samples status=2 TAG cases into
 * MasterProspectIndex, but LeadDeliveryItem is effectively WYNN-only. Before
 * building the intake that would admit them, this answers the only question
 * that decides whether the intake is worth building: how many rows would
 * actually be dialable, and why are the rest not?
 *
 * READ ONLY. Every count is a separate named read; nothing is written.
 *
 * The governing rule, borrowed from callRecoveryAdmissionService: an
 * unavailable, missing or contradictory DNC read is a HOLD, never permission.
 * "Not proven listed" must never round down to "clear" — these are old records
 * and the cost of that rounding is dialling somebody who asked us to stop.
 *
 *   node scripts/tag-filler-admission-audit.js
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { MasterProspectIndex, LeadDeliveryItem } = require("../packages/shared-models/src");

// Mirrors fillerPoolRefreshService: TAG post-mail-era floor.
const TAG_CASE_ID_FLOOR = 50000;

const pad = (s, n) => String(s).padEnd(n);
const num = (n) => String(n).padStart(7);

async function main() {
  await connectMongo(getSharedConfig());

  const total = await MasterProspectIndex.countDocuments({ domain: "TAG" });
  console.log("MasterProspectIndex TAG rows: " + total);
  if (!total) { await disconnectMongo(); return; }

  const sample = await MasterProspectIndex.findOne({ domain: "TAG" }).lean();
  console.log("  fields present: " + Object.keys(sample || {}).filter((k) => k !== "_id").join(", "));

  // Each stage independently — a cumulative funnel hides which gate is binding.
  const stages = [
    ["has a phone", { normalizedPhones: { $exists: true, $ne: [] } }],
    ["caseId >= " + TAG_CASE_ID_FLOOR, { caseId: { $gte: TAG_CASE_ID_FLOOR } }],
    ["dnc checked at all", { "dnc.checkedAt": { $ne: null } }],
  ];
  console.log("\nGates (independent, not cumulative):");
  for (const [label, q] of stages) {
    console.log("  " + pad(label, 26) + num(await MasterProspectIndex.countDocuments({ domain: "TAG", ...q })));
  }

  // There is NO `dnc.result` field — not on TAG, not on WYNN. The verdict is
  // carried as discrete suppression flags, and `checkedAt` is what proves the
  // lookup happened at all. Reading a `result` string here returns undefined
  // for every row and silently reports the whole pool as undialable for the
  // wrong reason.
  const SUPPRESSION_FLAGS = ["onNationalDnc", "onStateDnc", "onDma", "isLitigator"];
  console.log("\nSuppression flags among CHECKED rows:");
  for (const f of SUPPRESSION_FLAGS) {
    const hit = await MasterProspectIndex.countDocuments({
      domain: "TAG", "dnc.checkedAt": { $ne: null }, ["dnc." + f]: true,
    });
    console.log("  " + pad(f + " = true", 26) + num(hit));
  }

  // Admissible = the lookup actually happened AND nothing suppresses. An
  // absent checkedAt is a HOLD, never permission.
  const admissible = {
    domain: "TAG",
    caseId: { $gte: TAG_CASE_ID_FLOOR },
    normalizedPhones: { $exists: true, $ne: [] },
    "dnc.checkedAt": { $ne: null },
    "dnc.onNationalDnc": { $ne: true },
    "dnc.onStateDnc": { $ne: true },
    "dnc.onDma": { $ne: true },
    "dnc.isLitigator": { $ne: true },
  };
  const admissibleCount = await MasterProspectIndex.countDocuments(admissible);

  // Never double-emit a case the cadence already owns (composite source rule 3).
  const alreadyOwned = await LeadDeliveryItem.distinct("caseId", { domain: "TAG" });
  const ownedSet = new Set(alreadyOwned.map((c) => Number(c)));
  const admissibleIds = await MasterProspectIndex.distinct("caseId", admissible);
  const net = admissibleIds.filter((c) => !ownedSet.has(Number(c))).length;

  console.log("\nADMISSIBLE (floor + phone + checked + clean) : " + admissibleCount);
  console.log("  already owned by LeadDeliveryItem TAG      : " + ownedSet.size);
  console.log("  NET new dialable rows                      : " + net);

  // The binding gate, named explicitly — otherwise a zero here reads as
  // "nobody is dialable" when it means "nobody has been LOOKED UP".
  const unchecked = await MasterProspectIndex.countDocuments({
    domain: "TAG", "dnc.checkedAt": null,
  });
  if (unchecked) {
    console.log("\n  BINDING GATE: " + unchecked + " rows have never been DNC-checked.");
    console.log("  Those are held, not rejected — the scrub has not run for them.");
  }

  const byPool = await MasterProspectIndex.aggregate([
    { $match: { domain: "TAG" } },
    { $group: { _id: "$pool.tag", n: { $sum: 1 }, newest: { $max: "$updatedAt" } } },
    { $sort: { n: -1 } }, { $limit: 6 },
  ]);
  console.log("\npool.tag (is the monthly sample current?):");
  for (const p of byPool) {
    console.log("  " + pad(p._id === null || p._id === undefined ? "(absent)" : p._id, 26)
      + num(p.n) + "  newest " + String(p.newest).slice(0, 24));
  }

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
