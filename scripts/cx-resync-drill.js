"use strict";

// S3 DRILL: manufacture the ghost/drift shape ON PURPOSE (2026-07-06 incident replay).
// Cancels ONE buffered queue row of a RUNNING bulk session OUT-OF-BAND — deliberately
// bypassing the session kill and the RingCX unload, exactly like the incident — so the
// resync spine has something real to cure:
//   RingCX still holds the lead copy -> dials it -> serving CAS refuses (stamp.missed)
//   -> Trigger A audits -> buffer prunes -> cx.alpha.watch.resync.pruned + RESYNC line.
// This is the ONLY sanctioned out-of-band cancel: it exists to ring the alarm it feeds.
//
// Usage:
//   node scripts/cx-resync-drill.js                 -> dry run against the latest running session
//   node scripts/cx-resync-drill.js --arm           -> actually cancel the row
//   node scripts/cx-resync-drill.js --session cxbl-... --queue-item <id> --arm
//
// Read the aftermath with: node scripts/cx-bulk-session-inspect.js  (RESYNC line)
// and the control-plane stdout (cx.alpha.watch.serving_stamp.missed -> resync.pruned).

const mongoose = require("mongoose");
const { getSharedConfig } = require("../packages/shared-config/src");
const { CxBulkLoadSession, CxDialQueue } = require("../packages/shared-models/src");

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key === "--arm") args.arm = true;
  else if (key === "--session") args.session = process.argv[++i];
  else if (key === "--queue-item") args.queueItem = process.argv[++i];
}

async function main() {
  const config = getSharedConfig();
  await mongoose.connect(config.mongoUri, { dbName: config.parallelDbName });
  try {
    const session = await CxBulkLoadSession.findOne(
      args.session ? { sessionId: args.session } : { status: "running" },
    ).sort({ updatedAt: -1 }).lean();
    if (!session) { console.log("No running bulk session — start one first."); return; }
    if (session.status !== "running") { console.log(`Session ${session.sessionId} is ${session.status} — drill needs a RUNNING session.`); return; }

    const buffer = Array.isArray(session.acceptedBuffer) ? session.acceptedBuffer : [];
    if (!buffer.length) { console.log("Session buffer is empty — nothing to drill against."); return; }

    const target = args.queueItem
      ? buffer.find((c) => String(c.queueItemId) === String(args.queueItem))
      : buffer[0]; // first = next to dial = fastest signal
    if (!target) { console.log(`Queue item ${args.queueItem} is not in the session buffer.`); return; }

    const row = await CxDialQueue.findById(target.queueItemId).lean();
    if (!row) { console.log(`Row ${target.queueItemId} not found.`); return; }
    const owned = String(row.metadata?.reservationSessionId || "") === String(session.sessionId);
    console.log(`SESSION ${session.sessionId} (buffer ${buffer.length})`);
    console.log(`TARGET  ${target.queueItemId} "${target.name}" row.state=${row.state} owned=${owned ? "yes" : "NO"}`);
    if (!owned || !["claimed", "serving"].includes(String(row.state))) {
      console.log("Refusing: drill only cancels a claimed/serving row owned by the running session.");
      return;
    }
    if (!args.arm) {
      console.log("\nDRY RUN. Re-run with --arm to cancel this row out-of-band.");
      console.log("Expected after --arm: RingCX still dials the lead; stdout shows");
      console.log("serving_stamp.missed then resync.pruned (why=row-cancelled); inspect");
      console.log("shows the RESYNC line and buffer down by one; NO outcome row is written.");
      return;
    }

    const result = await CxDialQueue.updateOne(
      {
        _id: row._id,
        state: { $in: ["claimed", "serving"] },
        "metadata.reservationSessionId": session.sessionId,
      },
      {
        $set: {
          state: "cancelled",
          cancelledAt: new Date(),
          "metadata.cancelledAt": new Date(),
          "metadata.cancelledBy": "cx-resync-drill",
          "metadata.cancelledReason": "drill-manufactured-drift",
        },
      },
    );
    console.log(result.modifiedCount === 1
      ? `ARMED: ${target.queueItemId} cancelled out-of-band. Watch stdout for serving_stamp.missed -> resync.pruned.`
      : "CAS refused (row moved since read) — re-run the drill.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
