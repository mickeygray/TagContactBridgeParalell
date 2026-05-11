"use strict";

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const {
  userAccountRepository,
} = require("../packages/shared-repositories/src");

const TARGET_EMAILS = [
  "ballen@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "acalloway@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
];

async function main() {
  const state = await connectMongo(getSharedConfig());
  if (!state.connected) throw new Error(`Mongo not connected`);

  for (const email of TARGET_EMAILS) {
    const ua = await userAccountRepository.findUserAccountByEmail(email);
    if (!ua) { console.log(`  ${email.padEnd(34)} NOT FOUND`); continue; }
    console.log(
      `  ${email.padEnd(34)} ext=${ua.extensionNumber || "-"}(id ${ua.extensionId || "-"}) phone=${ua.phone || "-"}\n` +
      `    TAG  id=${ua.tagLogicsId || "-"}   email=${ua.tagEmail || "-"}\n` +
      `    WYNN id=${ua.wynnLogicsId || "-"}   email=${ua.wynnEmail || "-"}`,
    );
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
