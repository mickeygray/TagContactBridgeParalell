"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");

const { CallLog } = require("../packages/shared-models/src");
const { buildTimezoneDateWindow } = require("../packages/shared-services/src/timezoneDateWindowService");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });

  const TZ = "America/Los_Angeles";
  const dk = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const { start, end } = buildTimezoneDateWindow(dk, TZ);

  for (const domain of ["TAG", "WYNN"]) {
    console.log(`\n=== ${domain} ${dk} — null-source rows breakdown ===`);
    const nullRows = await CallLog.find(
      {
        domain,
        callStartTime: { $gte: start, $lte: end },
        $or: [{ sourceName: null }, { sourceName: { $exists: false } }, { sourceName: "" }],
      },
      {
        telephonySessionId: 1,
        direction: 1,
        caseId: 1,
        platform: 1,
        executionOwner: 1,
        extensionId: 1,
        agentName: 1,
        phone: 1,
        callStartTime: 1,
        status: 1,
        strategy: 1,
        confidence: 1,
      },
    ).limit(50).lean();
    console.log(`  total: ${nullRows.length}`);

    const bins = {
      withCaseId: nullRows.filter((r) => r.caseId != null).length,
      nullCaseId: nullRows.filter((r) => r.caseId == null).length,
      byDirection: {},
      byPlatform: {},
      byExecOwner: {},
    };
    for (const r of nullRows) {
      const d = r.direction || "(null)";
      bins.byDirection[d] = (bins.byDirection[d] || 0) + 1;
      const p = r.platform || "(null)";
      bins.byPlatform[p] = (bins.byPlatform[p] || 0) + 1;
      const e = r.executionOwner || "(null)";
      bins.byExecOwner[e] = (bins.byExecOwner[e] || 0) + 1;
    }
    console.log(JSON.stringify(bins, null, 2));

    console.log("  sample rows:");
    for (const r of nullRows.slice(0, 8)) {
      console.log(
        `    sess=${(r.telephonySessionId || "").slice(0, 12)} dir=${r.direction} plat=${r.platform} owner=${r.executionOwner} caseId=${r.caseId} agent=${r.agentName} status=${r.status} strat=${r.strategy}`,
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
