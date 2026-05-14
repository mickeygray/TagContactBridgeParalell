"use strict";

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel",
  });
  const db = mongoose.connection.db;

  const ids = [
    "6a06312e5165a13f503028e6", // end-call after dnc
    "6a063114618f89984aedf807", // disposition-hangup "Ended CX call after dnc"
    "6a06310e618f89984aedf63b", // Logics update case completed
    "6a06310d618f89984aedf615", // Logics update case requested
    "6a06310d618f89984aedf61c", // ReviewQueue: logics-update-case
  ];

  console.log("=== WorkflowStage full payloads ===");
  for (const id of ids) {
    const doc =
      (await db.collection("controlplaneworkflowrecords").findOne({ _id: new mongoose.Types.ObjectId(id) })) ||
      (await db.collection("controlplanereviewqueueitems").findOne({ _id: new mongoose.Types.ObjectId(id) }));
    console.log("\n---", id, "---");
    console.log(JSON.stringify(doc, null, 2));
  }

  // Also: look at every ConsentRecord that touched 9164204794 OR caseId 106029, regardless of domain
  console.log("\n=== ConsentRecord — case 106029 OR phone 9164204794, ANY format ===");
  const consents = await db
    .collection("controlplaneconsentrecords")
    .find({
      $or: [
        { caseId: 106029 },
        { phone: { $regex: /9164204794/ } },
        { primaryPhone: { $regex: /9164204794/ } },
      ],
    })
    .toArray();
  for (const c of consents) console.log(JSON.stringify(c, null, 2));

  // Also: the CX cadence row sub 6a05ee6576e1424b9a56fe2a — what was the cadence step number?
  console.log("\n=== CX cadence step around the timeframe ===");
  const cadenceRows = await db
    .collection("controlplaneworkflowrecords")
    .find({ caseId: 106029, subtype: { $in: ["cadence-call", "cadence-queue", "dial-request"] } })
    .sort({ happenedAt: 1 })
    .toArray();
  for (const r of cadenceRows) {
    console.log({
      time: r.happenedAt,
      family: r.family,
      subtype: r.subtype,
      stage: r.stage,
      summary: r.summary,
      payload: r.payload,
    });
  }

  // CallLog rows referencing this phone or case
  console.log("\n=== CallLog rows for phone 9164204794 or case 106029 ===");
  const callLogs = await db
    .collection("controlplanecalllogs")
    .find({
      $or: [
        { caseId: 106029 },
        { "metadata.caseId": 106029 },
        { fromNumber: { $regex: /9164204794/ } },
        { toNumber: { $regex: /9164204794/ } },
        { phone: { $regex: /9164204794/ } },
      ],
    })
    .sort({ startedAt: 1 })
    .limit(20)
    .toArray();
  for (const r of callLogs) {
    console.log({
      _id: String(r._id),
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      direction: r.direction,
      durationSec: r.durationSec,
      from: r.fromNumber,
      to: r.toNumber,
      platform: r.platform,
      campaignId: r.campaignId,
      disposition: r.disposition,
      result: r.result,
      agent: r.agent,
      extensionId: r.extensionId,
      metadata: r.metadata,
    });
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
