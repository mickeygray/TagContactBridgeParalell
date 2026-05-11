"use strict";

// Refresh `name` on CxDialQueue rows by re-reading from MasterProspectIndex.
// Used after the pool-name backfill — queue items served before names
// were populated still have `name: null` snapshots.

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const {
  CxDialQueue,
  MasterProspectIndex,
} = require("../packages/shared-models/src");

async function main() {
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(process.env.MONGO_URI, { dbName });

  // Target every active queue row that's missing a name. The pool
  // backfill just filled MPI; this propagates that into the queue.
  const queueRows = await CxDialQueue.find({
    state: { $in: ["queued", "ready", "claimed", "serving"] },
    $or: [{ name: null }, { name: "" }, { name: { $exists: false } }],
  })
    .select({ _id: 1, domain: 1, caseId: 1 })
    .lean();

  console.log(`[scan] ${queueRows.length} active queue rows missing name`);
  if (queueRows.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // Lookup names from MPI in one shot
  const keys = queueRows.map((r) => ({ domain: r.domain, caseId: r.caseId }));
  const mpiRows = await MasterProspectIndex.find({ $or: keys })
    .select({ domain: 1, caseId: 1, name: 1 })
    .lean();
  const nameByKey = new Map();
  for (const r of mpiRows) {
    if (r.name) nameByKey.set(`${r.domain}/${r.caseId}`, r.name);
  }
  console.log(`[lookup] resolved ${nameByKey.size} names from MPI`);

  const ops = [];
  for (const q of queueRows) {
    const name = nameByKey.get(`${q.domain}/${q.caseId}`);
    if (!name) continue;
    ops.push({
      updateOne: {
        filter: { _id: q._id },
        update: { $set: { name } },
      },
    });
  }

  if (ops.length === 0) {
    console.log(`[commit] nothing to write — MPI doesn't have names either.`);
    await mongoose.disconnect();
    return;
  }

  const result = await CxDialQueue.bulkWrite(ops, { ordered: false });
  console.log(`[commit] modified ${result.modifiedCount} queue rows`);

  await mongoose.disconnect();
  console.log(`[done]`);
}

main().catch((e) => {
  console.error("[refresh-cx-queue-names] FATAL:", e.stack || e.message);
  process.exit(1);
});
