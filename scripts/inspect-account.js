"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const { findUserAccountByEmail, listUserAccounts } = require("../packages/shared-repositories/src/userAccountRepository");

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  const dbName = process.env.PARALLEL_DB_NAME || "tagcontactbridge_parallel";
  await mongoose.connect(uri, { dbName });
  console.log(`(connected to db: ${mongoose.connection.name})`);

  const needle = (process.argv[2] || "").toLowerCase();
  if (!needle) {
    const all = await listUserAccounts({ limit: 200 });
    console.log("All accounts:");
    for (const a of all) {
      console.log(`  ${a.email.padEnd(40)} role=${(a.role||"-").padEnd(15)} audience=${(a.audience||"-").padEnd(8)} company=${(a.company||"-").padEnd(6)} status=${a.status}`);
    }
  } else {
    const all = await listUserAccounts({ search: needle, limit: 50 });
    console.log(`Matches for "${needle}":`);
    for (const a of all) {
      console.log(JSON.stringify(a, null, 2));
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
