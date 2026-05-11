"use strict";

// One-shot prune of MasterProspectIndex rows that aren't currently
// dialable. The operating rule is: MPI contains only filler-pool
// members (rows tagged with the current month's filler-* tag or the
// matching filler-retry-* tag). Anything else is bloat.
//
// What gets deleted:
//   - Rows with no pool subdoc / pool.tag null / pool.tag missing
//     (orphans, dnc-rejected leftovers, v2-migration leftovers, etc.)
//   - Rows tagged with a prior-month filler-* tag (already-rotated pool)
//
// What gets kept:
//   - Rows tagged with the current month's `filler-YYYY-MM` (dialable)
//   - Rows tagged with the current month's `filler-retry-YYYY-MM`
//     (DNC-lookup-pending, will retry next sweep)
//
// Going forward, the monthly fillerPoolRefreshService runs the same
// prune on every refresh — this script just clears the current
// accumulated orphans before the next refresh fires.
//
// Usage:
//   node scripts/prune-mpi-non-dialable.js          # DRY (default)
//   node scripts/prune-mpi-non-dialable.js --commit # actually delete
//   node scripts/prune-mpi-non-dialable.js --tag filler-2026-05 --commit

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { MasterProspectIndex } = require("../packages/shared-models/src");
const {
  defaultMonthTag,
} = require("../packages/shared-services/src/fillerPoolRefreshService");

function readFlag(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = argv.indexOf(name);
  if (idx >= 0 && idx < argv.length - 1) return argv[idx + 1];
  return null;
}
function hasFlag(argv, name) {
  return argv.includes(name);
}

async function main() {
  const argv = process.argv.slice(2);
  const commit = hasFlag(argv, "--commit");
  const tag = readFlag(argv, "--tag") || defaultMonthTag(new Date());
  const retryTag = tag.replace(/^filler-/, "filler-retry-");

  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  console.log("══ MPI prune (non-dialable) ══");
  console.log(`  mode:        ${commit ? "COMMIT" : "DRY"}`);
  console.log(`  keep tag:    ${tag}`);
  console.log(`  keep retry:  ${retryTag}\n`);

  const totalBefore = await MasterProspectIndex.countDocuments({});
  const dialable = await MasterProspectIndex.countDocuments({
    "pool.tag": tag,
  });
  const retryQueued = await MasterProspectIndex.countDocuments({
    "pool.tag": retryTag,
  });
  const expectedDelete = totalBefore - dialable - retryQueued;

  console.log(`  total MPI:           ${totalBefore}`);
  console.log(`  dialable (${tag}): ${dialable}`);
  console.log(`  retry-queue (${retryTag}): ${retryQueued}`);
  console.log(`  expected delete:     ${expectedDelete}`);

  // Sample what would be pruned for the operator's eyeballs
  const sample = await MasterProspectIndex.find({
    $or: [
      { "pool.tag": { $in: [null, undefined] } },
      { "pool.tag": { $exists: false } },
      {
        "pool.tag": {
          $exists: true,
          $ne: null,
          $nin: [tag, retryTag],
        },
      },
    ],
  })
    .limit(5)
    .select({ domain: 1, caseId: 1, name: 1, "pool.tag": 1, "metadata.notes": 1 })
    .lean();
  console.log(`\n  sample (first 5 of expected ${expectedDelete}):`);
  for (const r of sample) {
    console.log(
      `    ${r.domain}/${String(r.caseId).padStart(7)} ${(r.name || "(no-name)").padEnd(30)} pool.tag=${r.pool?.tag || "null"}  notes=${(r.metadata?.notes || []).join(",")}`,
    );
  }

  if (!commit) {
    console.log(`\n  Re-run with --commit to delete.`);
    await mongoose.disconnect();
    return;
  }

  const result = await MasterProspectIndex.deleteMany({
    $or: [
      { "pool.tag": { $in: [null, undefined] } },
      { "pool.tag": { $exists: false } },
      {
        "pool.tag": {
          $exists: true,
          $ne: null,
          $nin: [tag, retryTag],
        },
      },
    ],
  });

  const totalAfter = await MasterProspectIndex.countDocuments({});
  console.log(`\n  deleted: ${result.deletedCount}`);
  console.log(`  total MPI after: ${totalAfter}`);
  console.log(`  ${totalAfter === dialable + retryQueued ? "✓ MPI is now exactly dialable + retry rows" : "⚠ count mismatch — investigate"}`);

  await mongoose.disconnect();
  console.log(`\n[done]`);
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
