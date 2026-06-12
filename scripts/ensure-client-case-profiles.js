"use strict";

// Operator tool: run client-case discovery by hand — ensure every Logics
// client-status case has a caseProfile (the auth-spam-era blind spot).
// Same code path the nightly close runs.
//
//   node scripts/ensure-client-case-profiles.js --harvest
//       Mine the resolution bank's refreshed logics_status data and print
//       the statusId/statusName frequencies of the KNOWN client book — the
//       empirical answer to "which status IDs are client statuses".
//
//   node scripts/ensure-client-case-profiles.js --status-ids 209,210 --dry
//   node scripts/ensure-client-case-profiles.js --status-ids 209,210
//
// Once the ID list is blessed, set CLIENT_CASE_DISCOVERY_STATUS_IDS in env
// and the nightly close runs this automatically.

require("dotenv").config();
const mongoose = require("mongoose");
require("../packages/shared-models/src");
const { ensureClientCaseProfiles, parseStatusIds } = require("../packages/shared-services/src/clientCaseDiscoveryService");

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: process.env.MONGO_DB_NAME || "tagcontactbridge_parallel",
  });

  if (process.argv.includes("--harvest")) {
    const ClientProfile = mongoose.model("ClientProfile");
    const rows = await ClientProfile.aggregate([
      { $match: { "shorthand.logics_status.value.statusId": { $ne: null } } },
      {
        $group: {
          _id: {
            statusId: "$shorthand.logics_status.value.statusId",
            statusName: "$shorthand.logics_status.value.statusName",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);
    console.log("statusId frequencies across the refreshed resolution bank (the known client book):");
    for (const row of rows) {
      console.log(`  ${String(row._id.statusId).padEnd(6)} ${String(row.count).padStart(5)}×  ${row._id.statusName || "?"}`);
    }
    if (!rows.length) console.log("  (none refreshed yet — tonight's bank close populates this)");
    console.log("\nBless the client statuses and set CLIENT_CASE_DISCOVERY_STATUS_IDS.");
  } else {
    const statusIds = parseStatusIds(argValue("--status-ids", process.env.CLIENT_CASE_DISCOVERY_STATUS_IDS));
    const result = await ensureClientCaseProfiles({
      statusIds,
      dryRun: process.argv.includes("--dry"),
      logger: { info: (m, x) => console.log(m, JSON.stringify(x || {})), warn: (m, x) => console.warn(m, JSON.stringify(x || {})) },
    });
    console.log(JSON.stringify(result, null, 2));
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
