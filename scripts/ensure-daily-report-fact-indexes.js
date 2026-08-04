"use strict";

require("dotenv").config();
if (process.env.DNS_SERVERS) {
  try {
    require("dns").setServers(process.env.DNS_SERVERS.split(",").map((value) => value.trim()).filter(Boolean));
  } catch { /* connectMongo will report the actual failure */ }
}

const { connectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const DailyReportFact = require("../packages/shared-models/src/DailyReportFact");

async function main() {
  await connectMongo(getSharedConfig());
  const declared = DailyReportFact.schema.indexes();
  await DailyReportFact.createIndexes();
  console.log(`daily report fact indexes ready: ${declared.length}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`daily report fact index setup failed: ${String(error.message || error).slice(0, 200)}`);
    process.exit(1);
  });
