"use strict";

/**
 * tag-filler-dnc-probe — why does no TAG filler row carry a DNC verdict?
 *
 * The admission audit found 4,586 TAG rows, every one of them with a phone and
 * past the caseId floor, and NOT ONE with a `dnc.result`. Since admission holds
 * on an unproven DNC read (correctly — these are old records), the pool is
 * currently 100% undialable. This probe asks whether the scrub is failing, or
 * whether it writes a shape the audit is looking for in the wrong place.
 *
 * READ ONLY.
 *
 *   node scripts/tag-filler-dnc-probe.js
 */

require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) {
  require("dns").setServers(String(process.env.DNS_SERVERS).split(",").map((s) => s.trim()));
}

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { MasterProspectIndex } = require("../packages/shared-models/src");

async function main() {
  await connectMongo(getSharedConfig());

  // What does the dnc subdocument actually look like on rows that HAVE one?
  const checked = await MasterProspectIndex.find({
    domain: "TAG", "dnc.checkedAt": { $ne: null },
  }).select({ caseId: 1, dnc: 1, pool: 1, filler: 1 }).limit(5).lean();

  console.log("TAG rows with dnc.checkedAt set: " + checked.length + " (sample)");
  for (const r of checked) {
    console.log("  case " + r.caseId + "  dnc=" + JSON.stringify(r.dnc));
  }

  // And on a row that has none — is the key absent, or present-but-empty?
  const unchecked = await MasterProspectIndex.findOne({
    domain: "TAG", "dnc.checkedAt": null,
  }).select({ caseId: 1, dnc: 1, pool: 1, filler: 1 }).lean();
  console.log("\nA row WITHOUT a check:");
  console.log("  case " + unchecked?.caseId
    + "  dnc=" + JSON.stringify(unchecked?.dnc)
    + "  pool=" + JSON.stringify(unchecked?.pool)
    + "  filler=" + JSON.stringify(unchecked?.filler));

  // Does the WYNN side — the one that actually delivers — carry verdicts?
  // If WYNN rows have them and TAG rows do not, the scrub is domain-scoped.
  const wynnTotal = await MasterProspectIndex.countDocuments({ domain: "WYNN" });
  const wynnChecked = await MasterProspectIndex.countDocuments({
    domain: "WYNN", "dnc.checkedAt": { $ne: null },
  });
  console.log("\nWYNN comparison: " + wynnChecked + " checked of " + wynnTotal + " rows");

  const wynnVerdicts = await MasterProspectIndex.aggregate([
    { $match: { domain: "WYNN" } },
    { $group: { _id: "$dnc.result", n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 6 },
  ]);
  console.log("  WYNN dnc.result: " + wynnVerdicts
    .map((v) => (v._id == null ? "(absent)" : v._id) + "=" + v.n).join("  "));

  // Every distinct key ever seen under `dnc`, across both domains — this is
  // what tells us whether the writer uses a different field name entirely.
  const keys = await MasterProspectIndex.aggregate([
    { $match: { dnc: { $type: "object" } } },
    { $project: { k: { $objectToArray: "$dnc" }, domain: 1 } },
    { $unwind: "$k" },
    { $group: { _id: { d: "$domain", key: "$k.k" }, n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 14 },
  ]);
  console.log("\nkeys seen under `dnc`:");
  for (const k of keys) console.log("  " + String(k._id.d).padEnd(6) + String(k._id.key).padEnd(20) + k.n);

  await disconnectMongo();
}

main().catch((e) => { console.error("FAILED " + e.message); process.exitCode = 1; });
