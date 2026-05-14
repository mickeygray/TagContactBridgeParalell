"use strict";

require("dotenv").config({
  path: require("path").resolve(__dirname, "..", "..", ".env"),
});
const mongoose = require("mongoose");

const ID = 106029;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const names = await db.listCollections().toArray();
  console.log(`\nCollections with caseId=${ID} anywhere:`);
  for (const meta of names) {
    if (!meta.name.startsWith("control")) continue;
    const col = db.collection(meta.name);
    const hit = await col.findOne({ caseId: ID });
    if (hit) {
      console.log(`\n  ✅ ${meta.name}`);
      console.log(JSON.stringify(hit, null, 2).slice(0, 1800));
    }
  }

  // Maybe it's "caseId" as string, or under a nested key
  console.log(`\nFuzzy search across collections for "${ID}":`);
  for (const meta of names) {
    if (!meta.name.startsWith("control")) continue;
    const col = db.collection(meta.name);
    const strHit = await col.findOne({
      $or: [
        { caseId: String(ID) },
        { "primary.caseId": ID },
        { "payload.caseId": ID },
      ],
    });
    if (strHit) {
      console.log(`\n  ✅ ${meta.name} (alt field)`);
      console.log(JSON.stringify(strHit, null, 2).slice(0, 1800));
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
