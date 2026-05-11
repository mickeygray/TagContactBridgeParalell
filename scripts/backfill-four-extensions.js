"use strict";

require("dotenv").config();

const { connectMongo, disconnectMongo } = require("../packages/event-core/src");
const { getSharedConfig } = require("../packages/shared-config/src");
const { createRingCentralClient } = require("../packages/shared-integrations/src");
const { userAccountRepository } = require("../packages/shared-repositories/src");

const TARGETS = [
  "ballen@taxadvocategroup.com",
  "polson@taxadvocategroup.com",
  "acalloway@taxadvocategroup.com",
  "slucas@taxadvocategroup.com",
];

function norm(e) { return String(e || "").trim().toLowerCase(); }

async function main() {
  const dry = process.argv.includes("--dry") || process.argv.includes("--dry-run");

  const state = await connectMongo(getSharedConfig());
  if (!state.connected) throw new Error("mongo not connected");

  const rc = createRingCentralClient();
  await rc.reinitializePlatform({ force: false, reason: "backfill-ext" });
  const payload = await rc.listExtensions();
  const records = Array.isArray(payload.records) ? payload.records : [];

  const set = new Set(TARGETS.map(norm));
  const extByEmail = new Map();
  for (const r of records) {
    if (r.type !== "User") continue;
    const e = norm(r?.contact?.email);
    if (!set.has(e)) continue;
    const prev = extByEmail.get(e);
    if (!prev || (r.status === "Enabled" && prev.status !== "Enabled")) {
      extByEmail.set(e, r);
    }
  }

  for (const email of TARGETS) {
    const ua = await userAccountRepository.findUserAccountByEmail(email);
    const ext = extByEmail.get(norm(email));
    if (!ua) {
      console.log(`  ${email}: UA not found`);
      continue;
    }
    if (!ext) {
      console.log(`  ${email}: no RC extension found`);
      continue;
    }
    const patch = {
      extensionId: String(ext.id),
      extensionNumber: String(ext.extensionNumber),
      metadata: {
        ...(ua.metadata || {}),
        rcStatus: ext.status,
        extensionBackfilledAt: new Date(),
      },
    };
    console.log(
      `  ${email}: ext=${ext.extensionNumber} (id=${ext.id}) status=${ext.status} ${dry ? "(dry)" : "→ patch"}`,
    );
    if (!dry) {
      await userAccountRepository.updateUserAccount(ua.id, patch);
    }
  }

  await disconnectMongo();
}

main().catch((e) => { console.error(e); process.exit(1); });
