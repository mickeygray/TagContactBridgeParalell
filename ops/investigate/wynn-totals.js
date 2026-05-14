"use strict";

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const cols = [
    "controlplanemasterprospectindexes",
    "controlplanecaseprofiles",
    "controlplaneconsentrecords",
    "controlplaneconversationworkflows",
    "controlplaneconversationmessages",
    "controlplanereviewqueueitems",
    "controlplaneworkflowrecords",
    "controlplaneinboundsourcerecords",
  ];

  for (const name of cols) {
    const col = db.collection(name);
    const total = await col.countDocuments().catch(() => null);
    if (total == null) {
      console.log(`${name}: <missing>`);
      continue;
    }
    const wynn = await col.countDocuments({ domain: "WYNN" }).catch(() => null);
    const tag = await col.countDocuments({ domain: "TAG" }).catch(() => null);
    // most-recent doc createdAt per domain
    const wynnLatest = await col.find({ domain: "WYNN" }).sort({ createdAt: -1 }).limit(1).project({ createdAt: 1, caseId: 1 }).toArray();
    const tagLatest = await col.find({ domain: "TAG" }).sort({ createdAt: -1 }).limit(1).project({ createdAt: 1, caseId: 1 }).toArray();
    console.log(
      `${name}: total=${total} WYNN=${wynn} (latest=${wynnLatest[0]?.createdAt || "n/a"}) TAG=${tag} (latest=${tagLatest[0]?.createdAt || "n/a"})`,
    );
  }

  // Try to find caseId 106029 (Ronald Colbert) in ANY collection, ANY field
  console.log("\n=== Scan every control-plane collection for caseId 106029 ===");
  const meta = await db.listCollections().toArray();
  for (const m of meta) {
    if (!m.name.startsWith("control")) continue;
    const col = db.collection(m.name);
    const hits = await col.find({ caseId: 106029 }).limit(2).toArray();
    if (hits.length > 0) {
      console.log(`  ✅ ${m.name}: ${hits.length} doc(s)`);
      for (const h of hits) console.log(JSON.stringify(h, null, 2).slice(0, 1500));
    }
  }

  // And any inboundIntake / event row with body or summary referencing Ronald Colbert
  console.log("\n=== Recent inbound intake / event records mentioning COLBERT (any domain) ===");
  for (const name of ["controlplaneinboundsourcerecords", "controlplaneworkflowrecords", "controlplanereviewqueueitems"]) {
    const col = db.collection(name);
    const exists = await db.listCollections({ name }).toArray();
    if (exists.length === 0) continue;
    const hits = await col
      .find({
        $or: [
          { "payload.firstName": /^ronald$/i, "payload.lastName": /colbert/i },
          { "payload.name": /ronald.*colbert/i },
          { summary: /colbert/i },
          { customerName: /colbert/i },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    if (hits.length > 0) {
      console.log(`\n  ${name}: ${hits.length} hits`);
      for (const h of hits) console.log(JSON.stringify(h, null, 2).slice(0, 1500));
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
